const { setImmediate } = require('timers')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const TaskManager = require('./TaskManager')
const { ALGORITHM_VERSION, Classification, ClassificationRank, buildItemDescriptor, compareItems } = require('../utils/duplicateDetection/classify')
const { generateCandidatePairs } = require('../utils/duplicateDetection/candidates')
const { ByteRateLimiter } = require('../utils/duplicateDetection/fileHasher')
const { ItemContentHasher, compareItemContents, createHashStats } = require('../utils/duplicateDetection/hashCache')
const { iterateLibraryItems, pruneFileHashCache } = require('../utils/duplicateDetection/itemLoader')
const { DEFAULT_TITLE_PREFIXES } = require('../utils/duplicateDetection/normalize')

/**
 * @typedef {'incremental'|'full'} DetectionMode
 *
 * @typedef RunProgress
 * @property {string} phase loading | comparing | saving
 * @property {number} itemsLoaded
 * @property {number} candidatePairs
 * @property {number} pairsCompared
 * @property {number} filesHashed
 * @property {number} bytesHashed
 *
 * @typedef RunState
 * @property {string} libraryId
 * @property {DetectionMode} mode
 * @property {string} trigger
 * @property {number} startedAt
 * @property {AbortController} abortController
 * @property {boolean} [deferredByScan] aborted because a library scan started
 * @property {RunProgress} progress
 * @property {Promise<RunSummary>} promise
 *
 * @typedef RunSummary
 * @property {string} libraryId
 * @property {DetectionMode} mode
 * @property {string} trigger
 * @property {'completed'|'canceled'|'deferred'|'failed'} result
 * @property {number} startedAt
 * @property {number} finishedAt
 * @property {number} elapsedMs
 * @property {number} items
 * @property {number} blocks
 * @property {number} oversizedBlocks
 * @property {number} candidatePairs
 * @property {Record<string, number>} classifications
 * @property {{created:number, updated:number, removed:number, reopened:number, unchanged:number, kept:number}} findings
 * @property {import('../utils/duplicateDetection/hashCache').HashStats} hashing
 * @property {number} cacheRowsPruned
 * @property {string} [error]
 */

/**
 * Detects duplicate books in a library and stores reviewable findings.
 *
 * Runs are per library and never overlap: a request while a run is active is
 * queued and runs once afterwards. Runs started while the library is being
 * scanned are deferred until the scan is done. Detection never changes,
 * moves, hides or deletes library items or files.
 *
 * Dismissal policy: a dismissed finding stays dismissed when the same pair is
 * found again, unless
 *  - the classification became stronger than when it was dismissed
 *    (e.g. possible_duplicate -> exact), or
 *  - the audio content of either item changed (files added, removed or
 *    resized, or file durations changed).
 * Metadata-only edits do not reopen a dismissed finding. If a pair stops
 * matching altogether, its finding is removed.
 */
class DuplicateDetectionManager {
  constructor() {
    /** @type {Map<string, RunState>} */
    this.runs = new Map()
    /** @type {Map<string, {mode:DetectionMode, trigger:string}>} queued run per library, at most one */
    this.queued = new Map()
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map()
    /** @type {Map<string, RunSummary>} */
    this.lastRuns = new Map()

    this.options = {
      /** Wait after a scan or edit before running, so bursts of changes coalesce */
      debounceMs: 30 * 1000,
      /** Retry delay when the library is being scanned */
      scanDeferMs: 60 * 1000,
      /** Hashing read throughput cap shared by a run (0 = unlimited) */
      maxHashBytesPerSecond: 64 * 1024 * 1024,
      pageSize: 500,
      maxBlockSize: 250,
      /** Emit progress at most this often */
      progressIntervalMs: 2000
    }

    this.stopped = false
  }

  /**
   * @param {string} libraryId
   * @returns {boolean}
   */
  isRunning(libraryId) {
    return this.runs.has(libraryId)
  }

  /**
   * @param {string} libraryId
   */
  getStatus(libraryId) {
    const run = this.runs.get(libraryId)
    const queued = this.queued.get(libraryId) || null
    return {
      running: !!run,
      mode: run?.mode || null,
      trigger: run?.trigger || null,
      startedAt: run?.startedAt || null,
      progress: run ? { ...run.progress } : null,
      queued: queued ? { ...queued } : null,
      scheduled: this.timers.has(libraryId),
      lastRun: this.lastRuns.get(libraryId) || null
    }
  }

  /**
   * Called after library changes (completed scan, watcher scan, item edit).
   * Runs an incremental pass after a delay if the library has automatic
   * duplicate detection turned on.
   *
   * @param {import('../models/Library')} library
   * @param {string} trigger
   */
  notifyLibraryChanged(library, trigger) {
    if (this.stopped || !library?.isBook || !library.settings?.enableDuplicateDetection) return
    this.schedule(library.id, 'incremental', trigger, this.options.debounceMs)
  }

  /**
   * Same as notifyLibraryChanged for callers that only have a library id
   *
   * @param {string} libraryId
   * @param {string} trigger
   */
  async notifyLibraryChangedById(libraryId, trigger) {
    if (this.stopped || !libraryId) return
    try {
      const library = await Database.libraryModel.findByPk(libraryId)
      this.notifyLibraryChanged(library, trigger)
    } catch (error) {
      Logger.error(`[DuplicateDetectionManager] Failed to schedule duplicate detection for library "${libraryId}"`, error)
    }
  }

  /**
   * @param {string} libraryId
   * @param {DetectionMode} mode
   * @param {string} trigger
   * @param {number} delayMs
   */
  schedule(libraryId, mode, trigger, delayMs) {
    if (this.stopped) return
    const existing = this.timers.get(libraryId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(libraryId)
      this.requestRun(libraryId, mode, trigger).catch((error) => {
        Logger.error(`[DuplicateDetectionManager] Scheduled run failed to start for library "${libraryId}"`, error)
      })
    }, delayMs)
    timer.unref?.()
    this.timers.set(libraryId, timer)
  }

  /**
   * Start a run now, or queue it if one is already running for this library.
   * A queued full audit is not downgraded by a later incremental request.
   *
   * @param {string} libraryId
   * @param {DetectionMode} mode
   * @param {string} trigger
   * @returns {Promise<{status:'started'|'queued', promise?:Promise<RunSummary>}>}
   */
  async requestRun(libraryId, mode, trigger) {
    if (this.stopped) return { status: 'queued' }
    if (this.runs.has(libraryId)) {
      const queued = this.queued.get(libraryId)
      if (!queued || (queued.mode === 'incremental' && mode === 'full')) {
        this.queued.set(libraryId, { mode, trigger })
      }
      return { status: 'queued' }
    }
    const promise = this.startRun(libraryId, mode, trigger)
    return { status: 'started', promise }
  }

  /**
   * Cancel the active run and any queued or scheduled run for a library
   *
   * @param {string} libraryId
   * @returns {boolean} true if something was canceled
   */
  cancel(libraryId) {
    let canceled = false
    const timer = this.timers.get(libraryId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(libraryId)
      canceled = true
    }
    if (this.queued.delete(libraryId)) canceled = true
    const run = this.runs.get(libraryId)
    if (run) {
      run.abortController.abort()
      canceled = true
    }
    return canceled
  }

  /**
   * Called when a library scan starts. An active run is stopped and scheduled
   * again, so it does not read items while the scanner is changing them.
   *
   * @param {string} libraryId
   */
  deferForLibraryScan(libraryId) {
    const run = this.runs.get(libraryId)
    if (!run) return
    Logger.info(`[DuplicateDetectionManager] Library scan started, deferring active duplicate detection run`)
    run.deferredByScan = true
    run.abortController.abort()
  }

  /**
   * Stop all runs and timers (server shutdown)
   */
  async stop() {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.queued.clear()
    const pending = []
    for (const run of this.runs.values()) {
      run.abortController.abort()
      pending.push(run.promise.catch(() => {}))
    }
    await Promise.all(pending)
  }

  /**
   * @param {string} libraryId
   * @param {DetectionMode} mode
   * @param {string} trigger
   * @returns {Promise<RunSummary>}
   */
  startRun(libraryId, mode, trigger) {
    /** @type {RunState} */
    const run = {
      libraryId,
      mode,
      trigger,
      startedAt: Date.now(),
      abortController: new AbortController(),
      progress: { phase: 'loading', itemsLoaded: 0, candidatePairs: 0, pairsCompared: 0, filesHashed: 0, bytesHashed: 0 },
      promise: null
    }
    this.runs.set(libraryId, run)
    run.promise = this.executeRun(run)
      .catch((error) => {
        Logger.error(`[DuplicateDetectionManager] Duplicate detection run failed for library "${libraryId}"`, error)
        return this.finishSummary({ libraryId, mode, trigger, result: 'failed', startedAt: run.startedAt, error: error.message })
      })
      .finally(() => {
        this.runs.delete(libraryId)
        const next = this.queued.get(libraryId)
        if (next && !this.stopped) {
          this.queued.delete(libraryId)
          this.startRun(libraryId, next.mode, next.trigger)
        }
      })
    return run.promise
  }

  /**
   * @param {string} libraryId
   * @returns {boolean}
   */
  isLibraryScanning(libraryId) {
    // Required lazily: LibraryScanner notifies this manager
    return require('../scanner/LibraryScanner').isLibraryScanning(libraryId)
  }

  /**
   * @param {RunState} run
   * @returns {Promise<RunSummary>}
   */
  async executeRun(run) {
    const { libraryId, mode, trigger } = run
    /** @type {RunSummary} */
    const summary = {
      libraryId,
      mode,
      trigger,
      result: 'completed',
      startedAt: run.startedAt,
      finishedAt: null,
      elapsedMs: 0,
      items: 0,
      blocks: 0,
      oversizedBlocks: 0,
      candidatePairs: 0,
      classifications: {},
      findings: { created: 0, updated: 0, removed: 0, reopened: 0, unchanged: 0, kept: 0 },
      hashing: createHashStats(),
      cacheRowsPruned: 0
    }

    const library = await Database.libraryModel.findByPk(libraryId)
    if (!library || !library.isBook) {
      summary.result = 'failed'
      summary.error = 'Library not found or not a book library'
      return this.finishSummary(summary)
    }

    if (this.isLibraryScanning(libraryId)) {
      Logger.info(`[DuplicateDetectionManager] Library "${library.name}" is being scanned, deferring duplicate detection`)
      summary.result = 'deferred'
      this.schedule(libraryId, mode, trigger, this.options.scanDeferMs)
      return this.finishSummary(summary)
    }

    const task = TaskManager.createAndAddTask('duplicate-detection', { text: `Detecting duplicates in "${library.name}"`, key: 'MessageTaskDetectingDuplicates', subs: [library.name] }, mode === 'full' ? { text: 'Full audit', key: 'MessageTaskDuplicateFullAudit' } : null, false, { libraryId, libraryName: library.name, mode })

    let lastProgressEmit = 0
    const emitProgress = (force = false) => {
      const now = Date.now()
      if (!force && now - lastProgressEmit < this.options.progressIntervalMs) return
      lastProgressEmit = now
      SocketAuthority.adminEmitter('duplicate_detection_progress', { libraryId, mode, progress: { ...run.progress } })
    }

    try {
      await this.detect(run, library, summary, emitProgress)
      if (summary.result === 'canceled') {
        task.setFinished({ text: 'Task canceled by user', key: 'MessageTaskCanceledByUser' })
      } else if (summary.result === 'deferred') {
        task.setFinished({ text: 'Deferred until the library scan finishes', key: 'MessageTaskDuplicateDeferred' })
      } else {
        task.setFinished(null, true)
      }
    } catch (error) {
      summary.result = 'failed'
      summary.error = error.message
      Logger.error(`[DuplicateDetectionManager] Duplicate detection failed for library "${library.name}"`, error)
      task.setFailed({ text: 'Failed', key: 'MessageTaskFailed' })
    }
    task.data.summary = this.finishSummary(summary)
    TaskManager.taskFinished(task)
    emitProgress(true)
    SocketAuthority.adminEmitter('duplicate_detection_finished', summary)
    return summary
  }

  /**
   * @param {RunSummary} summary
   * @returns {RunSummary}
   */
  finishSummary(summary) {
    summary.finishedAt = Date.now()
    summary.elapsedMs = summary.finishedAt - summary.startedAt
    this.lastRuns.set(summary.libraryId, summary)
    if (summary.result === 'completed') {
      const hashing = summary.hashing
      Logger.info(
        `[DuplicateDetectionManager] ${summary.mode} run finished in ${summary.elapsedMs}ms | items ${summary.items}, blocks ${summary.blocks} (${summary.oversizedBlocks} oversized skipped), candidate pairs ${summary.candidatePairs} | ` +
          `classifications ${JSON.stringify(summary.classifications)} | findings ${JSON.stringify(summary.findings)} | ` +
          `cache hits ${hashing.cacheHits}, misses ${hashing.cacheMisses}, files hashed ${hashing.filesHashed} (${hashing.bytesHashed} bytes), hash failures ${hashing.hashFailures}`
      )
    } else {
      Logger.info(`[DuplicateDetectionManager] ${summary.mode} run ${summary.result} after ${summary.elapsedMs}ms${summary.error ? `: ${summary.error}` : ''}`)
    }
    return summary
  }

  /**
   * Core detection pass
   *
   * @param {RunState} run
   * @param {import('../models/Library')} library
   * @param {RunSummary} summary
   * @param {(force?:boolean) => void} emitProgress
   */
  async detect(run, library, summary, emitProgress) {
    const signal = run.abortController.signal
    const isCanceled = () => {
      if (!signal.aborted) return false
      if (run.deferredByScan) {
        summary.result = 'deferred'
        this.schedule(library.id, run.mode, run.trigger, this.options.scanDeferMs)
      } else {
        summary.result = 'canceled'
      }
      return true
    }

    const titlePrefixes = global.ServerSettings?.sortingPrefixes?.length ? global.ServerSettings.sortingPrefixes : DEFAULT_TITLE_PREFIXES

    // 1. Load descriptors
    /** @type {Map<string, import('../utils/duplicateDetection/classify').ItemDescriptor>} */
    const descriptors = new Map()
    for await (const page of iterateLibraryItems(library.id, { pageSize: this.options.pageSize, signal })) {
      for (const raw of page) {
        descriptors.set(raw.id, buildItemDescriptor(raw, { titlePrefixes }))
      }
      run.progress.itemsLoaded = descriptors.size
      emitProgress()
      await yieldToEventLoop()
    }
    if (isCanceled()) return
    summary.items = descriptors.size

    // 2. Candidate pairs
    run.progress.phase = 'comparing'
    const candidates = generateCandidatePairs([...descriptors.values()], { maxBlockSize: this.options.maxBlockSize })
    summary.blocks = candidates.blocks
    summary.oversizedBlocks = candidates.oversizedBlocks.length
    summary.candidatePairs = candidates.pairs.size
    run.progress.candidatePairs = candidates.pairs.size
    if (candidates.oversizedBlocks.length) {
      Logger.info(`[DuplicateDetectionManager] Skipped ${candidates.oversizedBlocks.length} oversized candidate blocks: ${JSON.stringify(candidates.oversizedBlocks)}`)
    }

    // 3. Compare pairs, hashing only when two items have identical file size sets
    const hasher = new ItemContentHasher({
      libraryId: library.id,
      mode: run.mode,
      signal,
      rateLimiter: new ByteRateLimiter(this.options.maxHashBytesPerSecond),
      stats: summary.hashing,
      onFileHashed: () => {
        run.progress.filesHashed = summary.hashing.filesHashed
        run.progress.bytesHashed = summary.hashing.bytesHashed
        emitProgress()
      }
    })

    /** @type {Map<string, {itemAId:string, itemBId:string, result:import('../utils/duplicateDetection/classify').ComparisonResult, contentSignature:string}>} */
    const detected = new Map()
    /** Pairs whose content could not be verified; existing exact findings for them are left alone */
    const unverifiedPairs = new Set()

    let compared = 0
    for (const [pairKey, pair] of candidates.pairs) {
      if (isCanceled()) return
      const a = descriptors.get(pair.itemAId)
      const b = descriptors.get(pair.itemBId)

      let hashComparison = { status: 'not_checked' }
      if (a.sizeSignature && a.sizeSignature === b.sizeSignature) {
        try {
          const [contentA, contentB] = [await hasher.getItemContent(a), await hasher.getItemContent(b)]
          hashComparison = compareItemContents(contentA, contentB)
        } catch (error) {
          if (error.code === 'ABORTED' || signal.aborted) {
            isCanceled()
            return
          }
          throw error
        }
        if (hashComparison.status === 'unavailable') unverifiedPairs.add(pairKey)
      }

      const result = compareItems(a, b, hashComparison)
      if (result.classification) {
        detected.set(pairKey, { itemAId: a.id, itemBId: b.id, result, contentSignature: `${a.contentSignature}|${b.contentSignature}` })
        summary.classifications[result.classification] = (summary.classifications[result.classification] || 0) + 1
      }

      compared++
      run.progress.pairsCompared = compared
      if (compared % 200 === 0) {
        emitProgress()
        await yieldToEventLoop()
      }
    }

    if (isCanceled()) return

    // A scan that started while comparing may have changed items; retry later instead of saving stale results
    if (this.isLibraryScanning(library.id)) {
      summary.result = 'deferred'
      this.schedule(library.id, run.mode, run.trigger, this.options.scanDeferMs)
      return
    }

    // 4. Persist
    run.progress.phase = 'saving'
    emitProgress(true)
    await this.saveFindings(library.id, detected, unverifiedPairs, summary)

    if (run.mode === 'full') {
      summary.cacheRowsPruned = await pruneFileHashCache(library.id)
    }
  }

  /**
   * Reconcile detected pairs with stored findings
   *
   * @param {string} libraryId
   * @param {Map<string, {itemAId:string, itemBId:string, result:import('../utils/duplicateDetection/classify').ComparisonResult, contentSignature:string}>} detected
   * @param {Set<string>} unverifiedPairs
   * @param {RunSummary} summary
   */
  async saveFindings(libraryId, detected, unverifiedPairs, summary) {
    const now = new Date()
    const Status = Database.duplicateFindingModel.Status

    await Database.sequelize.transaction(async (transaction) => {
      const existingFindings = await Database.duplicateFindingModel.findAll({
        where: { libraryId },
        transaction
      })
      const existingByPair = new Map(existingFindings.map((f) => [`${f.libraryItemAId}|${f.libraryItemBId}`, f]))

      // Items can be deleted while a run is in progress
      const itemIds = new Set()
      for (const d of detected.values()) {
        itemIds.add(d.itemAId)
        itemIds.add(d.itemBId)
      }
      const existingItemIds = new Set()
      const idList = [...itemIds]
      for (let i = 0; i < idList.length; i += 500) {
        const rows = await Database.libraryItemModel.findAll({ attributes: ['id'], where: { id: idList.slice(i, i + 500), libraryId }, transaction })
        rows.forEach((r) => existingItemIds.add(r.id))
      }

      const toCreate = []
      const unchangedIds = []
      for (const [pairKey, d] of detected) {
        if (!existingItemIds.has(d.itemAId) || !existingItemIds.has(d.itemBId)) continue
        const existing = existingByPair.get(pairKey)
        const { classification, evidence, limitations } = d.result

        if (existing && unverifiedPairs.has(pairKey) && ClassificationRank[existing.classification] > ClassificationRank[classification]) {
          // Do not downgrade a stronger finding because a file could not be read this time
          summary.findings.kept++
          continue
        }

        if (!existing) {
          toCreate.push({
            libraryId,
            libraryItemAId: d.itemAId,
            libraryItemBId: d.itemBId,
            classification,
            evidence,
            limitations,
            contentSignature: d.contentSignature,
            algorithmVersion: ALGORITHM_VERSION,
            status: Status.OPEN,
            statusReason: 'detected',
            firstDetectedAt: now,
            lastVerifiedAt: now
          })
          continue
        }

        const update = {
          classification,
          evidence,
          limitations,
          contentSignature: d.contentSignature,
          algorithmVersion: ALGORITHM_VERSION,
          lastVerifiedAt: now
        }
        const changed = existing.classification !== classification || existing.contentSignature !== d.contentSignature || existing.algorithmVersion !== ALGORITHM_VERSION || JSON.stringify(existing.evidence) !== JSON.stringify(evidence)

        if (existing.status === Status.DISMISSED) {
          const upgraded = ClassificationRank[classification] > ClassificationRank[existing.dismissedClassification || existing.classification]
          const audioChanged = !!existing.dismissedContentSignature && existing.dismissedContentSignature !== d.contentSignature
          if (upgraded || audioChanged) {
            Object.assign(update, {
              status: Status.OPEN,
              statusReason: upgraded ? 'reopened_stronger_classification' : 'reopened_audio_changed',
              dismissedAt: null,
              dismissedByUserId: null,
              dismissedClassification: null,
              dismissedContentSignature: null
            })
            summary.findings.reopened++
          }
        }

        if (!changed && update.status === undefined) {
          unchangedIds.push(existing.id)
          summary.findings.unchanged++
          continue
        }
        await existing.update(update, { transaction })
        summary.findings.updated++
      }

      for (let i = 0; i < unchangedIds.length; i += 500) {
        await Database.duplicateFindingModel.update({ lastVerifiedAt: now }, { where: { id: unchangedIds.slice(i, i + 500) }, transaction })
      }

      for (let i = 0; i < toCreate.length; i += 200) {
        await Database.duplicateFindingModel.bulkCreate(toCreate.slice(i, i + 200), { transaction })
      }
      summary.findings.created = toCreate.length

      // Findings for pairs that no longer match (or whose items became missing) are removed.
      // Unverified pairs keep their finding until content can be checked again.
      const toRemove = existingFindings.filter((f) => {
        const key = `${f.libraryItemAId}|${f.libraryItemBId}`
        return !detected.has(key) && !unverifiedPairs.has(key)
      })
      for (let i = 0; i < toRemove.length; i += 500) {
        await Database.duplicateFindingModel.destroy({ where: { id: toRemove.slice(i, i + 500).map((f) => f.id) }, transaction })
      }
      summary.findings.removed = toRemove.length
    })
  }

  /**
   * Dismiss a finding as "not a duplicate"
   *
   * @param {import('../models/DuplicateFinding')} finding
   * @param {import('../models/User')} user
   */
  async dismissFinding(finding, user) {
    const Status = Database.duplicateFindingModel.Status
    await finding.update({
      status: Status.DISMISSED,
      statusReason: 'dismissed',
      dismissedAt: new Date(),
      dismissedByUserId: user.id,
      dismissedClassification: finding.classification,
      dismissedContentSignature: finding.contentSignature
    })
    return finding
  }

  /**
   * Reopen a dismissed finding
   *
   * @param {import('../models/DuplicateFinding')} finding
   */
  async reopenFinding(finding) {
    const Status = Database.duplicateFindingModel.Status
    await finding.update({
      status: Status.OPEN,
      statusReason: 'reopened_manually',
      dismissedAt: null,
      dismissedByUserId: null,
      dismissedClassification: null,
      dismissedContentSignature: null
    })
    return finding
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

module.exports = new DuplicateDetectionManager()
module.exports.DuplicateDetectionManager = DuplicateDetectionManager
module.exports.Classification = Classification
