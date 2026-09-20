import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LIVE_WRITER_SPEC, LIVE_WRITER_CONTRACTS } from './live-writer-api.mjs'
import { applyUploadWriterApi } from './upload-writer-api.mjs'
import { applyRunWriterApi, RUN_WRITER_CONTRACTS } from './run-writer-api.mjs'

// Each module is pinned independently: an upstream change cannot leave a newly
// introduced writer outside this adapter while the managed contract still starts.
export const WRITER_MODULES = {
  'live-artifacts/store.js': LIVE_WRITER_SPEC,
  'projects.js': {
    sha256: '7602ae3687b7755fc26961bebf0986df7951fd06e71c87b796bf41425e95c24f', prefix: 'projects',
    extraImports: "import { copyFile as kellyCopyFile, open as kellyOpen, unlink as kellyUnlink } from 'node:fs/promises';\n",
    names: ['ensureProject', 'createProjectFolder', 'ensureProjectSubdir', 'deleteProjectFolder',
      'writeProjectFile', 'reconcileHtmlArtifactManifest', 'deleteProjectFile', 'renameProjectFile', 'copyProjectAssetFile', 'saveProjectUpload'],
    extra: { copyProjectAssetFile: `
export async function copyProjectAssetFile(projectsRoot, projectId, subdir, name, source, metadata) {
    if (typeof name !== 'string' || !name || name !== sanitizeName(name) || typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Invalid library file copy');
    const { absDir, relDir } = await ensureProjectSubdir(projectsRoot, projectId, subdir, metadata);
    const target = await resolveSafeReal(absDir, name);
    await kellyCopyFile(source, target);
    return { relPath: relDir ? relDir + '/' + name : name };
}
`, saveProjectUpload: `
export async function saveProjectUpload(projectsRoot, projectId, subdir, name, body, metadata) {
    if (typeof name !== 'string' || !Buffer.isBuffer(body)) throw new Error('Invalid project upload');
    const { absDir, relDir } = await ensureProjectSubdir(projectsRoot, projectId, subdir, metadata);
    const safe = sanitizeName(name), parsed = path.parse(safe);
    for (let index = 0; index < 10000; index++) {
        const filename = index === 0 ? safe : (parsed.name || parsed.base || 'file') + '-' + index + parsed.ext;
        const target = path.join(absDir, filename);
        let handle;
        try { handle = await kellyOpen(target, 'wx'); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        try {
            await handle.writeFile(body);
            const info = await handle.stat();
            return { path: target, filename, relDir, relPath: relDir ? relDir + '/' + filename : filename, size: info.size, mtime: info.mtimeMs };
        } catch (error) {
            await kellyUnlink(target).catch(() => {});
            throw error;
        } finally { await handle.close(); }
    }
    throw new Error('Project upload name exhausted');
}
` },
  },
  'project-file-versions.js': {
    sha256: '50f438ecb470b8c826421ee135f2eac9fb54ead17c7eb46dcd6d4c40b63d3d29', prefix: 'versions',
    names: ['createProjectFileVersion', 'markProjectFileVersionStoreDeleted', 'renameProjectFileVersionStore',
      'ensureCurrentProjectFileVersion', 'createProjectFileVersionUnlocked', 'ensureCurrentProjectFileVersionUnlocked'],
  },
  'media/hyperframes-scaffold.js': {
    sha256: 'bc0fbc68cde7fc44c47a4ff4a318721ed930d089a12de03ee19ee57f4b8b9b33', prefix: 'media', bridge: '../',
    names: ['scaffoldProjectHyperFrames'],
    extra: { scaffoldProjectHyperFrames: `
export async function scaffoldProjectHyperFrames(projectsRoot, projectId, input, metadata) {
    return scaffoldHyperFramesComposition({ projectDir: path.join(projectsRoot, projectId), compositionDir: input.compositionDir, ...(input.now ? { now: input.now } : {}) });
}
` },
  },
}

export function transformWriterModule(source, spec) {
  source += Object.values(spec.extra ?? {}).join('\n')
  for (const name of spec.names) {
    const pattern = new RegExp(`^(export )?async function ${name}\\([^\\n]*\\) \\{$`, 'gm')
    const matches = [...source.matchAll(pattern)]
    if (matches.length !== 1) throw new Error(`Unknown managed writer anchor: ${name}`)
    const anchor = matches[0][0]
    // Private version primitives are exported only for this pinned process
    // contract; they are not HTTP endpoints and do not accept executable callbacks.
    const exported = anchor.startsWith('export ') ? anchor : 'export ' + anchor
    const forward = spec.forward?.[name] ?? `if (hasKellyFileWriter()) return invokeKellyFileWriter(${JSON.stringify(spec.prefix + '.' + name)}, Array.from(arguments));`
    source = source.replace(anchor, `${exported}\n    ${forward}`)
  }
  return `import { hasKellyFileWriter, invokeKellyFileWriter } from '${spec.bridge ?? './'}kelly-writer-bridge.js';\n`
    + (spec.extraImports ?? '') + (spec.prelude ?? '') + source
}

export const PINNED_MEDIA_ROUTE_SHA256 = 'bb0334bf8820d6d6f485894f1609024788422e37391dba43b98d3ad7cf9384dd'
export function transformMediaRoute(source) {
  const replacements = [
    ["import { scaffoldHyperFramesComposition } from '../media/hyperframes-scaffold.js';", "import { scaffoldProjectHyperFrames } from '../media/hyperframes-scaffold.js';"],
    [`        const projectDir = resolveProjectDir(PROJECTS_DIR, project.id, project.metadata);
        const result = await scaffoldHyperFramesComposition({
            projectDir,
            compositionDir: body.compositionDir,
        });`, `        const result = await scaffoldProjectHyperFrames(PROJECTS_DIR, project.id, {
            compositionDir: body.compositionDir,
        }, project.metadata);`],
  ]
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Unknown media writer anchor')
    source = source.replace(before, after)
  }
  return source
}

export const PINNED_LIBRARY_ROUTE_SHA256 = 'eddb89734a873443fb894dd11559d44433256edc5470a452c5d09fa2afaa6dde'
export function transformLibraryRoute(source) {
  const replacements = [
    ["import { ensureProjectSubdir } from '../projects.js';", "import { ensureProjectSubdir, copyProjectAssetFile } from '../projects.js';"],
    ['await copyFile(bytesPath, path.join(absDir, name));', 'await copyProjectAssetFile(PROJECTS_DIR, projectId, relDir, name, bytesPath, project.metadata);'],
    ['await copyFile(sidecar, path.join(absDir, elName));', 'await copyProjectAssetFile(PROJECTS_DIR, projectId, relDir, elName, sidecar, project.metadata);'],
  ]
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Unknown library writer anchor')
    source = source.replace(before, after)
  }
  return source
}

export function writerContractSource() {
  const imports = "import path from 'node:path';\nimport * as run from './kelly-run-files.js';\n" + Object.entries(WRITER_MODULES).map(([file, spec]) => `import * as ${spec.prefix} from './${file}';`).join('\n')
  const operations = [...Object.values(WRITER_MODULES).flatMap(spec => spec.names.map(name => `${JSON.stringify(spec.prefix + '.' + name)}: ${spec.prefix === 'live' && LIVE_WRITER_CONTRACTS[name] ? LIVE_WRITER_CONTRACTS[name] : spec.prefix + '.' + name}`)), ...Object.entries(RUN_WRITER_CONTRACTS).map(([name, fn]) => `${JSON.stringify(name)}: ${fn}`)].join(',\n')
  return `${imports}
export { serializeKellyFileError } from './kelly-writer-errors.js';
export const KELLY_FILE_WRITER_VERSION = 1;
const operations = Object.freeze({${operations}});
export async function executeKellyFileOperation(name, args) {
  if (!Object.hasOwn(operations, name) || !Array.isArray(args)) throw new Error('Unknown Kelly file operation');
  return await operations[name](...args);
}
`
}

export const WRITER_BRIDGE_SOURCE = `import path from 'node:path';
let writer = null, projectsRoot = null;
export function installKellyFileWriter(value, root) {
  if (writer !== null || typeof value !== 'function' || typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Invalid Kelly file writer installation');
  writer = value; projectsRoot = root;
}
export function hasKellyFileWriter() { return writer !== null; }
export function invokeKellyFileWriter(name, args) {
  if (writer === null) throw new Error('Kelly file writer unavailable');
  return writer(name, args);
}
export function invokeKellyCwdFileWriter(name, cwd, args) {
  if (!projectsRoot || typeof cwd !== 'string' || cwd !== path.join(projectsRoot, path.basename(cwd)) || !/^[a-zA-Z0-9_-]+$/.test(path.basename(cwd))) throw new Error('Invalid Kelly project working directory');
  return invokeKellyFileWriter(name, [projectsRoot, path.basename(cwd), ...args]);
}
`

export async function applyFileWriterApi(payload) {
  const root = join(payload, 'apps/daemon/dist')
  const prepared = []
  // Validate every source before changing any file.
  for (const [name, spec] of Object.entries(WRITER_MODULES)) {
    const source = await readFile(join(root, name), 'utf8')
    if (createHash('sha256').update(source).digest('hex') !== spec.sha256) throw new Error(`Unknown OpenDesign writer: ${name}`)
    prepared.push([name, transformWriterModule(source, spec)])
  }
  const library = await readFile(join(root, 'routes/library.js'), 'utf8')
  if (createHash('sha256').update(library).digest('hex') !== PINNED_LIBRARY_ROUTE_SHA256) throw new Error('Unknown OpenDesign writer: routes/library.js')
  prepared.push(['routes/library.js', transformLibraryRoute(library)])
  const media = await readFile(join(root, 'routes/media.js'), 'utf8')
  if (createHash('sha256').update(media).digest('hex') !== PINNED_MEDIA_ROUTE_SHA256) throw new Error('Unknown OpenDesign writer: routes/media.js')
  prepared.push(['routes/media.js', transformMediaRoute(media)])
  prepared.push(['kelly-writer-errors.js', await readFile(new URL('./writer-errors.js', import.meta.url), 'utf8')])
  await applyUploadWriterApi(payload)
  await applyRunWriterApi(payload)
  for (const [name, source] of prepared) await writeFile(join(root, name), source)
  await writeFile(join(root, 'kelly-writer-bridge.js'), WRITER_BRIDGE_SOURCE)
  await writeFile(join(root, 'kelly-writer-contract.js'), writerContractSource())
}
