// Preserve the verified calendar-aware .8 payload and restore the complete
// managed/embedded integration. Native modules and resources stay unchanged.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, rm, stat, statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { verifyPayload, writeManifest } from './package.mjs'
import { removeManagedV1 } from './managed-api-v1.mjs'
import { applyManagedApi, PINNED_SERVER_SHA256 } from './managed-api.mjs'
import { webDigest, normalizeWebOutput } from './embedded-web.mjs'
import { requireArchiveSpace } from './archive-space.mjs'

const run = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex')
async function digest(file) { const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex') }
const [baseInput, webInput, provenanceFile, outputInput] = process.argv.slice(2)
assert(baseInput && webInput && provenanceFile && outputInput, 'Usage: rebuild-recovery-package.mjs <verified-alpha8-payload> <embedded-web-out> <provenance.json> <new-output>')
const base=resolve(baseInput), web=resolve(webInput), output=resolve(outputInput)
const trustedManifest='9bd6883ec26902a2e45b2d7bebe4d64f7420a923a842567addb611cd25ac86d8'
assert.equal(await digest(join(base,'component.json')),trustedManifest,'Unrecognized recovery base')
const original=await verifyPayload(base)
assert.equal(original.arch,'arm64');assert.equal(original.version,'0.1.0-alpha.8')
const pin=JSON.parse(await readFile(new URL('./upstream.json',import.meta.url),'utf8'))
const overlay=JSON.parse(await readFile(new URL('./embedded-web.json',import.meta.url),'utf8'))
const provenance=JSON.parse(await readFile(provenanceFile,'utf8'))
assert.equal(original.upstreamCommit,pin.upstreamCommit)
assert.equal(provenance.upstreamCommit,pin.upstreamCommit)
assert.equal(provenance.patchSha256,overlay.patchSha256)
assert.equal(provenance.mode,'kelly-project-v1')
assert.equal(await webDigest(web),provenance.webSha256)
await mkdir(output) // Never mutate/reuse an existing candidate.
const payload=join(output,'payload')
await run('/bin/cp',['-cpR',base,payload])
const server=join(payload,'apps/daemon/dist/server.js')
const raw=removeManagedV1(await readFile(server,'utf8'))
assert.equal(sha(raw),PINNED_SERVER_SHA256,'Unexpected calendar-aware server')
await writeFile(server,raw)
await applyManagedApi(payload)
await rm(join(payload,'apps/web/out'),{recursive:true})
await run('/bin/cp',['-cpR',web,join(payload,'apps/web/out')])
await normalizeWebOutput(join(payload,'apps/web/out'))
const {files:unusedFiles,...metadata}=original
void unusedFiles
const updated=await writeManifest(payload,{...metadata,version:pin.version,managedRuntimeVersion:2,embeddedWeb:provenance})
const unchanged=files=>files.filter(f=>!f.path.startsWith('apps/daemon/dist/')&&!f.path.startsWith('apps/web/out/'))
assert.deepEqual(unchanged(updated.files),unchanged(original.files),'Recovery changed native/runtime/resources')
await verifyPayload(payload)
const disk=await statfs(output)
const space=requireArchiveSpace(updated,disk.bavail*disk.bsize)
await writeFile(join(output,'disk-guard.json'),JSON.stringify(space,null,2)+'\n')
const archive=join(output,'design-studio-darwin-arm64.tar.gz')
await run('/usr/bin/tar',['-czf',archive,'-C',payload,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}})
const report={version:pin.version,upstreamCommit:pin.upstreamCommit,arch:'arm64',bytes:(await stat(archive)).size,sha256:await digest(archive),manifestSha256:await digest(join(payload,'component.json')),baseManifestSha256:trustedManifest,managedRuntimeVersion:2,embeddedWeb:provenance,unchangedNativeRuntimeResources:true}
await writeFile(join(output,'archive.json'),JSON.stringify(report,null,2)+'\n')
await writeFile(join(output,'component.json'),await readFile(join(payload,'component.json')))
console.log(JSON.stringify(report))
