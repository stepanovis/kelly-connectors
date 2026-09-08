import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireArchiveSpace } from './archive-space.mjs'

test('archive preparation leaves a reserve rather than filling the system disk', () => {
  assert.throws(() => requireArchiveSpace({ files: [{ bytes: 1024 * 1024 }] }, 200 * 1024 * 1024), /Insufficient archive space/)
  assert.equal(requireArchiveSpace({ files: [{ bytes: 1024 * 1024 }] }, 1024 * 1024 * 1024).payloadBytes, 1024 * 1024)
})
