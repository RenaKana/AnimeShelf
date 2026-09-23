import { Router, type Request } from 'express'
import { db } from '../../../server/db/instance'
import { POSTER_DIR } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { getAniListDetail, cachePoster, findPreferredBangumiSynopsis, preferBangumiSynopsis } from './metadata'
import { presentFolders, setDisplayMetadataFolder } from '../../../server/services/folder-presentation'
import { rebuildMediaCatalogForFolder } from '../../../server/core/catalog-access'
import { invalidateLibraryMatches } from '../../../server/core/extensions'
import { posterCacheKey } from '../../../shared/poster-cache-key'
import { candidateDomainEvidence, parseMediaDomainEvidence } from '../../../shared/media-domain'
import { isProviderRateLimitError } from '../../../server/services/provider-rate-limit'


const router = Router()

const folderDb = () => makeFolderDb(db)


function isTrustedLocalMutation(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? ''
  const isLoopback = remote === '::1' || remote === '127.0.0.1' || remote.startsWith('::ffff:127.')
  if (!isLoopback) return false
  const origin = req.get('origin')
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}


router.put('/:id/display-metadata', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面更改展示资料', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const requested = req.body?.folderId
    const folderId = requested == null ? null : Number(requested)
    if (!Number.isFinite(id) || (folderId != null && !Number.isFinite(folderId))) {
      return res.status(400).json({ error: '无效的文件夹编号', code: 'INVALID_FOLDER_ID' })
    }
    if (!folderDb().getById(id)) return res.status(404).json({ error: 'folder not found' })
    setDisplayMetadataFolder(db, id, folderId)
    rebuildMediaCatalogForFolder(db, id)
    invalidateLibraryMatches(db)
    const current = folderDb().getById(id)!
    return res.json(presentFolders(db, [current], POSTER_DIR, true)[0])
  } catch (error: any) {
    return res.status(400).json({ error: error?.message ?? '展示资料设置失败', code: 'INVALID_DISPLAY_METADATA_FOLDER' })
  }
})


router.post('/:id/refresh-metadata', async (req, res) => {
  try {
    const f = folderDb().getById(Number(req.params.id))
    if (!f) return res.status(404).json({ error: 'not found' })
    if (!f.anilist_id) return res.json(presentFolders(db, [f], POSTER_DIR, true)[0])
    const assertCurrentBinding = () => {
      const current = folderDb().getById(f.id)
      if (!current || current.source !== f.source || current.anilist_id !== f.anilist_id || current.tmdb_media_type !== f.tmdb_media_type) {
        throw Object.assign(new Error('绑定已变更，请重新刷新'), { status: 409 })
      }
    }
    const sendUpdated = (updated: typeof f) => res.json(presentFolders(db, [updated], POSTER_DIR, true)[0])
    // 按数据源刷新海报：bangumi/tmdb 用各自详情接口，anilist 用搜索回找
    if (f.source === 'bangumi') {
      const { getBangumiDetail } = await import('./metadata')
      const detail = await getBangumiDetail(f.anilist_id)
      const posterPath = detail.posterUrl ? await cachePoster(detail.posterUrl, `bg_${f.anilist_id}`, { refresh: true }) : null
      assertCurrentBinding()
      const updated = folderDb().updateAnilist(f.id, {
        source: 'bangumi', anilistId: f.anilist_id, hasPoster: Boolean(posterPath) || Boolean(f.has_poster),
        tmdbMediaType: null,
        rating: detail.rating ?? f.rating, genres: [], synopsis: detail.synopsis ?? f.synopsis, year: detail.year ?? f.year,
        episodes: detail.episodes ?? f.episodes,
        domainEvidence: candidateDomainEvidence('bangumi', { ...detail, bgmId: f.anilist_id }),
      })
      rebuildMediaCatalogForFolder(db, f.id)
      invalidateLibraryMatches(db)
      return sendUpdated(updated)
    }
    if (f.source === 'tmdb') {
      const { getTMDBPoster, getTMDBDetail } = await import('./metadata')
      if (f.tmdb_media_type !== 'movie' && f.tmdb_media_type !== 'tv') return sendUpdated(f)
      const detail = await getTMDBDetail(f.anilist_id, f.tmdb_media_type)
      const posterUrl = detail?.posterUrl ?? await getTMDBPoster(f.anilist_id, { tmdbMediaType: f.tmdb_media_type })
      if (!posterUrl && !detail) return sendUpdated(f)
      const posterKey = posterCacheKey('tmdb', f.anilist_id, f.tmdb_media_type)
      if (!posterKey) return sendUpdated(f)
      const posterPath = posterUrl ? await cachePoster(posterUrl, posterKey, { refresh: true }) : null
      assertCurrentBinding()
      const updated = folderDb().updateAnilist(f.id, {
        source: 'tmdb', anilistId: f.anilist_id, hasPoster: Boolean(posterPath) || Boolean(f.has_poster),
        tmdbMediaType: f.tmdb_media_type ?? null,
        rating: f.rating, genres: [], synopsis: detail?.synopsis ?? f.synopsis, year: f.year, episodes: f.episodes,
        domainEvidence: detail?.domainEvidence ?? (f.media_domain_evidence ? parseMediaDomainEvidence(f.media_domain_evidence) : undefined),
      })
      rebuildMediaCatalogForFolder(db, f.id)
      invalidateLibraryMatches(db)
      return sendUpdated(updated)
    }
    const found = await getAniListDetail(f.anilist_id)
    if (!found) return sendUpdated(f)
    const cand = await preferBangumiSynopsis(found)
    const posterPath = cand.posterUrl ? await cachePoster(cand.posterUrl, `al_${f.anilist_id}`, { refresh: true }) : null
    assertCurrentBinding()
    const updated = folderDb().updateAnilist(f.id, {
      source: 'anilist',
      domainEvidence: candidateDomainEvidence('anilist', cand),
      tmdbMediaType: null,
      anilistId: f.anilist_id,
      hasPoster: Boolean(posterPath),
      rating: cand.rating,
      genres: cand.genres,
      synopsis: cand.synopsis,
      year: cand.year,
      episodes: cand.episodes,
    })
    rebuildMediaCatalogForFolder(db, f.id)
    invalidateLibraryMatches(db)
    sendUpdated(updated)
  } catch (e: any) {
    if (isProviderRateLimitError(e)) return res.set('Retry-After', String(e.retryAfterSeconds)).status(429).json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds })
    res.status(e.status ?? 500).json({ error: e.message })
  }
})


// 只为 AniList 条目补 Bangumi 中文简介，不改海报、评分、集数与数据源。
router.post('/:id/prefer-bangumi-synopsis', async (req, res) => {
  try {
    const f = folderDb().getById(Number(req.params.id))
    if (!f) return res.status(404).json({ error: 'not found' })
    if (f.source !== 'anilist') return res.json(presentFolders(db, [f], POSTER_DIR, true)[0])
    const parenthesized = [...f.path.matchAll(/\(([^)]+)\)/g)].map(match => match[1].trim()).filter(Boolean)
    const pathYears = f.path.match(/(?:19|20)\d{2}/g)
    const expectedYear = pathYears?.length ? Number(pathYears[pathYears.length - 1]) : f.year
    const synopsis = await findPreferredBangumiSynopsis([f.name, ...parenthesized], expectedYear)
    if (!synopsis) return res.json(presentFolders(db, [f], POSTER_DIR, true)[0])
    db.prepare("UPDATE folders SET synopsis = ?, updated_at = datetime('now') WHERE id = ?").run([synopsis, f.id])
    rebuildMediaCatalogForFolder(db, f.id)
    invalidateLibraryMatches(db)
    return res.json(presentFolders(db, [folderDb().getById(f.id)!], POSTER_DIR, true)[0])
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})


// POST /api/folders/:id/clear-metadata — 清除整部番剧（主文件夹 + 全部子季/后代）的元数据
router.post('/:id/clear-metadata', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
    // 递归收集该文件夹全部后代（所有季），一并清除
    db.prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
      )
      UPDATE folders SET anilist_id = NULL, source = '', tmdb_media_type = NULL, rating = NULL, genres = NULL, synopsis = NULL, year = NULL, episodes = NULL, has_poster = 0,
        display_metadata_folder_id = NULL, media_domain_evidence = NULL
      WHERE id IN (SELECT id FROM sub)
    `).run(id)
    const folder = folderDb().getById(id)
    if (folder) {
      rebuildMediaCatalogForFolder(db, folder.id)
      invalidateLibraryMatches(db)
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
