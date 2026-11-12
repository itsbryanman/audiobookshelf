const { expect } = require('chai')
const { buildItemDescriptor } = require('../../../../server/utils/duplicateDetection/classify')
const { generateCandidatePairs, getBlockingKeys, orderPair } = require('../../../../server/utils/duplicateDetection/candidates')

function uniqueSize(id) {
  let h = 7
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 1000000007
  return 100000 + h
}

function descriptor(id, overrides = {}) {
  return buildItemDescriptor({
    id,
    title: `Unique Title ${id}`,
    authors: ['Author'],
    narrators: [],
    audioFiles: [{ path: `/${id}.m4b`, size: uniqueSize(id), duration: 100 }],
    ...overrides
  })
}

describe('duplicateDetection/candidates', () => {
  it('orders pair ids so the lower id comes first', () => {
    expect(orderPair('b', 'a')).to.deep.equal(['a', 'b'])
    expect(orderPair('a', 'b')).to.deep.equal(['a', 'b'])
  })

  it('builds blocking keys from title, identifiers and size signature', () => {
    const keys = getBlockingKeys(descriptor('x', { title: 'The Hobbit', asin: 'b00test001', isbn: '0-306-40615-2' }))
    expect(keys).to.include('t:hobbit')
    expect(keys).to.include('a:B00TEST001')
    expect(keys).to.include('i:9780306406157')
    expect(keys.some((k) => k.startsWith('s:1:'))).to.be.true
  })

  it('only pairs items that share a key', () => {
    const items = [descriptor('a', { title: 'Dune' }), descriptor('b', { title: 'Dune' }), descriptor('c', { title: 'Emma' }), descriptor('d', { title: 'Persuasion' })]
    const { pairs } = generateCandidatePairs(items)
    expect([...pairs.keys()]).to.deep.equal(['a|b'])
    expect([...pairs.get('a|b').keyTypes]).to.deep.equal(['t'])
  })

  it('pairs byte-identical candidates through the size signature even with unrelated metadata', () => {
    const files = [
      { path: '/x/1.mp3', size: 111, duration: 1 },
      { path: '/x/2.mp3', size: 222, duration: 1 }
    ]
    const items = [descriptor('a', { title: 'Foo', audioFiles: files }), descriptor('b', { title: 'Bar', audioFiles: files.map((f) => ({ ...f, path: f.path.replace('/x/', '/y/') })) })]
    const { pairs } = generateCandidatePairs(items)
    expect(pairs.get('a|b').keyTypes.has('s')).to.be.true
  })

  it('records every shared key type once per pair', () => {
    const items = [descriptor('a', { title: 'Dune', asin: 'B000000001' }), descriptor('b', { title: 'Dune', asin: 'B000000001' })]
    const { pairs } = generateCandidatePairs(items)
    expect(pairs.size).to.equal(1)
    expect([...pairs.get('a|b').keyTypes].sort()).to.deep.equal(['a', 't'])
  })

  it('skips oversized blocks instead of comparing them pairwise', () => {
    const items = Array.from({ length: 30 }, (_, i) => descriptor(`id${String(i).padStart(2, '0')}`, { title: 'Untitled' }))
    const result = generateCandidatePairs(items, { maxBlockSize: 10 })
    expect(result.pairs.size).to.equal(0)
    expect(result.oversizedBlocks).to.deep.equal([{ keyType: 't', size: 30 }])
  })

  it('scales with the number of look-alikes, not the library size', () => {
    const items = []
    for (let i = 0; i < 5000; i++) items.push(descriptor(`item${i}`))
    items.push(descriptor('dupA', { title: 'Twin' }), descriptor('dupB', { title: 'Twin' }))
    const result = generateCandidatePairs(items)
    expect(result.pairs.size).to.equal(1)
    expect(result.oversizedBlocks).to.deep.equal([])
  })
})
