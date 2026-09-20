import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import path from 'node:path'
import { WRITER_MODULES, WRITER_BRIDGE_SOURCE, transformWriterModule } from './file-writer-api.mjs'

test('every declared writer forwards its complete arguments before any original filesystem effect', async () => {
  for (const spec of Object.values(WRITER_MODULES)) {
    const source = spec.names.filter(name => !Object.hasOwn(spec.extra ?? {}, name)).map(name => `export async function ${name}(${spec.optionOperations?.includes(name) ? 'options' : name === 'releaseLiveArtifactRefreshLock' ? 'lock' : 'root, id, value = {}'}) {\n effects.push(${JSON.stringify(name)}); return 'unprotected';\n}`).join('\n')
    const transformed = transformWriterModule(source, spec).replace(/^import .*\n/gm, '').replaceAll('export ', '')
    const effects = [], requests = []
    const context = vm.createContext({ effects, hasKellyFileWriter: () => true, invokeKellyFileWriter: async (name, args) => { requests.push({name, args}); return { answer: 'child-result', bytes: 'retained' } } })
    vm.runInContext(transformed, context)
    for (const name of spec.names) {
      if (name === 'releaseLiveArtifactRefreshLock') {
        await vm.runInContext('releaseLiveArtifactRefreshLock(acquired)', context)
        const count = requests.length
        await assert.rejects(vm.runInContext('releaseLiveArtifactRefreshLock({...acquired})', context), /Unknown live artifact lock owner/)
        assert.equal(requests.length, count)
      } else {
        const args = spec.optionOperations?.includes(name) ? "{projectsRoot:'/root',projectId:'project',bytes:'retained'}" : "'/root', 'project', {bytes:'retained'}"
        const result = await vm.runInContext(`${name}(${args})`, context)
        assert.equal(result.answer, 'child-result')
        if (name === 'acquireLiveArtifactRefreshLock') context.acquired = result
      }
    }
    assert.equal(effects.length, 0)
    assert.deepEqual(requests.map(r => r.name), spec.names.map(n => `${spec.prefix}.${n}`))
    assert.ok(requests.every(r => r.args[0] === '/root' && r.args[1] === 'project' && r.args[2].bytes === 'retained'))
  }
})

test('unknown or duplicate function shapes cannot silently omit a writer', () => {
  const spec = { prefix:'projects', names:['writeProjectFile'] }
  assert.throws(() => transformWriterModule('different module', spec), /anchor/)
  assert.throws(() => transformWriterModule('async function writeProjectFile() {\n}\nasync function writeProjectFile() {\n}', spec), /anchor/)
})

test('the bridge can only be installed once by the host and has no unprotected fallback', async () => {
  const context = vm.createContext({ path })
  vm.runInContext(WRITER_BRIDGE_SOURCE.replace(/^import .*\n/gm, '').replaceAll('export ', ''), context)
  assert.throws(() => vm.runInContext("invokeKellyFileWriter('projects.writeProjectFile', [])", context), /unavailable/)
  vm.runInContext("installKellyFileWriter(async () => { throw new Error('child failed') }, '/projects')", context)
  await assert.rejects(vm.runInContext("invokeKellyFileWriter('projects.writeProjectFile', [])", context), /child failed/)
  assert.throws(() => vm.runInContext('installKellyFileWriter(async () => {})', context), /installation/)
})

test('run preparation derives project identity only from the installed project root', async () => {
  const requests = [], context = vm.createContext({ path, requests })
  vm.runInContext(WRITER_BRIDGE_SOURCE.replace(/^import .*\n/gm, '').replaceAll('export ', ''), context)
  vm.runInContext("installKellyFileWriter((name, args) => requests.push({ name, args }), '/projects')", context)
  vm.runInContext("invokeKellyCwdFileWriter('run.writeProjectMcpConfig', '/projects/own', ['content'])", context)
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ name:'run.writeProjectMcpConfig', args:['/projects', 'own', 'content'] }])
  for (const cwd of ['/profile', '/projects/own/..', '/projects/own/nested', '/projects/own/', 'own']) {
    context.cwd = cwd
    assert.throws(() => vm.runInContext("invokeKellyCwdFileWriter('run.writeProjectMcpConfig', cwd, ['content'])", context), /working directory/)
  }
  assert.equal(requests.length, 1)
})
