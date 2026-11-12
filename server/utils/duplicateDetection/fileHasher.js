/**
 * Streaming SHA-256 file hashing for duplicate detection.
 *
 * - Reads through one reusable buffer, so memory use does not depend on file size.
 * - Checks the AbortSignal between reads, so a cancel stops within one chunk.
 * - Can limit read throughput so a bulk audit does not saturate a disk or a
 *   network mount.
 * - Stats the file before and after reading and fails with CHANGED if the
 *   size, mtime or ctime moved, or if the path now points at a different
 *   file, so a file that changed while being read is never cached.
 */

const crypto = require('crypto')
const fs = require('fs')

const HASH_ALGORITHM = 'sha256'
const DEFAULT_CHUNK_SIZE = 1024 * 1024

class FileHashError extends Error {
  /**
   * @param {string} code ENOENT, EACCES, CHANGED, ABORTED or another fs error code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'FileHashError'
    this.code = code
  }
}

/**
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new FileHashError('ABORTED', 'Hashing aborted')
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FileHashError('ABORTED', 'Hashing aborted'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new FileHashError('ABORTED', 'Hashing aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Simple byte-rate limiter shared by all hashing in one detection run
 */
class ByteRateLimiter {
  /**
   * @param {number} bytesPerSecond 0 disables limiting
   */
  constructor(bytesPerSecond) {
    this.bytesPerSecond = bytesPerSecond > 0 ? bytesPerSecond : 0
    this.startedAt = Date.now()
    this.bytes = 0
  }

  /**
   * Record bytes read and wait if reading is ahead of the budget
   *
   * @param {number} bytes
   * @param {AbortSignal} [signal]
   */
  async consume(bytes, signal) {
    if (!this.bytesPerSecond) return
    this.bytes += bytes
    const expectedElapsedMs = (this.bytes / this.bytesPerSecond) * 1000
    const aheadMs = expectedElapsedMs - (Date.now() - this.startedAt)
    if (aheadMs > 5) await sleep(aheadMs, signal)
  }
}

/**
 * @param {import('fs').BigIntStats} stat
 */
function statToIdentity(stat) {
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    ino: String(stat.ino),
    dev: String(stat.dev)
  }
}

/**
 * Stat a file and return identity fields used for hash cache validation
 *
 * @param {string} path
 * @returns {Promise<{size:number, mtimeMs:number, ctimeMs:number, ino:string, dev:string}>}
 */
async function statFile(path) {
  try {
    const stat = await fs.promises.stat(path, { bigint: true })
    if (!stat.isFile()) throw new FileHashError('ENOTFILE', 'Not a regular file')
    return statToIdentity(stat)
  } catch (error) {
    if (error instanceof FileHashError) throw error
    throw new FileHashError(error.code || 'EIO', error.message)
  }
}

/**
 * @typedef FileHashResult
 * @property {string} hash hex digest
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} ctimeMs
 * @property {string} ino
 * @property {string} dev
 */

/**
 * Hash a file with SHA-256 using streaming reads
 *
 * @param {string} path
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {ByteRateLimiter} [options.rateLimiter]
 * @param {number} [options.chunkSize]
 * @returns {Promise<FileHashResult>}
 */
async function hashFile(path, options = {}) {
  const { signal, rateLimiter } = options
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE
  throwIfAborted(signal)

  let handle
  try {
    handle = await fs.promises.open(path, 'r')
  } catch (error) {
    throw new FileHashError(error.code || 'EIO', error.message)
  }

  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new FileHashError('ENOTFILE', 'Not a regular file')

    const hash = crypto.createHash(HASH_ALGORITHM)
    const buffer = Buffer.allocUnsafe(chunkSize)
    let position = 0
    while (true) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
      if (rateLimiter) await rateLimiter.consume(bytesRead, signal)
    }

    const after = await handle.stat({ bigint: true })
    const identityBefore = statToIdentity(before)
    const identityAfter = statToIdentity(after)
    if (identityBefore.size !== identityAfter.size || identityBefore.mtimeMs !== identityAfter.mtimeMs || identityBefore.ctimeMs !== identityAfter.ctimeMs || position !== identityAfter.size) {
      throw new FileHashError('CHANGED', 'File changed while it was being hashed')
    }

    // The path may have been replaced (renamed over) while the old file was open
    let current
    try {
      current = await statFile(path)
    } catch (error) {
      throw new FileHashError('CHANGED', `File was replaced or removed while it was being hashed (${error.code})`)
    }
    if (current.ino !== identityAfter.ino || current.dev !== identityAfter.dev || current.size !== identityAfter.size || current.mtimeMs !== identityAfter.mtimeMs) {
      throw new FileHashError('CHANGED', 'File was replaced while it was being hashed')
    }

    return { hash: hash.digest('hex'), ...identityAfter }
  } catch (error) {
    if (error instanceof FileHashError) throw error
    throw new FileHashError(error.code || 'EIO', error.message)
  } finally {
    await handle.close().catch(() => {})
  }
}

module.exports = {
  HASH_ALGORITHM,
  FileHashError,
  ByteRateLimiter,
  statFile,
  hashFile,
  sleep
}
