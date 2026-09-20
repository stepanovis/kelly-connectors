import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = readFileSync(new URL('./run-files.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replaceAll('export ', '')

test('run preparation forwards only data and leaves all writes and cleanup in the child', async () => {
  const calls = [], logs = [], effects = []
  const forbidden = () => { effects.push('host filesystem effect'); throw Error('Host write') }
  const context = vm.createContext({ hasKellyFileWriter: () => true, Buffer,
    invokeKellyCwdFileWriter: async (...args) => { calls.push(args); return { result:{ staged:true }, warnings:['child warning'] } },
    originalStageActiveSkill:forbidden, originalMaterializeFrozenSkillPackage:forbidden,
    originalMaterializeOdNextDeviceFrames:forbidden, originalStageAmrImagePaths:forbidden,
    mkdir:forbidden, writeFile:forbidden, unlink:forbidden, stat:forbidden,
    logs, bytes:Buffer.from([0,255,13,10]),
  })
  vm.runInContext(source, context)
  const staged = await vm.runInContext("stageActiveSkill('/projects/p','alias','/source', message => logs.push(message))", context)
  assert.equal(staged.staged, true)
  assert.deepEqual(logs, ['child warning'])
  await vm.runInContext("materializeFrozenSkillPackage({cwd:'/projects/p',frozen:{identity:'frozen'},ioHooks:()=>{}})", context)
  await vm.runInContext("materializeOdNextDeviceFrames({cwd:'/projects/p',resources:[{path:'iphone.html',text:'bytes'}],extra:'unused'})", context)
  await vm.runInContext("stageAmrImagePaths('/projects/p',['/uploads/a.png'],'/uploads')", context)
  await vm.runInContext("writeGeneratedMedia('/projects/p','a.png',bytes)", context)
  await vm.runInContext("writeProjectMcpConfig('/projects/p','{}')", context)
  await vm.runInContext("writeProjectMcpConfig('/projects/p',null)", context)
  assert.deepEqual(calls.map(call=>call[0]), ['run.stageActiveSkill','run.materializeFrozenSkillPackage','run.materializeOdNextDeviceFrames','run.stageAmrImagePaths','media.writeGeneratedMedia','run.writeProjectMcpConfig','run.writeProjectMcpConfig'])
  assert.ok(calls.every(call=>call[1]==='/projects/p'))
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][2])), [{identity:'frozen'}])
  assert.ok(calls[4][2][1].equals(Buffer.from([0,255,13,10])))
  assert.equal(calls[6][2][0], null)
  assert.deepEqual(effects, [])
})

test('failed admission never falls back to original helpers', async () => {
  let effects = 0, requests = 0
  const context = vm.createContext({ hasKellyFileWriter: () => true,
    invokeKellyCwdFileWriter: async () => { requests++; throw Error('admission failed') },
    originalStageActiveSkill: () => { effects++ },
  })
  vm.runInContext(source, context)
  await assert.rejects(vm.runInContext("stageActiveSkill('/projects/p','alias','/source')", context), /admission failed/)
  assert.equal(requests, 1)
  assert.equal(effects, 0)
})
