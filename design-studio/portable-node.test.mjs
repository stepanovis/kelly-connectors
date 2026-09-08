import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSystemLibraries } from './portable-node.mjs'

test('runtime rejects Homebrew dependencies even when Node is absent from PATH', () => {
  assert.throws(() => assertSystemLibraries('node:\n\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 2.0.0)\n'), /Non-portable/)
})

test('runtime accepts system frameworks and standard libraries', () => {
  assertSystemLibraries('node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/Security.framework/Security (compatibility version 1.0.0)\n')
})

test('empty tool output is not a portability PASS', () => {
  assert.throws(() => assertSystemLibraries(''), /No Mach-O/)
})
