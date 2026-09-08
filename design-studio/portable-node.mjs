import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function assertSystemLibraries(output) {
  const libraries = output.split('\n').filter(line => /^\s+\S.*\(compatibility version/.test(line)).map(line => line.trim().split(' (')[0])
  if (libraries.length === 0) throw new Error('No Mach-O dependency information')
  for (const library of libraries) {
    if (!library.startsWith('/usr/lib/') && !library.startsWith('/System/Library/')) {
      throw new Error(`Non-portable runtime dependency: ${library}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertSystemLibraries(execFileSync('/usr/bin/otool', ['-L', process.argv[2]], { encoding: 'utf8' }))
  console.log('Portable Mach-O dependencies: PASS')
}
