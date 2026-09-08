import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const launcher = join(directory, 'launcher.mjs')

test('missing data-root input cannot fall back to an upstream user profile', () => {
  const result = spawnSync(process.execPath, [launcher], { env: { OD_PORT: '23456' }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /absolute OD_DATA_DIR/)
})

test('a data directory inside the package is rejected before any write', async (context) => {
  const dataDirectory = join(directory, `test-data-${randomUUID()}`)
  context.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [launcher], { env: { OD_PORT: '23456', OD_DATA_DIR: dataDirectory }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /outside the versioned package/)
  await assert.rejects(access(dataDirectory), { code: 'ENOENT' })
})
