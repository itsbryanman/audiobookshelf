const { expect } = require('chai')
const sinon = require('sinon')
const express = require('express')
const http = require('http')
const { Sequelize } = require('sequelize')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const DuplicateDetectionManager = require('../../../server/managers/DuplicateDetectionManager')

describe('DuplicateController', () => {
  let server
  let baseUrl
  let currentUser
  let library
  let podcastLibrary
  let otherLibrary
  let users
  let items
  let apiCacheManager

  async function createUser(username, type, permissions = {}) {
    return Database.userModel.create({
      username,
      type,
      isActive: true,
      permissions: {
        download: true,
        update: type !== 'user',
        delete: type !== 'user',
        upload: type !== 'user',
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: true,
        ...permissions
      }
    })
  }

  async function createItem(lib, folder, title, { tags = [], explicit = false } = {}) {
    const book = await Database.bookModel.create({ title, narrators: ['Reader'], audioFiles: [{ ino: '1', metadata: { path: `/books/${title}/a.m4b`, relPath: 'a.m4b', size: 100, ext: '.m4b' }, duration: 100, codec: 'aac' }], tags, explicit, genres: [], chapters: [] })
    return Database.libraryItemModel.create({ path: `/books/${title}`, relPath: title, mediaId: book.id, mediaType: 'book', libraryId: lib.id, libraryFolderId: folder.id, libraryFiles: [], size: 100 })
  }

  async function createFinding(itemA, itemB, classification, firstDetectedAt, status = 'open') {
    const [a, b] = [itemA.id, itemB.id].sort()
    return Database.duplicateFindingModel.create({
      libraryId: itemA.libraryId,
      libraryItemAId: a,
      libraryItemBId: b,
      classification,
      evidence: [{ key: 'title', outcome: 'match' }],
      limitations: [],
      contentSignature: 'sig',
      algorithmVersion: 1,
      status,
      firstDetectedAt,
      lastVerifiedAt: firstDetectedAt
    })
  }

  function request(method, path, body) {
    const payload = body ? JSON.stringify(body) : null
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/api${path}`, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode, json, text })
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'error')

    apiCacheManager = new ApiCacheManager()
    apiCacheManager.init(Database)
    const apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager })

    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.user = currentUser
      next()
    })
    app.use('/api', apiRouter.router)
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: {} })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    otherLibrary = await Database.libraryModel.create({ name: 'Other', mediaType: 'book', settings: {} })
    podcastLibrary = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast', settings: {} })

    items = {
      a: await createItem(library, folder, 'Alpha'),
      b: await createItem(library, folder, 'Alpha Copy'),
      c: await createItem(library, folder, 'Bravo'),
      d: await createItem(library, folder, 'Bravo Copy', { tags: ['private'] }),
      e: await createItem(library, folder, 'Charlie'),
      f: await createItem(library, folder, 'Charlie Copy')
    }

    users = {
      root: await createUser('root', 'root'),
      admin: await createUser('admin', 'admin'),
      tagRestrictedAdmin: await createUser('tagadmin', 'admin', { accessAllTags: false, selectedTagsNotAccessible: true, itemTagsSelected: ['private'] }),
      otherLibraryAdmin: await createUser('otheradmin', 'admin', { accessAllLibraries: false, librariesAccessible: [otherLibrary.id] }),
      user: await createUser('user', 'user')
    }
    currentUser = users.admin
  })

  afterEach(async () => {
    sinon.restore()
    await DuplicateDetectionManager.stop()
    DuplicateDetectionManager.stopped = false
    DuplicateDetectionManager.lastRuns.clear()
    await new Promise((resolve) => server.close(resolve))
    await Database.sequelize.sync({ force: true })
  })

  describe('GET /libraries/:id/duplicates', () => {
    let exact, likely, possible, dismissed

    beforeEach(async () => {
      possible = await createFinding(items.e, items.f, 'possible_duplicate', new Date(1000))
      likely = await createFinding(items.c, items.d, 'likely_same_recording', new Date(2000))
      exact = await createFinding(items.a, items.b, 'exact', new Date(3000))
      dismissed = await createFinding(items.a, items.e, 'possible_duplicate', new Date(500), 'dismissed')
    })

    it('lists open findings, strongest first, with item details and counts', async () => {
      const { status, json } = await request('GET', `/libraries/${library.id}/duplicates`)
      expect(status).to.equal(200)
      expect(json.total).to.equal(3)
      expect(json.findings.map((f) => f.id)).to.deep.equal([exact.id, likely.id, possible.id])
      const first = json.findings[0]
      expect(first.classification).to.equal('exact')
      expect(first.evidence).to.deep.equal([{ key: 'title', outcome: 'match' }])
      expect([first.libraryItemA.title, first.libraryItemB.title].sort()).to.deep.equal(['Alpha', 'Alpha Copy'])
      expect(first.libraryItemA).to.include.keys('duration', 'size', 'addedAt', 'numAudioFiles', 'formats', 'narrators', 'authorName', 'path', 'hasCover')
      expect(first.libraryItemA.audioFiles).to.be.undefined
      expect(json.counts).to.deep.equal({ open: { exact: 1, likely_same_recording: 1, possible_duplicate: 1 }, dismissed: { possible_duplicate: 1 } })
    })

    it('filters by classification and status', async () => {
      let res = await request('GET', `/libraries/${library.id}/duplicates?classification=exact,likely_same_recording`)
      expect(res.json.findings.map((f) => f.id)).to.deep.equal([exact.id, likely.id])

      res = await request('GET', `/libraries/${library.id}/duplicates?status=dismissed`)
      expect(res.json.findings.map((f) => f.id)).to.deep.equal([dismissed.id])

      res = await request('GET', `/libraries/${library.id}/duplicates?status=all&classification=possible_duplicate`)
      expect(res.json.findings.map((f) => f.id)).to.deep.equal([dismissed.id, possible.id])
    })

    it('paginates deterministically', async () => {
      const page0 = await request('GET', `/libraries/${library.id}/duplicates?limit=2&page=0`)
      const page1 = await request('GET', `/libraries/${library.id}/duplicates?limit=2&page=1`)
      expect(page0.json.findings.map((f) => f.id)).to.deep.equal([exact.id, likely.id])
      expect(page1.json.findings.map((f) => f.id)).to.deep.equal([possible.id])
      expect(page1.json.total).to.equal(3)
      expect(page1.json.limit).to.equal(2)
      expect(page1.json.page).to.equal(1)
    })

    it('rejects invalid filters', async () => {
      expect((await request('GET', `/libraries/${library.id}/duplicates?status=deleted`)).status).to.equal(400)
      expect((await request('GET', `/libraries/${library.id}/duplicates?classification=exact,maybe`)).status).to.equal(400)
      expect((await request('GET', `/libraries/${library.id}/duplicates?limit=-1`)).status).to.equal(400)
    })

    it('scenario 24: non-admin users cannot read findings', async () => {
      currentUser = users.user
      expect((await request('GET', `/libraries/${library.id}/duplicates`)).status).to.equal(403)
      expect((await request('GET', `/libraries/${library.id}/duplicates/${exact.id}`)).status).to.equal(403)
      expect((await request('GET', `/libraries/${library.id}/duplicates/audit`)).status).to.equal(403)
    })

    it('scenario 24: admins without access to the library cannot read findings', async () => {
      currentUser = users.otherLibraryAdmin
      expect((await request('GET', `/libraries/${library.id}/duplicates`)).status).to.equal(403)
    })

    it('scenario 24: admins only see findings for items they can access', async () => {
      currentUser = users.tagRestrictedAdmin
      const { json } = await request('GET', `/libraries/${library.id}/duplicates`)
      expect(json.total).to.equal(2)
      expect(json.findings.map((f) => f.id)).to.deep.equal([exact.id, possible.id])
      expect((await request('GET', `/libraries/${library.id}/duplicates/${likely.id}`)).status).to.equal(403)
      expect((await request('POST', `/libraries/${library.id}/duplicates/${likely.id}/dismiss`)).status).to.equal(403)
    })

    it('is only available for book libraries', async () => {
      expect((await request('GET', `/libraries/${podcastLibrary.id}/duplicates`)).status).to.equal(400)
    })

    it('is not served from the API response cache', async () => {
      await request('GET', `/libraries/${library.id}/duplicates`)
      expect(apiCacheManager.cache.size).to.equal(0)
    })

    it('does not change the existing issues endpoint', async () => {
      // Duplicate findings are not "issues": the destructive issues cleanup ignores them
      currentUser = users.root
      const res = await request('DELETE', `/libraries/${library.id}/issues`)
      expect(res.status).to.equal(200)
      expect(await Database.libraryItemModel.count()).to.equal(6)
      expect(await Database.duplicateFindingModel.count()).to.equal(4)
    })
  })

  describe('finding endpoints', () => {
    let finding

    beforeEach(async () => {
      finding = await createFinding(items.a, items.b, 'exact', new Date(1000))
    })

    it('returns a finding with evidence and audio files, without absolute file paths', async () => {
      const { status, json } = await request('GET', `/libraries/${library.id}/duplicates/${finding.id}`)
      expect(status).to.equal(200)
      expect(json.id).to.equal(finding.id)
      expect(json.libraryItemA.audioFiles).to.deep.equal([{ ino: '1', relPath: 'a.m4b', size: 100, duration: 100, codec: 'aac' }])
      expect(JSON.stringify(json.libraryItemA.audioFiles)).to.not.include('/books/')
    })

    it('returns 404 for unknown findings and findings in another library', async () => {
      const otherFolder = await Database.libraryFolderModel.create({ path: '/other', libraryId: otherLibrary.id })
      const x = await createItem(otherLibrary, otherFolder, 'X')
      const y = await createItem(otherLibrary, otherFolder, 'Y')
      const otherFinding = await createFinding(x, y, 'exact', new Date())
      expect((await request('GET', `/libraries/${library.id}/duplicates/${otherFinding.id}`)).status).to.equal(404)
      expect((await request('GET', `/libraries/${library.id}/duplicates/00000000-0000-4000-8000-000000000000`)).status).to.equal(404)
      expect((await request('GET', `/libraries/${library.id}/duplicates/not-a-uuid`)).status).to.equal(400)
    })

    it('scenario 22: dismisses and reopens through the API', async () => {
      let res = await request('POST', `/libraries/${library.id}/duplicates/${finding.id}/dismiss`)
      expect(res.status).to.equal(200)
      expect(res.json.status).to.equal('dismissed')
      expect(res.json.dismissedByUserId).to.equal(users.admin.id)

      let stored = await Database.duplicateFindingModel.findByPk(finding.id)
      expect(stored.status).to.equal('dismissed')
      expect(stored.dismissedClassification).to.equal('exact')

      res = await request('GET', `/libraries/${library.id}/duplicates`)
      expect(res.json.total).to.equal(0)

      res = await request('POST', `/libraries/${library.id}/duplicates/${finding.id}/reopen`)
      expect(res.json.status).to.equal('open')
      stored = await Database.duplicateFindingModel.findByPk(finding.id)
      expect(stored.status).to.equal('open')
      expect(stored.dismissedByUserId).to.equal(null)
    })

    it('scenario 24: non-admin users cannot dismiss or reopen', async () => {
      currentUser = users.user
      expect((await request('POST', `/libraries/${library.id}/duplicates/${finding.id}/dismiss`)).status).to.equal(403)
      expect((await request('POST', `/libraries/${library.id}/duplicates/${finding.id}/reopen`)).status).to.equal(403)
      expect((await Database.duplicateFindingModel.findByPk(finding.id)).status).to.equal('open')
    })

    it('does not delete library items or files', async () => {
      await request('POST', `/libraries/${library.id}/duplicates/${finding.id}/dismiss`)
      expect(await Database.libraryItemModel.count()).to.equal(6)
    })
  })

  describe('audit endpoints', () => {
    it('starts an audit and reports status', async () => {
      const requestRun = sinon.stub(DuplicateDetectionManager, 'requestRun').resolves({ status: 'started' })
      const res = await request('POST', `/libraries/${library.id}/duplicates/audit`, { mode: 'full' })
      expect(res.status).to.equal(200)
      expect(res.json.status).to.equal('started')
      expect(requestRun.calledOnceWith(library.id, 'full', 'manual')).to.be.true

      const status = await request('GET', `/libraries/${library.id}/duplicates/audit`)
      expect(status.status).to.equal(200)
      expect(status.json).to.include.keys('running', 'progress', 'lastRun', 'queued')
    })

    it('runs a real audit end to end', async () => {
      const res = await request('POST', `/libraries/${library.id}/duplicates/audit`, { mode: 'incremental' })
      expect(res.json.status).to.equal('started')
      while (DuplicateDetectionManager.isRunning(library.id)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const status = await request('GET', `/libraries/${library.id}/duplicates/audit`)
      expect(status.json.running).to.equal(false)
      expect(status.json.lastRun.result).to.equal('completed')
      expect(status.json.lastRun.items).to.equal(6)
    })

    it('defaults to a full audit and validates the mode', async () => {
      const requestRun = sinon.stub(DuplicateDetectionManager, 'requestRun').resolves({ status: 'queued' })
      expect((await request('POST', `/libraries/${library.id}/duplicates/audit`)).json.status).to.equal('queued')
      expect(requestRun.firstCall.args[1]).to.equal('full')
      expect((await request('POST', `/libraries/${library.id}/duplicates/audit`, { mode: 'everything' })).status).to.equal(400)
    })

    it('cancels an audit', async () => {
      const cancel = sinon.stub(DuplicateDetectionManager, 'cancel').returns(true)
      const res = await request('POST', `/libraries/${library.id}/duplicates/audit/cancel`)
      expect(res.json).to.deep.equal({ canceled: true })
      expect(cancel.calledOnceWith(library.id)).to.be.true
    })

    it('scenario 24: non-admin users cannot start or cancel audits', async () => {
      currentUser = users.user
      const requestRun = sinon.stub(DuplicateDetectionManager, 'requestRun')
      expect((await request('POST', `/libraries/${library.id}/duplicates/audit`)).status).to.equal(403)
      expect((await request('POST', `/libraries/${library.id}/duplicates/audit/cancel`)).status).to.equal(403)
      expect(requestRun.called).to.be.false
    })
  })

  describe('library settings', () => {
    it('accepts enableDuplicateDetection on book libraries', async () => {
      currentUser = users.root
      const res = await request('PATCH', `/libraries/${library.id}`, { settings: { enableDuplicateDetection: true } })
      expect(res.status).to.equal(200)
      const stored = await Database.libraryModel.findByPk(library.id)
      expect(stored.settings.enableDuplicateDetection).to.equal(true)
      expect((await request('PATCH', `/libraries/${library.id}`, { settings: { enableDuplicateDetection: 'yes' } })).status).to.equal(400)
    })
  })
})
