const { expect } = require('chai')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const { hashFile, statFile, ByteRateLimiter, FileHashError } = require('../../../../server/utils/duplicateDetection/fileHasher')

describe('duplicateDetection/fileHasher', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-hash-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFile(name, content) {
    const path = Path.join(tmpDir, name)
    fs.writeFileSync(path, content)
    return path
  }

  async function expectHashError(promise, code) {
    try {
      await promise
    } catch (error) {
      expect(error).to.be.instanceOf(FileHashError)
      expect(error.code).to.equal(code)
      return error
    }
    throw new Error(`Expected FileHashError ${code}`)
  }

  it('computes the SHA-256 of the whole file across many chunks', async () => {
    const content = crypto.randomBytes(256 * 1024 + 17)
    const path = writeFile('a.bin', content)
    const result = await hashFile(path, { chunkSize: 4096 })
    expect(result.hash).to.equal(crypto.createHash('sha256').update(content).digest('hex'))
    expect(result.size).to.equal(content.length)
    expect(result.ino).to.be.a('string')
    expect(result.dev).to.be.a('string')
  })

  it('hashes an empty file', async () => {
    const path = writeFile('empty.bin', Buffer.alloc(0))
    const result = await hashFile(path)
    expect(result.hash).to.equal(crypto.createHash('sha256').digest('hex'))
  })

  it('scenario 19: reports missing files', async () => {
    await expectHashError(hashFile(Path.join(tmpDir, 'missing.mp3')), 'ENOENT')
    await expectHashError(statFile(Path.join(tmpDir, 'missing.mp3')), 'ENOENT')
  })

  it('scenario 19: reports unreadable files', async function () {
    if (process.getuid && process.getuid() === 0) {
      // root ignores file permissions; use a directory, which also cannot be hashed
      await expectHashError(hashFile(tmpDir), 'ENOTFILE')
      return
    }
    const path = writeFile('locked.mp3', 'data')
    fs.chmodSync(path, 0o000)
    await expectHashError(hashFile(path), 'EACCES')
  })

  it('scenario 18: fails with CHANGED when the file is modified while it is read', async () => {
    const path = writeFile('changing.mp3', crypto.randomBytes(64 * 1024))
    let modified = false
    const rateLimiter = {
      consume: async () => {
        if (!modified) {
          modified = true
          fs.appendFileSync(path, 'more data')
        }
      }
    }
    await expectHashError(hashFile(path, { chunkSize: 1024, rateLimiter }), 'CHANGED')
  })

  it('scenario 18: fails with CHANGED when the path is replaced while it is read', async () => {
    const path = writeFile('replaced.mp3', crypto.randomBytes(64 * 1024))
    const replacement = writeFile('replacement.tmp', crypto.randomBytes(64 * 1024))
    let replaced = false
    const rateLimiter = {
      consume: async () => {
        if (!replaced) {
          replaced = true
          fs.renameSync(replacement, path)
        }
      }
    }
    await expectHashError(hashFile(path, { chunkSize: 1024, rateLimiter }), 'CHANGED')
  })

  it('scenario 20: stops reading when aborted', async () => {
    const path = writeFile('big.bin', crypto.randomBytes(512 * 1024))
    const controller = new AbortController()
    let reads = 0
    const rateLimiter = {
      consume: async () => {
        reads++
        if (reads === 3) controller.abort()
      }
    }
    await expectHashError(hashFile(path, { chunkSize: 1024, rateLimiter, signal: controller.signal }), 'ABORTED')
    expect(reads).to.equal(3)
  })

  it('does not start when already aborted', async () => {
    const path = writeFile('x.bin', 'abc')
    const controller = new AbortController()
    controller.abort()
    await expectHashError(hashFile(path, { signal: controller.signal }), 'ABORTED')
  })

  it('limits throughput with ByteRateLimiter', async () => {
    const path = writeFile('rate.bin', crypto.randomBytes(200 * 1024))
    const limiter = new ByteRateLimiter(1024 * 1024) // 1 MiB/s -> 200 KiB takes ~195ms
    const started = Date.now()
    await hashFile(path, { chunkSize: 16 * 1024, rateLimiter: limiter })
    expect(Date.now() - started).to.be.at.least(150)
  })

  it('ByteRateLimiter sleeps are cancelable', async () => {
    const limiter = new ByteRateLimiter(1024) // 1 KiB/s
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    await expectHashError(limiter.consume(100 * 1024, controller.signal), 'ABORTED')
    expect(Date.now() - started).to.be.below(1000)
  })
})
