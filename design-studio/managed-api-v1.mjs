// Reverse only the known v1 overlay before applying the full managed writer.
export function removeManagedV1(source) {
source = source.replace('// Modified by Kelly: host authorization and project launch boundary (#1051).\nexport const KELLY_MANAGED_RUNTIME_VERSION = 1;\n', '')
source = source.replace('inheritedEnvironment = () => ({}), authorizeRequest = null, prepareAgentLaunch = null, odNextExecutionPreflightResolver', 'inheritedEnvironment = () => ({}), odNextExecutionPreflightResolver')
source = source.replace(`
    if (authorizeRequest !== null) {
        if (typeof authorizeRequest !== 'function') throw new Error('Invalid host request authorizer');
        app.use((req, res, next) => {
            const preview = req.method === 'GET' ? parseProjectPreviewAssetPath(req.path) : null;
            const scopedPreview = Boolean(preview && projectPreviewScopes.validate(preview.projectId, preview.scope));
            if (authorizeRequest(req, scopedPreview) === true) return next();
            return res.status(401).json({ error: { code: 'KELLY_HOST_AUTH', message: 'Managed Design Studio authorization required' } });
        });
    }`, '')
source = source.replace(`            const managedLaunch = prepareAgentLaunch
                ? await prepareAgentLaunch({ agentId: def.id, command: agentLaunch.launchPath, args, env, cwd: effectiveCwd })
                : { command: agentLaunch.launchPath, args };
            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({ command: managedLaunch.command, args: managedLaunch.args, env });`, `            spawnedAgentEnv = env;
            const invocation = createCommandInvocation({
                command: agentLaunch.launchPath,
                args,
                env,
            });`)

return source;
}
