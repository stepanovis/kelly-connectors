import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeWebOutput, webDigest } from './embedded-web.mjs'

test('static web modes and bytes survive normal user extraction with umask 022', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kelly-web-modes-'))
  try {
    const source = join(root, 'web'), extracted = join(root, 'extracted')
    await mkdir(source); await mkdir(extracted)
    await writeFile(join(source, 'index.html'), 'compiled web')
    await chmod(join(source, 'index.html'), 0o664)
    const before = await webDigest(source)
    await normalizeWebOutput(source)
    assert.equal((await stat(join(source, 'index.html'))).mode & 0o777, 0o644)
    const archive = join(root, 'web.tar.gz')
    await promisify(execFile)('/usr/bin/tar', ['-czf', archive, '-C', source, '.'])
    await promisify(execFile)('/bin/sh', ['-c', 'umask 022\nexec /usr/bin/tar "$@"', 'sh', '-xzf', archive, '-C', extracted])
    assert.equal((await stat(join(extracted, 'index.html'))).mode & 0o777, 0o644)
    assert.equal(await webDigest(extracted), before)
    assert.equal(await readFile(join(extracted, 'index.html'), 'utf8'), 'compiled web')
  } finally { await rm(root, { recursive: true, force: true }) }
})
