/**
 * Candidate pair generation by blocking.
 *
 * Items are only compared when they share at least one blocking key, so the
 * work grows with the number of real look-alikes instead of with N^2.
 *
 * Keys:
 *  - "t:<title key>"  normalized title
 *  - "a:<asin>"       ASIN
 *  - "i:<isbn13>"     ISBN
 *  - "s:<sizes>"      sorted audio file sizes. Byte-identical file sets always
 *                     share this key, even when their metadata has nothing in common.
 *
 * A block larger than maxBlockSize (e.g. hundreds of books titled "Untitled")
 * is skipped and reported instead of being compared pairwise.
 */

const DEFAULT_MAX_BLOCK_SIZE = 250

/**
 * @param {import('./classify').ItemDescriptor} descriptor
 * @returns {string[]}
 */
function getBlockingKeys(descriptor) {
  const keys = []
  if (descriptor.titleKey) keys.push(`t:${descriptor.titleKey}`)
  if (descriptor.asin) keys.push(`a:${descriptor.asin}`)
  if (descriptor.isbn) keys.push(`i:${descriptor.isbn}`)
  if (descriptor.sizeSignature) keys.push(`s:${descriptor.sizeSignature}`)
  return keys
}

/**
 * Build a stable pair key with the lower id first
 *
 * @param {string} idA
 * @param {string} idB
 * @returns {[string, string]}
 */
function orderPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA]
}

/**
 * @typedef CandidatePair
 * @property {string} itemAId lower id
 * @property {string} itemBId higher id
 * @property {Set<string>} keyTypes block key types the pair shares ('t','a','i','s')
 *
 * @typedef CandidateResult
 * @property {Map<string, CandidatePair>} pairs keyed by "idA|idB"
 * @property {number} blocks number of blocks with 2+ items
 * @property {{keyType:string, size:number}[]} oversizedBlocks blocks skipped for size
 */

/**
 * @param {import('./classify').ItemDescriptor[]} descriptors
 * @param {{maxBlockSize?:number}} [options]
 * @returns {CandidateResult}
 */
function generateCandidatePairs(descriptors, options = {}) {
  const maxBlockSize = options.maxBlockSize || DEFAULT_MAX_BLOCK_SIZE

  /** @type {Map<string, string[]>} */
  const blocks = new Map()
  for (const descriptor of descriptors) {
    for (const key of getBlockingKeys(descriptor)) {
      const block = blocks.get(key)
      if (block) block.push(descriptor.id)
      else blocks.set(key, [descriptor.id])
    }
  }

  /** @type {Map<string, CandidatePair>} */
  const pairs = new Map()
  let blockCount = 0
  const oversizedBlocks = []
  for (const [key, ids] of blocks) {
    if (ids.length < 2) continue
    const keyType = key[0]
    if (ids.length > maxBlockSize) {
      oversizedBlocks.push({ keyType, size: ids.length })
      continue
    }
    blockCount++
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (ids[i] === ids[j]) continue
        const [itemAId, itemBId] = orderPair(ids[i], ids[j])
        const pairKey = `${itemAId}|${itemBId}`
        const existing = pairs.get(pairKey)
        if (existing) existing.keyTypes.add(keyType)
        else pairs.set(pairKey, { itemAId, itemBId, keyTypes: new Set([keyType]) })
      }
    }
  }

  return { pairs, blocks: blockCount, oversizedBlocks }
}

module.exports = {
  DEFAULT_MAX_BLOCK_SIZE,
  getBlockingKeys,
  orderPair,
  generateCandidatePairs
}
