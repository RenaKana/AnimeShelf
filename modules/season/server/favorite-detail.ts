// 收藏（心愿单）详情抓取：优先 Bangumi（中文站，经代理），回退 AniList；返回海报路径 + 简介
// 供两个使用方共用：season 路由（收藏/更新海报时）与 poster-repair（恢复后批量补抓海报）
// source: 'auto' = Bangumi 优先（中文），AniList 补充原文，均无则 TMDB；'anilist' / 'bangumi' / 'tmdb' = 仅指定源

import type { AirStatus } from '../../metadata/server/metadata'
import { candidateDomainEvidence, evidenceMediaDomain, mediaDomainForBangumiType, type MediaDomainEvidence, type MediaDomain } from '../../../shared/media-domain'
import { isProviderRateLimitError, providerRequest, readProviderJson } from '../../../server/services/provider-rate-limit'
import { networkFetch } from '../../../server/services/network'
import { ProxyError } from '../../../server/services/proxy'

export interface FavoriteDetail {
  domainEvidence?: MediaDomainEvidence[]
  posterPath: string | null
  synopsis: string | null
  synopsisOriginal: string | null
  airedEpisodes: number | null
  totalEpisodes: number | null
  airStatus: AirStatus
}

export function anilistAirStatus(status: unknown): AirStatus {
  if (status === 'RELEASING') return 'airing'
  if (status === 'FINISHED') return 'finished'
  if (status === 'NOT_YET_RELEASED') return 'upcoming'
  return null
}

export async function fetchFavoriteDetail(itemId: string, links: { name: string; url: string }[], source: 'auto' | 'anilist' | 'bangumi' | 'tmdb' = 'auto', domain: MediaDomain = 'unknown'): Promise<FavoriteDetail> {
  const link = (name: string) => {
    const u = links.find(l => l.name === name)?.url
    if (!u) return undefined
    // MAL 链接形如 .../anime/56613/azur-lane-...，id 在 /anime/ 后的数字段
    if (name === 'MyAnimeList') return u.match(/\/anime\/(\d+)/)?.[1]
    if (name === 'TMDB') return u.match(/themoviedb\.org\/(movie|tv)\/(\d+)/)?.slice(1)?.join(',') // "movie,123"
    return u.split('/').filter(Boolean).pop() // 尾部斜杠安全
  }
  const { getBangumiDetail, cachePoster, getTMDBDetail } = await import('../../metadata/server/metadata')
  let posterPath: string | null = null
  let synopsis: string | null = null      // 主简介（Bangumi 中文 或 AniList 混合）
  let synopsisOriginal: string | null = null // 原文简介
  let airedEpisodes: number | null = null
  let totalEpisodes: number | null = null
  let airStatus: AirStatus = null
  const domainEvidence: MediaDomainEvidence[] = []
  let rateLimitError: unknown = null
  let transportError: ProxyError | null = null
  type DetailSource = 'anilist' | 'bangumi' | 'tmdb'
  const orderedSources: DetailSource[] = source === 'auto'
    ? domain === 'live_action' ? ['tmdb', 'bangumi', 'anilist'] : ['bangumi', 'anilist', 'tmdb']
    : [source]

  const fetchTMDB = async () => {
    const raw = link('TMDB')
    if (!raw) return
    const [kind, id] = raw.split(',')
    try {
      const d = await getTMDBDetail(Number(id), kind as 'movie' | 'tv')
      if (d?.domainEvidence) domainEvidence.push(...d.domainEvidence)
      const tmdbDomains = new Set((d?.domainEvidence ?? [])
        .map(evidenceMediaDomain)
        .filter(candidate => candidate !== 'unknown'))
      // TMDB movie/TV shape alone is not enough to choose favorite content:
      // animated and live-action works share both namespaces. Retain every
      // evidence entry for conflict detection, but only consume content when
      // the provider has one reliable domain matching the requested domain.
      const contentAllowed = tmdbDomains.size === 1 && (domain === 'unknown' || tmdbDomains.has(domain))
      if (!contentAllowed) return
      if (d?.posterUrl && !posterPath) posterPath = await cachePoster(d.posterUrl, `fav_${itemId}`)
      if (d?.synopsis && !synopsis) synopsis = d.synopsis
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        if (source !== 'auto') throw error
        rateLimitError ??= error
      }
      if (error instanceof ProxyError) {
        if (source !== 'auto') throw error
        transportError ??= error
      }
    }
  }

  const fetchBangumi = async () => {
    const bangumiId = link('番组计划')
    if (!bangumiId) return
    try {
      const d = await getBangumiDetail(Number(bangumiId))
      domainEvidence.push(...candidateDomainEvidence('bangumi', { ...d, bgmId: Number(bangumiId) }))
      const bangumiDomain = mediaDomainForBangumiType(d.type)
      // Manga/novel/music/game subjects may have a summary, but they must
      // never populate an anime favorite. Keep their evidence for conflicts.
      const contentAllowed = bangumiDomain !== 'unknown' && (domain === 'unknown' || domain === bangumiDomain)
      if (!contentAllowed) return
      if (d.posterUrl && !posterPath) posterPath = await cachePoster(d.posterUrl, `fav_${itemId}`)
      if (d.synopsis && !synopsis) synopsis = d.synopsis
      if (bangumiDomain === 'anime') {
        airedEpisodes = d.airedEpisodes ?? airedEpisodes
        totalEpisodes = d.episodes ?? totalEpisodes
        airStatus = d.airStatus ?? airStatus
      }
    } catch (error) {
      if (error instanceof ProxyError) {
        if (source !== 'auto') throw error
        transportError ??= error
      }
    }
  }

  const fetchAniList = async () => {
    // bangumi-data 链接通常无 AniList 只有 MyAnimeList——用 MAL id 映射查询（AniList 参数名是 idMal）
    const anilistId = link('AniList')
    const malId = link('MyAnimeList')
    const alVars = anilistId ? { id: Number(anilistId) } : malId ? { idMal: Number(malId) } : null
    if (!alVars) return
    try {
      const signal = AbortSignal.timeout(10000)
      const resp = await providerRequest('anilist', signal, () => networkFetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'AnimeShelf/1.0 (local media manager)' },
        body: JSON.stringify({
          query: 'query ($id: Int, $idMal: Int) { Media(id: $id, idMal: $idMal, type: ANIME) { coverImage { extraLarge large } description(asHtml: false) episodes status nextAiringEpisode { episode airingAt } } }',
          variables: alVars,
        }),
        signal,
      }))
      if (!resp.ok) throw new Error(`AniList ${resp.status}`)
      const d: any = await readProviderJson('anilist', resp)
      const media = d?.data?.Media
      if (media && anilistId) domainEvidence.push(...candidateDomainEvidence('anilist', { anilistId: Number(anilistId) }))
      // An AniList result is always anime evidence, so retain its identity for
      // conflict detection even when a live-action override suppresses content.
      if (domain === 'live_action') return
      // 已播集数 = 下一集号 - 1（nextAiringEpisode 为空 => 已完结）；总集数——先取，避免海报下载失败连带丢失
      if (typeof media?.nextAiringEpisode?.episode === 'number') airedEpisodes = media.nextAiringEpisode.episode - 1
      if (typeof media?.episodes === 'number') totalEpisodes = media.episodes
      const exactStatus = anilistAirStatus(media?.status)
      airStatus = exactStatus ?? airStatus
      if (exactStatus === 'finished' && totalEpisodes != null) airedEpisodes = totalEpisodes
      else if (exactStatus === 'upcoming') airedEpisodes = 0
      // AniList description 常为「中文 + [简介原文] 日文」混合
      if (media?.description && !synopsis) synopsis = String(media.description).slice(0, 500)
      // 海报下载失败不影响其余数据
      const url = media?.coverImage?.extraLarge ?? media?.coverImage?.large
      if (url && !posterPath) {
        try { posterPath = await cachePoster(url, `fav_${itemId}`) }
        catch (error) { if (error instanceof ProxyError) throw error /* 普通海报失败可接受 */ }
      }
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        if (source !== 'auto') throw error
        rateLimitError ??= error
      }
      if (error instanceof ProxyError) {
        if (source !== 'auto') throw error
        transportError ??= error
      }
    }
  }

  for (const currentSource of orderedSources) {
    if (currentSource === 'tmdb') await fetchTMDB()
    else if (currentSource === 'bangumi') await fetchBangumi()
    else await fetchAniList()
  }
  const hasUsableDetail = Boolean(
    posterPath
    || synopsis
    || synopsisOriginal
    || airedEpisodes != null
    || totalEpisodes != null
    || airStatus != null
    || domainEvidence.some(entry => evidenceMediaDomain(entry) !== 'unknown'),
  )
  if (!hasUsableDetail && rateLimitError) throw rateLimitError
  if (!hasUsableDetail && transportError) throw transportError
  return { posterPath, synopsis, synopsisOriginal, airedEpisodes, totalEpisodes, airStatus, domainEvidence }
}
