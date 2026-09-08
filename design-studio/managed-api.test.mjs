import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { transformServer } from './managed-api.mjs'

const fixture = `function startServer({ inheritedEnvironment = () => ({}), odNextExecutionPreflightResolver = null, } = {}) {
    const app = express();
    const projectPreviewScopes = createProjectPreviewScopeRegistry();
    async function run() {
            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({
                command: agentLaunch.launchPath,
                args,
                env,
            });
    }
    app.use((req,res) => res.end('private project contents'));
    app.run = run;
    return app;
}`

test('managed authorizer executes before private routes and receives preview scope validation', () => {
  const handlers = []
  const context = vm.createContext({ express: () => ({ use: h => handlers.push(h) }),
    createProjectPreviewScopeRegistry: () => ({ validate: () => true }),
    parseProjectPreviewAssetPath: path => path === '/scoped-preview' ? { projectId: 'a', scope: 'owned' } : null,
  })
  vm.runInContext(transformServer(fixture).replace('export const ', 'const '), context)
  vm.runInContext('startServer({ authorizeRequest: (req, preview) => req.headers.owner === "yes" || preview })', context)
  function request(path, headers = {}) {
    let index = 0, code = 200, text
    const req = { path, method: 'GET', headers }, res = { status: value => { code = value; return res }, json: value => { text = value }, end: value => { text = value } }
    const next = () => handlers[index++]?.(req, res, next)
    next()
    return { code, text }
  }
  assert.equal(request('/api/projects').code, 401)
  assert.equal(request('/api/projects', { owner: 'yes' }).text, 'private project contents')
  assert.equal(request('/scoped-preview').text, 'private project contents')
})

test('an unexpected server shape fails closed instead of silently omitting the guard', () => {
  assert.throws(() => transformServer('different upstream'), /anchor/)
})

test('the native CLI invocation must pass through the managed launch hook', async () => {
  const invocations = [], env = { project: 'a' }, args = ['native-session'], seen = []
  const context = vm.createContext({ express: () => ({ use: () => {} }),
    createProjectPreviewScopeRegistry: () => ({}), def: { id: 'codex' }, env, args,
    effectiveCwd: '/project/a', agentLaunch: { launchPath: '/cli' },
    createCommandInvocation: value => { invocations.push(value); return value },
  })
  vm.runInContext(transformServer(fixture).replace('export const ', 'const '), context)
  context.prepare = async value => { seen.push(value); value.env.HOME = '/home/a'; return { command: '/sandbox', args: ['policy', value.command, ...value.args] } }
  await vm.runInContext('startServer({ prepareAgentLaunch: prepare }).run()', context)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agentId, 'codex')
  assert.equal(seen[0].cwd, '/project/a')
  assert.equal(invocations[0].command, '/sandbox')
  assert.deepEqual([...invocations[0].args], ['policy', '/cli', 'native-session'])
  assert.equal(invocations[0].env.HOME, '/home/a')
  context.prepare = async () => { throw new Error('foreign project') }
  await assert.rejects(vm.runInContext('startServer({ prepareAgentLaunch: prepare }).run()', context), /foreign project/)
  assert.equal(invocations.length, 1, 'a rejected launch reached the CLI')
})
