import fs from 'fs'
import path from 'path'
import { resolveAllowedDirectory, tryResolveAllowedFile } from './path-access'

export interface Wallpaper {
  id: string; name: string
  type: 'video' | 'web' | 'scene' | 'application' | 'unknown'
  dir: string; mediaFile: string | null; preview: string | null
  renderMode: 'video' | 'web' | 'preview' | 'unavailable'
}

const TYPES = new Set(['video', 'web', 'scene', 'application'])
const PREVIEW_NAMES = ['preview.gif', 'preview.webp', 'preview.png', 'preview.jpg', 'preview.jpeg']

function findPreview(wdir: string, declared: unknown): string | null {
  const names = declared ? [String(declared), ...PREVIEW_NAMES] : PREVIEW_NAMES
  for (const name of [...new Set(names)]) {
    const candidate = path.resolve(wdir, name)
    const resolved = tryResolveAllowedFile(candidate, [wdir])
    if (resolved) return resolved
  }
  return null
}

export function scanWallpapers(dirs: string[]): Wallpaper[] {
  const out: Wallpaper[] = []
  for (const configuredDir of dirs) {
    let dir: string
    try { dir = resolveAllowedDirectory(configuredDir, [configuredDir], true) } catch { continue }
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const wdir = path.join(dir, e.name)
      try { resolveAllowedDirectory(wdir, [dir]) } catch { continue }
      const pjPath = tryResolveAllowedFile(path.join(wdir, 'project.json'), [wdir])
      if (!pjPath) continue
      let pj: any
      try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')) } catch { continue }
      const rawType = String(pj.type ?? 'unknown').toLowerCase()
      const type = (TYPES.has(rawType) ? rawType : 'unknown') as Wallpaper['type']
      // video/web 的入口由 project.json.file 声明。scene.pkg/application 是专有运行时，
      // 不能把目录里偶然存在的素材视频误当作完整壁纸，只提供官方预览图作为兼容回退。
      let mediaFile: string | null = null
      if ((type === 'video' || type === 'web') && pj.file) {
        mediaFile = tryResolveAllowedFile(path.resolve(wdir, String(pj.file)), [wdir])
      }
      const preview = findPreview(wdir, pj.preview)
      const renderMode: Wallpaper['renderMode'] =
        type === 'video' && mediaFile ? 'video'
          : type === 'web' && mediaFile ? 'web'
            : preview ? 'preview' : 'unavailable'
      out.push({
        id: wdir, name: pj.title ? String(pj.title) : e.name, type,
        dir: wdir, mediaFile, preview, renderMode,
      })
    }
  }
  return out
}
