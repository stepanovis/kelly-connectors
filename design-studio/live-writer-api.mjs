const optionOperations = [
  'createLiveArtifact', 'appendLiveArtifactRefreshLogEntry', 'acquireLiveArtifactRefreshLock',
  'markLiveArtifactRefreshCommitted', 'markLiveArtifactRefreshRunning', 'commitLiveArtifactRefreshCandidate',
  'markLiveArtifactRefreshFailed', 'regenerateLiveArtifactPreview', 'ensureLiveArtifactPreview',
  'updateLiveArtifact', 'deleteLiveArtifact',
]

export const LIVE_WRITER_SPEC = {
  sha256: 'eb2cbfe607575138ef298b5e0fa30c83572c36456a1dca784a5406c6a015af59', prefix: 'live', bridge: '../',
  names: [...optionOperations, 'ensureLiveArtifactStoreLayout', 'releaseLiveArtifactRefreshLock', 'recoverLiveArtifactRefreshLock'],
  optionOperations,
  prelude: 'const kellyLiveWriterLocks = new WeakMap();\n',
  forward: Object.fromEntries([
    ...optionOperations.map(name => [name, name === 'acquireLiveArtifactRefreshLock'
      ? `if (hasKellyFileWriter()) {
        const result = await invokeKellyFileWriter('live.acquireLiveArtifactRefreshLock', [options.projectsRoot, options.projectId, options]);
        kellyLiveWriterLocks.set(result, [options.projectsRoot, options.projectId]);
        return result;
    }`
      : `if (hasKellyFileWriter()) return invokeKellyFileWriter(${JSON.stringify('live.' + name)}, [options.projectsRoot, options.projectId, options]);`]),
    ['releaseLiveArtifactRefreshLock', `if (hasKellyFileWriter()) {
        const binding = kellyLiveWriterLocks.get(lock);
        if (!binding) throw new Error('Unknown live artifact lock owner');
        await invokeKellyFileWriter('live.releaseLiveArtifactRefreshLock', [...binding, lock]);
        kellyLiveWriterLocks.delete(lock);
        return;
    }`],
  ]),
}

// Absolute lockPath is an output of acquire, never filesystem authority. The
// writer derives its only admissible path again from its own root/project/id.
export const LIVE_WRITER_CONTRACTS = Object.fromEntries([
  ...optionOperations.map(name => [name, `(root, id, options) => live.${name}({ ...options, projectsRoot: root, projectId: id })`]),
  ['releaseLiveArtifactRefreshLock', `(root, id, lock) => {
    if (!lock?.metadata || lock.metadata.projectId !== id || lock.artifactId !== lock.metadata.artifactId) throw new Error('Invalid live artifact lock binding');
    const expected = live.liveArtifactStorePaths(root, id, lock.artifactId).refreshLockPath;
    if (lock.lockPath !== expected) throw new Error('Live artifact lock path changed');
    return live.releaseLiveArtifactRefreshLock({ ...lock, lockPath: expected });
  }`],
])
