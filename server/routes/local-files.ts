import { Router, type Response } from 'express'
import type { Database } from 'node-sqlite3-wasm'
import { db } from '../db/instance'
import { isOwnerRequest } from '../core/owner-request'
import { LocalFileError, openFolderInExplorer, revealFileInExplorer, type LocalFileDependencies } from '../services/local-files'

function parseId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function sendError(res: Response, error: unknown) {
  if (error instanceof LocalFileError) return res.status(error.status).json({ error: error.message, code: error.code })
  console.error('Local file action failed:', error)
  return res.status(500).json({ error: '本机文件操作失败', code: 'LOCAL_FILE_ACTION_FAILED' })
}

export function createLocalFilesRouter(resolveDatabase: () => Database = () => db, dependencies: LocalFileDependencies = {}): Router {
  const router = Router()

  router.post('/folder/:id/open', async (req, res) => {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面打开文件夹', code: 'OWNER_REQUIRED' })
    const id = parseId(req.params.id)
    if (!id) return res.status(400).json({ error: '无效的文件夹 ID', code: 'INVALID_ID' })
    try {
      return res.json(await openFolderInExplorer(resolveDatabase(), id, dependencies))
    } catch (error) {
      return sendError(res, error)
    }
  })

  router.post('/file/:id/reveal', async (req, res) => {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面定位文件', code: 'OWNER_REQUIRED' })
    const id = parseId(req.params.id)
    if (!id) return res.status(400).json({ error: '无效的文件 ID', code: 'INVALID_ID' })
    try {
      return res.json(await revealFileInExplorer(resolveDatabase(), id, dependencies))
    } catch (error) {
      return sendError(res, error)
    }
  })

  return router
}

export default createLocalFilesRouter()
