/**
 * Content hashes for library item audio files, backed by the fileHashes cache.
 *
 * Cache validation:
 *  - "incremental" runs trust the file size and mtime recorded by the last
 *    library scan and do not touch the filesystem for files with a valid
 *    cache entry. Files that changed on disk are picked up by the scanner,
 *    which updates the recorded size and mtime.
 *  - "full" audits stat every file they need and only reuse a cached hash
 *    when size, mtime, device and inode all still match.
 *
 * A file with no cache entry for its path (renamed or moved) can reuse the
 * hash of an entry with the same device, inode, size and mtime. The inode is
 * never used on its own.
 */

const Path = require('path')
const { Op } = require('sequelize')
const Database = require('../../Database')
const Logger = require('../../Logger')
const { HASH_ALGORITHM, FileHashError, statFile, hashFile } = require('./fileHasher')

/**
 * @typedef HashStats
 * @property {number} cacheHits
 * @property {number} cacheMisses
 * @property {number} filesHashed
 * @property {number} bytesHashed
 * @property {number} hashFailures
 * @property {Record<string, number>} failuresByCode
 *
 * @typedef FileContent
 * @property {string} hash
 * @property {string|null} physicalId "dev:ino" when known
 *
 * @typedef ItemContent
 * @property {'ok'|'unavailable'} status
 * @property {string} [reason] error code when unavailable
 * @property {FileContent[]} files
 */

/** @returns {HashStats} */
function createHashStats() {
  return { cacheHits: 0, cacheMisses: 0, filesHashed: 0, bytesHashed: 0, hashFailures: 0, failuresByCode: {} }
}

class ItemContentHasher {
  /**
   * @param {Object} options
   * @param {string} options.libraryId
   * @param {'incremental'|'full'} options.mode
   * @param {AbortSignal} [options.signal]
   * @param {import('./fileHasher').ByteRateLimiter} [options.rateLimiter]
   * @param {HashStats} [options.stats]
   * @param {(file:{path:string, size:number}) => void} [options.onFileHashed]
   */
  constructor(options) {
    this.libraryId = options.libraryId
    this.mode = options.mode
    this.signal = options.signal
    this.rateLimiter = options.rateLimiter
    this.stats = options.stats || createHashStats()
    this.onFileHashed = options.onFileHashed || null
    /** @type {Map<string, Promise<ItemContent>>} */
    this.itemCache = new Map()
  }

  /**
   * Get content hashes for every included audio file of an item. Results are
   * memoized for the lifetime of this hasher (one detection run).
   *
   * @param {import('./classify').ItemDescriptor} descriptor
   * @returns {Promise<ItemContent>}
   */
  getItemContent(descriptor) {
    if (!this.itemCache.has(descriptor.id)) {
      this.itemCache.set(descriptor.id, this.computeItemContent(descriptor))
    }
    return this.itemCache.get(descriptor.id)
  }

  /**
   * @param {import('./classify').ItemDescriptor} descriptor
   * @returns {Promise<ItemContent>}
   */
  async computeItemContent(descriptor) {
    const cacheRows = await Database.fileHashModel.findAll({
      where: { path: descriptor.files.map((f) => f.path) }
    })
    const rowsByPath = new Map(cacheRows.map((row) => [row.path, row]))

    /** @type {FileContent[]} */
    const files = []
    for (const file of descriptor.files) {
      if (this.signal?.aborted) throw new FileHashError('ABORTED', 'Hashing aborted')
      try {
        files.push(await this.getFileContent(file, rowsByPath.get(file.path) || null))
      } catch (error) {
        if (error.code === 'ABORTED') throw error
        const code = error.code || 'EIO'
        this.stats.hashFailures++
        this.stats.failuresByCode[code] = (this.stats.failuresByCode[code] || 0) + 1
        Logger.debug(`[DuplicateDetection] Could not hash audio file "${Path.basename(file.path)}" of item "${descriptor.id}" (${code})`)
        return { status: 'unavailable', reason: code, files: [] }
      }
    }
    return { status: 'ok', files }
  }

  /**
   * @param {import('../../models/FileHash')} row
   */
  isRowCurrent(row) {
    return row.cacheVersion === Database.fileHashModel.CACHE_VERSION && row.algorithm === HASH_ALGORITHM && !!row.hash
  }

  /**
   * @param {import('./classify').RawAudioFile} file
   * @param {import('../../models/FileHash')|null} row
   * @returns {Promise<FileContent>}
   */
  async getFileContent(file, row) {
    // Incremental: trust size/mtime recorded by the scanner
    if (this.mode === 'incremental' && row && this.isRowCurrent(row) && file.mtimeMs !== null && Number(row.size) === Number(file.size) && row.mtimeMs === file.mtimeMs) {
      this.stats.cacheHits++
      return { hash: row.hash, physicalId: row.dev && row.ino ? `${row.dev}:${row.ino}` : null }
    }

    const stat = await statFile(file.path)
    const physicalId = `${stat.dev}:${stat.ino}`

    if (row && this.isRowCurrent(row) && Number(row.size) === stat.size && row.mtimeMs === stat.mtimeMs && row.ino === stat.ino && row.dev === stat.dev) {
      this.stats.cacheHits++
      return { hash: row.hash, physicalId }
    }

    if (!row) {
      // Renamed or moved file: same device, inode, size and mtime
      const candidates = await Database.fileHashModel.findAll({
        where: { ino: stat.ino, size: stat.size, dev: stat.dev, mtimeMs: stat.mtimeMs, cacheVersion: Database.fileHashModel.CACHE_VERSION, algorithm: HASH_ALGORITHM, path: { [Op.ne]: file.path } },
        limit: 1
      })
      if (candidates.length) {
        this.stats.cacheHits++
        await this.saveRow(null, file.path, stat, candidates[0].hash)
        return { hash: candidates[0].hash, physicalId }
      }
    }

    this.stats.cacheMisses++
    const result = await hashFile(file.path, { signal: this.signal, rateLimiter: this.rateLimiter })
    this.stats.filesHashed++
    this.stats.bytesHashed += result.size
    this.onFileHashed?.({ path: file.path, size: result.size })
    await this.saveRow(row, file.path, result, result.hash)
    return { hash: result.hash, physicalId: `${result.dev}:${result.ino}` }
  }

  /**
   * @param {import('../../models/FileHash')|null} row existing row for this path
   * @param {string} path
   * @param {{size:number, mtimeMs:number, ctimeMs:number, ino:string, dev:string}} identity
   * @param {string} hash
   */
  async saveRow(row, path, identity, hash) {
    const values = {
      libraryId: this.libraryId,
      path,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      ctimeMs: identity.ctimeMs,
      ino: identity.ino,
      dev: identity.dev,
      algorithm: HASH_ALGORITHM,
      cacheVersion: Database.fileHashModel.CACHE_VERSION,
      hash,
      hashedAt: new Date()
    }
    if (row) {
      await row.update(values)
      return
    }
    // Another run may have inserted the row in the meantime
    const existing = await Database.fileHashModel.findOne({ where: { path } })
    if (existing) await existing.update(values)
    else await Database.fileHashModel.create(values)
  }
}

/**
 * Compare two items' file contents as multisets of hashes
 *
 * @param {ItemContent} contentA
 * @param {ItemContent} contentB
 * @returns {import('./classify').HashComparison}
 */
function compareItemContents(contentA, contentB) {
  if (contentA.status !== 'ok' || contentB.status !== 'ok') {
    return { status: 'unavailable', reason: contentA.reason || contentB.reason || 'unavailable' }
  }

  // Physical files both items point at (same device + inode)
  const physicalCounts = new Map()
  for (const file of contentA.files) {
    if (file.physicalId) physicalCounts.set(file.physicalId, (physicalCounts.get(file.physicalId) || 0) + 1)
  }
  let sharedPhysicalFiles = 0
  for (const file of contentB.files) {
    const count = file.physicalId ? physicalCounts.get(file.physicalId) : 0
    if (count) {
      sharedPhysicalFiles++
      physicalCounts.set(file.physicalId, count - 1)
    }
  }

  const hashesA = contentA.files.map((f) => f.hash).sort()
  const hashesB = contentB.files.map((f) => f.hash).sort()
  const identical = hashesA.length > 0 && hashesA.length === hashesB.length && hashesA.every((h, i) => h === hashesB[i])
  return { status: identical ? 'identical' : 'different', sharedPhysicalFiles }
}

module.exports = {
  createHashStats,
  ItemContentHasher,
  compareItemContents
}
