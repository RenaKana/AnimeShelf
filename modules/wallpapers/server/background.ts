import { Router, type Response } from 'express'
import fs from 'node:fs'
import { settingsDb } from '../../../server/db/instance'
import { isOwnerRequest } from '../../../server/core/owner-request'
import { resolveAllowedFile, WallpaperPathError } from './path-access'
import { readWallpaperPreview, WallpaperImageError } from './image-validation'
import {
  closeVideoPreview,
  createVideoPreview,
  openVideoPreview,
  revokeVideoPreview,
  WallpaperVideoPreviewError,
} from './video-preview'

const router = Router()

function sendPathError(res: Response, error: unknown) {
  if (error instanceof WallpaperPathError) return res.status(error.status).json({ error: error.message, code: error.code })
  if (error instanceof WallpaperImageError) return res.status(error.status).json({ error: error.message, code: error.code })
  if (error instanceof WallpaperVideoPreviewError) return res.status(error.status).json({ error: error.message, code: error.code })
  return res.status(500).json({ error: 'background path could not be resolved', code: 'PATH_RESOLUTION_FAILED' })
}

function sendVideoPathError(res: Response, error: unknown) {
  if (error instanceof WallpaperPathError) {
    const messages: Record<string, string> = {
      PATH_INVALID: '视频路径无效',
      PATH_OUTSIDE_ALLOWED_ROOT: '不允许访问该路径',
      PATH_NOT_FOUND: '视频文件不存在',
      PATH_NOT_REGULAR_FILE: '路径不是普通文件',
      PATH_SYMLINK_FORBIDDEN: '不允许访问符号链接',
    }
    return res.status(error.status).json({ error: messages[error.code] ?? '视频路径无效', code: error.code })
  }
  if (error instanceof WallpaperVideoPreviewError) return res.status(error.status).json({ error: error.message, code: error.code })
  return res.status(500).json({ error: '无法解析视频路径', code: 'PATH_RESOLUTION_FAILED' })
}

type ByteRange = { start: number; end: number } | null | 'unsatisfiable'

function byteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return 'unsatisfiable'
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) return 'unsatisfiable'
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function sendVideoNotFound(res: Response) {
  res.removeHeader('Content-Length')
  res.removeHeader('Content-Range')
  res.removeHeader('Accept-Ranges')
  res.removeHeader('Content-Type')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.status(404).json({ error: '视频预览已过期或不存在', code: 'VIDEO_PREVIEW_NOT_FOUND' })
}

function streamVideoPreview(req: import('express').Request, res: Response) {
  const opened = openVideoPreview(req.params.id, req.method === 'GET')
  if (!opened) return sendVideoNotFound(res)

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', opened.contentType)
  const range = byteRange(req.get('range'), opened.size)
  if (range === 'unsatisfiable') {
    closeVideoPreview(opened)
    res.setHeader('Content-Range', `bytes */${opened.size}`)
    res.setHeader('Content-Length', '0')
    return res.status(416).end()
  }

  const start = range?.start ?? 0
  const end = range?.end ?? opened.size - 1
  res.setHeader('Content-Length', String(end - start + 1))
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${opened.size}`)
  res.status(range ? 206 : 200)
  if (req.method === 'HEAD') {
    closeVideoPreview(opened)
    return res.end()
  }

  const stream = fs.createReadStream(opened.path, {
    fd: opened.fd,
    autoClose: true,
    start,
    end,
  })
  stream.once('error', () => {
    if (!res.headersSent) sendVideoNotFound(res)
    else res.destroy()
  })
  res.once('close', () => { if (!stream.destroyed) stream.destroy() })
  return stream.pipe(res)
}

// image/video 背景的本地文件代理：只允许读取当前已保存的背景文件。
// 这样仍支持用户选择任意本地背景，但查询参数不能被用来枚举其他本地文件。
router.use((req, res, next) => {
  if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面访问背景资源', code: 'OWNER_REQUIRED' })
  next()
})

router.get('/file', (req, res) => {
  try {
    const configured = settingsDb.get('background_path')
    const wallpaperRoots = (settingsDb.get('we_dirs') ?? '').split(';').map(value => value.trim()).filter(Boolean)
    const resolved = resolveAllowedFile(req.query.p, wallpaperRoots, configured ? [configured] : [])
    return res.sendFile(resolved)
  } catch (e: any) {
    return sendPathError(res, e)
  }
})

// A one-shot preview for a path explicitly entered or selected in the local
// settings page. Unlike /file, this route does not consult saved settings or
// wallpaper roots; the image validator is the only content gate.
router.post('/preview', (req, res) => {
  try {
    const image = readWallpaperPreview(req.body?.path)
    res.setHeader('Content-Type', image.contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.send(image.data)
  } catch (e: any) {
    return sendPathError(res, e)
  }
})

router.post('/video-preview', (req, res) => {
  try {
    const id = createVideoPreview(req.body?.path)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(201).json({ url: `/api/background/video-preview/${id}` })
  } catch (e: any) {
    return sendVideoPathError(res, e)
  }
})

router.route('/video-preview/:id')
  .head(streamVideoPreview)
  .get(streamVideoPreview)
  .delete((req, res) => {
    if (!revokeVideoPreview(req.params.id)) return sendVideoNotFound(res)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(204).end()
  })

export default router
