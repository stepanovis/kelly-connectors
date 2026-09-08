import { readFile, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function requireArchiveSpace(manifest, availableBytes) {
  const payloadBytes = manifest.files.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
  const requiredBytes = Math.ceil(payloadBytes * 1.01) + manifest.files.length * 1024 + 512 * 1024 * 1024
  if (availableBytes < requiredBytes) throw new Error(`Insufficient archive space: available=${availableBytes}, required=${requiredBytes}, payload=${payloadBytes}`)
  return { availableBytes, requiredBytes, payloadBytes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  const manifest = JSON.parse(await readFile(join(directory, 'component.json'), 'utf8'))
  const disk = await statfs(directory)
  console.log(JSON.stringify(requireArchiveSpace(manifest, disk.bavail * disk.bsize)))
}
