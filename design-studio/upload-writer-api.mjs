import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const PINNED_PROJECT_ROUTES_SHA256 = '3928639b2879a4780ec97f93039201d1586a7fa170e1e89f78cbc70feccbf535'

const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Unknown managed upload anchor')
  return source.replace(before, after)
}

export function transformUploadServer(source) {
  source = replaceOnce(source, 'const upload = multer({\n    storage: multer.diskStorage({',
    'const upload = multer({\n    storage: createKellyUploadStorage(multer, multer.diskStorage({')
  source = replaceOnce(source, "    }),\n    limits: { fileSize: 20 * 1024 * 1024 },",
    "    })),\n    limits: { fileSize: 20 * 1024 * 1024 },")
  source = replaceOnce(source, 'const projectUpload = multer({\n    storage: multer.diskStorage({',
    'const projectUpload = multer({\n    storage: createKellyUploadStorage(multer, multer.diskStorage({')
  source = replaceOnce(source, '    }),\n    limits: { fileSize: 200 * 1024 * 1024 },',
    `    }), {
        projectsRoot: PROJECTS_DIR,
        metadata: id => projectMetadataLookup?.(id) ?? null,
        decodeName: decodeMultipartFilename,
    }),
    limits: { fileSize: 200 * 1024 * 1024 },`)
  return 'import { createKellyUploadStorage } from "./kelly-upload-storage.js";\n' + source
}

export function transformUploadRoutes(source) {
  source = replaceOnce(source, "app.post('/api/projects/:id/upload', handleProjectUpload, async (req, res) => {",
    `app.post('/api/projects/:id/upload', async (req, res, next) => {
        if (!await enforceWorkspaceProjectMutation(req, res, sendApiError, getWorkspaceProject, getWorkspaceProjectByProjectId, db, req.params.id, 'writeFiles')) return;
        next();
    }, handleProjectUpload, async (req, res) => {`)
  source = replaceOnce(source, 'const buf = await fs.promises.readFile(req.file.path);',
    'const buf = req.file.buffer ?? await fs.promises.readFile(req.file.path);')
  source = replaceOnce(source, "                    fs.promises.unlink(req.file.path).catch(() => { });\n                }\n            }",
    "                    if (req.file.path) fs.promises.unlink(req.file.path).catch(() => { });\n                }\n            }")
  source = replaceOnce(source, "                    if (f?.path)\n                        fs.promises.unlink(f.path).catch(() => { });",
    `                    if (f?.kellyUploadPath) {
                        invokeKellyFileWriter('projects.deleteProjectFile', [PROJECTS_DIR, req.params.id, f.kellyUploadPath]).catch(() => {});
                    } else if (f?.path) fs.promises.unlink(f.path).catch(() => {});`)
  return 'import { invokeKellyFileWriter } from "../../kelly-writer-bridge.js";\n' + source
}

export async function applyUploadWriterApi(payload) {
  const root = join(payload, 'apps/daemon/dist')
  const source = await readFile(join(root, 'routes/project/index.js'), 'utf8')
  if (createHash('sha256').update(source).digest('hex') !== PINNED_PROJECT_ROUTES_SHA256) throw new Error('Unknown OpenDesign upload routes')
  const transformed = transformUploadRoutes(source)
  await writeFile(join(root, 'routes/project/index.js'), transformed)
  await writeFile(join(root, 'kelly-upload-storage.js'), await readFile(new URL('./upload-storage.js', import.meta.url), 'utf8'))
}
