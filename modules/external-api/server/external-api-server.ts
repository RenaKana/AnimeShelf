import express, { type Router, type ErrorRequestHandler } from 'express'
import type { Server } from 'node:http'
import type { Database } from 'node-sqlite3-wasm'
import type { ExternalApiConfig, ExternalApiStatus } from '../../../shared/external-api'
import { ExternalApiError, makeExternalApiStore, validateExternalApiConfig, type ExternalApiStore } from './external-api-tokens'

export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)
}
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && isLoopbackHost(url.host)
  } catch { return false }
}

function buckets() {
  const records = new Map<string, { count: number; until: number }>()
  const current = (key: string) => {
    const now = Date.now()
    const old = records.get(key)
    if (old && old.until > now) return old
    for (const [id, value] of records) if (value.until <= now) records.delete(id)
    if (records.size >= 1024) records.delete(records.keys().next().value!)
    const value = { count: 0, until: now + 60_000 }
    records.set(key, value)
    return value
  }
  return { exhausted: (key: string, limit: number) => current(key).count >= limit, add: (key: string) => { current(key).count++ } }
}

/** No owner routes, legacy routers or static file handlers are mounted here. */
export function createExternalApiApp(store: ExternalApiStore, dataRouter: Router, options: {
  failedAuthLimit?: number
  requestLimit?: number
  trackOperation?: (operation: Promise<unknown>) => void
} = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  // The external contract accepts flat scalar queries only; never parse nested qs objects.
  app.set('query parser', 'simple')
  const failures = buckets()
  const requests = buckets()
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    next()
  })
  app.use('/api/v1', (req, res, next) => {
    try {
      if (!store.getConfig().enabled) return res.status(503).json({ error: '外部 API 未启用', code: 'API_DISABLED' })
      if (!isLocalOrigin(req.get('origin'))) return res.status(403).json({ error: '不允许跨站浏览器调用', code: 'ORIGIN_FORBIDDEN' })
      const peer = req.socket.remoteAddress ?? 'unknown'
      const auth = req.get('authorization') ?? ''
      const authHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length
      const match = /^Bearer (as_[A-Za-z0-9_-]{43})$/i.exec(auth)
      const token = match && authHeaders === 1 ? store.authenticate(match[1]) : null
      if (!token) {
        // Valid callers must not be locked out by another loopback/proxy client.
        if (failures.exhausted(peer, options.failedAuthLimit ?? 30)) {
          res.setHeader('Retry-After', '60')
          return res.status(429).json({ error: '认证失败过于频繁，请稍后重试', code: 'RATE_LIMITED' })
        }
        failures.add(peer)
        res.setHeader('WWW-Authenticate', 'Bearer realm="AnimeShelf external API"')
        return res.status(401).json({ error: '访问令牌无效、已禁用、过期或已撤销', code: 'UNAUTHORIZED' })
      }
      if (requests.exhausted(token.id, options.requestLimit ?? 120)) {
        res.setHeader('Retry-After', '60')
        return res.status(429).json({ error: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED' })
      }
      requests.add(token.id)
      res.locals.externalApiToken = token
      res.locals.externalApiTrackOperation = options.trackOperation
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        let recorded = false
        const record = () => {
          if (recorded) return
          recorded = true
          // Route patterns only: never persist URLs, query strings, request bodies or Authorization.
          const route = typeof req.route?.path === 'string' ? req.route.path : '(unmatched)'
          try { store.recordAudit(token.id, req.method, route, res.writableFinished ? res.statusCode : 499) }
          catch { console.error('External API audit storage failed') }
        }
        res.once('finish', record)
        res.once('close', record)
      }
      next()
    } catch {
      res.status(503).json({ error: '外部 API 暂不可用', code: 'API_UNAVAILABLE' })
    }
  })
  app.use('/api/v1', express.json({ limit: '128kb', strict: true }))
  app.use('/api/v1', (req, res, next) => {
    // The owner may downgrade/revoke a token while a slow caller is sending JSON.
    // Recheck just before route dispatch, after the body has finished arriving.
    try {
      if (!store.getConfig().enabled) return res.status(503).json({ error: '外部 API 未启用', code: 'API_DISABLED' })
      const token = store.authenticate((req.get('authorization') ?? '').slice(7))
      if (!token) return res.status(401).json({ error: '访问令牌无效、已禁用、过期或已撤销', code: 'UNAUTHORIZED' })
      res.locals.externalApiToken = token
      next()
    } catch { res.status(503).json({ error: '外部 API 暂不可用', code: 'API_UNAVAILABLE' }) }
  })
  app.use('/api/v1', dataRouter)
  app.use((_req, res) => res.status(404).json({ error: '接口不存在或未对外开放', code: 'NOT_FOUND' }))
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const tooLarge = error?.type === 'entity.too.large'
    const invalidJson = error?.type === 'entity.parse.failed'
    res.status(tooLarge ? 413 : invalidJson ? 400 : 500).json({
      error: tooLarge ? '请求内容过大' : invalidJson ? '请求必须为有效 JSON 对象' : '外部 API 请求失败',
      code: tooLarge ? 'BODY_TOO_LARGE' : invalidJson ? 'INVALID_JSON' : 'INTERNAL_ERROR',
    })
  }
  app.use(errors)
  return app
}

export function createExternalApiService(db: Database, createDataRouter: () => Router, options: { drainTimeoutMs?: number } = {}) {
  const store = makeExternalApiStore(db)
  let server: Server | null = null
  let activePort: number | null = null
  let failure: string | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let stopping = false
  const operations = new Set<Promise<unknown>>()
  const trackOperation = (operation: Promise<unknown>) => {
    operations.add(operation)
    void operation.finally(() => operations.delete(operation)).catch(() => {})
  }
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action, action)
    queue = result.catch(() => undefined)
    return result
  }
  const close = async () => {
    const previous = server
    server = null
    activePort = null
    if (previous) {
      // Stop accepting, drain briefly, then terminate stuck HTTP connections. DB work is
      // tracked separately: disconnecting a caller must not close the DB under a file move.
      // https://nodejs.org/docs/latest-v24.x/api/http.html#servercloseallconnections
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => previous.closeAllConnections(), options.drainTimeoutMs ?? 2_000)
        deadline.unref()
        previous.close(() => { clearTimeout(deadline); resolve() })
        previous.closeIdleConnections()
      })
    }
  }
  const getStatus = (): ExternalApiStatus => {
    const config = store.getConfig()
    return { ...config, status: failure ? 'error' : server?.listening ? 'running' : 'stopped', base_url: `http://127.0.0.1:${config.port}/api/v1`, error: failure, tokens: store.listTokens() }
  }
  const apply = async (config: ExternalApiConfig): Promise<ExternalApiStatus> => {
    store.setConfig(config)
    failure = null
    if (config.enabled && server?.listening && activePort === config.port) return getStatus()
    await close()
    if (!config.enabled) return getStatus()
    try {
      const app = createExternalApiApp(store, createDataRouter(), { trackOperation })
      server = await new Promise<Server>((resolve, reject) => {
        const candidate = app.listen(config.port, '127.0.0.1')
        candidate.requestTimeout = 15_000
        candidate.headersTimeout = 10_000
        candidate.keepAliveTimeout = 5_000
        const failed = (error: Error) => { candidate.close(); reject(error) }
        candidate.once('error', failed)
        candidate.once('listening', () => {
          candidate.removeListener('error', failed)
          candidate.on('error', () => { failure = '外部 API 监听异常，请重新保存设置' })
          resolve(candidate)
        })
      })
      activePort = config.port
    } catch (error) {
      server = null
      activePort = null
      failure = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `端口 ${config.port} 已被占用，请更换端口或停止占用程序`
        : '外部 API 启动失败，请检查端口权限并重新保存设置'
    }
    return getStatus()
  }
  return {
    store,
    getStatus,
    configure(input: ExternalApiConfig) {
      if (stopping) throw new ExternalApiError('应用正在关闭', 503, 'SERVER_STOPPING')
      const config = validateExternalApiConfig(input)
      return serialized(() => apply(config))
    },
    start: () => serialized(() => apply(store.getConfig())),
    stop: () => {
      stopping = true
      return serialized(async () => {
        await close()
        // File operations may outlive their HTTP connections; let their transaction/rollback
        // settle before the caller closes the shared SQLite database.
        while (operations.size) await Promise.allSettled([...operations])
      })
    },
  }
}

export type ExternalApiService = ReturnType<typeof createExternalApiService>
