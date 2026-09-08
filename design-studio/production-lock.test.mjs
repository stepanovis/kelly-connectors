import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyProductionLock } from './production-lock.mjs'

function fixture() {
  const source = {
    lockfileVersion: '9.0',
    importers: {
      'apps/daemon': { dependencies: { '@open-design/example': { version: 'link:../../packages/example' } } },
      'packages/example': { dependencies: { external: { version: '1.0.0' } } },
    },
    packages: { 'external@1.0.0': { resolution: { integrity: 'sha512-source' } } },
    snapshots: { 'external@1.0.0': {} },
  }
  const deployed = {
    lockfileVersion: '9.0',
    importers: { 'apps/daemon': { dependencies: { '@open-design/example': { version: 'file:packages/example' } } } },
    packages: {
      ...structuredClone(source.packages),
      '@open-design/example@file:packages/example': { resolution: { type: 'directory', directory: 'packages/example' } },
    },
    snapshots: {
      ...structuredClone(source.snapshots),
      '@open-design/example@file:packages/example': { dependencies: { external: '1.0.0' } },
    },
  }
  return { source, deployed, names: { 'packages/example': '@open-design/example' } }
}

test('production lock preserves source resolutions and workspace edges', () => {
  const { source, deployed, names } = fixture()
  assert.deepEqual(verifyProductionLock(source, deployed, names), { external: 1, workspace: 1 })
})

test('production lock checks peer-qualified snapshots against their package resolution', () => {
  const { source, deployed, names } = fixture()
  for (const lock of [source, deployed]) {
    lock.snapshots['external@1.0.0(peer@2.0.0)'] = lock.snapshots['external@1.0.0']
    delete lock.snapshots['external@1.0.0']
  }
  assert.deepEqual(verifyProductionLock(source, deployed, names), { external: 1, workspace: 1 })
  deployed.snapshots['external@1.0.0(peer@3.0.0)'] = deployed.snapshots['external@1.0.0(peer@2.0.0)']
  delete deployed.snapshots['external@1.0.0(peer@2.0.0)']
  assert.throws(() => verifyProductionLock(source, deployed, names), /External snapshot differs/)
})

for (const [label, mutate] of [
  ['external integrity', d => { d.packages['external@1.0.0'].resolution.integrity = 'sha512-other' }],
  ['external edges', d => { d.snapshots['external@1.0.0'].dependencies = { injected: '2.0.0' } }],
  ['workspace edges', d => { d.snapshots['@open-design/example@file:packages/example'].dependencies.external = '2.0.0' }],
  ['daemon edges', d => { d.importers['apps/daemon'].dependencies.injected = { version: '2.0.0' } }],
  ['workspace escape', d => { d.packages['@open-design/example@file:packages/example'].resolution.directory = '../escape' }],
  ['missing snapshot', d => { delete d.snapshots['external@1.0.0'] }],
]) {
  test(`production lock rejects changed ${label}`, () => {
    const { source, deployed, names } = fixture()
    mutate(deployed)
    assert.throws(() => verifyProductionLock(source, deployed, names))
  })
}
