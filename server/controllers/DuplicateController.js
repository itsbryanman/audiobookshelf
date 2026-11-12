const { Request, Response, NextFunction } = require('express')
const { Op, literal } = require('sequelize')
const Logger = require('../Logger')
const Database = require('../Database')
const DuplicateDetectionManager = require('../managers/DuplicateDetectionManager')
const { Classification, ClassificationRank } = require('../utils/duplicateDetection/classify')
const { isUUID } = require('../utils/index')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/Library')} library
 * @property {import('../models/DuplicateFinding')} [duplicateFinding]
 *
 * @typedef {RequestWithUser & RequestEntityObject} DuplicateControllerRequest
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const STATUS_VALUES = ['open', 'dismissed', 'all']

// Strongest classification first, then oldest finding first, then id for a stable order
const ORDER_BY_RANK = literal(
  `CASE classification ${Object.entries(ClassificationRank)
    .map(([classification, rank]) => `WHEN '${classification}' THEN ${rank}`)
    .join(' ')} ELSE -1 END`
)
const FINDING_ORDER = [
  [ORDER_BY_RANK, 'DESC'],
  ['firstDetectedAt', 'ASC'],
  ['id', 'ASC']
]

/**
 * Item details shown next to a finding. Restricted to admins by the controller middleware.
 *
 * @param {import('../models/LibraryItem')} libraryItem expanded
 * @param {boolean} [includeFiles]
 */
function toItemSummary(libraryItem, includeFiles = false) {
  const book = libraryItem.media
  const audioFiles = (book.audioFiles || []).filter((af) => !af.exclude)
  const summary = {
    id: libraryItem.id,
    title: book.title,
    subtitle: book.subtitle,
    authorName: book.authors?.map((a) => a.name).join(', ') || '',
    narrators: book.narrators || [],
    series: (book.series || []).map((s) => ({ id: s.id, name: s.name, sequence: s.bookSeries?.sequence || null })),
    publishedYear: book.publishedYear,
    asin: book.asin,
    isbn: book.isbn,
    language: book.language,
    abridged: !!book.abridged,
    duration: book.duration,
    size: Number(libraryItem.size) || 0,
    audioFilesSize: audioFiles.reduce((total, af) => total + (Number(af.metadata?.size) || 0), 0),
    numAudioFiles: audioFiles.length,
    formats: [...new Set(audioFiles.map((af) => (af.metadata?.ext || '').replace(/^\./, '').toLowerCase()).filter(Boolean))],
    codecs: [...new Set(audioFiles.map((af) => af.codec).filter(Boolean))],
    hasCover: !!book.coverPath,
    path: libraryItem.path,
    relPath: libraryItem.relPath,
    isMissing: !!libraryItem.isMissing,
    isInvalid: !!libraryItem.isInvalid,
    addedAt: libraryItem.createdAt?.valueOf()
  }
  if (includeFiles) {
    summary.audioFiles = audioFiles.map((af) => ({
      ino: af.ino,
      relPath: af.metadata?.relPath,
      size: Number(af.metadata?.size) || 0,
      duration: af.duration,
      format: af.format,
      codec: af.codec,
      bitRate: af.bitRate,
      channels: af.channels
    }))
  }
  return summary
}

/**
 * @param {import('../models/DuplicateFinding')} finding
 * @param {Map<string, import('../models/LibraryItem')>} itemsById
 * @param {boolean} [includeFiles]
 */
function toFindingJSON(finding, itemsById, includeFiles = false) {
  const itemA = itemsById.get(finding.libraryItemAId)
  const itemB = itemsById.get(finding.libraryItemBId)
  return {
    id: finding.id,
    libraryId: finding.libraryId,
    classification: finding.classification,
    status: finding.status,
    statusReason: finding.statusReason,
    evidence: finding.evidence || [],
    limitations: finding.limitations || [],
    algorithmVersion: finding.algorithmVersion,
    firstDetectedAt: finding.firstDetectedAt?.valueOf() || null,
    lastVerifiedAt: finding.lastVerifiedAt?.valueOf() || null,
    dismissedAt: finding.dismissedAt?.valueOf() || null,
    dismissedByUserId: finding.dismissedByUserId || null,
    libraryItemAId: finding.libraryItemAId,
    libraryItemBId: finding.libraryItemBId,
    libraryItemA: itemA ? toItemSummary(itemA, includeFiles) : null,
    libraryItemB: itemB ? toItemSummary(itemB, includeFiles) : null
  }
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, import('../models/LibraryItem')>>}
 */
async function loadExpandedItems(ids) {
  if (!ids.length) return new Map()
  const items = await Database.libraryItemModel.findAllExpandedWhere({ id: [...new Set(ids)] })
  return new Map(items.map((item) => [item.id, item]))
}

/**
 * @param {import('../models/User')} user
 * @returns {boolean} true if the user has tag or explicit content restrictions
 */
function userHasContentRestrictions(user) {
  return !user.permissions?.accessAllTags || !user.canAccessExplicitContent
}

class DuplicateController {
  constructor() {}

  /**
   * Parse and validate list filters from the query string
   *
   * @param {import('express').Request['query']} query
   * @returns {{error?:string, where?:Object, limit?:number, page?:number}}
   */
  parseListQuery(query) {
    const status = query.status || 'open'
    if (!STATUS_VALUES.includes(status)) {
      return { error: `Invalid status. Expected one of ${STATUS_VALUES.join(', ')}` }
    }

    let classifications = null
    if (query.classification) {
      classifications = String(query.classification)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
      const valid = Object.values(Classification)
      if (!classifications.length || classifications.some((c) => !valid.includes(c))) {
        return { error: `Invalid classification. Expected a comma separated list of ${valid.join(', ')}` }
      }
    }

    // LibraryController.middleware already converted limit/page to non-negative integers
    const limit = query.limit === undefined ? DEFAULT_LIMIT : Math.min(Number(query.limit) || DEFAULT_LIMIT, MAX_LIMIT)
    const page = query.page === undefined ? 0 : Number(query.page) || 0

    const where = {}
    if (status !== 'all') where.status = status
    if (classifications) where.classification = { [Op.in]: classifications }
    return { where, limit, page }
  }

  /**
   * GET: /api/libraries/:id/duplicates
   * List duplicate findings for a library.
   *
   * Query: status=open|dismissed|all (default open), classification=exact,likely_same_recording,...,
   * limit (default 50, max 500), page (0 based)
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async findAll(req, res) {
    const parsed = this.parseListQuery(req.query)
    if (parsed.error) return res.status(400).send(parsed.error)
    const { limit, page } = parsed
    const where = { ...parsed.where, libraryId: req.library.id }

    let total
    let pageFindings
    if (!userHasContentRestrictions(req.user)) {
      const result = await Database.duplicateFindingModel.findAndCountAll({ where, order: FINDING_ORDER, limit, offset: page * limit })
      total = result.count
      pageFindings = result.rows
    } else {
      // Drop findings with an item this user cannot access, then paginate
      const all = await Database.duplicateFindingModel.findAll({ where, order: FINDING_ORDER, attributes: ['id', 'libraryItemAId', 'libraryItemBId'] })
      const itemsById = await loadExpandedItems(all.flatMap((f) => [f.libraryItemAId, f.libraryItemBId]))
      const accessible = all.filter((f) => {
        const a = itemsById.get(f.libraryItemAId)
        const b = itemsById.get(f.libraryItemBId)
        return a && b && req.user.checkCanAccessLibraryItem(a) && req.user.checkCanAccessLibraryItem(b)
      })
      total = accessible.length
      const pageIds = accessible.slice(page * limit, page * limit + limit).map((f) => f.id)
      pageFindings = pageIds.length ? await Database.duplicateFindingModel.findAll({ where: { id: pageIds }, order: FINDING_ORDER }) : []
    }

    const itemsById = await loadExpandedItems(pageFindings.flatMap((f) => [f.libraryItemAId, f.libraryItemBId]))
    const counts = await this.getCounts(req.library.id)

    res.json({
      findings: pageFindings.map((f) => toFindingJSON(f, itemsById)),
      total,
      limit,
      page,
      counts
    })
  }

  /**
   * Finding counts per status and classification
   *
   * @param {string} libraryId
   */
  async getCounts(libraryId) {
    const rows = await Database.duplicateFindingModel.findAll({
      attributes: ['status', 'classification', [literal('COUNT(*)'), 'count']],
      where: { libraryId },
      group: ['status', 'classification'],
      raw: true
    })
    const counts = { open: {}, dismissed: {} }
    for (const row of rows) {
      if (!counts[row.status]) counts[row.status] = {}
      counts[row.status][row.classification] = Number(row.count)
    }
    return counts
  }

  /**
   * GET: /api/libraries/:id/duplicates/:findingId
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async findOne(req, res) {
    const itemsById = await loadExpandedItems([req.duplicateFinding.libraryItemAId, req.duplicateFinding.libraryItemBId])
    res.json(toFindingJSON(req.duplicateFinding, itemsById, true))
  }

  /**
   * POST: /api/libraries/:id/duplicates/:findingId/dismiss
   * Mark a finding as "not a duplicate". It stays dismissed on later runs unless
   * the classification gets stronger or either item's audio changes.
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async dismiss(req, res) {
    const finding = await DuplicateDetectionManager.dismissFinding(req.duplicateFinding, req.user)
    Logger.info(`[DuplicateController] User "${req.user.username}" dismissed duplicate finding "${finding.id}"`)
    const itemsById = await loadExpandedItems([finding.libraryItemAId, finding.libraryItemBId])
    res.json(toFindingJSON(finding, itemsById))
  }

  /**
   * POST: /api/libraries/:id/duplicates/:findingId/reopen
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async reopen(req, res) {
    const finding = await DuplicateDetectionManager.reopenFinding(req.duplicateFinding)
    Logger.info(`[DuplicateController] User "${req.user.username}" reopened duplicate finding "${finding.id}"`)
    const itemsById = await loadExpandedItems([finding.libraryItemAId, finding.libraryItemBId])
    res.json(toFindingJSON(finding, itemsById))
  }

  /**
   * GET: /api/libraries/:id/duplicates/audit
   * Status of the current or last duplicate detection run
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async getAuditStatus(req, res) {
    res.json(DuplicateDetectionManager.getStatus(req.library.id))
  }

  /**
   * POST: /api/libraries/:id/duplicates/audit
   * Start a duplicate detection run. Body: { mode: 'full' | 'incremental' } (default full).
   * A full audit re-checks every candidate file on disk; incremental reuses cached
   * hashes for files whose recorded size and mtime have not changed.
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async startAudit(req, res) {
    const mode = req.body?.mode || 'full'
    if (!['full', 'incremental'].includes(mode)) {
      return res.status(400).send('Invalid mode. Expected full or incremental')
    }
    const { status } = await DuplicateDetectionManager.requestRun(req.library.id, mode, 'manual')
    Logger.info(`[DuplicateController] User "${req.user.username}" requested a ${mode} duplicate audit for library "${req.library.name}" (${status})`)
    res.json({ status, ...DuplicateDetectionManager.getStatus(req.library.id) })
  }

  /**
   * POST: /api/libraries/:id/duplicates/audit/cancel
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   */
  async cancelAudit(req, res) {
    const canceled = DuplicateDetectionManager.cancel(req.library.id)
    res.json({ canceled })
  }

  /**
   * Runs after LibraryController.middleware (library access check).
   * Duplicate review is limited to admins and book libraries.
   *
   * @param {DuplicateControllerRequest} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    if (!req.user.isAdminOrUp) {
      Logger.warn(`[DuplicateController] Non-admin user "${req.user.username}" attempted to access duplicate findings`)
      return res.sendStatus(403)
    }
    if (!req.library.isBook) {
      return res.status(400).send('Duplicate detection is only available for book libraries')
    }

    if (req.params.findingId !== undefined) {
      if (!isUUID(req.params.findingId)) {
        return res.status(400).send('Invalid finding id')
      }
      const finding = await Database.duplicateFindingModel.findOne({
        where: { id: req.params.findingId, libraryId: req.library.id }
      })
      if (!finding) return res.sendStatus(404)

      if (userHasContentRestrictions(req.user)) {
        const itemsById = await loadExpandedItems([finding.libraryItemAId, finding.libraryItemBId])
        const items = [itemsById.get(finding.libraryItemAId), itemsById.get(finding.libraryItemBId)]
        if (items.some((item) => !item || !req.user.checkCanAccessLibraryItem(item))) {
          return res.sendStatus(403)
        }
      }
      req.duplicateFinding = finding
    }
    next()
  }
}
module.exports = new DuplicateController()
