// Rebuild a UI-only component from a verified released native payload and the
// reproducible embedded-web output. Native/runtime/resources remain byte-identical.
import assert from 'node:assert/strict'
import { constants, createReadStream } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPayload, writeManifest } from './package.mjs'
import { requireArchiveSpace } from './archive-space.mjs'
import { webDigest, normalizeWebOutput } from './embedded-web.mjs'
const directory = dirname(fileURLToPath(import.meta.url))
const [base, web, provenanceFile, output] = process.argv.slice(2)
assert(base && web && provenanceFile && output, 'Usage: rebuild-web-package.mjs <released-payload> <web-out> <embedded-web.json> <new-output>')
const pin = JSON.parse(await readFile(join(directory, 'upstream.json'), 'utf8'))
const overlay = JSON.parse(await readFile(join(directory, 'embedded-web.json'), 'utf8'))
const baseDigests = {
  arm64: ['476e5ca45a88ab107079ab72ed79ef82a60db91d8f97404e42fe13df30c0f7ba', '1e4739737931c85a0e1119c7fa9aadf35bb7d8157a29610a9a6f487bca0881d7', '6a5865dece6506718f2279f6b2d1c53a672c1d8ec624e00e9c5f9fc829f2db22'],
  x64: ['998ec5a67eb40266fe9419d7ab9b9bd821653dac20819b5087833b41d2a53c1b', '11fe65ff10d107a76c8b34ae049c773b91ad96c9d91a2098e03b9e2e453db452', '474fe26d3109b03fe931c70d1c545c6727534a602bafc81ad778dee124464ec4'],
}
async function digest(file) { const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex') }
const manifest = await verifyPayload(base)
const baseManifestSha256 = await digest(join(base,'component.json'))
assert(baseDigests[manifest.arch]?.includes(baseManifestSha256), 'Unrecognized native base')
assert.equal(manifest.upstreamCommit,pin.upstreamCommit)
const provenance=JSON.parse(await readFile(provenanceFile,'utf8'))
assert.equal(provenance.patchSha256,overlay.patchSha256)
assert.equal(provenance.upstreamCommit,pin.upstreamCommit)
assert.equal(provenance.mode,'kelly-project-v1')
assert.equal(await webDigest(web),provenance.webSha256,'Web output does not match the build evidence')
await mkdir(output) // Existing output is never overwritten.
const payload=join(output,'payload')
try {
 // macOS cp -c preserves APFS sharing; Node copyFile reflinks are Linux-only.
 await promisify(execFile)('/bin/cp',['-cpR',base,payload])
 await rm(join(payload,'apps/web/out'),{recursive:true})
 await cp(web,join(payload,'apps/web/out'),{recursive:true,mode:constants.COPYFILE_FICLONE,verbatimSymlinks:true})
 await normalizeWebOutput(join(payload,'apps/web/out'))
 const updated=await writeManifest(payload,{version:pin.version,upstreamCommit:pin.upstreamCommit,upstreamVersion:pin.upstreamVersion,platform:manifest.platform,arch:manifest.arch,nodeVersion:manifest.nodeVersion,embeddedWeb:provenance})
 const nativeFiles=files=>files.filter(file=>!file.path.startsWith('apps/web/out/'))
 assert.deepEqual(nativeFiles(updated.files),nativeFiles(manifest.files),'UI-only repack changed native/runtime/resource bytes')
 await verifyPayload(payload)
 const disk=await statfs(payload)
 requireArchiveSpace(updated,disk.bavail*disk.bsize)
 const archive=join(output,`design-studio-darwin-${manifest.arch}.tar.gz`)
 await promisify(execFile)('/usr/bin/tar',['-czf',archive,'-C',payload,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}})
 const report={version:pin.version,arch:manifest.arch,bytes:(await stat(archive)).size,sha256:await digest(archive),manifestSha256:await digest(join(payload,'component.json')),baseManifestSha256,embeddedWeb:provenance,nativeFilesUnchanged:true}
 await cp(join(payload,'component.json'),join(output,'component.json'))
 await writeFile(join(output,'archive.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report))
} catch(error) { await rm(output,{recursive:true,force:true});throw error }
