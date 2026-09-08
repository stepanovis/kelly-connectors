import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { stopOwnedProcessGroup } from './process-group.mjs'

for (const exitBeforeStop of [false, true]) {
  test(`shutdown stops probes and preserves unrelated processes (parent exited: ${exitBeforeStop})`, { timeout: 5000 }, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'kelly-design-processes-'))
    const heartbeat = join(directory, 'heartbeat')
    const writer = `const fs=require('node:fs'); setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10); console.log('ready')`
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},process.argv[1]],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`
    const owned = spawn(process.execPath, ['-e', parent, heartbeat], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    context.after(async () => {
    const outcomes = await Promise.allSettled([owned, unrelated].map(child => stopOwnedProcessGroup(child, 100)))
    await delay(30)
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
    })
    await new Promise((resolve, reject) => {
      owned.once('error', reject)
      owned.stdout.on('data', chunk => { if (chunk.toString().includes('ready')) resolve() })
    })
    await delay(30)
    if (exitBeforeStop) {
      const exited = once(owned, 'exit')
      owned.kill('SIGTERM')
      await exited
    }
    await stopOwnedProcessGroup(owned)
    await delay(50)
    const stopped = await readFile(heartbeat, 'utf8')
    await delay(80)
    assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'background probe survived parent shutdown')
    assert.equal(unrelated.exitCode, null, 'unrelated process was stopped')
    process.kill(unrelated.pid, 0)
  })
}
