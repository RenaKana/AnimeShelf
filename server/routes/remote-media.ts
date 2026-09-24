import { Router, type Request, type Response } from 'express'
import { isLocalOrigin } from '../core/local-origin'
import { openRemoteMedia, RemoteMediaError } from '../services/remote-media'

const HEADER_TIMEOUT_MS = 15000
const IDLE_TIMEOUT_MS = 30000
const TOTAL_TIMEOUT_MS = 20 * 60 * 1000

function timeoutError(message: string): Error {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function sendFailure(res: Response, error: unknown): void {
  if (res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error instanceof RemoteMediaError) {
    res.status(error.status).json({ error: error.message, code: error.code })
    return
  }
  const timeout = error instanceof Error && error.name === 'TimeoutError'
  res.status(timeout ? 504 : 502).json({
    error: timeout ? '远程媒体请求超时' : '远程媒体请求失败',
    code: timeout ? 'REMOTE_MEDIA_TIMEOUT' : 'REMOTE_MEDIA_NETWORK_ERROR',
  })
}

function isLocalMediaRequest(req: Request): boolean {
  if (req.get('sec-fetch-site')?.trim().toLowerCase() === 'cross-site') return false
  if (!isLocalOrigin(req.get('origin'))) return false
  const referer = req.get('referer')
  if (!referer) return true
  try {
    return isLocalOrigin(new URL(referer).origin)
  } catch {
    return false
  }
}

async function relay(req: Request, res: Response): Promise<void> {
  if (!isLocalMediaRequest(req)) {
    res.status(403).json({ error: '不允许跨站浏览器调用', code: 'ORIGIN_FORBIDDEN' })
    return
  }
  const rawUrl = req.query.url
  if (typeof rawUrl !== 'string') {
    res.status(400).json({ error: '远程媒体 URL 无效', code: 'REMOTE_MEDIA_URL_INVALID' })
    return
  }

  const controller = new AbortController()
  let opened: Awaited<ReturnType<typeof openRemoteMedia>> | undefined
  let finished = false
  let headerTimer: ReturnType<typeof setTimeout>
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let totalTimer: ReturnType<typeof setTimeout>

  const cleanup = () => {
    clearTimeout(headerTimer)
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    req.removeListener('aborted', abortClient)
    res.removeListener('close', onClose)
    res.removeListener('finish', onFinish)
    if (opened) opened.dispose()
  }
  const abortClient = () => {
    if (finished) return
    finished = true
    controller.abort()
    opened?.stream?.destroy()
    cleanup()
  }
  const onClose = () => {
    if (!res.writableFinished) abortClient()
  }
  const onFinish = () => {
    finished = true
    cleanup()
  }
  const fail = (error: unknown) => {
    if (finished) return
    finished = true
    controller.abort(error)
    opened?.stream?.destroy()
    cleanup()
    sendFailure(res, error)
  }
  const startIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fail(timeoutError('Remote media stream timed out')), IDLE_TIMEOUT_MS)
  }

  req.once('aborted', abortClient)
  res.once('close', onClose)
  res.once('finish', onFinish)
  headerTimer = setTimeout(() => fail(timeoutError('Remote media headers timed out')), HEADER_TIMEOUT_MS)
  totalTimer = setTimeout(() => fail(timeoutError('Remote media request timed out')), TOTAL_TIMEOUT_MS)

  try {
    opened = await openRemoteMedia(rawUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      range: req.get('range'),
      ifRange: req.get('if-range'),
    }, controller.signal)
    clearTimeout(headerTimer)
    if (finished) {
      opened.stream?.destroy()
      opened.dispose()
      return
    }

    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (opened.contentType) res.setHeader('Content-Type', opened.contentType)
    if (opened.contentLength != null) res.setHeader('Content-Length', String(opened.contentLength))
    if (opened.contentRange) res.setHeader('Content-Range', opened.contentRange)
    if (opened.acceptRanges) res.setHeader('Accept-Ranges', opened.acceptRanges)
    if (opened.contentEncoding && opened.contentEncoding !== 'identity') res.setHeader('Content-Encoding', opened.contentEncoding)
    res.status(opened.status)

    if (!opened.stream) {
      finished = true
      cleanup()
      res.end()
      return
    }
    let bytes = 0
    opened.stream.on('data', chunk => {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
      if (bytes > opened!.maxBytes) {
        fail(new RemoteMediaError('远程媒体响应超过大小限制', 413, 'REMOTE_MEDIA_TOO_LARGE'))
        return
      }
      startIdleTimer()
    })
    opened.stream.once('error', error => fail(error))
    opened.stream.once('end', () => {
      if (idleTimer) clearTimeout(idleTimer)
    })
    startIdleTimer()
    opened.stream.pipe(res)
  } catch (error) {
    if (!finished) fail(error)
  }
}

export function createRemoteMediaRouter() {
  const router = Router()
  router.get('/', (req, res) => { void relay(req, res) })
  router.head('/', (req, res) => { void relay(req, res) })
  return router
}
