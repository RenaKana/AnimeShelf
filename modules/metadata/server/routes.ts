import { Router } from 'express'
import { db } from '../../../server/db/instance'
import { makeFolderDb } from '../../../server/db/folders'
import {
  searchAniList, searchBangumi, getBangumiDetail, searchTMDB, getTMDBKey,
  assertCandidateMatchesFolder, bindAnilist, bindBangumi, bindTMDB, preferBangumiSynopsis, mergeBangumiDetail,
  MetadataDomainError, folderMatchingDomain,
} from './metadata'
import type { AniListCandidate, BangumiCandidate, TMDBCandidate } from './metadata'
import { presentFolders, setDisplayMetadataFolder } from '../../../server/services/folder-presentation'
import { POSTER_DIR } from '../../../server/db/schema'
import { invalidateLibraryMatches } from '../../../server/core/extensions'
import type { MediaDomain } from '../../../shared/media-domain'
import { isProviderRateLimitError } from '../../../server/services/provider-rate-limit'

const router = Router()

const SEARCH_CACHE_TTL = 10 * 60 * 1000
const searchCache = new Map<string, { expires: number; data: unknown[] }>()
const searchInFlight = new Map<string, Promise<unknown[]>>()

async function cachedSearch<T>(key: string, loader: () => Promise<T[]>): Promise<T[]> {
  const now = Date.now()
  const cached = searchCache.get(key)
  if (cached && cached.expires > now) return cached.data as T[]
  const existing = searchInFlight.get(key)
  if (existing) return existing as Promise<T[]>
  const request = loader().then(data => {
    searchCache.set(key, { expires: Date.now() + SEARCH_CACHE_TTL, data })
    if (searchCache.size > 200) {
      const oldest = searchCache.keys().next().value
      if (oldest) searchCache.delete(oldest)
    }
    return data
  }).finally(() => searchInFlight.delete(key))
  searchInFlight.set(key, request)
  return request
}

function requestedFolderId(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) || typeof value !== 'string' || !/^\d+$/.test(value)) throw new MetadataDomainError('folder_id 参数格式无效', 400, 'INVALID_FOLDER_ID')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new MetadataDomainError('folder_id 参数格式无效', 400, 'INVALID_FOLDER_ID')
  return id
}

function targetDomainForFolder(folderId: number | undefined): MediaDomain | undefined {
  if (folderId === undefined) return undefined
  // Resolve the folder before making an external request, so a stale picker
  // cannot search or bind against an unrelated directory.
  // A manual picker must be able to repair an incorrectly classified binding.
  folderMatchingDomain(db, folderId)
  return 'unknown'
}

// GET /api/metadata/search?q=&source=anilist|bangumi|tmdb&folder_id= — 多源元数据搜索
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const source = String(req.query.source ?? 'bangumi')
    const folderId = requestedFolderId(req.query.folder_id)
    const targetDomain = targetDomainForFolder(folderId)
    if (!q) return res.json([])
    const cacheKey = `${source}:${targetDomain ?? 'any'}:${q.normalize('NFKC').toLocaleLowerCase()}`
    // 变体回退：输入含 [标签]/(括号) 时，自动先搜无括号主体，再试括号内英文名等
    const { searchVariants } = await import('./libraries')
    const queries = searchVariants(q)
    const tryEach = async <T>(fn: (qq: string) => Promise<T[]>): Promise<T[]> => {
      for (const qq of queries) {
        const list = await fn(qq)
        if (list.length > 0) return list
      }
      return []
    }
    if (source === 'bangumi') return res.json(await cachedSearch(cacheKey, () => tryEach((qq: string) => searchBangumi(qq, targetDomain ? { mediaDomain: targetDomain } : {}))))
    if (source === 'tmdb') {
      const key = getTMDBKey()
      if (!key) return res.status(400).json({ error: 'TMDB API Key 未配置，请先在设置页填写' })
      return res.json(await cachedSearch(cacheKey, () => tryEach((qq: string) => searchTMDB(qq, key, targetDomain ? { mediaDomain: targetDomain } : {}))))
    }
    if (source !== 'anilist') return res.status(400).json({ error: '不支持的元数据来源' })
    return res.json(await cachedSearch(cacheKey, () => tryEach((qq: string) => searchAniList(qq, targetDomain ? { mediaDomain: targetDomain } : {}))))
  } catch (e: any) {
    if (e instanceof MetadataDomainError) return res.status(e.status).json({ error: e.message, code: e.code })
    if (isProviderRateLimitError(e)) return res.set('Retry-After', String(e.retryAfterSeconds)).status(429).json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds })
    if (e?.response?.status === 429) return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    res.status(500).json({ error: e.message })
  }
})

// POST /api/metadata/bind { folder_id, source, candidate } — 按数据源绑定
router.post('/bind', async (req, res) => {
  try {
    const { folder_id, source, candidate } = req.body as {
      folder_id?: number
      source?: string
      candidate?: AniListCandidate & BangumiCandidate & TMDBCandidate
    }
    if (!folder_id || !candidate) return res.status(400).json({ error: 'folder_id and candidate required' })
    const f = makeFolderDb(db).getById(Number(folder_id))
    if (!f) return res.status(404).json({ error: 'folder not found' })
    if (source !== 'anilist' && source !== 'bangumi' && source !== 'tmdb') return res.status(400).json({ error: '不支持的元数据来源' })
    assertCandidateMatchesFolder(db, Number(folder_id), source, candidate)

    if (source === 'bangumi' && (candidate as BangumiCandidate).bgmId) {
      // Bangumi 搜索候选缺详情，绑定前补全（评分/中文简介/海报）
      const bangumiCandidate = candidate as BangumiCandidate
      const detail = await getBangumiDetail(bangumiCandidate.bgmId, {
        expectedBangumiType: bangumiCandidate.type === 2 || bangumiCandidate.type === 6 ? bangumiCandidate.type : undefined,
      })
      const bound = await bindBangumi(Number(folder_id), mergeBangumiDetail(bangumiCandidate, detail), db)
      setDisplayMetadataFolder(db, Number(folder_id), Number(folder_id))
      invalidateLibraryMatches(db)
      return res.json(presentFolders(db, [bound], POSTER_DIR, true)[0])
    }
    if (source === 'tmdb' && (candidate as TMDBCandidate).tmdbId) {
      const bound = await bindTMDB(Number(folder_id), candidate as TMDBCandidate, db)
      setDisplayMetadataFolder(db, Number(folder_id), Number(folder_id))
      invalidateLibraryMatches(db)
      return res.json(presentFolders(db, [bound], POSTER_DIR, true)[0])
    }
    if ((candidate as AniListCandidate).anilistId) {
      const enriched = await preferBangumiSynopsis(candidate as AniListCandidate)
      const bound = await bindAnilist(Number(folder_id), enriched, db)
      setDisplayMetadataFolder(db, Number(folder_id), Number(folder_id))
      invalidateLibraryMatches(db)
      return res.json(presentFolders(db, [bound], POSTER_DIR, true)[0])
    }
    res.status(400).json({ error: 'candidate 缺少有效 id' })
  } catch (e: any) {
    if (e instanceof MetadataDomainError) return res.status(e.status).json({ error: e.message, code: e.code })
    if (isProviderRateLimitError(e)) return res.set('Retry-After', String(e.retryAfterSeconds)).status(429).json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds })
    if (e?.response?.status === 429) return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    res.status(500).json({ error: e.message })
  }
})

// GET /api/metadata/image?u= — 代理远程海报图片（服务端走代理抓取，前端无需直连被墙图床）；白名单防 SSRF
const IMAGE_HOST_ALLOWLIST = [
  'lain.bgm.tv', 'bgm.tv', 'lain.bgm.tv',
  's4.anilist.co', 'image.anilist.co',
  'image.tmdb.org',
]
router.get('/image', async (req, res) => {
  try {
    const u = String(req.query.u ?? '').trim()
    let parsed: URL
    try { parsed = new URL(u) } catch { return res.status(400).json({ error: 'invalid url' }) }
    if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'invalid protocol' })
    if (!IMAGE_HOST_ALLOWLIST.includes(parsed.hostname)) return res.status(403).json({ error: 'host not allowed' })
    const { fetchRemoteImage } = await import('./metadata')
    const image = await fetchRemoteImage(u)
    res.setHeader('Content-Type', image.contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(image.data)
  } catch {
    res.status(404).json({ error: 'image fetch failed' })
  }
})

export default router
