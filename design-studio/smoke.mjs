import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyPayload } from './package.mjs'

const payload = resolve(process.argv[2])
const evidence = resolve(process.argv[3])
const manifest = await verifyPayload(payload)
const profile = await mkdtemp(join(tmpdir(), 'kelly-design-smoke-'))
await mkdir(evidence, { recursive: true })
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise(resolveClose => probe.close(resolveClose))
let output = ''
let child
try {
  child = spawn(join(payload, 'bin/node'), [join(payload, 'launcher.mjs')], {
    cwd: profile,
    env: { HOME: profile, PATH: '/usr/bin:/bin', TMPDIR: tmpdir(), OD_DATA_DIR: join(profile, 'data'), OD_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.on('error', error => { output += `${error.stack}\n` })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-128 * 1024) })
  let health
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `Daemon exited before readiness: ${output}`)
    assert.ok(!child.signalCode, `Daemon terminated before readiness: ${output}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        health = await response.json()
        if (health.ok === true) break
      }
    } catch {}
    await delay(250)
  }
  assert.equal(health?.ok, true, `Readiness deadline exceeded: ${output}`)
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/html/)
  assert.match(await response.text(), /_next\/static/)
  const result = { ok: true, version: manifest.version, upstreamCommit: manifest.upstreamCommit, health, systemNodeOnPath: false, appRoot: payload }
  await writeFile(join(evidence, 'smoke.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await Promise.race([exited, delay(8000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
  await writeFile(join(evidence, 'daemon.log'), output)
  await rm(profile, { recursive: true, force: true })
}
