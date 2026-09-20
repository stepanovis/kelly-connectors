import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// These helpers are invoked before model spawn. Their entire staging and
// cleanup sequences must run inside the file writer too.
export const PINNED_RUN_FILES = {
  'cwd-aliases.js': '72e4c3c0a995cc3b965c1a2e8ae90aab54e942d657c7e83d3ef996e2164b9991',
  'strategies/od-next/frozen-skill-package.js': '54ea645187f452ab5f0faa593067f9ce0910a4f442641f11f36f4b57f50e00d0',
  'strategies/od-next/device-frames.js': 'ea259035ba1b4a38f781b83e735f2eded2ad387a2eb9ddc9bc01ae6c8b44f151',
  'media/amr-image-staging.js': '3f3d07cdbd7b6678f7509ee81bfb779d8be624a2d09b1395b12187c473a133bd',
}

export const RUN_WRITER_CONTRACTS = {
  'run.stageActiveSkill': `async (root, id, folder, source) => {
    const warnings = [];
    const result = await run.stageActiveSkill(path.join(root, id), folder, source, message => warnings.push(message));
    return { result, warnings };
  }`,
  'run.materializeFrozenSkillPackage': '(root, id, frozen) => run.materializeFrozenSkillPackage({ cwd: path.join(root, id), frozen })',
  'run.materializeOdNextDeviceFrames': '(root, id, resources) => run.materializeOdNextDeviceFrames({ cwd: path.join(root, id), resources })',
  'run.writeProjectMcpConfig': '(root, id, content) => run.writeProjectMcpConfig(path.join(root, id), content)',
  'run.stageAmrImagePaths': '(root, id, images, uploads) => run.stageAmrImagePaths(path.join(root, id), images, uploads)',
  'media.writeGeneratedMedia': '(root, id, name, bytes) => run.writeGeneratedMedia(path.join(root, id), name, bytes)',
}

export function transformRunServer(source) {
  const replacements = [
    ["import { skillCwdAliasSegment, stageActiveSkill } from './cwd-aliases.js';", "import { skillCwdAliasSegment } from './cwd-aliases.js';\nimport { stageActiveSkill, materializeFrozenSkillPackage, materializeOdNextDeviceFrames, writeProjectMcpConfig } from './kelly-run-files.js';"],
    ["loadOdNextTaskResourcesForSnapshot, materializeOdNextDeviceFrames, observeOdNextDeviceShell", "loadOdNextTaskResourcesForSnapshot, observeOdNextDeviceShell"],
    ["InvalidFrozenSkillPackageError, materializeFrozenSkillPackage, renderFrozenSkillRosterContext", "InvalidFrozenSkillPackageError, renderFrozenSkillRosterContext"],
    ["import { stageAmrImagePaths } from './media/amr-image-staging.js';", "import { stageAmrImagePaths } from './kelly-run-files.js';"],
    ["                            await fs.promises.mkdir(path.dirname(target), { recursive: true });\n                            await fs.promises.writeFile(target, JSON.stringify(claudeMcp, null, 2), 'utf8');", "                            await writeProjectMcpConfig(cwd, JSON.stringify(claudeMcp, null, 2));"],
    ["                        await fs.promises.unlink(target);", "                        await writeProjectMcpConfig(cwd, null);"],
  ]
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Unknown managed run-files anchor')
    source = source.replace(before, after)
  }
  return source
}

export const PINNED_MEDIA_GENERATOR_SHA256 = '99b6ddf21e1b3aba2eb6d61e9018fa1694d57a09d41a8f1bb4a5e48e8f8d6a52'
export function transformMediaGenerator(source) {
  const replacements = [
    ['    await mkdir(path.dirname(target), { recursive: true });', '    // ensureProject created the project inside the protected writer.'],
    ['    await writeFile(finalTarget, bytes);\n    const st = await stat(finalTarget);', '    const st = await writeGeneratedMedia(dir, finalOut, bytes);'],
  ]
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Unknown managed media generation anchor')
    source = source.replace(before, after)
  }
  return 'import { writeGeneratedMedia } from "../kelly-run-files.js";\n' + source
}

export async function applyRunWriterApi(payload) {
  const root = join(payload, 'apps/daemon/dist')
  for (const [name, hash] of Object.entries(PINNED_RUN_FILES)) {
    const source = await readFile(join(root, name))
    if (createHash('sha256').update(source).digest('hex') !== hash) throw new Error(`Unknown OpenDesign run writer: ${name}`)
  }
  const mediaFile = join(root, 'media/index.js'), media = await readFile(mediaFile, 'utf8')
  if (createHash('sha256').update(media).digest('hex') !== PINNED_MEDIA_GENERATOR_SHA256) throw new Error('Unknown OpenDesign media generator')
  const transformed = transformMediaGenerator(media)
  await writeFile(mediaFile, transformed)
  await writeFile(join(root, 'kelly-run-files.js'), await readFile(new URL('./run-files.js', import.meta.url), 'utf8'))
}
