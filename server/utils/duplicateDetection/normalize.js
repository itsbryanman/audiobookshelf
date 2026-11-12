/**
 * Deterministic normalization helpers used by duplicate detection.
 *
 * These functions are pure. They are intentionally conservative: they fold
 * differences that do not change meaning (case, accents, punctuation, spacing,
 * a leading article, bracketed release noise) but keep anything that can
 * distinguish two different books, such as numbers, volume and edition words.
 */

const DEFAULT_TITLE_PREFIXES = ['the', 'a', 'an']

// Bracketed groups made up only of these tokens are removed from titles.
// "abridged" is deliberately not in this list because it is meaningful.
const NOISE_TOKENS = new Set(['unabridged', 'audiobook', 'audio book', 'audiobooks', 'retail', 'mp3', 'm4b', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'audible', 'audible studios'])
const BITRATE_TOKEN = /^\d{2,3}\s?k(bps)?$/

/**
 * Fold a string to a comparable form: NFKD, strip combining marks, lowercase,
 * replace punctuation with spaces and collapse whitespace.
 *
 * @param {string} str
 * @returns {string}
 */
function foldText(str) {
  if (typeof str !== 'string') return ''
  return str
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '') // apostrophes join words: "Ender's" -> "enders"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Check whether a bracketed group only contains release noise
 *
 * @param {string} inner
 * @returns {boolean}
 */
function isNoiseGroup(inner) {
  const parts = inner
    .split(/[,;/|]/)
    .map((p) => foldText(p))
    .filter(Boolean)
  if (!parts.length) return true
  return parts.every((p) => NOISE_TOKENS.has(p) || BITRATE_TOKEN.test(p))
}

/**
 * Remove bracketed noise groups like "(Unabridged)", "[MP3]" or "{64k}" and a
 * trailing " - Audiobook" suffix. Bracketed groups with any other content
 * (e.g. "(Book 2)", "(Revised Edition)") are kept.
 *
 * @param {string} title
 * @returns {string}
 */
function stripTitleNoise(title) {
  if (typeof title !== 'string') return ''
  let result = title.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (match, inner) => (isNoiseGroup(inner) ? ' ' : match))
  result = result.replace(/\s+[-–—:]\s*(unabridged|audiobook|audio book)\s*$/i, '')
  return result.trim()
}

/**
 * Normalized title key used for matching
 *
 * @param {string} title
 * @param {string[]} [prefixes] leading articles to ignore
 * @returns {string}
 */
function normalizeTitle(title, prefixes = DEFAULT_TITLE_PREFIXES) {
  let folded = foldText(stripTitleNoise(title))
  if (!folded) return ''
  const foldedPrefixes = (prefixes || []).map((p) => foldText(p)).filter(Boolean)
  for (const prefix of foldedPrefixes) {
    // "The Hobbit" -> "hobbit"
    if (folded.startsWith(`${prefix} `) && folded.length > prefix.length + 1) {
      folded = folded.slice(prefix.length + 1)
      break
    }
    // "Hobbit, The" (already folded to "hobbit the") -> "hobbit"
    if (folded.endsWith(` ${prefix}`) && /,\s*\S+\s*$/.test(title.trim())) {
      folded = folded.slice(0, -(prefix.length + 1))
      break
    }
  }
  return folded
}

/**
 * Normalize a single person name. "Last, First" is reordered to "First Last"
 * and initials are separated so "J.R.R. Tolkien", "J. R. R. Tolkien" and
 * "Tolkien, J.R.R." all produce "j r r tolkien".
 *
 * @param {string} name
 * @returns {string}
 */
function normalizePersonName(name) {
  if (typeof name !== 'string') return ''
  let value = name.trim()
  if (!value) return ''
  const commaParts = value.split(',').map((p) => p.trim())
  // Only reorder a single "Last, First" form. Suffixes like "Jr." stay as they are.
  if (commaParts.length === 2 && commaParts[0] && commaParts[1] && !/^(jr|sr|ii|iii|iv|phd|md)\.?$/i.test(commaParts[1])) {
    value = `${commaParts[1]} ${commaParts[0]}`
  }
  // Separate glued initials "J.R.R." -> "J. R. R."
  value = value.replace(/\b(\p{L})\.(?=\p{L})/gu, '$1. ')
  return foldText(value)
}

/**
 * Looser person key: surname plus first initial, e.g. "tolkien j"
 *
 * @param {string} normalizedName output of normalizePersonName
 * @returns {string}
 */
function personSurnameInitialKey(normalizedName) {
  if (!normalizedName) return ''
  const parts = normalizedName.split(' ')
  if (parts.length < 2) return normalizedName
  return `${parts[parts.length - 1]} ${parts[0][0]}`
}

/**
 * Normalize a list of person names, dropping empties and duplicates
 *
 * @param {string[]} names
 * @returns {string[]} sorted unique normalized names
 */
function normalizePersonList(names) {
  if (!Array.isArray(names)) return []
  return [...new Set(names.map(normalizePersonName).filter(Boolean))].sort()
}

/**
 * Normalize an ISBN to ISBN-13 digits. ISBN-10 values are converted so both
 * forms of the same ISBN compare equal. Invalid values return ''.
 *
 * @param {string} isbn
 * @returns {string}
 */
function normalizeIsbn(isbn) {
  if (typeof isbn !== 'string' && typeof isbn !== 'number') return ''
  const cleaned = String(isbn)
    .toUpperCase()
    .replace(/[^0-9X]/g, '')
  if (/^\d{13}$/.test(cleaned)) return cleaned
  if (/^\d{9}[\dX]$/.test(cleaned)) {
    const core = `978${cleaned.slice(0, 9)}`
    let sum = 0
    for (let i = 0; i < 12; i++) {
      sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3)
    }
    const check = (10 - (sum % 10)) % 10
    return `${core}${check}`
  }
  return ''
}

/**
 * @param {string} asin
 * @returns {string}
 */
function normalizeAsin(asin) {
  if (typeof asin !== 'string') return ''
  const cleaned = asin.trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(cleaned) ? cleaned : ''
}

const LANGUAGE_ALIASES = {
  en: 'en',
  eng: 'en',
  english: 'en',
  de: 'de',
  deu: 'de',
  ger: 'de',
  german: 'de',
  deutsch: 'de',
  fr: 'fr',
  fra: 'fr',
  fre: 'fr',
  french: 'fr',
  francais: 'fr',
  es: 'es',
  spa: 'es',
  spanish: 'es',
  espanol: 'es',
  it: 'it',
  ita: 'it',
  italian: 'it',
  italiano: 'it',
  nl: 'nl',
  nld: 'nl',
  dut: 'nl',
  dutch: 'nl',
  nederlands: 'nl',
  pt: 'pt',
  por: 'pt',
  portuguese: 'pt',
  ru: 'ru',
  rus: 'ru',
  russian: 'ru',
  ja: 'ja',
  jpn: 'ja',
  japanese: 'ja',
  zh: 'zh',
  zho: 'zh',
  chi: 'zh',
  chinese: 'zh',
  pl: 'pl',
  pol: 'pl',
  polish: 'pl',
  sv: 'sv',
  swe: 'sv',
  swedish: 'sv'
}

/**
 * Normalize a language value. Region suffixes are dropped ("en-US" -> "en").
 *
 * @param {string} language
 * @returns {string}
 */
function normalizeLanguage(language) {
  const folded = foldText(language)
  if (!folded) return ''
  const base = folded.split(' ')[0]
  return LANGUAGE_ALIASES[folded] || LANGUAGE_ALIASES[base] || folded
}

/**
 * True when the title or subtitle explicitly says the recording is abridged
 *
 * @param {string} text
 * @returns {boolean}
 */
function textSaysAbridged(text) {
  // The letter check before "abridged" keeps "unabridged" from matching
  return /(^|[^\p{L}])abridged([^\p{L}]|$)/iu.test(text || '')
}

module.exports = {
  DEFAULT_TITLE_PREFIXES,
  foldText,
  stripTitleNoise,
  normalizeTitle,
  normalizePersonName,
  personSurnameInitialKey,
  normalizePersonList,
  normalizeIsbn,
  normalizeAsin,
  normalizeLanguage,
  textSaysAbridged
}
