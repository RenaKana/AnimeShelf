import { Router, type Request, type Response } from 'express'
import { ExternalApiError } from './external-api-tokens'
import { isLocalOrigin, isLoopbackHost, type ExternalApiService } from './external-api-server'

function ownerRequest(req: Request): boolean {
  const peer = req.socket.remoteAddress ?? ''
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer.startsWith('::ffff:127.')
  return loopback && isLoopbackHost(req.get('host') ?? '') && isLocalOrigin(req.get('origin'))
    && req.headers.authorization === undefined && (['GET', 'HEAD'].includes(req.method) || req.get('X-AnimeShelf-Owner') === '1')
}

export function createExternalAccessRouter(service: ExternalApiService): Router {
  const router = Router()
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!ownerRequest(req)) return res.status(403).json({ error: '仅允许通过本机设置页管理外部访问', code: 'OWNER_REQUIRED' })
    next()
  })
  const failure = (res: Response, error: unknown) => {
    if (error instanceof ExternalApiError) return res.status(error.status).json({ error: error.message, code: error.code })
    return res.status(500).json({ error: '外部访问设置操作失败', code: 'EXTERNAL_ACCESS_FAILED' })
  }
  router.get('/', (_req, res) => { try { res.json(service.getStatus()) } catch (error) { failure(res, error) } })
  router.put('/', async (req, res) => { try { res.json(await service.configure(req.body)) } catch (error) { failure(res, error) } })
  router.post('/tokens', (req, res) => { try { res.status(201).json(service.store.createToken(req.body)) } catch (error) { failure(res, error) } })
  router.patch('/tokens/:id', (req, res) => { try { res.json(service.store.updateToken(req.params.id, req.body)) } catch (error) { failure(res, error) } })
  router.delete('/tokens/:id', (req, res) => { try { service.store.revokeToken(req.params.id); res.json({ ok: true }) } catch (error) { failure(res, error) } })
  router.use((_req, res) => res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' }))
  return router
}
