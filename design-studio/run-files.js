import path from 'node:path'
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises'
import { sanitizeName } from './projects.js'
import { stageAmrImagePaths as originalStageAmrImagePaths } from './media/amr-image-staging.js'
import { stageActiveSkill as originalStageActiveSkill } from './cwd-aliases.js'
import { materializeFrozenSkillPackage as originalMaterializeFrozenSkillPackage } from './strategies/od-next/frozen-skill-package.js'
import { materializeOdNextDeviceFrames as originalMaterializeOdNextDeviceFrames } from './strategies/od-next/device-frames.js'
import { hasKellyFileWriter, invokeKellyCwdFileWriter } from './kelly-writer-bridge.js'

export async function stageActiveSkill(cwd, folder, source, log = () => {}) {
  if (!hasKellyFileWriter()) return originalStageActiveSkill(cwd, folder, source, log)
  const { result, warnings } = await invokeKellyCwdFileWriter('run.stageActiveSkill', cwd, [folder, source])
  for (const message of warnings) log(message)
  return result
}

export async function materializeFrozenSkillPackage(input) {
  if (!hasKellyFileWriter()) return originalMaterializeFrozenSkillPackage(input)
  return invokeKellyCwdFileWriter('run.materializeFrozenSkillPackage', input.cwd, [input.frozen])
}

export async function materializeOdNextDeviceFrames(input) {
  if (!hasKellyFileWriter()) return originalMaterializeOdNextDeviceFrames(input)
  return invokeKellyCwdFileWriter('run.materializeOdNextDeviceFrames', input.cwd, [input.resources])
}

export async function stageAmrImagePaths(cwd, images, uploads) {
  if (!hasKellyFileWriter()) return originalStageAmrImagePaths(cwd, images, uploads)
  return invokeKellyCwdFileWriter('run.stageAmrImagePaths', cwd, [images, uploads])
}

export async function writeGeneratedMedia(cwd, name, bytes) {
  if (hasKellyFileWriter()) return invokeKellyCwdFileWriter('media.writeGeneratedMedia', cwd, [name, bytes])
  if (typeof name !== 'string' || name !== sanitizeName(name) || !Buffer.isBuffer(bytes)) throw new Error('Invalid generated media')
  const target = path.join(cwd, name)
  await writeFile(target, bytes)
  const result = await stat(target)
  return { size: result.size, mtimeMs: result.mtimeMs }
}

export async function writeProjectMcpConfig(cwd, content) {
  if (!hasKellyFileWriter()) {
    if (content !== null && typeof content !== 'string') throw new Error('Invalid project MCP configuration')
    const target = path.join(cwd, '.mcp.json')
    if (content === null) await unlink(target)
    else {
      await mkdir(cwd, { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    return
  }
  return invokeKellyCwdFileWriter('run.writeProjectMcpConfig', cwd, [content])
}
