import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const requiredFiles = ['bin/node', 'launcher.mjs', 'package.json', 'apps/daemon/dist/cli.js', 'apps/daemon/package.json', 'apps/web/out/index.html', 'LICENSE', 'NODE-LICENSE']

export async function relocateSelfReference(directory, source) {
  const daemon = join(directory, 'apps/daemon')
  const selfLink = join(daemon, 'node_modules/.pnpm/node_modules/@open-design/daemon')
  let linkStat
  try {
    linkStat = await lstat(selfLink)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!linkStat.isSymbolicLink()) throw new Error('Unexpected daemon self-reference')
  const target = await realpath(selfLink)
  if (target === await realpath(daemon)) return
  if (target !== await realpath(join(source, 'apps/daemon'))) throw new Error('Unexpected daemon self-reference target')
  await unlink(selfLink)
  await symlink(relative(dirname(selfLink), daemon), selfLink)
}

async function digest(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export async function inspectPayload(directory) {
  const root = await realpath(directory)
  for (const name of requiredFiles) {
    if (!(await lstat(join(root, name))).isFile()) throw new Error(`Required file missing: ${name}`)
  }
  const files = []
  async function visit(subdirectory) {
    for (const name of (await readdir(join(root, subdirectory))).sort()) {
      const relativePath = join(subdirectory, name)
      if (relativePath === 'component.json') continue
      const filename = join(root, relativePath)
      const stat = await lstat(filename)
      if (stat.isSymbolicLink()) {
        const target = await readlink(filename)
        const resolvedTarget = relative(root, await realpath(filename))
        if (isAbsolute(target) || resolvedTarget === '..' || resolvedTarget.startsWith('../') || isAbsolute(resolvedTarget)) {
          throw new Error(`Link outside payload: ${relativePath} -> ${target}`)
        }
        files.push({ path: relativePath, target })
      } else if (stat.isDirectory()) {
        await visit(relativePath)
      } else if (stat.isFile()) {
        files.push({ path: relativePath, bytes: stat.size, mode: stat.mode & 0o777, sha256: await digest(filename) })
      } else {
        throw new Error(`Unsupported payload entry: ${relativePath}`)
      }
    }
  }
  await visit('')
  return files
}

export async function writeManifest(directory, metadata) {
  if (!/^[0-9a-f]{40}$/.test(metadata.upstreamCommit) || metadata.platform !== 'darwin' || !['arm64', 'x64'].includes(metadata.arch) || !/^24\./.test(metadata.nodeVersion) || typeof metadata.version !== 'string') {
    throw new Error('Invalid Design Studio build metadata')
  }
  const manifest = {
    schemaVersion: 1,
    name: 'design-studio',
    contractVersion: 1,
    ...metadata,
    runtime: 'bin/node',
    entry: 'launcher.mjs',
    files: await inspectPayload(directory),
  }
  await writeFile(join(directory, 'component.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function verifyPayload(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'component.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.name !== 'design-studio' || manifest.contractVersion !== 1 || manifest.runtime !== 'bin/node' || manifest.entry !== 'launcher.mjs') {
    throw new Error('Unsupported Design Studio manifest')
  }
  if (JSON.stringify(await inspectPayload(directory)) !== JSON.stringify(manifest.files)) {
    throw new Error('Design Studio payload integrity mismatch')
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory, metadataPath] = process.argv.slice(2)
  if (action === 'create') {
    await writeManifest(directory, JSON.parse(await readFile(metadataPath, 'utf8')))
  } else if (action === 'prepare') {
    await relocateSelfReference(directory, metadataPath)
  } else if (action === 'verify') {
    const manifest = await verifyPayload(directory)
    console.log(JSON.stringify({ ok: true, version: manifest.version, files: manifest.files.length }))
  } else {
    throw new Error('Usage: node package.mjs create <payload> <metadata.json> | verify <payload>')
  }
}
