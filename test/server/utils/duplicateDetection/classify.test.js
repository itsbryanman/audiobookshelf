const { expect } = require('chai')
const { buildItemDescriptor, compareItems, Classification, getDurationTolerances } = require('../../../../server/utils/duplicateDetection/classify')

const HOUR = 3600

/**
 * @param {Object} overrides
 * @returns {import('../../../../server/utils/duplicateDetection/classify').RawItem}
 */
function rawItem(overrides = {}) {
  return {
    id: overrides.id || 'item',
    title: 'The Way of Kings',
    subtitle: null,
    authors: ['Brandon Sanderson'],
    narrators: ['Michael Kramer', 'Kate Reading'],
    series: [],
    asin: null,
    isbn: null,
    language: 'English',
    abridged: false,
    publishedYear: '2010',
    audioFiles: [{ path: `/books/${overrides.id || 'item'}/book.m4b`, size: 1000, duration: 45 * HOUR, ext: '.m4b' }],
    ...overrides
  }
}

function evidenceFor(result, key) {
  return result.evidence.find((e) => e.key === key)
}

function compare(rawA, rawB, hashComparison) {
  return compareItems(buildItemDescriptor(rawA), buildItemDescriptor(rawB), hashComparison)
}

/** Split a duration into n MP3 files */
function mp3Files(id, n, totalDuration, sizeEach = 5000) {
  return Array.from({ length: n }, (_, i) => ({ path: `/books/${id}/part${String(i + 1).padStart(2, '0')}.mp3`, size: sizeEach + i, duration: totalDuration / n, ext: '.mp3' }))
}

describe('duplicateDetection/classify', () => {
  describe('buildItemDescriptor', () => {
    it('removes duplicate records for the same path without double counting duration', () => {
      const descriptor = buildItemDescriptor(
        rawItem({
          id: 'a',
          audioFiles: [
            { path: '/books/a/book.opus', size: 10, duration: 100 },
            { path: '/books/a/book.opus', size: 10, duration: 100 },
            { path: '/books/a/book.opus', size: 10, duration: 100 }
          ]
        })
      )
      expect(descriptor.files).to.have.length(1)
      expect(descriptor.duration).to.equal(100)
      expect(descriptor.duplicateFileRecords).to.equal(2)
    })

    it('keeps distinct files with the same size (repeated content) in the size signature', () => {
      const descriptor = buildItemDescriptor(
        rawItem({
          id: 'a',
          audioFiles: [
            { path: '/books/a/1.mp3', size: 10, duration: 5 },
            { path: '/books/a/2.mp3', size: 10, duration: 5 }
          ]
        })
      )
      expect(descriptor.sizeSignature).to.equal('2:10,10')
    })

    it('produces the same size signature regardless of file order and names', () => {
      const a = buildItemDescriptor(
        rawItem({
          id: 'a',
          audioFiles: [
            { path: '/x/1.mp3', size: 30 },
            { path: '/x/2.mp3', size: 10 }
          ]
        })
      )
      const b = buildItemDescriptor(
        rawItem({
          id: 'b',
          audioFiles: [
            { path: '/y/b.mp3', size: 10 },
            { path: '/y/a.mp3', size: 30 }
          ]
        })
      )
      expect(a.sizeSignature).to.equal(b.sizeSignature)
    })

    it('reads abridged status from the flag or the title', () => {
      expect(buildItemDescriptor(rawItem({ abridged: true })).abridged).to.be.true
      expect(buildItemDescriptor(rawItem({ title: 'Dune (Abridged)' })).abridged).to.be.true
      expect(buildItemDescriptor(rawItem({ title: 'Dune (Unabridged)' })).abridged).to.be.false
    })
  })

  describe('compareItems', () => {
    it('classifies identical file hashes as exact even when metadata differs', () => {
      const result = compare(rawItem({ id: 'a' }), rawItem({ id: 'b', title: 'Totally Different', authors: ['Someone Else'] }), { status: 'identical' })
      expect(result.classification).to.equal(Classification.EXACT)
      expect(evidenceFor(result, 'content_hash').outcome).to.equal('match')
      expect(evidenceFor(result, 'title').outcome).to.equal('mismatch')
    })

    it('classifies items that point at the same physical files as shared_files, not exact', () => {
      const result = compare(rawItem({ id: 'a' }), rawItem({ id: 'b' }), { status: 'identical', sharedPhysicalFiles: 1 })
      expect(result.classification).to.equal(Classification.SHARED_FILES)
      expect(evidenceFor(result, 'shared_files').details.count).to.equal(1)
    })

    it('scenario 3: same recording as single M4B and multi-file MP3 is likely_same_recording', () => {
      const m4b = rawItem({ id: 'a', audioFiles: [{ path: '/a/book.m4b', size: 700000, duration: 45 * HOUR, ext: '.m4b' }] })
      // MP3 split adds a little padding per file
      const mp3 = rawItem({ id: 'b', audioFiles: mp3Files('b', 60, 45 * HOUR + 40) })
      const result = compare(m4b, mp3, { status: 'not_checked' })
      expect(result.classification).to.equal(Classification.LIKELY_SAME_RECORDING)
      expect(evidenceFor(result, 'duration').outcome).to.equal('match')
      expect(evidenceFor(result, 'narrators').outcome).to.equal('match')
      expect(evidenceFor(result, 'files').details).to.include({ itemA: 1, itemB: 60 })
      expect(result.limitations).to.deep.equal([])
    })

    it('scenario 10: multi-disc set vs single file uses total runtime, not track count', () => {
      const discs = rawItem({ id: 'a', title: 'Dune', authors: ['Frank Herbert'], narrators: ['Scott Brick'], audioFiles: mp3Files('a', 18, 21 * HOUR + 20) })
      const single = rawItem({ id: 'b', title: 'Dune', authors: ['Frank Herbert'], narrators: ['Scott Brick'], audioFiles: [{ path: '/b/dune.m4b', size: 1, duration: 21 * HOUR, ext: '.m4b' }] })
      expect(compare(discs, single).classification).to.equal(Classification.LIKELY_SAME_RECORDING)
    })

    it('scenario 4: different narrators are never likely_same_recording', () => {
      const a = rawItem({ id: 'a', narrators: ['Michael Kramer'] })
      const b = rawItem({ id: 'b', narrators: ['Simon Vance'] })
      const result = compare(a, b)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(evidenceFor(result, 'narrators').outcome).to.equal('mismatch')
      expect(result.limitations).to.include('narrators')
    })

    it('scenario 4: a shared ASIN does not override different narrators', () => {
      const a = rawItem({ id: 'a', narrators: ['Michael Kramer'], asin: 'B003P2WO5E' })
      const b = rawItem({ id: 'b', narrators: ['Simon Vance'], asin: 'B003P2WO5E' })
      const result = compare(a, b)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(result.limitations).to.include('narrators')
    })

    it('scenario 5: abridged vs unabridged is at most a possible duplicate', () => {
      const unabridged = rawItem({ id: 'a' })
      const abridged = rawItem({ id: 'b', abridged: true, audioFiles: [{ path: '/b/x.m4b', size: 5, duration: 45 * HOUR, ext: '.m4b' }] })
      const result = compare(unabridged, abridged)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(evidenceFor(result, 'abridged').outcome).to.equal('mismatch')
      expect(result.limitations).to.include('abridged')
    })

    it('scenario 6: revised edition with the same title shows runtime and year differences', () => {
      const original = rawItem({ id: 'a', publishedYear: '2010', audioFiles: [{ path: '/a/x.m4b', size: 1, duration: 40 * HOUR }] })
      const revised = rawItem({ id: 'b', publishedYear: '2020', audioFiles: [{ path: '/b/x.m4b', size: 2, duration: 44 * HOUR }] })
      const result = compare(original, revised)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(evidenceFor(result, 'duration').outcome).to.equal('mismatch')
      expect(evidenceFor(result, 'published_year').outcome).to.equal('mismatch')
      expect(result.limitations).to.include('duration')
    })

    it('scenario 7: matching ISBN with materially different audio is not the same recording', () => {
      const a = rawItem({ id: 'a', isbn: '978-0-7653-2635-5', narrators: [], audioFiles: [{ path: '/a/x.m4b', size: 1, duration: 45 * HOUR }] })
      const b = rawItem({ id: 'b', isbn: '9780765326355', narrators: [], audioFiles: [{ path: '/b/x.m4b', size: 2, duration: 12 * HOUR }] })
      const result = compare(a, b)
      expect(evidenceFor(result, 'isbn').outcome).to.equal('match')
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(result.limitations).to.include('duration')
    })

    it('scenario 8: missing ISBN, ASIN and narrator lowers the result to possible_duplicate', () => {
      const a = rawItem({ id: 'a', narrators: [], asin: null, isbn: null })
      const b = rawItem({ id: 'b', narrators: [], asin: null, isbn: null })
      const result = compare(a, b)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(evidenceFor(result, 'asin').outcome).to.equal('unknown')
      expect(evidenceFor(result, 'narrators').outcome).to.equal('unknown')
      expect(result.limitations).to.deep.equal(['recording_identity'])
    })

    it('scenario 8: missing metadata on one side is not a wildcard match', () => {
      // No title and no authors on one side: nothing to match on
      const a = rawItem({ id: 'a', title: '', authors: [] })
      const b = rawItem({ id: 'b' })
      expect(compare(a, b).classification).to.equal(null)
    })

    it('scenario 9: Unicode and punctuation differences still match', () => {
      const a = rawItem({ id: 'a', title: 'Les Misérables', authors: ['Hugo, Victor'], narrators: ['George Guidall'] })
      const b = rawItem({ id: 'b', title: 'LES MISÉRABLES!', authors: ['Victor Hugo'], narrators: ['George  Guidall'] })
      const result = compare(a, b)
      expect(evidenceFor(result, 'title').outcome).to.equal('match')
      expect(evidenceFor(result, 'authors').outcome).to.equal('match')
      expect(result.classification).to.equal(Classification.LIKELY_SAME_RECORDING)
    })

    it('scenario 26: identically titled but unrelated books are not flagged', () => {
      const a = rawItem({ id: 'a', title: 'Legacy', authors: ['Greg Bear'], narrators: ['A Reader'] })
      const b = rawItem({ id: 'b', title: 'Legacy', authors: ['Danielle Steel'], narrators: ['A Reader'] })
      const result = compare(a, b)
      expect(result.classification).to.equal(null)
      expect(evidenceFor(result, 'authors').outcome).to.equal('mismatch')
    })

    it('different volumes in the same series are not flagged', () => {
      const a = rawItem({ id: 'a', title: 'Untitled', series: [{ name: 'The Saga', sequence: '1' }] })
      const b = rawItem({ id: 'b', title: 'Untitled', series: [{ name: 'The Saga', sequence: '2' }] })
      const result = compare(a, b)
      expect(result.classification).to.equal(null)
      expect(evidenceFor(result, 'series_sequence').outcome).to.equal('mismatch')
    })

    it('different subtitles are not flagged unless an identifier matches', () => {
      const a = rawItem({ id: 'a', title: 'Mistborn', subtitle: 'The Final Empire' })
      const b = rawItem({ id: 'b', title: 'Mistborn', subtitle: 'The Well of Ascension' })
      expect(compare(a, b).classification).to.equal(null)

      const withSameAsin = compare({ ...a, asin: 'B002UZMLXM' }, { ...b, asin: 'B002UZMLXM' })
      expect(withSameAsin.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(withSameAsin.limitations).to.include('subtitle')
    })

    it('a shared identifier with matching author flags differently titled items as possible', () => {
      const a = rawItem({ id: 'a', title: 'Book One', asin: 'B000000001' })
      const b = rawItem({ id: 'b', title: 'Book Two', asin: 'B000000001' })
      const result = compare(a, b)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(result.limitations).to.include('title')
    })

    it('different ASINs keep a pair at possible_duplicate and show the conflict', () => {
      const a = rawItem({ id: 'a', asin: 'B000000001' })
      const b = rawItem({ id: 'b', asin: 'B000000002' })
      const result = compare(a, b)
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(evidenceFor(result, 'asin').outcome).to.equal('mismatch')
      expect(result.limitations).to.include('asin')
    })

    it('different languages keep a pair at possible_duplicate', () => {
      const result = compare(rawItem({ id: 'a', language: 'English' }), rawItem({ id: 'b', language: 'de' }))
      expect(result.classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(result.limitations).to.include('language')
    })

    it('hash mismatch does not prevent a metadata-based classification', () => {
      // Same recording, different encoding: hashes differ but the recording evidence holds
      const result = compare(rawItem({ id: 'a' }), rawItem({ id: 'b' }), { status: 'different', sharedPhysicalFiles: 0 })
      expect(result.classification).to.equal(Classification.LIKELY_SAME_RECORDING)
      expect(evidenceFor(result, 'content_hash').outcome).to.equal('mismatch')
    })

    it('records unavailable hashes as unknown evidence', () => {
      const result = compare(rawItem({ id: 'a' }), rawItem({ id: 'b' }), { status: 'unavailable', reason: 'EACCES' })
      expect(evidenceFor(result, 'content_hash')).to.deep.equal({ key: 'content_hash', outcome: 'unknown', details: { reason: 'EACCES' } })
    })

    it('scenario 27: A~B and B~C do not imply A~C', () => {
      // B has no narrator, so it is compatible with both A and C; A and C have different narrators
      const a = rawItem({ id: 'a', narrators: ['Reader One'] })
      const b = rawItem({ id: 'b', narrators: [] })
      const c = rawItem({ id: 'c', narrators: ['Reader Two'] })
      expect(compare(a, b).classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(compare(b, c).classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      const ac = compare(a, c)
      expect(evidenceFor(ac, 'narrators').outcome).to.equal('mismatch')

      // With runtimes, B can match both while A and C are far apart
      const a2 = rawItem({ id: 'a', title: 'Saga', authors: ['X Y'], narrators: [], asin: 'B000000001', audioFiles: [{ path: '/a', size: 1, duration: 10 * HOUR }] })
      const b2 = rawItem({ id: 'b', title: 'Other', authors: ['X Y'], narrators: [], asin: 'B000000001', isbn: '9780306406157', audioFiles: [{ path: '/b', size: 1, duration: 10 * HOUR }] })
      const c2 = rawItem({ id: 'c', title: 'Different', authors: ['Z W'], narrators: [], isbn: '9780306406157', audioFiles: [{ path: '/c', size: 1, duration: 3 * HOUR }] })
      expect(compare(a2, b2).classification).to.equal(Classification.POSSIBLE_DUPLICATE)
      expect(compare(b2, c2).classification).to.equal(null) // isbn only, no title or author overlap
      expect(compare(a2, c2).classification).to.equal(null)
    })

    it('reports duplicate audio file records on an item as integrity evidence', () => {
      const a = rawItem({
        id: 'a',
        audioFiles: [
          { path: '/a/x.opus', size: 1, duration: 45 * HOUR },
          { path: '/a/x.opus', size: 1, duration: 45 * HOUR }
        ]
      })
      const result = compare(a, rawItem({ id: 'b' }))
      expect(evidenceFor(result, 'duplicate_file_records').details).to.deep.equal({ itemA: 1, itemB: 0 })
      // Runtime was not doubled by the duplicate record
      expect(evidenceFor(result, 'duration').outcome).to.equal('match')
    })
  })

  describe('getDurationTolerances', () => {
    it('grows with runtime and file count', () => {
      const single = buildItemDescriptor(rawItem({ audioFiles: [{ path: '/a', size: 1, duration: 10 * HOUR }] }))
      const many = buildItemDescriptor(rawItem({ audioFiles: mp3Files('m', 50, 10 * HOUR) }))
      const t1 = getDurationTolerances(single, single)
      const t2 = getDurationTolerances(single, many)
      expect(t1.sameRecording).to.be.closeTo(15 + 0.5 + 36, 0.01)
      expect(t2.sameRecording).to.be.closeTo(15 + 25 + 36, 0.01)
      expect(t1.comparable).to.be.closeTo(60 + 720, 0.01)
    })
  })
})
