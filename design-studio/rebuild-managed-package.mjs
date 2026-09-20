// Reuse verified immutable component bytes; apply the pinned managed-writer
// overlay without rebuilding or modifying the installed native runtime.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, unlink, stat, statfs } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { verifyPayload, writeManifest } from './package.mjs'
import { applyManagedApi, PINNED_SERVER_SHA256 } from './managed-api.mjs'
import { requireArchiveSpace } from './archive-space.mjs'

const run = promisify(execFile)
const [base, archive, arch, output] = process.argv.slice(2)
assert(base && archive && output, 'Usage: rebuild-managed-package.mjs <verified-alpha4-arm64-payload> <alpha6-archive> <arch> <new-output>')
const trusted = {
  arm64: { archive: '53138461c605b23faec111ad7d300aa250cad57eda5aa734b70047d09a92e785', manifest: '351055b8ac989d51c6dd651c996276e95cd7fc062305016c065d480703f3a7d9' },
  x64: { archive: '9e5c638973ee9e8ea52c1c2bb3848ebc47f4ed871374c006cfffea04839a4a9f', manifest: '943813eb28905960d37f4dd6f6ef587dc1eb3606042d1b233df0a3938e0bd9b6' },
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
assert(trusted[arch], 'Unsupported architecture')
assert.equal(await digest(archive), trusted[arch].archive, 'Unrecognized archive')
assert.equal(await digest(join(base, 'component.json')), '476e5ca45a88ab107079ab72ed79ef82a60db91d8f97404e42fe13df30c0f7ba', 'Unrecognized installed base')
const original = await verifyPayload(base)
const { stdout: manifestBytes } = await run('/usr/bin/tar', ['-xOf', archive, './component.json'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })
assert.equal(sha(manifestBytes), trusted[arch].manifest)
const reviewed = JSON.parse(manifestBytes)
assert.equal(reviewed.arch, arch)
assert.equal(reviewed.version, '0.1.0-alpha.6')
const pin = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'))
assert.equal(reviewed.upstreamCommit, pin.upstreamCommit)

await mkdir(output) // Refuse an existing output; never overwrite a candidate.
const payload = join(output, 'payload')
await run('/bin/cp', ['-cpR', base, payload])
const old = new Map(original.files.map(item => [item.path, item]))
const next = new Map(reviewed.files.map(item => [item.path, item]))
const replace = reviewed.files.filter(item => JSON.stringify(item) !== JSON.stringify(old.get(item.path)))
// Only verified manifest leaves are removed. Existing directory trees are retained.
for (const item of original.files) if (!next.has(item.path) || replace.some(other => other.path === item.path)) await unlink(join(payload, item.path))
const selection = join(output, 'archive-selection.txt')
await writeFile(selection, replace.map(item => './' + item.path).join('\n') + '\n')
await run('/usr/bin/tar', ['-xzf', archive, '-C', payload, '-T', selection])
await writeFile(join(payload, 'component.json'), manifestBytes)
await verifyPayload(payload) // Full equality to the independently reviewed .6, including native bytes.

const server = join(payload, 'apps/daemon/dist/server.js')
let source = await readFile(server, 'utf8')
source = source.replace('// Modified by Kelly: host authorization and project launch boundary (#1051).\nexport const KELLY_MANAGED_RUNTIME_VERSION = 1;\n', '')
source = source.replace('inheritedEnvironment = () => ({}), authorizeRequest = null, prepareAgentLaunch = null, odNextExecutionPreflightResolver', 'inheritedEnvironment = () => ({}), odNextExecutionPreflightResolver')
source = source.replace(`
    if (authorizeRequest !== null) {
        if (typeof authorizeRequest !== 'function') throw new Error('Invalid host request authorizer');
        app.use((req, res, next) => {
            const preview = req.method === 'GET' ? parseProjectPreviewAssetPath(req.path) : null;
            const scopedPreview = Boolean(preview && projectPreviewScopes.validate(preview.projectId, preview.scope));
            if (authorizeRequest(req, scopedPreview) === true) return next();
            return res.status(401).json({ error: { code: 'KELLY_HOST_AUTH', message: 'Managed Design Studio authorization required' } });
        });
    }`, '')
source = source.replace(`            const managedLaunch = prepareAgentLaunch
                ? await prepareAgentLaunch({ agentId: def.id, command: agentLaunch.launchPath, args, env, cwd: effectiveCwd })
                : { command: agentLaunch.launchPath, args };
            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({ command: managedLaunch.command, args: managedLaunch.args, env });`, `            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({
                command: agentLaunch.launchPath,
                args,
                env,
            });`)
assert.equal(sha(source), PINNED_SERVER_SHA256, 'Original server reconstruction differs from pinned upstream')
await writeFile(server, source)
await applyManagedApi(payload)
const { files: _files, ...metadata } = reviewed
const updated = await writeManifest(payload, { ...metadata, version: pin.version, managedRuntimeVersion: 2 })
const unchanged = files => files.filter(item => !item.path.startsWith('apps/daemon/dist/'))
assert.deepEqual(unchanged(updated.files), unchanged(reviewed.files), 'Managed overlay changed native/runtime/UI/resource bytes')
await verifyPayload(payload)
const space = await statfs(output)
requireArchiveSpace(updated, space.bavail * space.bsize)
const packed = join(output, `design-studio-darwin-${arch}.tar.gz`)
await run('/usr/bin/tar', ['-czf', packed, '-C', payload, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
const report = { version: pin.version, arch, bytes: (await stat(packed)).size, sha256: await digest(packed), manifestSha256: await digest(join(payload, 'component.json')), baseArchiveSha256: trusted[arch].archive, managedRuntimeVersion: 2, unchangedNativeAndWeb: true }
await writeFile(join(output, 'archive.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(join(output, 'component.json'), await readFile(join(payload, 'component.json')))
console.log(JSON.stringify(report))
