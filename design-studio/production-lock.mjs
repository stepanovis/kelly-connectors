import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function versions(importer, field, directory) {
  return Object.fromEntries(Object.entries(importer[field] ?? {}).map(([name, dependency]) => {
    const version = dependency.version
    return [name, version.startsWith('link:') ? `file:${posix.normalize(posix.join(directory, version.slice(5)))}` : version]
  }))
}

export function verifyProductionLock(source, deployed, workspaceNames) {
  assert.equal(source.lockfileVersion, '9.0', 'Unsupported source lockfile version')
  assert.equal(deployed.lockfileVersion, source.lockfileVersion, 'Deployed lockfile version differs')
  const packageKeys = new Set(Object.keys(deployed.snapshots).map(key => key.split('(')[0]))
  assert.deepEqual([...packageKeys].sort(), Object.keys(deployed.packages).sort(), 'Package/snapshot set differs')
  assert.ok(deployed.importers['apps/daemon'], 'Deployed daemon importer missing')
  const counts = { external: 0, workspace: 0 }
  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.deepEqual(versions(deployed.importers['apps/daemon'], field, 'apps/daemon'), versions(source.importers['apps/daemon'], field, 'apps/daemon'), `Daemon ${field} differs`)
  }
  for (const [key, entry] of Object.entries(deployed.packages)) {
    if (entry.resolution.type === 'directory') {
      const snapshot = deployed.snapshots[key]
      const directory = entry.resolution.directory
      assert.match(directory, /^packages\/[a-zA-Z0-9_-]+$/, 'Invalid workspace directory')
      assert.ok(workspaceNames[directory], `Workspace package missing: ${directory}`)
      assert.equal(key, `${workspaceNames[directory]}@file:${directory}`, 'Workspace identity differs')
      const importer = source.importers[directory]
      assert.ok(importer, `Source workspace importer missing: ${directory}`)
      for (const field of ['dependencies', 'optionalDependencies']) {
        assert.deepEqual(snapshot[field] ?? {}, versions(importer, field, directory), `Workspace ${key} ${field} differs`)
      }
      counts.workspace++
    } else {
      assert.ok(source.packages[key], `Unknown external package: ${key}`)
      assert.deepEqual(entry.resolution, source.packages[key].resolution, `External resolution differs: ${key}`)
      counts.external++
    }
  }
  for (const [key, snapshot] of Object.entries(deployed.snapshots)) {
    if (deployed.packages[key.split('(')[0]].resolution.type === 'directory') continue
    assert.deepEqual(snapshot, source.snapshots[key], `External snapshot differs: ${key}`)
  }
  return counts
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourceRoot, payload, evidencePath] = process.argv.slice(2)
  assert.ok(sourceRoot && payload && evidencePath, 'Usage: production-lock.mjs <source> <payload> <evidence-file>')
  // The pinned upstream installation already supplies this parser. No extra
  // network install or unpinned build dependency is introduced here.
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const yamlVersion = packageJson.pnpm.overrides.yaml
  assert.match(yamlVersion, /^\d+\.\d+\.\d+$/)
  const parserPath = join(resolve(sourceRoot), `node_modules/.pnpm/yaml@${yamlVersion}/node_modules/yaml/package.json`)
  const { parse } = createRequire(parserPath)('./dist/index.js')
  const sourceText = await readFile(join(sourceRoot, 'pnpm-lock.yaml'), 'utf8')
  const deployedText = await readFile(join(payload, 'apps/daemon/node_modules/.pnpm/lock.yaml'), 'utf8')
  const source = parse(sourceText)
  const deployed = parse(deployedText)
  const workspaceNames = {}
  for (const entry of Object.values(deployed.packages)) {
    if (entry.resolution.type !== 'directory') continue
    const directory = entry.resolution.directory
    assert.match(directory, /^packages\/[a-zA-Z0-9_-]+$/)
    workspaceNames[directory] = JSON.parse(await readFile(join(sourceRoot, directory, 'package.json'), 'utf8')).name
  }
  const result = {
    ok: true,
    ...verifyProductionLock(source, deployed, workspaceNames),
    sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
    deployedSha256: createHash('sha256').update(deployedText).digest('hex'),
  }
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
}
