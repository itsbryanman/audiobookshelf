const { expect } = require('chai')
const sinon = require('sinon')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const { Sequelize } = require('sequelize')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const { DuplicateDetectionManager } = require('../../../server/managers/DuplicateDetectionManager')

const HOUR = 3600

describe('DuplicateDetectionManager', () => {
  let tmpDir
  let library
  let folder
  /** @type {DuplicateDetectionManager} */
  let manager

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'adminEmitter')
    sinon.stub(SocketAuthority, 'emitter')

    tmpDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-dupes-'))
    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    folder = await Database.libraryFolderModel.create({ path: tmpDir, libraryId: library.id })

    manager = new DuplicateDetectionManager()
    manager.options.maxHashBytesPerSecond = 0
    manager.options.debounceMs = 10
    manager.options.scanDeferMs = 10
  })

  afterEach(async () => {
    await manager.stop()
    sinon.restore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await Database.sequelize.sync({ force: true })
  })

  /**
   * Write audio files to disk and return audioFile JSON as the scanner would store it
   *
   * @param {string} itemDir
   * @param {{name:string, content:Buffer, duration?:number}[]} files
   */
  function writeAudioFiles(itemDir, files) {
    fs.mkdirSync(itemDir, { recursive: true })
    return files.map((file, index) => {
      const path = Path.join(itemDir, file.name)
      fs.writeFileSync(path, file.content)
      return audioFileJson(path, index, file.duration)
    })
  }

  function audioFileJson(path, index = 0, duration = 600) {
    const stat = fs.statSync(path, { bigint: true })
    return {
      index: index + 1,
      ino: String(stat.ino),
      metadata: {
        filename: Path.basename(path),
        ext: Path.extname(path),
        path,
        relPath: Path.basename(path),
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs),
        ctimeMs: Number(stat.ctimeMs),
        birthtimeMs: Number(stat.birthtimeMs)
      },
      exclude: false,
      duration,
      codec: Path.extname(path) === '.mp3' ? 'mp3' : 'aac'
    }
  }

  /**
   * @param {Object} options
   * @param {string} options.dir folder name under the library folder
   * @param {{name:string, content:Buffer, duration?:number}[]} options.files
   */
  async function createBook({ dir, files, title = 'The Way of Kings', authors = ['Brandon Sanderson'], narrators = ['Michael Kramer'], asin = null, isbn = null, abridged = false, language = 'English', publishedYear = null, audioFiles = null }) {
    const itemDir = Path.join(tmpDir, dir)
    const audioFileObjs = audioFiles || writeAudioFiles(itemDir, files)
    const duration = audioFileObjs.reduce((t, af) => t + af.duration, 0)
    const book = await Database.bookModel.create({ title, narrators, asin, isbn, abridged, language, publishedYear, audioFiles: audioFileObjs, duration, tags: [], genres: [], chapters: [] })
    const libraryItem = await Database.libraryItemModel.create({
      path: itemDir,
      relPath: dir,
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: folder.id,
      libraryFiles: [],
      isMissing: false,
      size: audioFileObjs.reduce((t, af) => t + af.metadata.size, 0)
    })
    for (const name of authors) {
      const author = (await Database.authorModel.findOne({ where: { name, libraryId: library.id } })) || (await Database.authorModel.create({ name, libraryId: library.id }))
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    }
    return libraryItem
  }

  async function setAudioFiles(libraryItem, audioFiles) {
    const book = await Database.bookModel.findByPk(libraryItem.mediaId)
    book.audioFiles = audioFiles
    book.duration = audioFiles.reduce((t, af) => t + af.duration, 0)
    book.changed('audioFiles', true)
    await book.save()
  }

  async function getAudioFiles(libraryItem) {
    return (await Database.bookModel.findByPk(libraryItem.mediaId)).audioFiles
  }

  async function run(mode = 'incremental', trigger = 'test') {
    const { status, promise } = await manager.requestRun(library.id, mode, trigger)
    expect(status).to.equal('started')
    return promise
  }

  async function findings() {
    return Database.duplicateFindingModel.findAll({ order: [['classification', 'ASC']] })
  }

  function pairKey(a, b) {
    return [a.id, b.id].sort().join('|')
  }

  async function findingFor(a, b) {
    const [idA, idB] = [a.id, b.id].sort()
    return Database.duplicateFindingModel.findOne({ where: { libraryItemAId: idA, libraryItemBId: idB } })
  }

  const random = (size, seed) => {
    // Deterministic content per seed
    const out = Buffer.alloc(size)
    let x = crypto.createHash('sha256').update(String(seed)).digest()
    for (let i = 0; i < size; i += 32) {
      x.copy(out, i, 0, Math.min(32, size - i))
      x = crypto.createHash('sha256').update(x).digest()
    }
    return out
  }

  describe('exact duplicates', () => {
    it('scenario 1: two byte-identical M4B files are exact duplicates', async () => {
      const content = random(50000, 'm4b')
      const a = await createBook({ dir: 'A/Book', files: [{ name: 'book.m4b', content, duration: 40 * HOUR }] })
      const b = await createBook({ dir: 'B/Book', title: 'Way of Kings (Retail)', narrators: [], files: [{ name: 'Book Copy.m4b', content, duration: 40 * HOUR }] })

      const summary = await run()
      expect(summary.result).to.equal('completed')
      expect(summary.hashing.filesHashed).to.equal(2)

      const all = await findings()
      expect(all).to.have.length(1)
      expect(all[0].classification).to.equal('exact')
      expect(all[0].status).to.equal('open')
      expect(`${all[0].libraryItemAId}|${all[0].libraryItemBId}`).to.equal(pairKey(a, b))
      expect(all[0].evidence.find((e) => e.key === 'content_hash').outcome).to.equal('match')
      expect(all[0].algorithmVersion).to.equal(1)
    })

    it('scenario 2: identical MP3 collections with different file names are exact duplicates', async () => {
      const parts = [random(30000, 'p1'), random(31000, 'p2'), random(29000, 'p3')]
      await createBook({ dir: 'A', files: parts.map((content, i) => ({ name: `Chapter ${i + 1}.mp3`, content })) })
      // Different names and a different order
      await createBook({
        dir: 'B',
        files: [
          { name: 'z-03.mp3', content: parts[2] },
          { name: 'a-01.mp3', content: parts[0] },
          { name: 'm-02.mp3', content: parts[1] }
        ]
      })

      await run()
      const all = await findings()
      expect(all).to.have.length(1)
      expect(all[0].classification).to.equal('exact')
    })

    it('scenario 11: repeated identical files keep their multiplicity', async () => {
      const x = random(20000, 'x')
      const y = random(20000, 'y')
      const a = await createBook({
        dir: 'A',
        narrators: [],
        files: [
          { name: '1.mp3', content: x },
          { name: '2.mp3', content: x },
          { name: '3.mp3', content: y }
        ]
      })
      const b = await createBook({
        dir: 'B',
        narrators: [],
        files: [
          { name: '1.mp3', content: x },
          { name: '2.mp3', content: y },
          { name: '3.mp3', content: y }
        ]
      })
      const c = await createBook({
        dir: 'C',
        narrators: [],
        files: [
          { name: 'a.mp3', content: y },
          { name: 'b.mp3', content: x },
          { name: 'c.mp3', content: x }
        ]
      })

      await run()
      // Same sizes for all three, but only A and C have the same multiset of contents
      expect((await findingFor(a, c)).classification).to.equal('exact')
      expect((await findingFor(a, b)).classification).to.not.equal('exact')
      expect((await findingFor(b, c)).classification).to.not.equal('exact')
      expect((await findingFor(a, b)).evidence.find((e) => e.key === 'content_hash').outcome).to.equal('mismatch')
    })

    it('scenario 12: one changed file among several prevents an exact match', async () => {
      const parts = [random(10000, 'c1'), random(10000, 'c2'), random(10000, 'c3')]
      const changed = Buffer.from(parts[1])
      changed[5000] ^= 0xff // same size, one byte different (e.g. a retagged file)
      const a = await createBook({ dir: 'A', files: parts.map((content, i) => ({ name: `${i}.mp3`, content, duration: 1000 })) })
      const b = await createBook({ dir: 'B', files: [parts[0], changed, parts[2]].map((content, i) => ({ name: `${i}.mp3`, content, duration: 1000 })) })

      await run()
      const finding = await findingFor(a, b)
      expect(finding.classification).to.equal('likely_same_recording')
      expect(finding.evidence.find((e) => e.key === 'content_hash').outcome).to.equal('mismatch')
    })

    it('flags two items pointing at the same file as shared_files, not exact', async () => {
      const content = random(10000, 'shared')
      const a = await createBook({ dir: 'A', files: [{ name: 'book.m4b', content }] })
      // A second record for the same physical file (e.g. a hard link or a broken rescan)
      const linkDir = Path.join(tmpDir, 'B')
      fs.mkdirSync(linkDir)
      fs.linkSync(Path.join(tmpDir, 'A', 'book.m4b'), Path.join(linkDir, 'book.m4b'))
      const b = await createBook({ dir: 'B', audioFiles: [audioFileJson(Path.join(linkDir, 'book.m4b'))] })

      await run()
      const finding = await findingFor(a, b)
      expect(finding.classification).to.equal('shared_files')
      expect(finding.evidence.find((e) => e.key === 'shared_files').details.count).to.equal(1)
    })
  })

  describe('metadata based detection', () => {
    it('scenario 3: same book in M4B and MP3 with different encodings is likely_same_recording', async () => {
      const a = await createBook({ dir: 'A', files: [{ name: 'book.m4b', content: random(40000, 'enc1'), duration: 10 * HOUR }] })
      const b = await createBook({
        dir: 'B',
        files: Array.from({ length: 4 }, (_, i) => ({ name: `part${i}.mp3`, content: random(12000 + i, `enc2-${i}`), duration: (10 * HOUR + 20) / 4 }))
      })
      const summary = await run()
      expect(summary.hashing.filesHashed).to.equal(0) // different size sets are never hashed
      const finding = await findingFor(a, b)
      expect(finding.classification).to.equal('likely_same_recording')
      expect(finding.evidence.find((e) => e.key === 'content_hash')).to.be.undefined
    })

    it('scenario 26: same title by different authors is not flagged', async () => {
      await createBook({ dir: 'A', title: 'Legacy', authors: ['Greg Bear'], files: [{ name: 'a.m4b', content: random(1000, 'l1') }] })
      await createBook({ dir: 'B', title: 'Legacy', authors: ['Danielle Steel'], files: [{ name: 'b.m4b', content: random(1001, 'l2') }] })
      const summary = await run()
      expect(summary.candidatePairs).to.equal(1)
      expect(await findings()).to.have.length(0)
    })

    it('scenario 27: stores A-B and B-C without inventing A-C', async () => {
      const a = await createBook({ dir: 'A', narrators: ['Reader One'], files: [{ name: 'a.m4b', content: random(1000, 'n1') }] })
      const b = await createBook({ dir: 'B', narrators: [], files: [{ name: 'b.m4b', content: random(1001, 'n2') }] })
      const c = await createBook({ dir: 'C', narrators: ['Reader Two'], files: [{ name: 'c.m4b', content: random(1002, 'n3') }] })
      await run()
      expect((await findingFor(a, b)).classification).to.equal('possible_duplicate')
      expect((await findingFor(b, c)).classification).to.equal('possible_duplicate')
      // A and C are still a possible duplicate pair in their own right, with the narrator conflict recorded
      const ac = await findingFor(a, c)
      expect(ac.classification).to.equal('possible_duplicate')
      expect(ac.limitations).to.include('narrators')
      expect(await findings()).to.have.length(3)
    })

    it('excludes items marked missing and removes their findings', async () => {
      const a = await createBook({ dir: 'A', files: [{ name: 'a.m4b', content: random(1000, 'm1') }] })
      const b = await createBook({ dir: 'B', files: [{ name: 'b.m4b', content: random(1001, 'm2') }] })
      await run()
      expect(await findings()).to.have.length(1)

      await Database.libraryItemModel.update({ isMissing: true }, { where: { id: b.id } })
      const summary = await run()
      expect(summary.items).to.equal(1)
      expect(summary.findings.removed).to.equal(1)
      expect(await findings()).to.have.length(0)
      expect(a).to.exist
    })

    it('does not compare items across libraries', async () => {
      await createBook({ dir: 'A', files: [{ name: 'a.m4b', content: random(1000, 'x1') }] })
      const otherLibrary = await Database.libraryModel.create({ name: 'Other', mediaType: 'book', settings: {} })
      const otherFolder = await Database.libraryFolderModel.create({ path: '/other', libraryId: otherLibrary.id })
      const book = await Database.bookModel.create({ title: 'The Way of Kings', narrators: ['Michael Kramer'], audioFiles: [], tags: [], genres: [], chapters: [] })
      await Database.libraryItemModel.create({ path: '/other/x', relPath: 'x', mediaId: book.id, mediaType: 'book', libraryId: otherLibrary.id, libraryFolderId: otherFolder.id, libraryFiles: [] })
      const summary = await run()
      expect(summary.items).to.equal(1)
      expect(await findings()).to.have.length(0)
    })
  })

  describe('hash cache', () => {
    let a, b, content

    beforeEach(async () => {
      content = [random(25000, 'h1'), random(26000, 'h2')]
      a = await createBook({
        dir: 'A',
        files: [
          { name: '1.mp3', content: content[0] },
          { name: '2.mp3', content: content[1] }
        ]
      })
      b = await createBook({
        dir: 'B',
        files: [
          { name: '1.mp3', content: content[0] },
          { name: '2.mp3', content: content[1] }
        ]
      })
      const first = await run()
      expect(first.hashing.filesHashed).to.equal(4)
      expect((await findingFor(a, b)).classification).to.equal('exact')
    })

    it('scenario 16: unchanged files reuse cached hashes in incremental and full runs', async () => {
      const incremental = await run('incremental')
      expect(incremental.hashing.filesHashed).to.equal(0)
      expect(incremental.hashing.cacheHits).to.equal(4)

      const full = await run('full')
      expect(full.hashing.filesHashed).to.equal(0)
      expect(full.hashing.cacheHits).to.equal(4)
      expect(full.findings.unchanged).to.equal(1)
      expect(await Database.fileHashModel.count()).to.equal(4)
    })

    it('scenario 13: renamed files reuse their hash through device + inode + size + mtime', async () => {
      const audioFiles = await getAudioFiles(b)
      const oldPath = audioFiles[0].metadata.path
      const newPath = Path.join(Path.dirname(oldPath), 'renamed.mp3')
      fs.renameSync(oldPath, newPath)
      await setAudioFiles(b, [audioFileJson(newPath, 0), audioFiles[1]])

      const summary = await run('incremental')
      expect(summary.hashing.filesHashed).to.equal(0)
      expect(summary.hashing.cacheHits).to.equal(4)
      expect((await findingFor(a, b)).classification).to.equal('exact')
      expect(await Database.fileHashModel.findOne({ where: { path: newPath } })).to.exist
    })

    it('scenario 14: moving an audiobook folder keeps the finding and the cache', async () => {
      const before = await findingFor(a, b)
      const oldDir = Path.join(tmpDir, 'B')
      const newDir = Path.join(tmpDir, 'Moved', 'B')
      fs.mkdirSync(Path.dirname(newDir), { recursive: true })
      fs.renameSync(oldDir, newDir)
      await Database.libraryItemModel.update({ path: newDir, relPath: 'Moved/B' }, { where: { id: b.id } })
      await setAudioFiles(b, [audioFileJson(Path.join(newDir, '1.mp3'), 0), audioFileJson(Path.join(newDir, '2.mp3'), 1)])

      const summary = await run('full')
      expect(summary.hashing.filesHashed).to.equal(0)
      const after = await findingFor(a, b)
      expect(after.id).to.equal(before.id)
      expect(after.classification).to.equal('exact')
      // The old paths no longer belong to any item and are pruned by the full audit
      expect(summary.cacheRowsPruned).to.equal(2)
      expect(await Database.fileHashModel.count()).to.equal(4)
    })

    it('scenario 15: a changed inode with the same content is re-hashed and still exact', async () => {
      const audioFiles = await getAudioFiles(b)
      const path = audioFiles[0].metadata.path
      const stat = fs.statSync(path)
      const tmpCopy = `${path}.tmp`
      fs.copyFileSync(path, tmpCopy)
      fs.renameSync(tmpCopy, path) // new inode, same content
      fs.utimesSync(path, stat.atime, stat.mtime) // keep mtime so only the inode changed
      expect(String(fs.statSync(path, { bigint: true }).ino)).to.not.equal(audioFiles[0].ino)

      const summary = await run('full')
      expect(summary.hashing.filesHashed).to.equal(1)
      expect((await findingFor(a, b)).classification).to.equal('exact')
    })

    it('scenario 17: a file modified after hashing is re-hashed and the finding updated', async () => {
      const audioFiles = await getAudioFiles(b)
      const path = audioFiles[1].metadata.path
      const modified = Buffer.from(content[1])
      modified[100] ^= 0xff
      fs.writeFileSync(path, modified)
      const newTime = new Date(Date.now() + 5000)
      fs.utimesSync(path, newTime, newTime)
      // The scanner records the new mtime
      await setAudioFiles(b, [audioFiles[0], audioFileJson(path, 1)])

      const summary = await run('incremental')
      expect(summary.hashing.filesHashed).to.equal(1)
      const finding = await findingFor(a, b)
      expect(finding.classification).to.equal('likely_same_recording')
      expect(summary.findings.updated).to.equal(1)
    })

    it('scenario 17: a full audit notices a modified file the scanner has not seen yet', async () => {
      const path = (await getAudioFiles(b))[1].metadata.path
      const modified = Buffer.from(content[1])
      modified[100] ^= 0xff
      fs.writeFileSync(path, modified)
      const newTime = new Date(Date.now() + 5000)
      fs.utimesSync(path, newTime, newTime)

      // Incremental trusts the recorded mtime, the full audit checks the disk
      expect((await run('incremental')).hashing.filesHashed).to.equal(0)
      const full = await run('full')
      expect(full.hashing.filesHashed).to.equal(1)
      expect((await findingFor(a, b)).classification).to.equal('likely_same_recording')
    })

    it('scenario 19: a missing file does not downgrade or remove an exact finding', async () => {
      fs.rmSync((await getAudioFiles(b))[0].metadata.path)
      const summary = await run('full')
      expect(summary.hashing.hashFailures).to.equal(1)
      expect(summary.hashing.failuresByCode).to.deep.equal({ ENOENT: 1 })
      expect(summary.findings.kept).to.equal(1)
      const finding = await findingFor(a, b)
      expect(finding.classification).to.equal('exact')
    })

    it('scenario 19: an unreadable file is reported and the run completes', async () => {
      const lockedPath = (await getAudioFiles(b))[1].metadata.path
      fs.appendFileSync(lockedPath, 'x') // force a re-hash
      const realOpen = fs.promises.open
      sinon.stub(fs.promises, 'open').callsFake((path, ...args) => {
        if (path === lockedPath) {
          const error = new Error('permission denied')
          error.code = 'EACCES'
          return Promise.reject(error)
        }
        return realOpen.call(fs.promises, path, ...args)
      })
      const summary = await run('full')
      expect(summary.result).to.equal('completed')
      expect(summary.hashing.failuresByCode).to.deep.equal({ EACCES: 1 })
      expect((await findingFor(a, b)).classification).to.equal('exact')
    })

    it('ignores cache entries from an older cache version', async () => {
      await Database.fileHashModel.update({ cacheVersion: 0 }, { where: {} })
      const summary = await run('incremental')
      expect(summary.hashing.filesHashed).to.equal(4)
      expect(await Database.fileHashModel.count({ where: { cacheVersion: Database.fileHashModel.CACHE_VERSION } })).to.equal(4)
    })

    it('scenario 21: deleting an item removes its findings', async () => {
      const c = await createBook({
        dir: 'C',
        files: [
          { name: '1.mp3', content: content[0] },
          { name: '2.mp3', content: content[1] }
        ]
      })
      await run()
      expect(await findings()).to.have.length(3)

      await Database.libraryItemModel.removeById(c.id)
      const remaining = await findings()
      expect(remaining).to.have.length(1)
      expect(`${remaining[0].libraryItemAId}|${remaining[0].libraryItemBId}`).to.equal(pairKey(a, b))
    })

    it('scenario 21: deleting the library removes findings and cached hashes', async () => {
      await Database.libraryModel.destroy({ where: { id: library.id } })
      expect(await Database.duplicateFindingModel.count()).to.equal(0)
      expect(await Database.fileHashModel.count()).to.equal(0)
    })

    it('never modifies media files', async () => {
      const paths = [...(await getAudioFiles(a)), ...(await getAudioFiles(b))].map((af) => af.metadata.path)
      const before = paths.map((p) => {
        const s = fs.statSync(p)
        return `${s.size}:${s.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`
      })
      await run('full')
      const after = paths.map((p) => {
        const s = fs.statSync(p)
        return `${s.size}:${s.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`
      })
      expect(after).to.deep.equal(before)
      expect(await Database.libraryItemModel.count()).to.equal(2)
    })
  })

  describe('review status', () => {
    let a, b
    const user = { id: null }

    beforeEach(async () => {
      const admin = await Database.userModel.create({ username: 'admin', type: 'admin', permissions: {}, isActive: true })
      user.id = admin.id
      a = await createBook({ dir: 'A', narrators: [], files: [{ name: 'a.m4b', content: random(1000, 'r1'), duration: 10 * HOUR }] })
      b = await createBook({ dir: 'B', narrators: [], files: [{ name: 'b.m4b', content: random(1001, 'r2'), duration: 10 * HOUR }] })
      await run()
    })

    it('scenario 22: dismisses and reopens a finding', async () => {
      const finding = await findingFor(a, b)
      expect(finding.classification).to.equal('possible_duplicate')

      await manager.dismissFinding(finding, user)
      let stored = await findingFor(a, b)
      expect(stored.status).to.equal('dismissed')
      expect(stored.dismissedByUserId).to.equal(user.id)
      expect(stored.dismissedClassification).to.equal('possible_duplicate')
      expect(stored.dismissedAt).to.be.instanceOf(Date)

      await manager.reopenFinding(stored)
      stored = await findingFor(a, b)
      expect(stored.status).to.equal('open')
      expect(stored.statusReason).to.equal('reopened_manually')
      expect(stored.dismissedAt).to.equal(null)
    })

    it('scenario 23: a dismissed finding does not come back for unchanged books', async () => {
      await manager.dismissFinding(await findingFor(a, b), user)
      await run('incremental')
      await run('full')
      const stored = await findingFor(a, b)
      expect(stored.status).to.equal('dismissed')
      expect(await findings()).to.have.length(1)
    })

    it('scenario 23: metadata-only changes keep the dismissal', async () => {
      await manager.dismissFinding(await findingFor(a, b), user)
      await Database.bookModel.update({ publishedYear: '1999' }, { where: { id: b.mediaId } })
      const summary = await run()
      expect(summary.findings.reopened).to.equal(0)
      expect((await findingFor(a, b)).status).to.equal('dismissed')
    })

    it('scenario 23: a stronger classification reopens a dismissed finding', async () => {
      await manager.dismissFinding(await findingFor(a, b), user)
      // Narrator added to both: now likely the same recording
      await Database.bookModel.update({ narrators: ['Same Reader'] }, { where: { id: [a.mediaId, b.mediaId] } })
      const summary = await run()
      expect(summary.findings.reopened).to.equal(1)
      const stored = await findingFor(a, b)
      expect(stored.status).to.equal('open')
      expect(stored.classification).to.equal('likely_same_recording')
      expect(stored.statusReason).to.equal('reopened_stronger_classification')
    })

    it('scenario 23: changed audio reopens a dismissed finding', async () => {
      await manager.dismissFinding(await findingFor(a, b), user)
      const audioFiles = await getAudioFiles(b)
      const extra = writeAudioFiles(Path.join(tmpDir, 'B'), [{ name: 'bonus.m4b', content: random(500, 'bonus'), duration: 60 }])
      await setAudioFiles(b, [...audioFiles, ...extra])
      const summary = await run()
      expect(summary.findings.reopened).to.equal(1)
      const stored = await findingFor(a, b)
      expect(stored.status).to.equal('open')
      expect(stored.statusReason).to.equal('reopened_audio_changed')
    })

    it('scenario 28: rescanning updates the existing finding instead of adding rows', async () => {
      const before = await findingFor(a, b)
      await Database.bookModel.update({ narrators: ['Same Reader'] }, { where: { id: [a.mediaId, b.mediaId] } })
      await run()
      await run('full')
      const all = await findings()
      expect(all).to.have.length(1)
      expect(all[0].id).to.equal(before.id)
      expect(all[0].classification).to.equal('likely_same_recording')
      expect(all[0].firstDetectedAt.valueOf()).to.equal(before.firstDetectedAt.valueOf())
      expect(all[0].lastVerifiedAt.valueOf()).to.be.at.least(before.lastVerifiedAt.valueOf())
    })

    it('removes a finding when the pair no longer matches', async () => {
      await Database.bookModel.update({ title: 'A Completely Different Book' }, { where: { id: b.mediaId } })
      const summary = await run()
      expect(summary.findings.removed).to.equal(1)
      expect(await findings()).to.have.length(0)
    })
  })

  describe('run control', () => {
    async function createLargeDuplicatePair() {
      const content = random(4 * 1024 * 1024, 'large')
      await createBook({ dir: 'A', files: [{ name: 'a.m4b', content }] })
      await createBook({ dir: 'B', files: [{ name: 'b.m4b', content }] })
    }

    it('scenario 20: canceling a run midway saves nothing', async () => {
      await createLargeDuplicatePair()
      manager.options.maxHashBytesPerSecond = 2 * 1024 * 1024 // ~4 s for both files
      const { promise } = await manager.requestRun(library.id, 'full', 'test')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(manager.isRunning(library.id)).to.be.true
      expect(manager.cancel(library.id)).to.be.true
      const summary = await promise
      expect(summary.result).to.equal('canceled')
      expect(await findings()).to.have.length(0)
      expect(manager.isRunning(library.id)).to.be.false
      expect(manager.getStatus(library.id).lastRun.result).to.equal('canceled')
    })

    it('scenario 25: requests during a run are queued and run once afterwards', async () => {
      await createLargeDuplicatePair()
      manager.options.maxHashBytesPerSecond = 16 * 1024 * 1024
      const first = await manager.requestRun(library.id, 'incremental', 'test')
      const second = await manager.requestRun(library.id, 'incremental', 'test')
      const third = await manager.requestRun(library.id, 'full', 'test')
      expect(first.status).to.equal('started')
      expect(second.status).to.equal('queued')
      expect(third.status).to.equal('queued')
      expect(manager.getStatus(library.id).queued).to.deep.equal({ mode: 'full', trigger: 'test' })

      await first.promise
      // The queued full audit starts right after
      expect(manager.isRunning(library.id)).to.be.true
      await manager.runs.get(library.id).promise
      expect(manager.getStatus(library.id).lastRun.mode).to.equal('full')
      expect(manager.isRunning(library.id)).to.be.false
      expect(await findings()).to.have.length(1)
    })

    it('scenario 25: a library scan starting during a run defers it without saving', async () => {
      await createLargeDuplicatePair()
      manager.options.maxHashBytesPerSecond = 2 * 1024 * 1024
      const { promise } = await manager.requestRun(library.id, 'full', 'test')
      await new Promise((resolve) => setTimeout(resolve, 200))
      LibraryScanner.librariesScanning.push(library.id)
      try {
        manager.deferForLibraryScan(library.id)
        const summary = await promise
        expect(summary.result).to.equal('deferred')
        expect(await findings()).to.have.length(0)
        expect(manager.getStatus(library.id).scheduled).to.be.true
      } finally {
        LibraryScanner.librariesScanning = LibraryScanner.librariesScanning.filter((id) => id !== library.id)
      }
    })

    it('scenario 25: a run requested while the library is scanning is deferred', async () => {
      await createBook({ dir: 'A', files: [{ name: 'a.m4b', content: random(100, 's1') }] })
      LibraryScanner.librariesScanning.push(library.id)
      try {
        const summary = await run()
        expect(summary.result).to.equal('deferred')
        expect(manager.getStatus(library.id).scheduled).to.be.true
      } finally {
        LibraryScanner.librariesScanning = LibraryScanner.librariesScanning.filter((id) => id !== library.id)
      }
    })

    it('only schedules automatic runs for libraries with duplicate detection enabled', async () => {
      manager.notifyLibraryChanged(library, 'test')
      expect(manager.getStatus(library.id).scheduled).to.be.false

      library.settings = { ...library.settings, enableDuplicateDetection: true }
      manager.notifyLibraryChanged(library, 'test')
      expect(manager.getStatus(library.id).scheduled).to.be.true
    })

    it('debounced notifications run once', async () => {
      await createBook({ dir: 'A', files: [{ name: 'a.m4b', content: random(100, 'd1') }] })
      library.settings = { ...library.settings, enableDuplicateDetection: true }
      const spy = sinon.spy(manager, 'startRun')
      manager.notifyLibraryChanged(library, 'test')
      manager.notifyLibraryChanged(library, 'test')
      manager.notifyLibraryChanged(library, 'test')
      await new Promise((resolve) => setTimeout(resolve, 50))
      await manager.runs.get(library.id)?.promise
      expect(spy.callCount).to.equal(1)
      expect(manager.getStatus(library.id).lastRun.trigger).to.equal('test')
    })

    it('a failed run leaves the manager usable', async () => {
      sinon.stub(Logger, 'error')
      sinon.stub(manager, 'detect').rejects(new Error('boom'))
      const summary = await run()
      expect(summary.result).to.equal('failed')
      expect(manager.isRunning(library.id)).to.be.false
      manager.detect.restore()
      expect((await run()).result).to.equal('completed')
    })
  })

  describe('library scanner integration', () => {
    it('only notifies after completed scans', async () => {
      const notify = sinon.stub(require('../../../server/managers/DuplicateDetectionManager'), 'notifyLibraryChanged')
      const scanLibrary = sinon.stub(LibraryScanner, 'scanLibrary')
      sinon.stub(Logger, 'error')
      const TaskManager = require('../../../server/managers/TaskManager')
      sinon.stub(TaskManager, 'addTask')
      sinon.stub(TaskManager, 'taskFinished')
      const scannedLibrary = await Database.libraryModel.findByIdWithFolders(library.id)
      sinon.stub(scannedLibrary, 'save').resolves()

      scanLibrary.resolves(true) // canceled
      await LibraryScanner.scan(scannedLibrary)
      expect(notify.called).to.be.false

      scanLibrary.rejects(new Error('scan failed'))
      await LibraryScanner.scan(scannedLibrary)
      expect(notify.called).to.be.false

      scanLibrary.resolves(false) // completed
      await LibraryScanner.scan(scannedLibrary)
      expect(notify.calledOnce).to.be.true
      expect(notify.firstCall.args[1]).to.equal('library-scan')
    })
  })
})
