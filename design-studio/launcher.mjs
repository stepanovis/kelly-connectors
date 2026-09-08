import { mkdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const daemon = join(root, 'apps/daemon/dist/cli.js')
const requireDaemon = createRequire(join(root, 'apps/daemon/package.json'))

if (process.argv[2] === '--check-native') {
  const Database = requireDaemon('better-sqlite3')
  const database = new Database(':memory:')
  if (database.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('SQLite check failed')
  database.close()
  if (typeof requireDaemon('node-pty').spawn !== 'function') throw new Error('PTY check failed')
  console.log(JSON.stringify({ ok: true, node: process.versions.node, platform: process.platform, arch: process.arch, nativeModules: Object.keys(requireDaemon.cache).filter(filename => filename.endsWith('.node')) }))
} else {
  const dataDirectory = process.env.OD_DATA_DIR
  const port = Number(process.env.OD_PORT)
  if (!dataDirectory || !isAbsolute(dataDirectory)) throw new Error('Kelly must provide an absolute OD_DATA_DIR')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Kelly must provide OD_PORT between 1024 and 65535')
  let canonicalDataDirectory
  try {
    canonicalDataDirectory = await realpath(dataDirectory)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    canonicalDataDirectory = join(await realpath(dirname(dataDirectory)), basename(dataDirectory))
  }
  const dataRelative = relative(await realpath(root), canonicalDataDirectory)
  if (!dataRelative.startsWith('../') && dataRelative !== '..' && !isAbsolute(dataRelative)) throw new Error('Design data must stay outside the versioned package')
  await mkdir(canonicalDataDirectory, { recursive: true })
  process.env.OD_DATA_DIR = canonicalDataDirectory
  process.env.OD_RESOURCE_ROOT = join(root, 'resources')
  process.env.OD_BIND_HOST = '127.0.0.1'
  process.env.NODE_ENV = 'production'
  process.argv = [process.execPath, daemon, 'daemon', 'start', '--headless', '--serve-web', '--host', '127.0.0.1', '--port', String(port)]
  await import(pathToFileURL(daemon).href)
}
