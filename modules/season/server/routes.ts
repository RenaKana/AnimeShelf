import { Router } from 'express'
import { db } from '../../../server/db/instance'
import { as } from '../../../server/db/schema'
import { backfillFavoriteSchedule, currentQuarter, favoriteIdentityMatches, findBangumiSeasonEntry, getSeasonItems, isSeasonItemFavorited, mergeFavoriteLinks, reconcileFavoriteTitles, resolveFavoriteAirStatus, seasonItemIdForEntry, type FavoriteIdentityRecord, type SeasonItem } from './bangumi-data'
import { detectLibStatus } from './libhit'
import { anilistIdsOf, bangumiIdOf, bangumiIdsOf, favoriteAirStatusFallback, refreshAiringProgress, tmdbIdsOf } from './airing'
import { fetchFavoriteDetail } from './favorite-detail'
import type { AirStatus } from '../../metadata/server/metadata'
import { isOwnerRequest } from '../../../server/core/owner-request'
import { bangumiDataFavoriteEvidence, classifyFavorite, mergeFavoriteEvidence } from '../../../shared/favorite-media-domain'
import { evidenceMediaDomain, isMediaDomainOverride, parseMediaDomainEvidence, resolveMediaDomain, type MediaDomainEvidence } from '../../../shared/media-domain'
import { isProviderRateLimitError } from '../../../server/services/provider-rate-limit'

const router = Router()

export const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'UNKNOWN'] as const

type FavoriteLink = { name: string; url: string }

function parseFavoriteLinks(value: unknown): FavoriteLink[] {
  if (Array.isArray(value)) return value.filter(link => link && typeof link.url === 'string' && link.url.trim()) as FavoriteLink[]
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(link => link && typeof link.url === 'string' && link.url.trim()) as FavoriteLink[] : []
  } catch {
    return []
  }
}

function favoriteIdentityFromRow(row: any): FavoriteIdentityRecord {
  return { item_id: row.item_id, bangumi_id: row.bangumi_id, links: parseFavoriteLinks(row.links) }
}

/**
 * Title-only Bangumi-data matches are display hints, never a source identity.
 * In particular, a TMDB live-action favorite with the same title must not be
 * rebound to an unrelated animated calendar entry.
 */
function canonicalFavoriteEntry(row: { item_id: string; bangumi_id?: string | null; links?: unknown; title?: string | null; title_zh?: string | null; begin?: string | null }) {
  const links = parseFavoriteLinks(row.links)
  const bangumiId = bangumiIdOf(row.item_id, row.bangumi_id ?? null, JSON.stringify(links))
  if (!bangumiId) return null
  return findBangumiSeasonEntry({ bangumiId, title: row.title, titleZh: row.title_zh, begin: row.begin })
}

function favoriteDomainEvidence(row: { item_id: string; bangumi_id?: string | null; links?: unknown; media_domain_evidence?: unknown; title?: string | null; title_zh?: string | null; begin?: string | null }) {
  const canonical = canonicalFavoriteEntry(row)
  const canonicalItemId = canonical ? seasonItemIdForEntry(canonical.begin, canonical.title) : null
  return canonicalItemId === row.item_id ? bangumiDataFavoriteEvidence(row.item_id) : []
}

// GET /api/season/calendar — 当季全部新番按星期分组（数据源：bangumi-data，与 bgmlist 相同）
router.get('/calendar', (_req, res) => {
  try {
    const { season, year, quarter } = currentQuarter()
    const items = getSeasonItems(year, quarter)
    const favRows = as<{ item_id: string; title: string; title_zh: string | null; begin: string | null; bangumi_id: string | null; links: string | null }[]>(db.prepare('SELECT item_id, title, title_zh, begin, bangumi_id, links FROM season_favorites').all())
    const favSet = new Set(favRows.map(r => r.item_id))
    const favoriteIdentities = favRows.map(row => ({
      item_id: row.item_id,
      bangumi_id: bangumiIdOf(row.item_id, row.bangumi_id, row.links) ?? row.bangumi_id,
      links: mergeFavoriteLinks(
        parseFavoriteLinks(row.links),
        findBangumiSeasonEntry({ bangumiId: bangumiIdOf(row.item_id, row.bangumi_id, row.links), title: row.title, titleZh: row.title_zh, begin: row.begin })?.links,
      ),
    }))

    const days: Record<string, any[]> = { MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [], UNKNOWN: [] }
    for (const it of items) {
      days[it.day] ??= []
      const favorited = isSeasonItemFavorited(it, favoriteIdentities) || favSet.has(it.id)
      days[it.day].push({
        id: it.id,
        title: it.title,
        titleZh: it.titleZh,
        begin: it.begin,
        airDay: it.day,
        airTime: it.time,
        links: it.links,
        favorited,
        ...resolveMediaDomain({ evidence: bangumiDataFavoriteEvidence(it.id) }),
        media_domain_evidence: JSON.stringify(bangumiDataFavoriteEvidence(it.id)),
      })
      if (favorited) favSet.add(it.id)
    }
    for (const key of Object.keys(days)) {
      days[key].sort((a, b) => (a.airTime ?? '99:99').localeCompare(b.airTime ?? '99:99'))
    }
    res.json({ season, year, days, favorites: [...favSet] })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/season/favorites — 收藏列表（本地快照，离线可用）；旧数据缺 links 时按日文名反查补全
// 过期时先同步刷新「正在放送」已播集数（30 分钟冷却；AniList 失败静默降级为旧数据）
router.get('/favorites', async (req, res) => {
  try {
    // Bangumi 旧收藏回填可能需要多次外网请求；放到后台后立即返回本地快照，
    // 避免数据源不可达时打开心愿单卡住。下次请求会自动读到已完成的回填。
    void refreshAiringProgress().catch(() => { /* 刷新失败不影响列表 */ })
    const rows = as<any[]>(db.prepare('SELECT * FROM season_favorites ORDER BY added_at DESC').all())
    let refreshLibraryMatches = String(req.query.refresh_library_matches ?? '') === '1'
    const out = rows.map(r => {
      let links: FavoriteLink[] = parseFavoriteLinks(r.links)
      // 旧收藏以及搜索入口收藏都可按 Bangumi ID/原名/中文名补全跨站链接。
      const explicitBangumiId = bangumiIdOf(String(r.item_id), r.bangumi_id, JSON.stringify(links))
      const canonical = canonicalFavoriteEntry({ item_id: String(r.item_id), bangumi_id: r.bangumi_id, links, title: r.title, title_zh: r.title_zh, begin: r.begin })
      const schedule = backfillFavoriteSchedule(r, canonical)
      const reconciledTitles = reconcileFavoriteTitles({ item_id: r.item_id, bangumi_id: r.bangumi_id, links, title: r.title, title_zh: r.title_zh }, canonical)
      const mergedLinks = mergeFavoriteLinks(links, canonical?.links)
      const linksChanged = JSON.stringify(mergedLinks) !== JSON.stringify(links)
      links = mergedLinks
      const mergedLinksJson = JSON.stringify(links)
      const resolvedBangumiId = bangumiIdOf(String(r.item_id), r.bangumi_id, mergedLinksJson)
      const normalizedBangumiId = resolvedBangumiId ? String(resolvedBangumiId) : null
      const bangumiIdChanged = String(r.bangumi_id ?? '') !== String(normalizedBangumiId ?? '')
      if (linksChanged || reconciledTitles.changed || bangumiIdChanged || schedule.changed) {
        db.prepare('UPDATE season_favorites SET title = ?, title_zh = ?, air_day = ?, air_time = ?, begin = ?, bangumi_id = ?, links = ? WHERE item_id = ?')
          .run([reconciledTitles.title, reconciledTitles.titleZh, schedule.air_day, schedule.air_time, schedule.begin, normalizedBangumiId, links.length > 0 ? mergedLinksJson : null, r.item_id])
      }
      const domainRow = { ...r, item_id: String(r.item_id), bangumi_id: normalizedBangumiId, links, title: reconciledTitles.title, title_zh: reconciledTitles.titleZh, begin: schedule.begin }
      const favoriteDomain = classifyFavorite(domainRow, favoriteDomainEvidence(domainRow))
      // 媒体库重复检测：允许用户覆盖；自动模式使用 ID 精确 → 保守名称兜底。
      const forceLibraryRefresh = refreshLibraryMatches && !r.lib_match_override
      const sourceIds = {
        bangumiIds: bangumiIdsOf(String(r.item_id), normalizedBangumiId, mergedLinksJson),
        anilistIds: anilistIdsOf(String(r.item_id), mergedLinksJson),
        tmdbIds: tmdbIdsOf(String(r.item_id), mergedLinksJson),
        mediaDomain: favoriteDomain.media_domain,
      }
      const autoStatus = r.lib_match_override
        ? null
        : detectLibStatus(r.item_id, reconciledTitles.title, reconciledTitles.titleZh, sourceIds, forceLibraryRefresh)
      const libStatus = r.lib_match_override === 'absent'
        ? 'absent'
        : r.lib_match_override === 'present'
          ? 'present'
          : autoStatus?.status ?? 'unknown'
      const hit = r.lib_match_override === 'absent'
        ? null
        : r.lib_match_override === 'present'
          ? { matched: true, method: 'manual', folderName: null, folderId: null }
          : autoStatus?.hit ?? null
      return { ...r, ...favoriteDomain, title: reconciledTitles.title, title_zh: reconciledTitles.titleZh, air_day: schedule.air_day, air_time: schedule.air_time, begin: schedule.begin, bangumi_id: normalizedBangumiId, links: links ?? [], lib_hit: hit, lib_status: libStatus }
    })
    res.json(out)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// 收藏时获取详情：优先 Bangumi（中文站，经代理），回退 AniList；返回海报路径 + 简介
// source: 'auto' = Bangumi 优先（中文），AniList 补充原文，均无则 TMDB；'anilist' / 'bangumi' / 'tmdb' = 仅指定源
// （实现已提取到 services/favorite-detail.ts，season 路由与 poster-repair 补抓共用）

// POST /api/season/favorites { item_id, title, title_zh?, air_day?, air_time?, begin?, bangumi_id?, links?, image?, media_type?, fallback metadata... }
router.post('/favorites', async (req, res) => {
  try {
    const { item_id, title, title_zh, air_day, air_time, begin, bangumi_id, links, image, media_type, media_domain_evidence, air_status, synopsis: synopsisFallback, synopsis_original: synopsisOriginalFallback, aired_episodes: airedEpisodesFallback, total_episodes: totalEpisodesFallback } = req.body as {
      item_id?: string; title?: string; title_zh?: string | null; air_day?: string | null; air_time?: string | null; begin?: string | null; bangumi_id?: string | null; links?: { name: string; url: string }[] | null; image?: string | null; media_type?: 'anime' | 'live' | null; media_domain_evidence?: unknown; air_status?: AirStatus; synopsis?: string | null; synopsis_original?: string | null; aired_episodes?: number | null; total_episodes?: number | null
    }
    if (!item_id || !title) return res.status(400).json({ error: 'item_id and title required' })
    const incomingItemId = String(item_id)
    const incomingLinks = parseFavoriteLinks(links)
    // `media_type` is retained for old clients/API compatibility only.  It is
    // never used as the desktop classification source.
    const mt = media_type ?? (incomingItemId.startsWith('manual-tmdb-') ? 'live' : 'anime')
    const inferredBangumiId = bangumiIdOf(incomingItemId, bangumi_id ?? null, JSON.stringify(incomingLinks))
    const canonical = canonicalFavoriteEntry({ item_id: incomingItemId, bangumi_id: inferredBangumiId == null ? null : String(inferredBangumiId), links: incomingLinks, title, title_zh, begin })
    const mergedIncomingLinks = mergeFavoriteLinks(incomingLinks, canonical?.links)
    const incomingEvidence = parseMediaDomainEvidence(media_domain_evidence)
    const canonicalItemId = canonical ? seasonItemIdForEntry(canonical.begin, canonical.title) : null
    const calendarEvidence = canonicalItemId === incomingItemId ? bangumiDataFavoriteEvidence(incomingItemId) : []
    const candidateEvidence = [...incomingEvidence, ...calendarEvidence]
    const resolvedTitle = canonical?.title || title
    const resolvedTitleZh = canonical?.titleZh ?? title_zh ?? null
    const resolvedBangumiId = canonical?.bangumiId ?? (inferredBangumiId == null ? null : String(inferredBangumiId)) ?? bangumi_id ?? null

    // 日历入口使用 md5 item_id，搜索入口使用 manual-*；先按资料身份查找旧行，
    // 避免重新添加同一番剧时 INSERT OR REPLACE 删除用户字段。
    const existingRows = as<any[]>(db.prepare('SELECT item_id, title, title_zh, air_day, air_time, begin, bangumi_id, links, image, synopsis, synopsis_original, aired_episodes, total_episodes, air_status, media_type, media_domain_override, media_domain_evidence FROM season_favorites').all())
    const existing = existingRows.find(row => {
      const identity = favoriteIdentityFromRow(row)
      const rowCanonical = canonicalFavoriteEntry(row)
      return favoriteIdentityMatches(
        { item_id: incomingItemId, bangumi_id: resolvedBangumiId, links: mergedIncomingLinks },
        {
          ...identity,
          bangumi_id: identity.bangumi_id ?? rowCanonical?.bangumiId,
          links: mergeFavoriteLinks(identity.links as FavoriteLink[] | null | undefined, rowCanonical?.links),
        },
      )
    })
    const targetItemId = existing?.item_id ?? incomingItemId
    // 未提供详情时自动获取（海报 + 简介：Bangumi → AniList）
    let posterPath: string | null = null
    // 传入的远程海报 URL 先缓存到本地（前端无法直连第三方图床）
    if (image && /^https?:\/\//.test(image)) {
      try {
        const { cachePoster } = await import('../../metadata/server/metadata')
         posterPath = await cachePoster(image, `fav_${targetItemId}`)
      } catch { /* 缓存失败则尝试详情抓取 */ }
    } else if (image) {
      posterPath = image // 本地 /posters/ 路径直接使用
    }
    let synopsis: string | null = synopsisFallback ?? null
    let synopsisOriginal: string | null = synopsisOriginalFallback ?? null
    let airedEpisodes: number | null = airedEpisodesFallback ?? null
    let totalEpisodes: number | null = totalEpisodesFallback ?? null
    let detailAirStatus: AirStatus = null
    let detailEvidence: MediaDomainEvidence[] = []
    const detailDomain = classifyFavorite(
      existing
        ? { ...existing, item_id: String(existing.item_id), bangumi_id: existing.bangumi_id, links: existing.links, media_domain_evidence: existing.media_domain_evidence }
        : { item_id: incomingItemId, bangumi_id: inferredBangumiId, links: mergedIncomingLinks, media_domain_evidence: candidateEvidence.length ? JSON.stringify(candidateEvidence) : null },
      candidateEvidence,
    ).media_domain
    if (mergedIncomingLinks.length > 0) {
      try {
        const detail = await fetchFavoriteDetail(targetItemId, mergedIncomingLinks, 'auto', detailDomain)
        // 详情抓取结果优先；网络失败/字段缺失时再保留搜索候选的 fallback。
        posterPath = detail.posterPath ?? posterPath
        synopsis = detail.synopsis ?? synopsis
        synopsisOriginal = detail.synopsisOriginal ?? synopsisOriginal
        airedEpisodes = detail.airedEpisodes ?? airedEpisodes
        totalEpisodes = detail.totalEpisodes ?? totalEpisodes
        detailAirStatus = detail.airStatus ?? null
        detailEvidence = detail.domainEvidence ?? []
      } catch {
        // 详情源暂时不可达时继续保存候选 fallback。
      }
    }
    const existingLinks = existing ? parseFavoriteLinks(existing.links) : []
    const finalLinks = mergeFavoriteLinks(existingLinks, mergedIncomingLinks)
    const schedule = backfillFavoriteSchedule({
      begin: existing?.begin ?? begin ?? null,
      air_day: existing?.air_day ?? air_day ?? null,
      air_time: existing?.air_time ?? air_time ?? null,
    }, canonical)
    const finalTitle = resolvedTitle || existing?.title || title
    const finalTitleZh = resolvedTitleZh ?? existing?.title_zh ?? null
    const finalAirDay = schedule.air_day
    const finalAirTime = schedule.air_time
    const finalBegin = schedule.begin
    const finalBangumiId = resolvedBangumiId ?? existing?.bangumi_id ?? null
    // NULL fallback 不得覆盖现有数据；简介还可能是用户自定义内容，已有值优先保留。
    const finalImage = existing?.image ?? posterPath
    const finalSynopsis = existing?.synopsis != null ? existing.synopsis : synopsis
    const finalSynopsisOriginal = synopsisOriginal ?? existing?.synopsis_original ?? null
    const finalAiredEpisodes = airedEpisodes ?? existing?.aired_episodes ?? null
    const finalTotalEpisodes = totalEpisodes ?? existing?.total_episodes ?? null
    const finalDomain = classifyFavorite(
      existing
        ? { ...existing, item_id: targetItemId, bangumi_id: finalBangumiId, links: finalLinks, media_domain_evidence: existing.media_domain_evidence }
        : { item_id: targetItemId, bangumi_id: finalBangumiId, links: finalLinks, media_domain_evidence: candidateEvidence.length ? JSON.stringify(candidateEvidence) : null },
      candidateEvidence,
    ).media_domain
    const fallbackAirStatus = finalDomain === 'anime' ? favoriteAirStatusFallback(finalBegin) : null
    const finalAirStatus = resolveFavoriteAirStatus(air_status, detailAirStatus, existing?.air_status ?? null, fallbackAirStatus)
    const finalMediaType = existing?.media_type ?? mt
    if (existing) {
      db.prepare('UPDATE season_favorites SET title = ?, title_zh = ?, air_day = ?, air_time = ?, begin = ?, bangumi_id = ?, links = ?, image = ?, synopsis = ?, synopsis_original = ?, aired_episodes = ?, total_episodes = ?, air_status = ?, media_type = ? WHERE item_id = ?')
        .run([finalTitle, finalTitleZh, finalAirDay, finalAirTime, finalBegin, finalBangumiId, finalLinks.length > 0 ? JSON.stringify(finalLinks) : null, finalImage, finalSynopsis, finalSynopsisOriginal, finalAiredEpisodes, finalTotalEpisodes, finalAirStatus, finalMediaType, targetItemId])
    } else {
      db.prepare('INSERT INTO season_favorites (item_id, title, title_zh, air_day, air_time, begin, bangumi_id, links, image, synopsis, synopsis_original, aired_episodes, total_episodes, air_status, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run([targetItemId, finalTitle, finalTitleZh, finalAirDay, finalAirTime, finalBegin, finalBangumiId, finalLinks.length > 0 ? JSON.stringify(finalLinks) : null, finalImage, finalSynopsis, finalSynopsisOriginal, finalAiredEpisodes, finalTotalEpisodes, finalAirStatus, finalMediaType])
    }
    // Detail fetching is asynchronous and another refresh may have written a
    // newer evidence set meanwhile.  Re-read the row and merge only evidence
    // bound to its current identities so concurrent writes cannot erase a
    // confirmed result.
    const latest = as<any | undefined>(db.prepare('SELECT item_id, bangumi_id, links, media_domain_override, media_domain_evidence FROM season_favorites WHERE item_id = ?').get(targetItemId) ?? undefined)
    if (latest) {
      const mergedEvidence = mergeFavoriteEvidence(latest, [...candidateEvidence, ...detailEvidence])
      if (mergedEvidence !== latest.media_domain_evidence) {
        db.prepare('UPDATE season_favorites SET media_domain_evidence = ? WHERE item_id = ?').run([mergedEvidence, targetItemId])
      }
    }
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/season/favorites/:itemId
router.delete('/favorites/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM season_favorites WHERE item_id = ?').run(String(req.params.id))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/season/favorites/:id/poster { url? } — 更新海报：无 url 重新从 Bangumi/AniList 获取；有 url 用自定义图片
router.post('/favorites/:id/poster', async (req, res) => {
  try {
    const itemId = String(req.params.id)
    const row = as<any | undefined>(db.prepare('SELECT item_id, title, title_zh, begin, air_day, air_time, bangumi_id, links, media_domain_override, media_domain_evidence FROM season_favorites WHERE item_id = ?').get(itemId) ?? undefined)
    if (!row) return res.status(404).json({ error: 'favorite not found' })
    const { url, source } = req.body as { url?: string; source?: 'auto' | 'anilist' | 'bangumi' | 'tmdb' }
    let posterPath: string | null = null
    if (url && /^https?:\/\//.test(url)) {
      const { cachePoster } = await import('../../metadata/server/metadata')
      posterPath = await cachePoster(url, `fav_${itemId}`)
    } else {
      const links = parseFavoriteLinks(row.links)
      const explicitBangumiId = bangumiIdOf(itemId, row.bangumi_id, JSON.stringify(links))
      // Poster refreshes may update links/schedule, but title-only matches are
      // never strong enough to bind a favorite to a canonical season.
      const canonical = canonicalFavoriteEntry({ ...row, item_id: itemId, bangumi_id: explicitBangumiId == null ? row.bangumi_id : String(explicitBangumiId), links })
      const schedule = backfillFavoriteSchedule(row, canonical)
      const reconciledTitles = reconcileFavoriteTitles({ item_id: row.item_id, bangumi_id: row.bangumi_id, links, title: row.title, title_zh: row.title_zh }, canonical)
      const mergedLinks = mergeFavoriteLinks(links, canonical?.links)
      const linksChanged = JSON.stringify(mergedLinks) !== JSON.stringify(links)
      const bangumiIdChanged = !String(row.bangumi_id ?? '').trim() && Boolean(explicitBangumiId)
      if (linksChanged || reconciledTitles.changed || bangumiIdChanged || schedule.changed) {
        db.prepare("UPDATE season_favorites SET title = ?, title_zh = ?, bangumi_id = CASE WHEN TRIM(COALESCE(bangumi_id, '')) = '' THEN ? ELSE bangumi_id END, air_day = ?, air_time = ?, begin = ?, links = ? WHERE item_id = ?")
          .run([reconciledTitles.title, reconciledTitles.titleZh, explicitBangumiId, schedule.air_day, schedule.air_time, schedule.begin, mergedLinks.length > 0 ? JSON.stringify(mergedLinks) : null, itemId])
      }
      if (mergedLinks.length === 0) {
        return res.status(422).json({ error: '该条目没有可用的资料来源，请先补充 Bangumi/AniList/TMDB 链接' })
      }
      const detailRow = {
        ...row,
        item_id: itemId,
        bangumi_id: explicitBangumiId == null ? row.bangumi_id : String(explicitBangumiId),
        links: mergedLinks,
      }
      const detailDomain = classifyFavorite(detailRow, favoriteDomainEvidence(detailRow)).media_domain
      let detail
      try {
        detail = await fetchFavoriteDetail(itemId, mergedLinks, source ?? 'auto', detailDomain)
      } catch (error) {
        if (isProviderRateLimitError(error)) {
          return res.set('Retry-After', String(error.retryAfterSeconds)).status(429).json({ error: error.message, code: error.code, retryAfterSeconds: error.retryAfterSeconds })
        }
        return res.status(502).json({ error: '资料源暂时不可用，未能更新资料与海报' })
      }
      const latest = as<any | undefined>(db.prepare('SELECT item_id, bangumi_id, links, media_domain_override, media_domain_evidence FROM season_favorites WHERE item_id = ?').get(itemId) ?? undefined)
      if (latest && detail.domainEvidence?.length) {
        const mergedEvidence = mergeFavoriteEvidence(latest, detail.domainEvidence)
        if (mergedEvidence !== latest.media_domain_evidence) {
          db.prepare('UPDATE season_favorites SET media_domain_evidence = ? WHERE item_id = ?').run([mergedEvidence, itemId])
        }
      }
      const hasDomainEvidence = (detail.domainEvidence ?? []).some(entry => evidenceMediaDomain(entry) !== 'unknown')
      const hasDetail = Boolean(hasDomainEvidence || detail.posterPath || detail.synopsis || detail.synopsisOriginal || detail.airedEpisodes != null || detail.totalEpisodes != null || detail.airStatus != null)
      if (!hasDetail) {
        return res.status(502).json({ error: '资料源未返回可用资料，未能更新资料与海报' })
      }
      posterPath = detail.posterPath
      if (detail.synopsis || detail.synopsisOriginal || detail.airedEpisodes != null || detail.totalEpisodes != null || detail.airStatus != null) {
        db.prepare('UPDATE season_favorites SET synopsis = COALESCE(?, synopsis), synopsis_original = COALESCE(?, synopsis_original), aired_episodes = COALESCE(?, aired_episodes), total_episodes = COALESCE(?, total_episodes), air_status = COALESCE(?, air_status) WHERE item_id = ?').run([detail.synopsis, detail.synopsisOriginal, detail.airedEpisodes, detail.totalEpisodes, detail.airStatus, itemId])
      }
    }
    if (url) {
      db.prepare('UPDATE season_favorites SET image = ? WHERE item_id = ?').run([posterPath, itemId])
    } else {
      // 数据源临时不可达时保留现有海报，不让“重新获取”把已有图片清空。
      db.prepare('UPDATE season_favorites SET image = COALESCE(?, image) WHERE item_id = ?').run([posterPath, itemId])
    }
    res.json({ ok: true, image: posterPath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/season/favorites/:id/library-status — 覆盖“媒体库已有”的自动判断
router.put('/favorites/:id/library-status', (req, res) => {
  try {
    const itemId = String(req.params.id)
    const override = String(req.body?.override ?? 'auto')
    if (!['auto', 'present', 'absent'].includes(override)) {
      return res.status(400).json({ error: 'override must be auto, present, or absent' })
    }
    const row = as<any | undefined>(db.prepare('SELECT item_id FROM season_favorites WHERE item_id = ?').get(itemId) ?? undefined)
    if (!row) return res.status(404).json({ error: 'favorite not found' })
    const stored = override === 'auto' ? null : override
    db.prepare('UPDATE season_favorites SET lib_match_override = ? WHERE item_id = ?').run([stored, itemId])
    res.json({ ok: true, lib_match_override: stored })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PUT /api/season/favorites/:id/media-domain — only the current favorite row
// is changed; this never propagates into folders or other catalog records.
router.put('/favorites/:id/media-domain', (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: 'owner request required' })
    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'override') || !isMediaDomainOverride(req.body?.override)) {
      return res.status(400).json({ error: 'override must be anime, live_action, unknown, or null' })
    }
    const itemId = String(req.params.id)
    const row = as<any | undefined>(db.prepare('SELECT item_id FROM season_favorites WHERE item_id = ?').get(itemId) ?? undefined)
    if (!row) return res.status(404).json({ error: 'favorite not found' })
    db.prepare('UPDATE season_favorites SET media_domain_override = ? WHERE item_id = ?').run([req.body.override, itemId])
    const updated = as<any | undefined>(db.prepare('SELECT item_id, title, title_zh, begin, bangumi_id, links, media_domain_override, media_domain_evidence FROM season_favorites WHERE item_id = ?').get(itemId) ?? undefined)
    return res.json({ ok: true, ...(updated ?? {}), ...classifyFavorite(updated ?? { item_id: itemId, media_domain_override: req.body.override }, updated ? favoriteDomainEvidence(updated) : undefined) })
  } catch (e: any) { return res.status(500).json({ error: e.message }) }
})

// PUT /api/season/favorites/:id — 更新简介（用户自定义）
router.put('/favorites/:id', async (req, res) => {
  try {
    const itemId = String(req.params.id)
    const { synopsis } = req.body as { synopsis?: string }
    if (typeof synopsis !== 'string') return res.status(400).json({ error: 'synopsis 必填' })
    const row = as<any | undefined>(db.prepare('SELECT item_id FROM season_favorites WHERE item_id = ?').get(itemId) ?? undefined)
    if (!row) return res.status(404).json({ error: 'favorite not found' })
    db.prepare('UPDATE season_favorites SET synopsis = ? WHERE item_id = ?').run([synopsis.slice(0, 2000), itemId])
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
