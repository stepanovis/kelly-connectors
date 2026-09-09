import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withEmbeddedWeb } from './embedded-web.mjs'

// Integration control against the actual pinned checkout, with no compilation.
// The caller supplies a clean dedicated checkout; the fixture restores it.
const source = process.argv[2]
assert(source, 'Usage: verify-embedded-web.mjs <clean-pinned-checkout>')
const directory = dirname(fileURLToPath(import.meta.url))
const pin = JSON.parse(await readFile(join(directory, 'embedded-web.json'), 'utf8'))
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pin.upstreamCommit)
const target = join(source, 'apps/web/src/router.ts')
const original = await readFile(target)
let called = false
try {
  await writeFile(target, Buffer.concat([original, Buffer.from('\n// deliberately changed upstream\n')]))
  await assert.rejects(withEmbeddedWeb(source, async () => { called = true }), /Unknown embedded web source/)
  assert.equal(called, false, 'Drift must fail before starting the build')
} finally { await writeFile(target, original) }
await assert.rejects(withEmbeddedWeb(source, async () => {
  called = true
  await access(join(source, 'apps/web/src/features/kellyEmbeddedProject.ts'))
  throw new Error('deliberate build failure')
}), /deliberate build failure/)
assert(called)
assert.deepEqual(await readFile(target), original)
await assert.rejects(access(join(source, 'apps/web/src/features/kellyEmbeddedProject.ts')))
await withEmbeddedWeb(source, async () => { assert((await readFile(target, 'utf8')).includes('allowsEmbeddedNavigation')) })
assert.deepEqual(await readFile(target), original)
console.log(JSON.stringify({ ok: true, driftRejected: true, failureRestoresSource: true, successRestoresSource: true, patchSha256: pin.patchSha256 }))
