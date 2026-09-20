import { hasKellyFileWriter, invokeKellyFileWriter } from './kelly-writer-bridge.js'

/** The parser owns bytes only. All project writes, collision selection and
 * cleanup go through the same protected writer as ordinary file saves. */
export function createKellyUploadStorage(multer, fallback, project) {
  const memory = multer.memoryStorage()
  return {
    _handleFile(req, file, callback) {
      if (!hasKellyFileWriter()) return fallback._handleFile(req, file, callback)
      memory._handleFile(req, file, (error, received) => {
        if (error || !project) return callback(error, received)
        Promise.resolve().then(() => {
          const originalname = project.decodeName(file.originalname)
          const subdir = typeof req.body?.dir === 'string' ? req.body.dir : ''
          return Promise.resolve(invokeKellyFileWriter('projects.saveProjectUpload', [project.projectsRoot, req.params.id,
            subdir, originalname, received.buffer, project.metadata(req.params.id)])).then(saved => ({ saved, originalname }))
        })
          .then(({ saved, originalname }) => {
            file.originalname = originalname
            req._uploadRelDir = saved.relDir
            callback(null, { ...saved, kellyUploadPath: saved.relPath })
          }, callback)
      })
    },
    _removeFile(req, file, callback) {
      if (!hasKellyFileWriter()) return fallback._removeFile(req, file, callback)
      if (!project || !file.kellyUploadPath) return memory._removeFile(req, file, callback)
      Promise.resolve().then(() => invokeKellyFileWriter('projects.deleteProjectFile', [project.projectsRoot, req.params.id,
        file.kellyUploadPath, project.metadata(req.params.id)]))
        .then(() => callback(null), callback)
    },
  }
}
