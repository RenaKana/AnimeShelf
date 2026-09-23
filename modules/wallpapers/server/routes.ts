import { Router, type Response } from 'express'
import path from 'path'
import fs from 'fs'
import { settingsDb } from '../../../server/db/instance'
import { isOwnerRequest } from '../../../server/core/owner-request'
import { scanWallpapers } from './wallpapers'
import {
  isInside,
  resolveAllowedDirectory,
  resolveAllowedFile,
  WallpaperPathError,
} from './path-access'

const router = Router()

function weDirs(): string[] {
  return (settingsDb.get('we_dirs') ?? '').split(';').map(s => s.trim()).filter(Boolean)
}

function sendPathError(res: Response, error: unknown) {
  if (error instanceof WallpaperPathError) return res.status(error.status).json({ error: error.message, code: error.code })
  return res.status(500).json({ error: 'wallpaper path could not be resolved', code: 'PATH_RESOLUTION_FAILED' })
}

function findProjectRoot(file: string, dirs: string[]): string | null {
  for (const allowed of dirs) {
    if (!isInside(allowed, file)) continue
    let cursor = path.dirname(file)
    while (isInside(allowed, cursor)) {
      try {
        const projectRoot = resolveAllowedDirectory(cursor, [allowed])
        resolveAllowedFile(path.join(projectRoot, 'project.json'), [projectRoot])
        return projectRoot
      } catch { /* Continue searching the containing project directory. */ }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return null
}

function injectWebBase(html: string, projectRoot: string, htmlFile: string): string {
  const token = Buffer.from(projectRoot, 'utf8').toString('base64url')
  const relativeDir = path.relative(projectRoot, path.dirname(htmlFile)).split(path.sep).filter(Boolean).map(encodeURIComponent).join('/')
  const baseUrl = `/api/wallpapers/web/${token}/${relativeDir ? `${relativeDir}/` : ''}`
  const baseTag = `<base href="${baseUrl}">`
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${baseTag}`)
  return `${baseTag}${html}`
}

router.use((req, res, next) => {
  if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面访问壁纸资源', code: 'OWNER_REQUIRED' })
  next()
})

router.get('/', (_req, res) => {
  try { res.json(scanWallpapers(weDirs())) } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Web 壁纸资源树：为 iframe 提供稳定的目录型 URL。这样 HTML、CSS、字体、脚本、
// CSS url(...) 与运行时 fetch() 的相对路径都会自然解析到同一个壁纸项目中。
router.get('/web/:token/*', (req, res) => {
  try {
    const dirs = weDirs()
    const token = req.params.token
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return res.status(400).json({ error: 'invalid wallpaper token', code: 'PATH_INVALID' })
    }
    let projectRoot: string
    try {
      const decoded = Buffer.from(token, 'base64url').toString('utf8')
      if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== token) {
        throw new WallpaperPathError('PATH_INVALID', 'invalid wallpaper token', 400)
      }
      projectRoot = resolveAllowedDirectory(decoded, dirs)
      resolveAllowedFile(path.join(projectRoot, 'project.json'), [projectRoot])
    } catch (error) {
      return sendPathError(res, error)
    }
    const relative = (req.params as Record<string, unknown>)[0]
    if (typeof relative !== 'string') return res.status(400).json({ error: 'invalid wallpaper path', code: 'PATH_INVALID' })
    const resolved = resolveAllowedFile(path.resolve(projectRoot, relative), [projectRoot])
    return res.sendFile(resolved)
  } catch (e: any) {
    return sendPathError(res, e)
  }
})

router.get('/file', (req, res) => {
  try {
    const dirs = weDirs()
    const resolved = resolveAllowedFile(req.query.p, dirs)
    // HTML 壁纸注入项目级 base URL；所有相对资源（包括 CSS 内的 url 与 JS fetch）
    // 都通过上面的资源树路由加载，不再只修补首页的 src/href。
    if (/\.html?$/i.test(resolved)) {
      try {
        let html = fs.readFileSync(resolved, 'utf8')
        const projectRoot = findProjectRoot(resolved, dirs)
        if (projectRoot) html = injectWebBase(html, projectRoot, resolved)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        return res.send(html)
      } catch { /* 读取失败走 sendFile */ }
    }
    res.sendFile(resolved)
  } catch (e: any) {
    return sendPathError(res, e)
  }
})

export default router
