import { Router } from 'express'
import type { ModuleRuntime } from '../core/module-runtime'
import { isOwnerRequest } from '../core/owner-request'

export function createModulesRouter(runtime: ModuleRuntime): Router {
  const router = Router()
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许从本机设置页管理模块', code: 'OWNER_REQUIRED' })
    next()
  })
  router.get('/', (_req, res) => res.json(runtime.snapshot()))
  router.patch('/', (req, res) => {
    try { res.json(runtime.configure(req.body)) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '模块配置无效', code: 'INVALID_MODULE_CONFIGURATION' }) }
  })
  return router
}
