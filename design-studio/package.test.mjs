import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectPayload, relocateSelfReference, verifyPayload, writeManifest } from './package.mjs'

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'kelly-design-package-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['bin/node', 'launcher.mjs', 'package.json', 'apps/daemon/dist/cli.js', 'apps/daemon/package.json', 'apps/web/out/index.html', 'LICENSE', 'NODE-LICENSE']) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), name)
  }
  return root
}

test('payload inventory and manifest survive relocation', async (context) => {
  const root = await fixture(context)
  const manifest = await writeManifest(root, { version: '0.1.0', upstreamCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeVersion: '24.1.0' })
  assert.equal(manifest.files.length, 8)
  assert.equal((await verifyPayload(root)).version, '0.1.0')
  assert.ok(!JSON.stringify(manifest).includes(root))
  const relocated = `${root}-relocated`
  await rename(root, relocated)
  context.after(() => rm(relocated, { recursive: true, force: true }))
  assert.equal((await verifyPayload(relocated)).version, '0.1.0')
})

test('missing web UI is rejected rather than packaging an API-only service', async (context) => {
  const root = await fixture(context)
  await rm(join(root, 'apps/web/out/index.html'))
  await assert.rejects(inspectPayload(root), /apps\/web\/out\/index.html/)
})

test('a symlink outside the package cannot leak build-machine dependencies', async (context) => {
  const root = await fixture(context)
  await symlink(tmpdir(), join(root, 'external'))
  await assert.rejects(inspectPayload(root), /outside payload/)
})

test('relative dependency links inside the payload are supported', async (context) => {
  const root = await fixture(context)
  await symlink('LICENSE', join(root, 'license-link'))
  const manifest = await writeManifest(root, { version: '0.1.0', upstreamCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeVersion: '24.1.0' })
  assert.equal(manifest.files.find(entry => entry.path === 'license-link').target, 'LICENSE')
  await verifyPayload(root)
})

test('pnpm source self-reference is redirected only to the deployed daemon', async (context) => {
  const root = await fixture(context)
  const source = await fixture(context)
  const parent = join(root, 'apps/daemon/node_modules/.pnpm/node_modules/@open-design')
  await mkdir(parent, { recursive: true })
  await symlink(join(source, 'apps/daemon'), join(parent, 'daemon'))
  await assert.rejects(inspectPayload(root), /outside payload/)
  await relocateSelfReference(root, source)
  await inspectPayload(root)
})

test('changed and newly added payload files fail integrity verification', async (context) => {
  const root = await fixture(context)
  await writeManifest(root, { version: '0.1.0', upstreamCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeVersion: '24.1.0' })
  await writeFile(join(root, 'apps/daemon/dist/cli.js'), 'changed')
  await assert.rejects(verifyPayload(root), /integrity/)
  await writeFile(join(root, 'apps/daemon/dist/cli.js'), 'apps/daemon/dist/cli.js')
  await writeFile(join(root, 'unexpected.mjs'), 'extra')
  await assert.rejects(verifyPayload(root), /integrity/)
})
