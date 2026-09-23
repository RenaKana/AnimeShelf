import { Router } from 'express'
import type { Database } from 'node-sqlite3-wasm'
import { isOwnerRequest } from '../core/owner-request'
import { browseMoveDirectories, FolderMoveService } from '../services/folder-moves'

export function createFolderMovesRouter(db: Database, service: FolderMoveService) {
  const router = Router()
  router.use((req, res, next) => {
    if (!isOwnerRequest(req)) { res.status(403).json({ error: '仅允许本机页面管理磁盘迁移', code: 'OWNER_REQUIRED' }); return }
    next()
  })
  const route = (handler: (req: any) => unknown) => async (req: any, res: any) => {
    try { res.json(await handler(req)) }
    catch (error: any) { res.status(Number(error.status) || 409).json({ error: error.message ?? '移动任务失败', code: error.code ?? 'MOVE_FAILED' }) }
  }
  router.get('/directories', route(req => browseMoveDirectories(db, Number(req.query.libraryId), String(req.query.relativePath ?? ''))))
  router.post('/preview', route(req => service.preview(req.body)))
  router.get('/', route(() => service.list()))
  router.post('/', route(req => service.create(req.body, req.get('Idempotency-Key'))))
  router.get('/:id', route(req => service.get(req.params.id)))
  router.post('/:id/cancel', route(req => service.cancel(req.params.id)))
  router.post('/:id/resume', route(req => service.resume(req.params.id)))
  router.post('/:id/retry', route(req => service.resume(req.params.id, true)))
  router.post('/:id/reconcile', route(req => service.reconcile(req.params.id)))
  return router
}
