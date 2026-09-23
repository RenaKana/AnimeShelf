import { Router } from 'express'
import { InvalidQuery, parseQuery } from './security'
import type { DownloadService } from './service'
import { isOwnerRequest } from '../../../server/core/owner-request'

export function createDownloadRouter(service: DownloadService): Router {
  const router = Router()
  router.use((req, res, next) => {
    if (!isOwnerRequest(req)) { res.status(403).json({ error: '仅允许本机所有者查询下载来源', code: 'OWNER_REQUIRED' }); return }
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  router.get('/sources', (_req, res) => res.json({ sources: service.sources() }))
  router.get('/resources', async (req, res) => {
    const controller = new AbortController()
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', abort)
    try {
      const query = parseQuery(req.query)
      const result = await service.resources(query, controller.signal)
      if (!controller.signal.aborted && !res.destroyed) res.json(result)
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return
      res.status(error instanceof InvalidQuery ? 400 : 503).json({ error: error instanceof InvalidQuery ? error.message : '下载模块暂不可用' })
    } finally { res.off('close', abort) }
  })
  return router
}
