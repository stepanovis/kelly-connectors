import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PINNED_SERVER_SHA256 = '50861c30a156970b455233c1c639152bd7960300058d93c704619d1ab4264c95'

export function transformServer(source) {
  const option = 'inheritedEnvironment = () => ({}), odNextExecutionPreflightResolver'
  const registry = '    const projectPreviewScopes = createProjectPreviewScopeRegistry();'
  const launch = `            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({
                command: agentLaunch.launchPath,
                args,
                env,
            });`
  for (const anchor of [option, registry, launch]) if (source.split(anchor).length !== 2) throw new Error('Unknown managed API patch anchor')
  return '// Modified by Kelly: host authorization and project launch boundary (#1051).\nexport const KELLY_MANAGED_RUNTIME_VERSION = 1;\n' + source
    .replace(option, 'inheritedEnvironment = () => ({}), authorizeRequest = null, prepareAgentLaunch = null, odNextExecutionPreflightResolver')
    .replace(launch, `            const managedLaunch = prepareAgentLaunch
                ? await prepareAgentLaunch({ agentId: def.id, command: agentLaunch.launchPath, args, env, cwd: effectiveCwd })
                : { command: agentLaunch.launchPath, args };
            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({ command: managedLaunch.command, args: managedLaunch.args, env });`)
    .replace(registry, registry + `
    if (authorizeRequest !== null) {
        if (typeof authorizeRequest !== 'function') throw new Error('Invalid host request authorizer');
        app.use((req, res, next) => {
            const preview = req.method === 'GET' ? parseProjectPreviewAssetPath(req.path) : null;
            const scopedPreview = Boolean(preview && projectPreviewScopes.validate(preview.projectId, preview.scope));
            if (authorizeRequest(req, scopedPreview) === true) return next();
            return res.status(401).json({ error: { code: 'KELLY_HOST_AUTH', message: 'Managed Design Studio authorization required' } });
        });
    }`)
}

export async function applyManagedApi(payload) {
  const filename = join(payload, 'apps/daemon/dist/server.js')
  const source = await readFile(filename, 'utf8')
  if (createHash('sha256').update(source).digest('hex') !== PINNED_SERVER_SHA256) throw new Error('Unknown OpenDesign server: managed API patch refused')
  await writeFile(filename, transformServer(source))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await applyManagedApi(process.argv[2])
