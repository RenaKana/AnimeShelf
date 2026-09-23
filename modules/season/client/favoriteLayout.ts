import type { MetadataCandidate, MetadataSource, SeasonFavorite, SeasonFavoritePayload } from '@/types'
import { MEDIA_DOMAIN_LABELS, type MediaDomain } from '../../../shared/media-domain'
import { candidateDomainEvidence } from '../../../shared/media-domain'

export const FAVORITE_CARD_WIDTH_MIN = 160
export const FAVORITE_CARD_WIDTH_MAX = 420
export const FAVORITE_CARD_WIDTH_STEP = 10
export const FAVORITE_CARD_WIDTH_DEFAULT = 260

export type FavoriteCardDensity = 'comfortable' | 'compact' | 'dense'
export type FavoriteAnimeStatus = 'AIRING' | 'UPCOMING' | 'FINISHED'

export function favoriteMediaDomain(favorite: Pick<SeasonFavorite, 'media_domain'>): MediaDomain {
  return favorite.media_domain ?? 'unknown'
}

export function favoriteMediaDomainLabel(favorite: Pick<SeasonFavorite, 'media_domain'>): string {
  return MEDIA_DOMAIN_LABELS[favoriteMediaDomain(favorite)]
}

export type FavoriteCardLayout = {
  density: FavoriteCardDensity
  synopsisLines: 2 | 3 | 4
  showOriginalTitle: boolean
  showProgress: boolean
}

export function formatFavoriteBeginDate(value: string | null | undefined, timeZone?: string): string {
  const raw = value?.trim() ?? ''
  const dateOnly = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/)
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2].padStart(2, '0')}-${dateOnly[3].padStart(2, '0')}`
  if (!raw) return ''
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return ''
  const formatter = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  })
  const parts = Object.fromEntries(formatter.formatToParts(parsed).map(part => [part.type, part.value]))
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : ''
}

function normalizeFallback(fallback: number): number {
  const safeFallback = Number.isFinite(fallback) ? fallback : FAVORITE_CARD_WIDTH_DEFAULT
  const clamped = Math.min(FAVORITE_CARD_WIDTH_MAX, Math.max(FAVORITE_CARD_WIDTH_MIN, safeFallback))
  return Math.round((clamped - FAVORITE_CARD_WIDTH_MIN) / FAVORITE_CARD_WIDTH_STEP) * FAVORITE_CARD_WIDTH_STEP + FAVORITE_CARD_WIDTH_MIN
}

export function normalizeFavoriteCardWidth(value: unknown, fallback = FAVORITE_CARD_WIDTH_DEFAULT): number {
  const safeFallback = normalizeFallback(fallback)
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue)) return safeFallback

  const clamped = Math.min(FAVORITE_CARD_WIDTH_MAX, Math.max(FAVORITE_CARD_WIDTH_MIN, numericValue))
  return Math.round((clamped - FAVORITE_CARD_WIDTH_MIN) / FAVORITE_CARD_WIDTH_STEP) * FAVORITE_CARD_WIDTH_STEP + FAVORITE_CARD_WIDTH_MIN
}

export function getFavoriteCardDensity(cardWidth: number): FavoriteCardDensity {
  const width = normalizeFavoriteCardWidth(cardWidth)
  if (width >= 240) return 'comfortable'
  if (width >= 200) return 'compact'
  return 'dense'
}

export function getFavoriteSynopsisLines(cardWidth: number): 2 | 3 | 4 {
  const density = getFavoriteCardDensity(cardWidth)
  return density === 'comfortable' ? 4 : density === 'compact' ? 3 : 2
}

export function getFavoriteCardLayout(cardWidth: number): FavoriteCardLayout {
  const density = getFavoriteCardDensity(cardWidth)
  return {
    density,
    synopsisLines: getFavoriteSynopsisLines(cardWidth),
    showOriginalTitle: density === 'comfortable',
    showProgress: density !== 'dense',
  }
}

export function resolvedFavoriteAnimeStatus(
  favorite: Pick<SeasonFavorite, 'air_status' | 'aired_episodes' | 'total_episodes' | 'air_day' | 'begin'>,
  now = new Date(),
): FavoriteAnimeStatus {
  if (favorite.air_status === 'airing') return 'AIRING'
  if (favorite.air_status === 'finished') return 'FINISHED'
  if (favorite.air_status === 'upcoming') return 'UPCOMING'

  const aired = typeof favorite.aired_episodes === 'number' ? favorite.aired_episodes : null
  const total = typeof favorite.total_episodes === 'number' && favorite.total_episodes > 0 ? favorite.total_episodes : null
  if (aired != null && total != null && aired >= total) return 'FINISHED'

  const begin = favorite.begin?.trim()
  if (begin) {
    const normalized = begin.replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, '$1-$2-$3')
    const beginDate = new Date(normalized)
    if (!Number.isNaN(beginDate.getTime())) return beginDate.getTime() > now.getTime() ? 'UPCOMING' : 'AIRING'
  }
  if (favorite.air_day || (aired != null && aired > 0)) return 'AIRING'
  return 'UPCOMING'
}

export function selectRefreshedFavorite<T extends { item_id: string }>(
  current: T,
  refreshed: readonly T[] | null | undefined,
): T {
  return refreshed?.find(item => item.item_id === current.item_id) ?? current
}

export function selectFavoriteDraftAfterRefresh(
  draft: string,
  previousPersistedValue: string | null | undefined,
  refreshedPersistedValue: string | null | undefined,
): string {
  const previous = previousPersistedValue ?? ''
  return draft.trim() !== previous.trim() ? draft : (refreshedPersistedValue ?? '')
}

export function isFavoriteEditorDirty(
  favorite: { synopsis?: string | null; lib_match_override?: 'present' | 'absent' | null; media_domain_override?: MediaDomain | null },
  synopsisDraft: string,
  libraryStatus: 'auto' | 'present' | 'absent',
  mediaDomainOverride: MediaDomain | null = null,
): boolean {
  const savedLibraryStatus = favorite.lib_match_override ?? 'auto'
  return synopsisDraft.trim() !== (favorite.synopsis ?? '').trim()
    || libraryStatus !== savedLibraryStatus
    || mediaDomainOverride !== (favorite.media_domain_override ?? null)
}

export type FavoriteLibraryStatusTone = 'success' | 'info' | 'neutral' | 'warning'
export type FavoriteLibraryStatusPresentation = {
  label: '已收录' | '同系列已有' | '未收录' | '待确认'
  tone: FavoriteLibraryStatusTone
  mode: 'auto' | 'manual'
  ariaLabel: string
  folder: string | null
}

type FavoriteLibraryStatus = 'present' | 'related' | 'absent' | 'unknown'

function automaticFavoriteLibraryStatus(
  favorite: Pick<SeasonFavorite, 'lib_status' | 'lib_hit'>,
): FavoriteLibraryStatus {
  if (favorite.lib_status === 'present' || favorite.lib_status === 'related' || favorite.lib_status === 'absent' || favorite.lib_status === 'unknown') {
    return favorite.lib_status
  }
  return favorite.lib_hit?.matched ? 'present' : 'unknown'
}

export function getFavoriteLibraryStatusPresentation(
  favorite: Pick<SeasonFavorite, 'lib_match_override' | 'lib_hit' | 'lib_status'>,
): FavoriteLibraryStatusPresentation {
  if (favorite.lib_match_override === 'present') {
    return { label: '已收录', tone: 'warning', mode: 'manual', ariaLabel: '媒体库状态：手动标记为已收录', folder: null }
  }
  if (favorite.lib_match_override === 'absent') {
    return { label: '未收录', tone: 'warning', mode: 'manual', ariaLabel: '媒体库状态：手动标记为未收录', folder: null }
  }
  const status = automaticFavoriteLibraryStatus(favorite)
  if (status === 'present') {
    return { label: '已收录', tone: 'success', mode: 'auto', ariaLabel: '媒体库状态：自动判断，已收录', folder: favorite.lib_hit?.folderName ?? null }
  }
  if (status === 'related') {
    return { label: '同系列已有', tone: 'info', mode: 'auto', ariaLabel: '媒体库状态：自动判断，同系列已有', folder: favorite.lib_hit?.folderName ?? null }
  }
  if (status === 'absent') {
    return { label: '未收录', tone: 'neutral', mode: 'auto', ariaLabel: '媒体库状态：自动判断，未收录', folder: null }
  }
  return { label: '待确认', tone: 'warning', mode: 'auto', ariaLabel: '媒体库状态：自动判断，待确认', folder: null }
}

export function isFavoriteEditorSessionCurrent(
  requestSession: number,
  requestItemId: string,
  activeSession: number,
  activeItemId: string | null,
): boolean {
  return requestSession === activeSession && requestItemId === activeItemId
}

function candidateId(candidate: MetadataCandidate, source: MetadataSource): number {
  if (source === 'anilist' && 'anilistId' in candidate) return candidate.anilistId
  if (source === 'bangumi' && 'bgmId' in candidate) return candidate.bgmId
  if (source === 'tmdb' && 'tmdbId' in candidate) return candidate.tmdbId
  return -1
}

export function metadataCandidateSource(candidate: MetadataCandidate): MetadataSource {
  if ('anilistId' in candidate) return 'anilist'
  if ('bgmId' in candidate) return 'bangumi'
  return 'tmdb'
}

function candidateLink(candidate: MetadataCandidate, source: MetadataSource): { name: string; url: string } {
  if (source === 'anilist' && 'anilistId' in candidate) return { name: 'AniList', url: `https://anilist.co/anime/${candidate.anilistId}` }
  if (source === 'bangumi' && 'bgmId' in candidate) return { name: '番组计划', url: `https://bgm.tv/subject/${candidate.bgmId}` }
  if (source === 'tmdb' && 'tmdbId' in candidate) return { name: 'TMDB', url: `https://www.themoviedb.org/${candidate.mediaType}/${candidate.tmdbId}` }
  return { name: source, url: '' }
}

function normalizeSearchValue(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase().trim()
}

function normalizeLink(value: string): string {
  return value.trim().replace(/\/+$/, '').toLocaleLowerCase()
}

export function favoriteItemIdForCandidate(candidate: MetadataCandidate, source = metadataCandidateSource(candidate)): string {
  return `manual-${source}-${candidateId(candidate, source)}`
}

export function favoritePayloadFromCandidate(candidate: MetadataCandidate, source = metadataCandidateSource(candidate)): SeasonFavoritePayload {
  const id = candidateId(candidate, source)
  const link = candidateLink(candidate, source)
  if (source === 'bangumi' && 'bgmId' in candidate) {
    return {
      item_id: favoriteItemIdForCandidate(candidate, source),
      title: candidate.title || String(id),
      title_zh: candidate.titleZh ?? null,
      bangumi_id: String(candidate.bgmId),
      links: [link],
      image: candidate.posterPath ?? candidate.posterUrl ?? null,
      media_type: candidate.type === 6 ? 'live' : 'anime',
      media_domain_evidence: candidateDomainEvidence(source, candidate),
      synopsis: candidate.synopsis ?? null,
      aired_episodes: candidate.airedEpisodes ?? null,
      total_episodes: candidate.episodes ?? null,
      begin: candidate.airDate ?? null,
      air_status: candidate.airStatus ?? null,
    }
  }
  if (source === 'anilist' && 'anilistId' in candidate) {
    return {
      item_id: favoriteItemIdForCandidate(candidate, source),
      title: candidate.originalTitle || candidate.title || String(id),
      title_zh: null,
      links: [link],
      image: candidate.posterPath ?? candidate.posterUrl ?? null,
      media_type: 'anime',
      media_domain_evidence: candidateDomainEvidence(source, candidate),
      synopsis: candidate.synopsis ?? null,
      total_episodes: candidate.episodes ?? null,
    }
  }
  if ('tmdbId' in candidate) {
    return {
      item_id: favoriteItemIdForCandidate(candidate, source),
      title: candidate.originalTitle || candidate.title || String(id),
      title_zh: candidate.title || null,
      links: [link],
      image: candidate.posterPath ?? candidate.posterUrl ?? null,
      media_type: 'live',
      media_domain_evidence: candidateDomainEvidence(source, candidate),
      synopsis: candidate.synopsis ?? null,
    }
  }
  return {
    item_id: favoriteItemIdForCandidate(candidate, source),
    title: candidate.title || String(id),
    links: [link],
  }
}

export function isFavoriteCandidateAdded(
  favorites: readonly Pick<SeasonFavorite, 'item_id' | 'bangumi_id' | 'links'>[],
  candidate: MetadataCandidate,
  source = metadataCandidateSource(candidate),
): boolean {
  const payload = favoritePayloadFromCandidate(candidate, source)
  const expectedUrl = payload.links?.[0]?.url ? normalizeLink(payload.links[0].url) : ''
  return favorites.some(favorite => {
    if (favorite.item_id === payload.item_id) return true
    if (source === 'bangumi' && 'bgmId' in candidate && String(favorite.bangumi_id ?? '') === String(candidate.bgmId)) return true
    return expectedUrl !== '' && (favorite.links ?? []).some(link => normalizeLink(link.url) === expectedUrl)
  })
}

export function filterFavoriteEntries<T extends Pick<SeasonFavorite, 'title' | 'title_zh'>>(
  favorites: readonly T[],
  query: string,
): T[] {
  const needle = normalizeSearchValue(query)
  if (!needle) return [...favorites]
  return favorites.filter(favorite => [favorite.title, favorite.title_zh].map(normalizeSearchValue).some(value => value.includes(needle)))
}

export type FavoriteSortKey = 'title' | 'media_type' | 'status' | 'schedule' | 'progress' | 'library' | 'added_at'
export type FavoriteSortDirection = 'asc' | 'desc'
export type FavoriteSortState = { key: FavoriteSortKey; direction: FavoriteSortDirection }

type FavoriteSortEntry = Pick<SeasonFavorite, 'title' | 'title_zh' | 'media_type' | 'media_domain' | 'air_status' | 'aired_episodes' | 'total_episodes' | 'air_day' | 'air_time' | 'begin' | 'lib_match_override' | 'lib_hit' | 'lib_status'> & {
  item_id?: string
  added_at: string | null
}

const FAVORITE_STATUS_ORDER: Record<string, number> = { AIRING: 0, UPCOMING: 1, FINISHED: 2, LIVE: 3, UNKNOWN: 4 }
const FAVORITE_DAY_ORDER: Record<string, number> = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 }

function sortTitleValue(favorite: FavoriteSortEntry): string | null {
  const title = normalizeSearchValue(favorite.title_zh || favorite.title)
  return title || null
}

function sortStatusValue(favorite: FavoriteSortEntry): number | null {
  const status = favorite.media_domain === 'live_action'
    ? 'LIVE'
    : favorite.media_domain === 'unknown'
      ? 'UNKNOWN'
      : resolvedFavoriteAnimeStatus(favorite)
  return FAVORITE_STATUS_ORDER[status] ?? null
}

function sortScheduleValue(favorite: FavoriteSortEntry): string | null {
  const begin = favorite.begin?.trim()
  if (begin) {
    const parsed = Date.parse(begin.replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, '$1-$2-$3'))
    if (Number.isFinite(parsed)) return `0:${String(parsed).padStart(15, '0')}`
  }
  const day = favorite.air_day?.trim().toLocaleUpperCase() ?? ''
  const dayIndex = FAVORITE_DAY_ORDER[day]
  if (dayIndex == null) return null
  const time = favorite.air_time?.trim() || '99:99'
  return `1:${String(dayIndex).padStart(2, '0')}:${time}`
}

function sortProgressValue(favorite: FavoriteSortEntry): number | null {
  const aired = typeof favorite.aired_episodes === 'number' && Number.isFinite(favorite.aired_episodes)
    ? Math.max(0, favorite.aired_episodes)
    : null
  const total = typeof favorite.total_episodes === 'number' && Number.isFinite(favorite.total_episodes) && favorite.total_episodes > 0
    ? favorite.total_episodes
    : null
  if (aired == null && total == null) return null
  if (total != null) return Math.min(1, aired == null ? 0 : aired / total)
  return aired
}

function sortLibraryValue(favorite: FavoriteSortEntry): number | null {
  const status = favorite.lib_match_override === 'present'
    ? 'present'
    : favorite.lib_match_override === 'absent'
      ? 'absent'
      : automaticFavoriteLibraryStatus(favorite)
  return ({ present: 0, related: 1, unknown: 2, absent: 3 } as const)[status]
}

function favoriteSortValue(favorite: FavoriteSortEntry, key: FavoriteSortKey): string | number | null {
  switch (key) {
    case 'title': return sortTitleValue(favorite)
    case 'media_type': return favorite.media_domain ?? 'unknown'
    case 'status': return sortStatusValue(favorite)
    case 'schedule': return sortScheduleValue(favorite)
    case 'progress': return sortProgressValue(favorite)
    case 'library': return sortLibraryValue(favorite)
    case 'added_at': {
      const parsed = Date.parse(favorite.added_at ?? '')
      return Number.isFinite(parsed) ? parsed : null
    }
  }
}

/** Sort overview rows without mutating the source; empty values always remain at the end. */
export function sortFavoriteEntries<T extends FavoriteSortEntry>(favorites: readonly T[], state: FavoriteSortState): T[] {
  return favorites
    .map((favorite, index) => ({ favorite, index, value: favoriteSortValue(favorite, state.key) }))
    .sort((left, right) => {
      const leftEmpty = left.value == null || left.value === ''
      const rightEmpty = right.value == null || right.value === ''
      if (leftEmpty || rightEmpty) {
        if (leftEmpty && rightEmpty) return left.index - right.index
        return leftEmpty ? 1 : -1
      }
      let comparison = 0
      if (typeof left.value === 'number' && typeof right.value === 'number') {
        comparison = left.value - right.value
      } else {
        comparison = String(left.value).localeCompare(String(right.value), undefined, { numeric: true, sensitivity: 'base' })
      }
      if (comparison === 0) return left.index - right.index
      return state.direction === 'desc' ? -comparison : comparison
    })
    .map(entry => entry.favorite)
}
