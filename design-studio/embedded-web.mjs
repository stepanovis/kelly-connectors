import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, writeFile, readdir, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

// Static files never need executable or group-write bits. Canonical modes
// survive normal user tar extraction regardless of the builder's umask.
export async function normalizeWebOutput(root) {
  await chmod(root, 0o755)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await normalizeWebOutput(path)
    else if (entry.isFile()) await chmod(path, 0o644)
    else throw new Error(`Unexpected web output entry: ${path}`)
  }
}

export async function webDigest(root) {
  const files = []
  async function visit(path = '') {
    for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path ? `${path}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile()) files.push([name, hash(await readFile(join(root, name)))])
      else throw new Error(`Unexpected web output entry: ${name}`)
    }
  }
  await visit()
  if (!files.some(([name]) => name === 'index.html')) throw new Error('Missing web entry')
  return hash(JSON.stringify(files))
}

// Apply the reviewed source patch only around the web build. Every upstream
// byte is pinned; failed builds restore the checkout. An interrupted process
// leaves a dirty checkout, which the next build rejects rather than reusing.
export async function withEmbeddedWeb(source, run) {
  const manifest = JSON.parse(await readFile(join(directory, 'embedded-web.json'), 'utf8'))
  const patch = await readFile(join(directory, 'embedded-web.patch'))
  if (hash(patch) !== manifest.patchSha256) throw new Error('Embedded web patch digest mismatch')
  for (const [file, digest] of Object.entries(manifest.sources)) {
    if (hash(await readFile(join(source, file))) !== digest) throw new Error(`Unknown embedded web source: ${file}`)
  }
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== manifest.upstreamCommit) throw new Error('Unexpected embedded web upstream commit')
  if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
    throw new Error('Embedded web requires a clean dedicated checkout')
  }
  const git = args => execFileSync('git', ['-C', source, 'apply', ...args], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
  git(['--check', '-'])
  git(['-'])
  try {
    return await run({ patchSha256: manifest.patchSha256, upstreamCommit: manifest.upstreamCommit, mode: 'kelly-project-v1' })
  } finally {
    // --check is atomic across files. If someone edited the patched sources,
    // retain their changes and fail instead of blindly overwriting them.
    git(['--reverse', '--check', '-'])
    git(['--reverse', '-'])
  }
}

function command(source, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }
    delete env.OD_WEB_OUTPUT_MODE
    const child = spawn('pnpm', args, { cwd: source, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Embedded web command failed: ${code ?? signal}`)))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, evidence] = process.argv.slice(2)
  if (source === '--normalize-output') {
    if (!evidence) throw new Error('Missing web output directory')
    await normalizeWebOutput(evidence)
  } else {
    if (!source || !evidence) throw new Error('Usage: embedded-web.mjs <clean-pinned-source> <evidence.json>')
    await withEmbeddedWeb(resolve(source), async provenance => {
      await command(source, ['--filter', '@open-design/web', 'test', 'tests/kelly-embedded-navigation.test.ts', 'tests/router.test.ts', 'tests/router.navigate.test.tsx', 'tests/components/WorkspaceTabsBar.test.tsx', 'tests/components/ChatPane.conversation-title.test.tsx'])
      await command(source, ['--filter', '@open-design/web', 'run', 'build'])
      await writeFile(evidence, JSON.stringify({ ...provenance, webSha256: await webDigest(join(source, 'apps/web/out')) }, null, 2) + '\n')
    })
  }
}
