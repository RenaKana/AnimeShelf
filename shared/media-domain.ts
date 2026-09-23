/**
 * The media domain is deliberately separate from a physical format such as
 * movie/TV or from a directory name. Library.type is only a last-resort hint.
 */
export type MediaDomain = 'anime' | 'live_action' | 'unknown'

export interface MediaDomainEvidence {
  source: 'anilist' | 'bangumi' | 'tmdb' | 'bangumi-data'
  externalId: string
  authority: 'confirmed' | 'automatic'
  mediaType?: 'ANIME' | 'movie' | 'tv'
  subjectType?: number | null
  genreIds?: readonly unknown[] | null
}

export interface MediaDomainResolution {
  media_domain: MediaDomain
  media_domain_source: 'manual' | 'metadata' | 'automatic' | 'library_default' | 'unknown'
  media_domain_reason: 'manual_pending' | 'conflict' | 'insufficient' | 'missing' | 'display_metadata' | null
}

export interface MediaDomainFields extends Partial<MediaDomainResolution> {
  media_domain_override?: MediaDomain | null
  media_domain_evidence?: string | null
}

export const MEDIA_DOMAIN_LABELS: Record<MediaDomain, string> = { anime: '动漫', live_action: '真人影视', unknown: '待确认' }
export const MEDIA_DOMAIN_SOURCE_LABELS: Record<MediaDomainResolution['media_domain_source'], string> = {
  manual: '人工指定', metadata: '元数据确认', automatic: '自动识别', library_default: '媒体库默认', unknown: '待确认',
}

export function isMediaDomainOverride(value: unknown): value is MediaDomain | null {
  return value === null || value === 'anime' || value === 'live_action' || value === 'unknown'
}

export function parseMediaDomainEvidence(value: unknown): MediaDomainEvidence[] {
  let entries: unknown = value
  if (typeof value === 'string') {
    try { entries = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(entries)) return []
  return entries.filter((entry): entry is MediaDomainEvidence => Boolean(entry && typeof entry === 'object'
    && ['anilist', 'bangumi', 'tmdb', 'bangumi-data'].includes(entry.source)
    && typeof entry.externalId === 'string' && entry.externalId.length > 0
    && ['confirmed', 'automatic'].includes(entry.authority)))
}

export function evidenceMediaDomain(entry: MediaDomainEvidence): MediaDomain {
  if (entry.source === 'anilist') return entry.mediaType === 'ANIME' ? 'anime' : 'unknown'
  if (entry.source === 'bangumi-data') return entry.subjectType === 2 ? 'anime' : 'unknown'
  if (entry.source === 'bangumi') return mediaDomainForBangumiType(entry.subjectType)
  return mediaDomainForTMDB({ mediaType: entry.mediaType, genreIds: entry.genreIds })
}

/** Pure, shared policy. An explicit unknown is never the same as no evidence. */
export function resolveMediaDomain(input: {
  override?: MediaDomain | null
  evidence?: unknown
  hasMetadata?: boolean
  libraryType?: unknown
}): MediaDomainResolution {
  if (input.override != null && isMediaDomainOverride(input.override)) {
    return { media_domain: input.override, media_domain_source: 'manual', media_domain_reason: input.override === 'unknown' ? 'manual_pending' : null }
  }
  const evidence = parseMediaDomainEvidence(input.evidence)
  for (const authority of ['confirmed', 'automatic'] as const) {
    const domains = new Set(evidence.filter(entry => entry.authority === authority).map(evidenceMediaDomain).filter(domain => domain !== 'unknown'))
    if (domains.size > 1) return { media_domain: 'unknown', media_domain_source: 'unknown', media_domain_reason: 'conflict' }
    if (domains.size === 1) return { media_domain: [...domains][0], media_domain_source: authority === 'confirmed' ? 'metadata' : 'automatic', media_domain_reason: null }
  }
  if (input.hasMetadata || input.evidence != null) return { media_domain: 'unknown', media_domain_source: 'unknown', media_domain_reason: 'insufficient' }
  const fallback = mediaDomainForLibrary(input.libraryType)
  return { media_domain: fallback, media_domain_source: fallback === 'unknown' ? 'unknown' : 'library_default', media_domain_reason: fallback === 'unknown' ? 'missing' : null }
}

/** Only structured evidence is accepted; no title/path or provider-name guess. */
export function candidateDomainEvidence(source: string, candidate: unknown, authority: MediaDomainEvidence['authority'] = 'confirmed'): MediaDomainEvidence[] {
  if (!candidate || typeof candidate !== 'object') return []
  const value = candidate as Record<string, unknown>
  const id = source === 'anilist' ? value.anilistId : source === 'bangumi' ? value.bgmId : value.tmdbId
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return []
  const common = { externalId: String(id), authority }
  if (source === 'anilist') return [{ ...common, source, mediaType: 'ANIME' }]
  if (source === 'bangumi') return [{ ...common, source, subjectType: typeof value.type === 'number' ? value.type : null }]
  if (source === 'tmdb') return [{ ...common, source,
    mediaType: value.mediaType === 'movie' || value.mediaType === 'tv' ? value.mediaType : undefined,
    genreIds: Array.isArray(value.genreIds) ? value.genreIds : Array.isArray(value.genres) ? value.genres.map(genre => genre?.id) : null,
  }]
  return []
}

const ANIME_LIBRARY_TYPES = new Set([
  'anime', 'animation', 'animated', 'animé', 'animes', '动漫', '动画', '番剧',
])

const LIVE_ACTION_LIBRARY_TYPES = new Set([
  // `movie` is the legacy value used by the existing “影视” library option.
  // It is an explicit library type, not an inference from a folder name.
  'movie', 'live', 'live_action', 'live-action', 'live action', '影视', '真人', '真人影视',
])

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : ''
}

/** Normalize the persisted library type without guessing from paths/names. */
export function normalizeMediaDomain(value: unknown): MediaDomain {
  const token = normalized(value)
  if (ANIME_LIBRARY_TYPES.has(token)) return 'anime'
  if (LIVE_ACTION_LIBRARY_TYPES.has(token)) return 'live_action'
  return 'unknown'
}

/** Accept either a library row or its type for callers at different layers. */
export function mediaDomainForLibrary(libraryOrType: unknown): MediaDomain {
  if (libraryOrType && typeof libraryOrType === 'object' && 'type' in libraryOrType) {
    return normalizeMediaDomain((libraryOrType as { type?: unknown }).type)
  }
  return normalizeMediaDomain(libraryOrType)
}

export function mediaDomainForBangumiType(type: unknown): MediaDomain {
  const value = typeof type === 'number' ? type : Number(type)
  if (value === 2) return 'anime'
  if (value === 6) return 'live_action'
  return 'unknown'
}

export interface TMDBDomainEvidence {
  mediaType?: unknown
  genreIds?: readonly unknown[] | null
  genres?: readonly unknown[] | null
}

const TMDB_ANIMATION_GENRE_ID = 16
const TMDB_MOVIE_NON_ANIMATION_GENRE_IDS = new Set([
  12, 14, 18, 27, 28, 35, 36, 37, 53, 80, 878, 9648, 99, 10402, 10749, 10751, 10752, 10770,
])
const TMDB_TV_NON_ANIMATION_GENRE_IDS = new Set([
  18, 35, 80, 99, 9648, 10751, 10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768,
])

type GenreEvidence = { ids: number[]; malformed: boolean }

function positiveGenreId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function genreEvidence(value: readonly unknown[] | null | undefined, allowObjects: boolean): GenreEvidence {
  if (!Array.isArray(value) || value.length === 0) return { ids: [], malformed: false }
  const ids: number[] = []
  let malformed = false
  for (const item of value) {
    const id = positiveGenreId(item) ?? (allowObjects && item !== null && typeof item === 'object' && !Array.isArray(item)
      ? positiveGenreId((item as { id?: unknown }).id)
      : null)
    if (id === null) malformed = true
    else ids.push(id)
  }
  return { ids, malformed }
}

/**
 * Classify a TMDB search result only when it carries structured type evidence.
 * A movie/TV discriminator alone does not prove live action: animated films
 * and series use the same TMDB media types.
 */
export function mediaDomainForTMDB(value: TMDBDomainEvidence): MediaDomain {
  const mediaType = value.mediaType === 'movie' || value.mediaType === 'tv' ? value.mediaType : null
  if (!mediaType) return 'unknown'

  const directEvidence = genreEvidence(value.genreIds, false)
  const detailEvidence = genreEvidence(value.genres, true)
  const ids = [...directEvidence.ids, ...detailEvidence.ids]
  const malformed = directEvidence.malformed || detailEvidence.malformed
  if (ids.includes(TMDB_ANIMATION_GENRE_ID)) return 'anime'

  // A positive live-action result must be made entirely of known TMDB genre
  // IDs for the stated media type. Unknown, malformed, or missing evidence is
  // deliberately not guessed as live action.
  const knownNonAnimationIds = mediaType === 'movie' ? TMDB_MOVIE_NON_ANIMATION_GENRE_IDS : TMDB_TV_NON_ANIMATION_GENRE_IDS
  if (!malformed && ids.length > 0 && ids.every(id => knownNonAnimationIds.has(id))) return 'live_action'
  return 'unknown'
}

/** Candidate domains must be known; unknown candidates are never auto-bound. */
export function mediaDomainMatches(target: MediaDomain, candidate: MediaDomain): boolean {
  if (candidate === 'unknown') return false
  return target === 'unknown' || target === candidate
}
