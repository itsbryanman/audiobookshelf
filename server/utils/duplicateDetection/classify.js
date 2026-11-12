/**
 * Pure comparison and classification of two book library items.
 *
 * Classifications, strongest first:
 *  - "exact": every included audio file of one item has a byte-identical
 *    counterpart in the other (compared as a multiset of SHA-256 hashes).
 *  - "likely_same_recording": same work and the evidence says it is the same
 *    recording (same narrator or same ASIN, matching runtime) with nothing
 *    contradicting it.
 *  - "possible_duplicate": the bibliographic metadata overlaps strongly
 *    (title + author, or a shared identifier plus title or author) but the
 *    evidence is not enough to say the audio is the same recording.
 *  - "shared_files": both library item records point at the same physical
 *    audio files. This is a library record problem, not two copies of a book.
 *
 * Every result carries the evidence used so a reviewer can see what matched,
 * what did not and what was unknown.
 */

const crypto = require('crypto')
const { normalizeTitle, foldText, normalizePersonList, personSurnameInitialKey, normalizeIsbn, normalizeAsin, normalizeLanguage, textSaysAbridged } = require('./normalize')

const ALGORITHM_VERSION = 1

const Classification = {
  EXACT: 'exact',
  LIKELY_SAME_RECORDING: 'likely_same_recording',
  POSSIBLE_DUPLICATE: 'possible_duplicate',
  SHARED_FILES: 'shared_files'
}

/** Higher rank = stronger duplicate claim. Used for ordering and dismissal policy. */
const ClassificationRank = {
  [Classification.SHARED_FILES]: 0,
  [Classification.POSSIBLE_DUPLICATE]: 1,
  [Classification.LIKELY_SAME_RECORDING]: 2,
  [Classification.EXACT]: 3
}

/**
 * Runtime tolerances.
 *
 * Two encodes of the same recording rarely have identical durations. Sources
 * of drift: encoder delay and padding (tens of ms per file), per-file padding
 * when a book is split into many MP3s, container rounding, and retailer
 * intro/outro clips (Audible adds roughly 5-10 seconds at each end).
 *
 *  - same recording: |a - b| <= 15s + 0.5s per file of the larger file count + 0.1% of the longer runtime
 *    (10 h single file ~ 51 s; 10 h in 50 files ~ 76 s)
 *  - comparable runtime: |a - b| <= 60s + 2% of the longer runtime. Beyond this
 *    the recordings differ materially (abridged, revised, different reading).
 */
const DurationTolerance = {
  sameRecordingBaseSeconds: 15,
  sameRecordingPerFileSeconds: 0.5,
  sameRecordingRatio: 0.001,
  comparableBaseSeconds: 60,
  comparableRatio: 0.02
}

/**
 * @typedef RawAudioFile
 * @property {string} path
 * @property {number} size
 * @property {number} [mtimeMs]
 * @property {string} [ino]
 * @property {number} [duration]
 * @property {string} [codec]
 * @property {string} [format]
 * @property {number} [bitRate]
 * @property {string} [ext]
 *
 * @typedef RawItem
 * @property {string} id
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string[]} [authors]
 * @property {string[]} [narrators]
 * @property {{name:string, sequence:string|null}[]} [series]
 * @property {string} [asin]
 * @property {string} [isbn]
 * @property {string} [language]
 * @property {boolean} [abridged]
 * @property {string} [publishedYear]
 * @property {RawAudioFile[]} audioFiles included audio files only
 *
 * @typedef ItemDescriptor
 * @property {string} id
 * @property {string} title
 * @property {string} titleKey
 * @property {string} subtitleKey
 * @property {string[]} authorKeys
 * @property {string[]} authorLooseKeys
 * @property {string[]} narratorKeys
 * @property {string[]} narratorLooseKeys
 * @property {Record<string,string>} seriesSequences normalized series name -> folded sequence ('' when unknown)
 * @property {string} asin
 * @property {string} isbn
 * @property {string} language
 * @property {boolean} abridged
 * @property {string} publishedYear
 * @property {number} duration sum of file durations (after removing duplicate records)
 * @property {RawAudioFile[]} files included audio files, one per path
 * @property {number} duplicateFileRecords number of extra records pointing at an already listed path
 * @property {string} sizeSignature sorted file sizes; equal for byte-identical file sets
 * @property {string} contentSignature hash over file sizes and durations; changes when audio changes
 * @property {string[]} formats
 */

/**
 * Build the comparison descriptor for an item
 *
 * @param {RawItem} raw
 * @param {{titlePrefixes?:string[]}} [options]
 * @returns {ItemDescriptor}
 */
function buildItemDescriptor(raw, options = {}) {
  const seen = new Set()
  const files = []
  let duplicateFileRecords = 0
  for (const file of raw.audioFiles || []) {
    if (!file?.path) continue
    if (seen.has(file.path)) {
      duplicateFileRecords++
      continue
    }
    seen.add(file.path)
    files.push(file)
  }

  const sizes = files.map((f) => Number(f.size) || 0).sort((a, b) => a - b)
  const duration = files.reduce((total, f) => total + (Number(f.duration) > 0 ? Number(f.duration) : 0), 0)

  const authorKeys = normalizePersonList(raw.authors)
  const narratorKeys = normalizePersonList(raw.narrators)

  const seriesSequences = {}
  for (const series of raw.series || []) {
    const key = foldText(series?.name)
    if (key) seriesSequences[key] = foldText(series.sequence || '')
  }

  const contentHash = crypto.createHash('sha1')
  const durationsBySize = files.map((f) => `${Number(f.size) || 0}:${Math.round(Number(f.duration) || 0)}`).sort()
  contentHash.update(durationsBySize.join('|'))

  return {
    id: raw.id,
    title: raw.title || '',
    titleKey: normalizeTitle(raw.title, options.titlePrefixes),
    subtitleKey: foldText(raw.subtitle),
    authorKeys,
    authorLooseKeys: [...new Set(authorKeys.map(personSurnameInitialKey))],
    narratorKeys,
    narratorLooseKeys: [...new Set(narratorKeys.map(personSurnameInitialKey))],
    seriesSequences,
    asin: normalizeAsin(raw.asin),
    isbn: normalizeIsbn(raw.isbn),
    language: normalizeLanguage(raw.language),
    abridged: raw.abridged === true || textSaysAbridged(raw.title) || textSaysAbridged(raw.subtitle),
    publishedYear: String(raw.publishedYear || '').trim(),
    duration,
    files,
    duplicateFileRecords,
    sizeSignature: files.length ? `${files.length}:${sizes.join(',')}` : '',
    contentSignature: files.length ? contentHash.digest('hex') : '',
    formats: [...new Set(files.map((f) => (f.ext || '').replace(/^\./, '').toLowerCase()).filter(Boolean))].sort()
  }
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function intersects(a, b) {
  if (!a.length || !b.length) return false
  const set = new Set(a)
  return b.some((v) => set.has(v))
}

/**
 * Compare two people lists
 *
 * @returns {'match'|'partial'|'mismatch'|'unknown'}
 */
function comparePeople(keysA, looseA, keysB, looseB) {
  if (!keysA.length || !keysB.length) return 'unknown'
  if (intersects(keysA, keysB)) return 'match'
  if (intersects(looseA, looseB)) return 'partial'
  return 'mismatch'
}

/**
 * @param {ItemDescriptor} a
 * @param {ItemDescriptor} b
 */
function getDurationTolerances(a, b) {
  const longest = Math.max(a.duration, b.duration)
  const maxFiles = Math.max(a.files.length, b.files.length)
  return {
    sameRecording: DurationTolerance.sameRecordingBaseSeconds + DurationTolerance.sameRecordingPerFileSeconds * maxFiles + DurationTolerance.sameRecordingRatio * longest,
    comparable: DurationTolerance.comparableBaseSeconds + DurationTolerance.comparableRatio * longest
  }
}

/**
 * @typedef HashComparison
 * @property {'identical'|'different'|'unavailable'|'not_checked'} status
 * @property {number} [sharedPhysicalFiles] number of files both items point at
 * @property {string} [reason] why hashes are unavailable
 *
 * @typedef Evidence
 * @property {string} key
 * @property {'match'|'partial'|'mismatch'|'unknown'|'info'} outcome
 * @property {Object} [details]
 *
 * @typedef ComparisonResult
 * @property {string|null} classification null when the pair is not a duplicate candidate
 * @property {Evidence[]} evidence
 * @property {string[]} limitations evidence keys that capped the classification
 */

/**
 * Compare two item descriptors and classify the pair
 *
 * @param {ItemDescriptor} a
 * @param {ItemDescriptor} b
 * @param {HashComparison} [hashComparison]
 * @returns {ComparisonResult}
 */
function compareItems(a, b, hashComparison = { status: 'not_checked' }) {
  /** @type {Evidence[]} */
  const evidence = []
  const limitations = []
  const add = (key, outcome, details) => evidence.push(details === undefined ? { key, outcome } : { key, outcome, details })

  // --- Physical file identity
  const sharedPhysicalFiles = hashComparison.sharedPhysicalFiles || 0
  if (sharedPhysicalFiles > 0) {
    add('shared_files', 'info', { count: sharedPhysicalFiles, filesA: a.files.length, filesB: b.files.length })
  }
  if (a.duplicateFileRecords || b.duplicateFileRecords) {
    add('duplicate_file_records', 'info', { itemA: a.duplicateFileRecords, itemB: b.duplicateFileRecords })
  }

  // --- Content hashes
  if (hashComparison.status === 'identical') add('content_hash', 'match', { files: a.files.length })
  else if (hashComparison.status === 'different') add('content_hash', 'mismatch')
  else if (hashComparison.status === 'unavailable') add('content_hash', 'unknown', { reason: hashComparison.reason || 'unavailable' })

  // --- Identifiers
  const asin = a.asin && b.asin ? (a.asin === b.asin ? 'match' : 'mismatch') : 'unknown'
  add('asin', asin)
  const isbn = a.isbn && b.isbn ? (a.isbn === b.isbn ? 'match' : 'mismatch') : 'unknown'
  add('isbn', isbn)

  // --- Bibliographic
  const title = a.titleKey && b.titleKey ? (a.titleKey === b.titleKey ? 'match' : 'mismatch') : 'unknown'
  add('title', title)

  let subtitle = 'unknown'
  if (a.subtitleKey && b.subtitleKey) subtitle = a.subtitleKey === b.subtitleKey ? 'match' : 'mismatch'
  if (subtitle !== 'unknown') add('subtitle', subtitle)

  const authors = comparePeople(a.authorKeys, a.authorLooseKeys, b.authorKeys, b.authorLooseKeys)
  add('authors', authors)
  const authorOverlap = authors === 'match' || authors === 'partial'

  // Same series with a different sequence means a different book
  let seriesSequence = 'unknown'
  for (const seriesKey of Object.keys(a.seriesSequences)) {
    if (!(seriesKey in b.seriesSequences)) continue
    const seqA = a.seriesSequences[seriesKey]
    const seqB = b.seriesSequences[seriesKey]
    if (!seqA || !seqB) continue
    seriesSequence = seqA === seqB ? 'match' : 'mismatch'
    if (seriesSequence === 'mismatch') break
  }
  if (seriesSequence !== 'unknown') add('series_sequence', seriesSequence)

  // --- Recording
  const narrators = comparePeople(a.narratorKeys, a.narratorLooseKeys, b.narratorKeys, b.narratorLooseKeys)
  add('narrators', narrators)

  const abridged = a.abridged === b.abridged ? 'match' : 'mismatch'
  add('abridged', abridged, { itemA: a.abridged, itemB: b.abridged })

  const language = a.language && b.language ? (a.language === b.language ? 'match' : 'mismatch') : 'unknown'
  add('language', language)

  let durationOutcome = 'unknown'
  let durationClass = 'unknown'
  if (a.duration > 0 && b.duration > 0) {
    const difference = Math.abs(a.duration - b.duration)
    const tolerances = getDurationTolerances(a, b)
    if (difference <= tolerances.sameRecording) durationClass = 'same'
    else if (difference <= tolerances.comparable) durationClass = 'comparable'
    else durationClass = 'different'
    durationOutcome = durationClass === 'same' ? 'match' : durationClass === 'comparable' ? 'partial' : 'mismatch'
    add('duration', durationOutcome, {
      itemA: round(a.duration),
      itemB: round(b.duration),
      difference: round(difference),
      sameRecordingTolerance: round(tolerances.sameRecording)
    })
  } else {
    add('duration', 'unknown')
  }

  if (a.publishedYear && b.publishedYear) {
    add('published_year', a.publishedYear === b.publishedYear ? 'match' : 'mismatch', { itemA: a.publishedYear, itemB: b.publishedYear })
  }

  add('files', 'info', { itemA: a.files.length, itemB: b.files.length, formatsA: a.formats, formatsB: b.formats })

  // --- Classification
  const allFilesShared = sharedPhysicalFiles > 0 && sharedPhysicalFiles >= Math.max(a.files.length, b.files.length)
  if (allFilesShared) {
    return { classification: Classification.SHARED_FILES, evidence, limitations }
  }

  if (hashComparison.status === 'identical') {
    return { classification: Classification.EXACT, evidence, limitations }
  }

  // Not the same work: different subtitle (when both set) or different position in the same series.
  // A shared identifier can still bring the pair back as a possible duplicate (likely a metadata mistake).
  const identifierMatch = asin === 'match' || isbn === 'match'
  const differentWork = subtitle === 'mismatch' || seriesSequence === 'mismatch'

  const qualifies = (title === 'match' && authorOverlap && !differentWork) || (identifierMatch && (title === 'match' || authorOverlap))
  if (!qualifies) {
    return { classification: null, evidence, limitations }
  }

  // Requirements for "same recording"
  const recordingIdentity = narrators === 'match' || asin === 'match'
  if (durationClass !== 'same') limitations.push('duration')
  if (!recordingIdentity) limitations.push(narrators === 'mismatch' ? 'narrators' : 'recording_identity')
  if (narrators === 'mismatch' && !limitations.includes('narrators')) limitations.push('narrators')
  if (abridged === 'mismatch') limitations.push('abridged')
  if (language === 'mismatch') limitations.push('language')
  if (asin === 'mismatch') limitations.push('asin')
  if (isbn === 'mismatch') limitations.push('isbn')
  if (title !== 'match') limitations.push('title')
  if (!authorOverlap) limitations.push('authors')
  if (differentWork) limitations.push(subtitle === 'mismatch' ? 'subtitle' : 'series_sequence')

  if (!limitations.length) {
    return { classification: Classification.LIKELY_SAME_RECORDING, evidence, limitations }
  }
  return { classification: Classification.POSSIBLE_DUPLICATE, evidence, limitations }
}

function round(n) {
  return Math.round(n * 10) / 10
}

module.exports = {
  ALGORITHM_VERSION,
  Classification,
  ClassificationRank,
  DurationTolerance,
  buildItemDescriptor,
  compareItems,
  getDurationTolerances
}
