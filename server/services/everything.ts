import fs from 'fs'
import { win32 as path } from 'path' // Everything 返回 Windows 路径，固定 win32 语义

export interface EverythingFile { path: string; size: number | null; dateModified: number | null }
export const VIDEO_EXTS = ['mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'flv', 'ts', 'webm']
const PAGE_SIZE = 1024
const MAX_PAGES = 512

export class EverythingQueryError extends Error {
  readonly code: string
  readonly retryable = true

  constructor(message: string, code = 'EVERYTHING_QUERY_INCOMPLETE') {
    super(message)
    this.name = 'EverythingQueryError'
    this.code = code
  }
}

// 实测 Everything HTTP server 的 size 字段是字符串（如 "274"），date_modified 是字符串 FILETIME
// （1601-01-01 起的 100ns 计数，如 "134285936321588154"），个别配置下也可能是 "YYYY-MM-DD HH:MM:SS"。
// 统一转为 number / Unix 秒。
export function parseSize(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function parseDateModified(v: unknown): number | null {
  if (typeof v === 'number') return Math.floor(v / 1e7) - 11644473600
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (!Number.isNaN(n)) return Math.floor(n / 1e7) - 11644473600
    const d = Date.parse(v.replace(' ', 'T'))
    return Number.isNaN(d) ? null : Math.floor(d / 1000)
  }
  return null
}

// 严格前缀过滤：Everything 的 path:"root" 查询在 root 含 [] 等通配符时可能误匹配其他目录
// 或混入 root 的祖先，这里只保留 root 自身及其后代
const isWithin = (p: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(p))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

// 完整路径 = path 列（父目录）+ name 列（文件名）
const fullPath = (r: any): string => {
  const p = String(r.path ?? '')
  const n = String(r.name ?? '')
  if (!p || !n) return ''
  return p.endsWith('\\') || p.endsWith('/') ? p + n : p + '\\' + n
}

export class EverythingClient {
  constructor(private baseUrl: string) {}

  private async fetchAll(params: Record<string, string>, signal?: AbortSignal): Promise<any[]> {
    const out: any[] = []
    let offset = 0
    let expectedTotal: number | undefined
    const pageFingerprints = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams(params)
      q.set('json', '1'); q.set('count', String(PAGE_SIZE)); q.set('offset', String(offset))
      q.set('path_column', '1'); q.set('size_column', '1'); q.set('date_modified_column', '1')
      const timeout = AbortSignal.timeout(10000)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      let res: Response
      let data: any
      try {
        res = await fetch(`${this.baseUrl}/?${q.toString()}`, { signal: requestSignal })
        if (!res.ok) throw new EverythingQueryError(`Everything HTTP ${res.status}`, 'EVERYTHING_HTTP_ERROR')
        data = await res.json()
      } catch (error) {
        if (error instanceof EverythingQueryError || (error as Error).name === 'AbortError') throw error
        throw new EverythingQueryError(`Everything 请求失败：${(error as Error).message}`, 'EVERYTHING_UNAVAILABLE')
      }
      if (!Array.isArray(data?.results)) throw new EverythingQueryError('Everything 返回了无效的 results')
      const rawTotal = data?.totalResults
      const parsedTotal = typeof rawTotal === 'string' && rawTotal.trim() !== '' ? Number(rawTotal) : rawTotal
      if (!Number.isSafeInteger(parsedTotal) || parsedTotal < 0) throw new EverythingQueryError('Everything 返回了无效的 totalResults')
      const total = Number(parsedTotal)
      if (expectedTotal === undefined) {
        expectedTotal = total
        if (expectedTotal > PAGE_SIZE * MAX_PAGES) throw new EverythingQueryError('Everything 结果超过安全分页上限')
      } else if (total !== expectedTotal) {
        throw new EverythingQueryError('Everything totalResults 在分页期间发生变化')
      }
      if (expectedTotal === undefined) throw new EverythingQueryError('Everything 缺少 totalResults')
      const items: any[] = data.results
      if (items.length > PAGE_SIZE) throw new EverythingQueryError('Everything 单页结果超过请求上限')
      const fingerprint = JSON.stringify(items.map(item => fullPath(item)))
      if (pageFingerprints.has(fingerprint) && items.length > 0) throw new EverythingQueryError('Everything 重复返回同一页，可能忽略了 offset')
      pageFingerprints.add(fingerprint)
      if (out.length + items.length > expectedTotal) throw new EverythingQueryError('Everything 返回结果数超过 totalResults')
      out.push(...items)
      if (out.length === expectedTotal) return out
      if (items.length === 0) throw new EverythingQueryError('Everything 在结果结束前返回空页')
      if (items.length < PAGE_SIZE) throw new EverythingQueryError('Everything 在结果结束前返回短页')
      offset += items.length
    }
    throw new EverythingQueryError('Everything 分页达到安全上限但结果仍不完整')
  }

  async searchFiles(root: string, signal?: AbortSignal): Promise<EverythingFile[]> {
    // 实测：Everything HTTP JSON 的 path 列是【父目录】、name 列是文件名，完整路径 = path + '\\' + name。
    // （path 列曾被误当作完整路径，导致文件夹被当文件入库）
    const rows = await this.fetchAll({ search: `file: path:"${root}"` }, signal)
    const seen = new Set<string>()
    return rows.map(r => ({
      path: fullPath(r),
      size: parseSize(r.size),
      dateModified: parseDateModified(r.date_modified),
    })).filter(f => {
      if (!f.path || !isWithin(f.path, root) || seen.has(f.path)) return false
      // 客户端防御（实测驱动）：
      // 1) 扩展名白名单 2) statSync 确认不是目录（路径不存在时保留——测试/索引延迟场景）
      const ext = path.extname(f.path).slice(1).toLowerCase()
      if (!VIDEO_EXTS.includes(ext)) return false
      try {
        if (fs.statSync(f.path).isDirectory()) return false
      } catch { /* 不存在：保留 */ }
      seen.add(f.path)
      return true
    })
  }

  async searchFolders(root: string, signal?: AbortSignal): Promise<string[]> {
    const rows = await this.fetchAll({ search: `path:"${root}" folder:` }, signal)
    const seen = new Set<string>()
    return rows.map(r => fullPath(r)).filter(p => {
      if (!p || !isWithin(p, root) || seen.has(p)) return false
      seen.add(p)
      return true
    })
  }
}
