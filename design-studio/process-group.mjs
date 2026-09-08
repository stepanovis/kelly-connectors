import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

async function hasLiveGroupMember(pgid) {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='])
  return stdout.trim().split('\n').some(line => {
    const [group, state] = line.trim().split(/\s+/)
    return Number(group) === pgid && !state.startsWith('Z')
  })
}

// Only accepts children created by this caller with detached: true on macOS.
// Capability probes can outlive the daemon, so its exit alone is not shutdown.
export async function stopOwnedProcessGroup(child, graceMs = 8000) {
  if (!child?.pid) return
  const exited = child.exitCode === null && child.signalCode === null
    ? once(child, 'exit')
    : Promise.resolve()
  const signal = async (name) => {
    try { process.kill(-child.pid, name) } catch (error) {
      if (error.code === 'ESRCH') return
      // macOS can report EPERM when the group only contains exiting zombies.
      // A failed signal to a live member is still an error, never a silent PASS.
      if (error.code === 'EPERM' && !(await hasLiveGroupMember(child.pid))) return
      throw error
    }
  }
  await signal('SIGTERM')
  await Promise.race([exited, delay(graceMs, undefined, { ref: false })])
  await signal('SIGKILL')
  await exited
}
