import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = readFileSync(new URL('./upload-storage.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/m, '').replace('export function ', 'function ')

function fixture(invoke, project = true) {
  const fallbackCalls = []
  const context = vm.createContext({ hasKellyFileWriter: () => true, invokeKellyFileWriter: invoke })
  vm.runInContext(source, context)
  const storage = context.createKellyUploadStorage({ memoryStorage: () => ({
    _handleFile: (_req, _file, cb) => cb(null, { buffer: Buffer.from('retained bytes') }),
    _removeFile: (_req, _file, cb) => cb(null),
  }) }, {
    _handleFile: () => fallbackCalls.push('write'),
    _removeFile: () => fallbackCalls.push('remove'),
  }, project ? { projectsRoot: '/projects', metadata: () => ({ marker: 'server' }), decodeName: name => name } : undefined)
  return { storage, fallbackCalls, req: { params: { id: 'a' }, body: { dir: 'images' } } }
}
const handle = (storage, req) => new Promise((resolve, reject) => storage._handleFile(req, { originalname: 'image.png' }, (error, value) => error ? reject(error) : resolve(value)))

test('parser hands a single upload to the route as bytes without any filesystem writer', async () => {
  const f = fixture(() => { throw Error('unexpected write') }, false)
  assert.equal((await handle(f.storage, f.req)).buffer.toString(), 'retained bytes')
  assert.deepEqual(f.fallbackCalls, [])
})

test('batch bytes and server metadata reach the protected writer, cleanup uses only its relative result', async () => {
  const requests = []
  const f = fixture(async (name, args) => {
    requests.push({ name, args })
    return { path: '/projects/a/images/image.png', relPath: 'images/image.png', relDir: 'images', filename: 'image.png' }
  })
  const saved = await handle(f.storage, f.req)
  assert.equal(requests[0].name, 'projects.saveProjectUpload')
  assert.equal(requests[0].args[1], 'a')
  assert.equal(requests[0].args[4].toString(), 'retained bytes')
  assert.equal(requests[0].args[5].marker, 'server')
  saved.path = '/outside/forged'
  await new Promise((resolve, reject) => f.storage._removeFile(f.req, saved, error => error ? reject(error) : resolve()))
  assert.equal(requests[1].name, 'projects.deleteProjectFile')
  assert.equal(requests[1].args[2], 'images/image.png')
  assert.deepEqual(f.fallbackCalls, [])
})

for (const synchronous of [false, true]) test(`writer ${synchronous ? 'synchronous' : 'asynchronous'} failure reaches multer without fallback or retry`, async () => {
  let requests = 0
  const fail = () => { requests++; throw Error('writer outcome unknown') }
  const f = fixture(synchronous ? fail : async () => fail())
  await assert.rejects(handle(f.storage, f.req), /outcome unknown/)
  assert.equal(requests, 1)
  assert.deepEqual(f.fallbackCalls, [])
})
