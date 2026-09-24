import { db } from '../../../server/db/instance'
import { moduleRuntime } from '../../../server/core/extensions'
import { requestSignal } from '../../../server/core/request-signal'
import { isProviderRateLimitError, providerRequest, readProviderJson } from '../../../server/services/provider-rate-limit'
import { networkFetch } from '../../../server/services/network'
import { ProxyError } from '../../../server/services/proxy'
import { getBangumiDetail, type AirStatus } from '../../metadata/server/metadata'
import { classifyFavorite } from '../../../shared/favorite-media-domain'

// 心愿单放送信息刷新：
// - 有 MAL 链接的条目使用一次 AniList 批量请求，获得精确 status/episodes/nextAiringEpisode。
// - 只有 Bangumi 链接的手动收藏使用 Bangumi 详情，补全计划集数与推断状态。

const COOLDOWN_MS = 30 * 60_000
const BANGUMI_ITEM_COOLDOWN_MS = 24 * 60 * 60_000
const BANGUMI_CONCURRENCY = 4
let lastRefresh = 0
let refreshInFlight: Promise<number> | null = null
const bangumiAttemptedAt = new Map<string, number>()

type FavoriteProgressRow = {
  item_id: string
  bangumi_id: string | null
  links: string | null
  air_status: AirStatus
  aired_episodes: number | null
  total_episodes: number | null
  media_domain_override?: 'anime' | 'live_action' | 'unknown' | null
  media_domain_evidence?: string | null
}

/** 首次抓取详情失败时的保守状态：只依据 begin 是否已到达，不能用 air_day 推断正在放送。 */
export function favoriteAirStatusFallback(begin: string | null | undefined, now = new Date()): Exclude<AirStatus, null> {
  if (!begin || !begin.trim()) return 'upcoming'
  const parsed = new Date(begin.trim().replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, '$1-$2-$3'))
  if (Number.isNaN(parsed.getTime())) return 'upcoming'
  return parsed.getTime() > now.getTime() ? 'upcoming' : 'airing'
}

function parsedLinks(linksJson: string | null): { name: string; url: string }[] {
  if (!linksJson) return []
  try {
    const value = JSON.parse(linksJson)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function sourceIdsFromLinks(linksJson: string | null, source: 'anilist' | 'bangumi' | 'tmdb'): number[] {
  const ids: number[] = []
  for (const link of parsedLinks(linksJson)) {
    const name = String(link.name ?? '').toLocaleLowerCase()
    const url = String(link.url ?? '').trim()
    let match: RegExpMatchArray | null = null
    if (source === 'anilist') {
      match = url.match(/(?:anilist\.co|anilist\.com)\/anime\/(\d+)/i)
      if (!match && /anilist/.test(name)) match = url.match(/(?:^|[^\d])(\d{1,10})(?:$|[^\d])/)
    } else if (source === 'bangumi') {
      match = url.match(/(?:bangumi\.tv|bgm\.tv|chii\.in)\/subject\/(\d+)/i)
      if (!match && /番组计划|bangumi/.test(name)) match = url.match(/(?:^|[^\d])(\d{1,10})(?:$|[^\d])/)
    } else {
      match = url.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i)
      if (!match && /tmdb/.test(name)) match = url.match(/(?:^|[^\d])(\d{1,10})(?:$|[^\d])/)
    }
    const id = positiveId(match?.[1])
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function manualSourceIdOf(itemId: string, source: 'anilist' | 'bangumi' | 'tmdb'): number | null {
  return positiveId(itemId.match(new RegExp(`^manual-${source}-(\\d+)$`))?.[1])
}

/**
 * Returns all Bangumi ids, ordered as primary identity followed by related
 * links. The stored bangumi_id column is authoritative when present; a
 * manual-bangumi item id is the primary identity when that column is absent.
 */
export function bangumiIdsOf(itemId: string, bangumiId: string | null, linksJson: string | null): number[] {
  const ids: number[] = []
  const direct = positiveId(bangumiId)
  const manual = manualSourceIdOf(itemId, 'bangumi')
  const linked = sourceIdsFromLinks(linksJson, 'bangumi')
  for (const id of [direct, manual, ...linked]) {
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Returns all AniList ids, with a manual-anilist item id first when present. */
export function anilistIdsOf(itemId: string, linksJson: string | null): number[] {
  const ids: number[] = []
  const manual = manualSourceIdOf(itemId, 'anilist')
  for (const id of [manual, ...sourceIdsFromLinks(linksJson, 'anilist')]) {
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Returns all TMDB ids, with a manual-tmdb item id first when present. */
export function tmdbIdsOf(itemId: string, linksJson: string | null): number[] {
  const ids: number[] = []
  const manual = manualSourceIdOf(itemId, 'tmdb')
  for (const id of [manual, ...sourceIdsFromLinks(linksJson, 'tmdb')]) {
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

// 从收藏 links JSON 提取 MyAnimeList ID（形如 https://myanimelist.net/anime/5114/...）
export function malIdOf(linksJson: string | null): number | null {
  const url = parsedLinks(linksJson).find(link => link.name === 'MyAnimeList')?.url
  const match = url?.match(/\/anime\/(\d+)/)
  return match ? Number(match[1]) : null
}

export function anilistIdOf(itemId: string, linksJson: string | null): number | null {
  const url = parsedLinks(linksJson).find(link => link.name === 'AniList')?.url
  const fromLink = url?.match(/\/anime\/(\d+)/)?.[1]
  if (fromLink) return Number(fromLink)
  return manualSourceIdOf(itemId, 'anilist')
}

// 兼容三种历史写法：bangumi_id 列、番组计划链接、manual-bangumi-<id> 主键。
export function bangumiIdOf(itemId: string, bangumiId: string | null, linksJson: string | null): number | null {
  const direct = Number(bangumiId)
  if (Number.isInteger(direct) && direct > 0) return direct
  const url = parsedLinks(linksJson).find(link => link.name === '番组计划')?.url
  const fromLink = url?.match(/\/subject\/(\d+)/)?.[1]
  if (fromLink) return Number(fromLink)
  return manualSourceIdOf(itemId, 'bangumi')
}

export function tmdbIdOf(itemId: string, linksJson: string | null): number | null {
  const url = parsedLinks(linksJson).find(link => link.name === 'TMDB')?.url
  const fromLink = url?.match(/\/(?:movie|tv)\/(\d+)/)?.[1]
  if (fromLink) return Number(fromLink)
  return manualSourceIdOf(itemId, 'tmdb')
}

function aniListStatus(value: unknown): AirStatus {
  if (value === 'RELEASING') return 'airing'
  if (value === 'FINISHED') return 'finished'
  if (value === 'NOT_YET_RELEASED') return 'upcoming'
  return null
}

async function refreshAniList(rows: FavoriteProgressRow[]): Promise<number> {
  const byAniList = new Map<number, FavoriteProgressRow[]>()
  const byMal = new Map<number, FavoriteProgressRow[]>()
  for (const row of rows) {
    const anilistId = anilistIdOf(row.item_id, row.links)
    if (anilistId) {
      const sameMedia = byAniList.get(anilistId) ?? []
      sameMedia.push(row)
      byAniList.set(anilistId, sameMedia)
      continue
    }
    const malId = malIdOf(row.links)
    if (!malId) continue
    const sameMedia = byMal.get(malId) ?? []
    sameMedia.push(row)
    byMal.set(malId, sameMedia)
  }
  if (byAniList.size === 0 && byMal.size === 0) return 0

  const ids = [...byAniList.keys()].slice(0, 50)
  const malIds = [...byMal.keys()].slice(0, 50)
  const signal = requestSignal(db, undefined, 8000)
  const resp = await providerRequest('anilist', signal, () => networkFetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'AnimeShelf/1.0 (local media manager)' },
    body: JSON.stringify({
      query: 'query ($ids: [Int], $malIds: [Int]) { byId: Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id idMal episodes status nextAiringEpisode { episode } } } byMal: Page(perPage: 50) { media(idMal_in: $malIds, type: ANIME) { id idMal episodes status nextAiringEpisode { episode } } } }',
      variables: { ids, malIds },
    }),
    signal,
  }))
  if (!resp.ok) throw new Error(`AniList ${resp.status}`)
  const data: any = await readProviderJson('anilist', resp)
  const medias: any[] = [
    ...(Array.isArray(data?.data?.byId?.media) ? data.data.byId.media : []),
    ...(Array.isArray(data?.data?.byMal?.media) ? data.data.byMal.media : []),
  ]

  const update = db.prepare(`
    UPDATE season_favorites
    SET aired_episodes = COALESCE(?, aired_episodes),
        total_episodes = COALESCE(total_episodes, ?),
        air_status = COALESCE(?, air_status)
    WHERE item_id = ?
  `)
  let updated = 0
  let transportError: ProxyError | null = null
  try {
    for (const media of medias) {
      const targets = byAniList.get(Number(media?.id)) ?? byMal.get(Number(media?.idMal)) ?? []
      const total = typeof media?.episodes === 'number' && media.episodes > 0 ? media.episodes : null
      const status = aniListStatus(media?.status)
      let aired: number | null = null
      if (typeof media?.nextAiringEpisode?.episode === 'number') aired = Math.max(0, media.nextAiringEpisode.episode - 1)
      else if (status === 'finished' && total != null) aired = total
      else if (status === 'upcoming') aired = 0
      if (aired == null && total == null && status == null) continue
      for (const row of targets) {
        update.run([aired, total, status, row.item_id])
        updated++
      }
    }
  } finally {
    update.finalize()
  }
  return updated
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !moduleRuntime(db)?.aborted) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

async function refreshBangumi(rows: FavoriteProgressRow[]): Promise<number> {
  const now = Date.now()
  // AniList 的状态更精确；有 MAL 映射时不再重复请求 Bangumi。
  const targets = rows.filter(row => {
    if (anilistIdOf(row.item_id, row.links) || malIdOf(row.links)) return false
    if (!bangumiIdOf(row.item_id, row.bangumi_id, row.links)) return false
    return now - (bangumiAttemptedAt.get(row.item_id) ?? 0) >= BANGUMI_ITEM_COOLDOWN_MS
  })
  if (targets.length === 0) return 0

  const update = db.prepare(`
    UPDATE season_favorites
    SET aired_episodes = COALESCE(?, aired_episodes),
        total_episodes = COALESCE(total_episodes, ?),
        air_status = COALESCE(?, air_status)
    WHERE item_id = ?
  `)
  let updated = 0
  let transportError: ProxyError | null = null
  try {
    await runPool(targets, async row => {
      const bangumiId = bangumiIdOf(row.item_id, row.bangumi_id, row.links)
      if (!bangumiId) return
      try {
        const detail = await getBangumiDetail(bangumiId, { expectedBangumiType: 2 })
        if (detail.episodes == null && detail.airedEpisodes == null && detail.airStatus == null) return
        update.run([detail.airedEpisodes ?? null, detail.episodes ?? null, detail.airStatus ?? null, row.item_id])
        bangumiAttemptedAt.set(row.item_id, now)
        updated++
      } catch (error) {
        if (error instanceof ProxyError) transportError ??= error
        // 单条失败不阻塞其它收藏；全局 30 分钟冷却仍会阻止 GET 紧密重试。
      }
    }, BANGUMI_CONCURRENCY)
  } finally {
    update.finalize()
  }
  if (transportError) throw transportError
  return updated
}

async function runRefresh(): Promise<number> {
  const select = db.prepare(`
    SELECT item_id, bangumi_id, links, air_status, aired_episodes, total_episodes, media_domain_override, media_domain_evidence
    FROM season_favorites
    WHERE (
        air_status IS NULL
        OR total_episodes IS NULL
        OR (air_status = 'airing' AND (aired_episodes IS NULL OR aired_episodes < total_episodes))
        -- upcoming 条目也要在临近/到达 begin 后重新请求，避免永久停留在待播。
        OR air_status = 'upcoming'
      )
  `)
  let rows: FavoriteProgressRow[]
  try { rows = select.all() as FavoriteProgressRow[] } finally { select.finalize() }
  rows = rows.filter(row => classifyFavorite(row).media_domain === 'anime')
  if (rows.length === 0) return 0

  // 两个来源互不依赖；某一来源不可达时仍可完成另一来源的旧数据回填。
  const [aniListResult, bangumiResult] = await Promise.allSettled([
    refreshAniList(rows),
    refreshBangumi(rows),
  ])
  const proxyFailure = [aniListResult, bangumiResult].find(result => result.status === 'rejected' && result.reason instanceof ProxyError)
  if (proxyFailure?.status === 'rejected') throw proxyFailure.reason
  const updated = (aniListResult.status === 'fulfilled' ? aniListResult.value : 0)
    + (bangumiResult.status === 'fulfilled' ? bangumiResult.value : 0)
  const rateLimit = [aniListResult, bangumiResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected' && isProviderRateLimitError(result.reason))
    .map(result => result.reason)[0]
  if (updated === 0 && rateLimit) throw rateLimit
  if (updated === 0 && aniListResult.status === 'rejected' && bangumiResult.status === 'rejected') {
    throw aniListResult.reason
  }
  return updated
}

/**
 * 刷新收藏的集数与放送状态。
 * 同进程请求共享一个 in-flight Promise，成功或失败后均进入 30 分钟冷却，避免
 * 服务启动刷新与 GET /favorites 并发时产生重复外网请求。
 */
export async function refreshAiringProgress(force = false): Promise<number> {
  if (moduleRuntime(db)?.aborted) return 0
  if (refreshInFlight) return refreshInFlight
  if (!force && Date.now() - lastRefresh < COOLDOWN_MS) return 0

  refreshInFlight = runRefresh().finally(() => {
    lastRefresh = Date.now()
    refreshInFlight = null
  })
  moduleRuntime(db)?.track(refreshInFlight)
  return refreshInFlight
}

export function resetAiringProgressCache(): void {
  lastRefresh = 0
  bangumiAttemptedAt.clear()
}
