import { Router } from 'express'
import { isOwnerRequest } from '../core/owner-request'

export function createServiceRouter(instanceId: string, restart?: () => Promise<void>, assertAvailable?: () => void): Router {
  const router = Router()
  let requested = false
  router.post('/restart', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许从本机设置页重启服务', code: 'OWNER_REQUIRED' })
    if (!restart) return res.status(503).json({ error: '当前启动方式不支持重启服务，请手动重启 AnimeShelf', code: 'RESTART_UNAVAILABLE' })
    try { assertAvailable?.() } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : '媒体库正在处理任务，请稍后重启', code: 'LIBRARY_BUSY' })
    }
    if (!requested) {
      requested = true
      // Drain after the acknowledgement, including a client that disconnects early.
      const schedule = () => {
        res.removeListener('finish', schedule)
        res.removeListener('close', schedule)
        setImmediate(() => { void Promise.resolve().then(restart).catch(error => {
          requested = false
          console.error('Service restart failed', error)
        }) })
      }
      res.once('finish', schedule)
      res.once('close', schedule)
    }
    res.status(202).json({ instanceId })
  })
  return router
}
