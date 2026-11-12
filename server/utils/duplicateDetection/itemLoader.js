/**
 * Database reads for duplicate detection.
 *
 * Items are loaded in pages ordered by id. Only the audio file fields that
 * detection needs are pulled out with SQLite JSON functions, so the large
 * audioFiles JSON (chapters, meta tags) never reaches JavaScript.
 */

const { Op, literal } = require('sequelize')
const Database = require('../../Database')

const DEFAULT_PAGE_SIZE = 500

/**
 * @param {string|null} value
 * @returns {any[]}
 */
function parseJsonArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Ids of book items in a library that are not missing or invalid
 *
 * @param {string} libraryId
 * @returns {Promise<string[]>}
 */
async function loadEligibleItemIds(libraryId) {
  const [rows] = await Database.sequelize.query(
    `SELECT li.id FROM libraryItems li
    WHERE li.libraryId = :libraryId AND li.mediaType = 'book' AND COALESCE(li.isMissing, 0) = 0 AND COALESCE(li.isInvalid, 0) = 0
    ORDER BY li.id ASC`,
    { replacements: { libraryId } }
  )
  return rows.map((r) => r.id)
}

/**
 * Load book items by id
 *
 * @param {string[]} itemIds
 * @returns {Promise<import('./classify').RawItem[]>}
 */
async function loadItemPage(itemIds) {
  if (!itemIds.length) return []
  const [rows] = await Database.sequelize.query(
    `SELECT li.id, li.createdAt, b.id AS bookId, b.title, b.subtitle, b.asin, b.isbn, b.language, b.abridged, b.publishedYear, b.narrators,
      (SELECT json_group_array(json_object(
          'path', json_extract(af.value, '$.metadata.path'),
          'size', json_extract(af.value, '$.metadata.size'),
          'mtimeMs', json_extract(af.value, '$.metadata.mtimeMs'),
          'ino', json_extract(af.value, '$.ino'),
          'duration', json_extract(af.value, '$.duration'),
          'ext', json_extract(af.value, '$.metadata.ext'),
          'codec', json_extract(af.value, '$.codec'),
          'bitRate', json_extract(af.value, '$.bitRate')))
        FROM json_each(b.audioFiles) af
        WHERE json_valid(af.value) AND COALESCE(json_extract(af.value, '$.exclude'), 0) = 0) AS audioFiles
    FROM libraryItems li
    INNER JOIN books b ON b.id = li.mediaId
    WHERE li.id IN (:itemIds) AND li.mediaType = 'book'
    ORDER BY li.id ASC`,
    { replacements: { itemIds } }
  )
  if (!rows.length) return []

  const bookIds = rows.map((r) => r.bookId)
  const [authorRows] = await Database.sequelize.query(`SELECT ba.bookId, a.name FROM bookAuthors ba INNER JOIN authors a ON a.id = ba.authorId WHERE ba.bookId IN (:bookIds) ORDER BY ba.createdAt ASC`, { replacements: { bookIds } })
  const [seriesRows] = await Database.sequelize.query(`SELECT bs.bookId, s.name, bs.sequence FROM bookSeries bs INNER JOIN series s ON s.id = bs.seriesId WHERE bs.bookId IN (:bookIds)`, {
    replacements: { bookIds }
  })

  const authorsByBook = new Map()
  for (const row of authorRows) {
    if (!authorsByBook.has(row.bookId)) authorsByBook.set(row.bookId, [])
    authorsByBook.get(row.bookId).push(row.name)
  }
  const seriesByBook = new Map()
  for (const row of seriesRows) {
    if (!seriesByBook.has(row.bookId)) seriesByBook.set(row.bookId, [])
    seriesByBook.get(row.bookId).push({ name: row.name, sequence: row.sequence })
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    asin: row.asin,
    isbn: row.isbn,
    language: row.language,
    abridged: row.abridged === true || row.abridged === 1,
    publishedYear: row.publishedYear,
    narrators: parseJsonArray(row.narrators).filter((n) => typeof n === 'string'),
    authors: authorsByBook.get(row.bookId) || [],
    series: seriesByBook.get(row.bookId) || [],
    audioFiles: parseJsonArray(row.audioFiles)
      .filter((af) => af && typeof af.path === 'string')
      .map((af) => ({
        path: af.path,
        size: Number(af.size) || 0,
        mtimeMs: af.mtimeMs === null || af.mtimeMs === undefined ? null : Number(af.mtimeMs),
        ino: af.ino === null || af.ino === undefined ? null : String(af.ino),
        duration: Number(af.duration) || 0,
        ext: af.ext || '',
        codec: af.codec || null,
        bitRate: Number(af.bitRate) || null
      }))
  }))
}

/**
 * Iterate over all eligible book items in a library in pages
 *
 * @param {string} libraryId
 * @param {{pageSize?:number, signal?:AbortSignal}} [options]
 * @returns {AsyncGenerator<import('./classify').RawItem[]>}
 */
async function* iterateLibraryItems(libraryId, options = {}) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE
  // Ids are read once up front. Paging with "id > lastId" made SQLite sort
  // the whole library for every page (quadratic on large libraries).
  const itemIds = await loadEligibleItemIds(libraryId)
  for (let i = 0; i < itemIds.length; i += pageSize) {
    if (options.signal?.aborted) return
    const page = await loadItemPage(itemIds.slice(i, i + pageSize))
    if (page.length) yield page
  }
}

/**
 * Remove cached hashes for files in this library that no longer belong to
 * any of its book items
 *
 * @param {string} libraryId
 * @returns {Promise<number>} rows removed
 */
async function pruneFileHashCache(libraryId) {
  const escapedLibraryId = Database.sequelize.escape(libraryId)
  return Database.fileHashModel.destroy({
    where: {
      libraryId,
      [Op.and]: literal(
        `path NOT IN (
          SELECT json_extract(af.value, '$.metadata.path')
          FROM libraryItems li
          INNER JOIN books b ON b.id = li.mediaId, json_each(b.audioFiles) af
          WHERE li.libraryId = ${escapedLibraryId} AND li.mediaType = 'book' AND json_valid(af.value) AND json_extract(af.value, '$.metadata.path') IS NOT NULL
        )`
      )
    }
  })
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  loadEligibleItemIds,
  loadItemPage,
  iterateLibraryItems,
  pruneFileHashCache
}
