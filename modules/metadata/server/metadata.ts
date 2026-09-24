import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { isValidPosterImage, MAX_POSTER_BYTES } from '../../../server/services/poster-image'
export { isValidPosterImage } from '../../../server/services/poster-image'
import { lookup as dnsLookup } from 'node:dns/promises'
import net from 'node:net'
import type { Database } from 'node-sqlite3-wasm'
import { POSTER_DIR } from '../../../server/db/schema'
import { db as processDb, settingsDb } from '../../../server/db/instance'
import { requestSignal } from '../../../server/core/request-signal'
import { isProviderRateLimitError, providerRequest, readProviderJson } from '../../../server/services/provider-rate-limit'
import { makeFolderDb } from '../../../server/db/folders'
import { resolveFolderMediaDomain } from '../../../server/services/folder-presentation'
import { isTrustedImageOrigin } from '../../../server/services/image-proxy'
import { networkAxiosConfig, networkFailure, networkFetch } from '../../../server/services/network'
import { ProxyError, resolveProxy } from '../../../server/services/proxy'
import { rebuildMediaCatalogForFolder } from '../../../server/core/catalog-access'
import type { Folder } from '../../../server/types'
import {
  mediaDomainForBangumiType,
  mediaDomainForLibrary,
  mediaDomainForTMDB,
  mediaDomainMatches,
  candidateDomainEvidence,
  evidenceMediaDomain,
  type MediaDomainEvidence,
  type MediaDomain,
} from '../../../shared/media-domain'
import { posterCacheKey } from '../../../shared/poster-cache-key'
import packageMetadata from '../../../package.json'

// Rena is the maintainer's public attribution, not an assumed GitHub username.
// Add the real public homepage to package.json when its address is confirmed.
const { version, homepage } = packageMetadata as { version: string; homepage?: string }
const bangumiUserAgent = `Rena/AnimeShelf/${version}${homepage ? ` (${homepage})` : ''}`

// Shared Axios instance; every request obtains a fresh route from the network service.
const http = axios.create({ timeout: 15000, headers: { 'User-Agent': 'AnimeShelf/1.0 (local media manager)' } })
async function routedAxiosGet(url: string, cfg: Record<string, any> = {}) {
  const signal = requestSignal(processDb, cfg.signal)
  const decision = resolveProxy(url)
  const route = networkAxiosConfig(url, signal, { route: decision })
  try {
    return await http.get(url, { ...cfg, ...route.config, ...(signal ? { signal } : {}) })
  } catch (error: any) {
    if (signal?.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') throw error
    if (error?.response) throw error
    throw networkFailure(error, Boolean(decision.proxy))
  } finally {
    route.dispose()
  }
}

async function routedAxiosPost(url: string, data: unknown, cfg: Record<string, any> = {}) {
  const signal = requestSignal(processDb, cfg.signal)
  const decision = resolveProxy(url)
  const route = networkAxiosConfig(url, signal, { route: decision })
  try {
    return await http.post(url, data, { ...cfg, ...route.config, ...(signal ? { signal } : {}) })
  } catch (error: any) {
    if (signal?.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') throw error
    if (error?.response) throw error
    throw networkFailure(error, Boolean(decision.proxy))
  } finally {
    route.dispose()
  }
}

export interface AniListCandidate {
  anilistId: number; title: string; originalTitle: string | null
  year: number | null; rating: number | null; genres: string[]
  synopsis: string | null; episodes: number | null
  posterUrl: string | null; posterPath: string | null
}

export interface TMDBCandidate {
  tmdbId: number; mediaType: 'movie' | 'tv'
  title: string; originalTitle: string | null
  year: number | null; rating: number | null; genres: string[]
  synopsis: string | null; seasons: number | null
  posterUrl: string | null; posterPath: string | null
  /** Structured evidence used to keep animated TMDB titles in the anime domain. */
  genreIds?: number[] | null
  mediaDomain?: MediaDomain
}

export interface BangumiCandidate {
  bgmId: number
  title: string        // 日文名
  titleZh: string | null // 中文名（name_cn）
  year: number | null
  rating: number | null
  synopsis: string | null
  posterUrl: string | null
  posterPath: string | null
  type: number | null  // bgm 类型：2=动画 6=真人影视 1=书籍 3=音乐 4=游戏
  episodes: number | null
  airedEpisodes: number | null
  airDate: string | null
  airStatus: AirStatus
  mediaDomain?: MediaDomain
}

export class MetadataDomainError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = 'MEDIA_DOMAIN_MISMATCH',
  ) {
    super(message)
    this.name = 'MetadataDomainError'
  }
}

export class BangumiDetailValidationError extends MetadataDomainError {
  constructor(message: string, code: 'BANGUMI_DETAIL_ID_MISMATCH' | 'BANGUMI_DETAIL_TYPE_UNKNOWN' | 'BANGUMI_DETAIL_TYPE_MISMATCH') {
    super(message, 422, code)
    this.name = 'BangumiDetailValidationError'
  }
}

function hasPositiveId(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function candidateMediaDomain(source: string, candidate: unknown): MediaDomain {
  const evidence = candidateDomainEvidence(source, candidate)[0]
  return evidence ? evidenceMediaDomain(evidence) : 'unknown'
}

export function folderMediaDomain(db: Database, folderId: number): MediaDomain {
  const result = resolveFolderMediaDomain(db, folderId)
  if (!result) throw new MetadataDomainError('folder not found', 404, 'FOLDER_NOT_FOUND')
  return result.media_domain
}

export function folderMatchingDomain(db: Database, folderId: number): MediaDomain {
  const result = resolveFolderMediaDomain(db, folderId)
  if (!result) throw new MetadataDomainError('folder not found', 404, 'FOLDER_NOT_FOUND')
  return result.media_domain_source === 'library_default' ? 'unknown' : result.media_domain
}

/** Manual rebind may correct old metadata; automatic jobs respect current
 * item evidence (never the library default). Neither writes the override. */
export function assertCandidateMatchesFolder(
  db: Database,
  folderId: number,
  source: string,
  candidate: unknown,
  automatic = false,
): { target: MediaDomain; candidate: MediaDomain } {
  const target = folderMatchingDomain(db, folderId)
  const candidateDomain = candidateMediaDomain(source, candidate)
  if (candidateDomain === 'unknown') {
    throw new MetadataDomainError('候选缺少可确认的动画/真人影视类型，未写入元数据', 422, 'UNKNOWN_MEDIA_DOMAIN')
  }
  if (automatic && !mediaDomainMatches(target, candidateDomain)) {
    const expected = target === 'anime' ? '动漫' : '真人影视'
    const actual = candidateDomain === 'anime' ? '动漫' : '真人影视'
    throw new MetadataDomainError(`候选属于${actual}，与条目当前${expected}分类不符`, 409, 'MEDIA_DOMAIN_MISMATCH')
  }
  return { target, candidate: candidateDomain }
}

function normalizeMatchTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** An exact title (and year, when supplied) must identify one candidate.
 * Search order and a library hint are not proof of work identity. */
export function pickAutomaticMetadataCandidate<T extends { title: string; originalTitle?: string | null; titleZh?: string | null; year?: number | null }>(
  source: string, candidates: T[], queries: string[], expectedYear: number | null,
): T | undefined {
  const names = new Set(queries.map(normalizeMatchTitle).filter(Boolean))
  const matches = candidates.filter(candidate => candidateMediaDomain(source, candidate) !== 'unknown'
    && [candidate.title, candidate.originalTitle, candidate.titleZh].some(title => title && names.has(normalizeMatchTitle(title)))
    && (expectedYear == null || candidate.year === expectedYear))
  const unique = new Map(matches.map(candidate => {
    const evidence = candidateDomainEvidence(source, candidate)[0]
    return [`${evidence.source}:${evidence.mediaType ?? ''}:${evidence.externalId}`, candidate]
  }))
  return unique.size === 1 ? [...unique.values()][0] : undefined
}

function hasSpecialEditionMarker(value: string): boolean {
  return /(?:第\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部)|season\s*\d+|\b(?:ova|oad|special)\b|剧场版|劇場版|第\s*0\s*话|第\s*0\s*話)/i.test(value)
}

function hasFirstSeasonMarker(value: string): boolean {
  return /(?:第\s*(?:1|一)\s*(?:季|期|部)|season\s*1\b)/i.test(value)
}

function isLikelyChineseSynopsis(value: string | null | undefined): value is string {
  if (!value) return false
  const sample = value.slice(0, 500)
  const han = sample.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const kana = sample.match(/[ぁ-んァ-ヶ]/g)?.length ?? 0
  // 允许中文简介中出现少量日文人名/片名，但拒绝以日文正文为主的 Bangumi summary。
  return han >= 4 && kana <= Math.max(4, Math.floor(han * 0.35))
}

/**
 * 为 Bangumi 搜索结果打分。媒体类型是硬条件；标题、路径年份和是否为特别篇
 * 共同决定候选，避免同名漫画或 OVA 抢在 TV 正片前面。
 */
export function scoreBangumiCandidate(
  candidate: BangumiCandidate,
  query: string,
  preferType: 2 | 6,
  expectedYear: number | null,
): number {
  if (candidate.type !== preferType) return Number.NEGATIVE_INFINITY
  const queryTitle = normalizeMatchTitle(query)
  const titles = [candidate.title, candidate.titleZh ?? ''].filter(Boolean)
  const normalizedTitles = titles.map(normalizeMatchTitle).filter(Boolean)
  let score = 100
  if (normalizedTitles.some(title => title === queryTitle)) score += 90
  else if (normalizedTitles.some(title => title.includes(queryTitle) || queryTitle.includes(title))) score += 35
  else score -= 35

  if (expectedYear != null && candidate.year != null) {
    const distance = Math.abs(candidate.year - expectedYear)
    score += distance === 0 ? 45 : distance === 1 ? 12 : -Math.min(45, distance * 8)
  }
  if (candidate.episodes != null) score += 8
  const candidateTitle = titles.join(' ')
  if (hasSpecialEditionMarker(candidateTitle) && !hasSpecialEditionMarker(query)) {
    // 系列根目录通常不写“第一季”，第一季仍是合理主候选；其他季度/OVA 继续重罚。
    score -= hasFirstSeasonMarker(candidateTitle) ? 5 : 55
  }
  return score
}

export function pickBangumiCandidate(
  candidates: BangumiCandidate[],
  query: string,
  preferType: 2 | 6,
  expectedYear: number | null,
): BangumiCandidate | undefined {
  const ranked = candidates
    .map(candidate => ({ candidate, score: scoreBangumiCandidate(candidate, query, preferType, expectedYear) }))
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.score >= 135 ? ranked[0].candidate : undefined
}

export type AirStatus = 'airing' | 'finished' | 'upcoming' | null

const DAY_MS = 24 * 60 * 60_000

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function bangumiDateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/((?:19|20)\d{2})(?:\D+(\d{1,2}))?(?:\D+(\d{1,2}))?/)
  if (!match) return null
  const year = Number(match[1])
  const month = Math.min(12, Math.max(1, Number(match[2] ?? 1)))
  const day = Math.min(31, Math.max(1, Number(match[3] ?? 1)))
  const ms = Date.UTC(year, month - 1, day)
  return Number.isNaN(ms) ? null : ms
}

function infoboxText(infobox: unknown, keyPattern: RegExp): string | null {
  if (!Array.isArray(infobox)) return null
  const row = infobox.find((entry: any) => keyPattern.test(String(entry?.key ?? ''))) as any
  if (!row) return null
  const value = row.value
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value.map(v => typeof v === 'string' ? v : (v?.v ?? v?.value ?? '')).filter(Boolean).join(' ')
    return text || null
  }
  return value == null ? null : String(value)
}

/**
 * Bangumi 没有直接返回放送状态。优先使用开始/结束日期；缺少结束日期时，
 * 按 TV 动画通常每周一集估算。完全没有日期的心愿单条目按“待播”处理，
 * 这比误归到“已完结”更符合心愿单语义。
 */
export function inferBangumiAirStatus(
  airDate: string | null,
  endDate: string | null,
  totalEpisodes: number | null,
  now = new Date(),
): Exclude<AirStatus, null> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = bangumiDateMs(airDate)
  const end = bangumiDateMs(endDate)
  if (start != null && start > today) return 'upcoming'
  if (end != null) return end < today ? 'finished' : 'airing'
  if (start == null) return 'upcoming'

  if (totalEpisodes != null) {
    // 给最终话两周资料延迟余量，避免放送延期时过早标成完结。
    const estimatedFinish = start + Math.max(0, totalEpisodes - 1) * 7 * DAY_MS + 14 * DAY_MS
    return today > estimatedFinish ? 'finished' : 'airing'
  }
  // 集数仍未知时，只把半年内开播的条目视为在播；更早的按已完结处理。
  return today - start <= 180 * DAY_MS ? 'airing' : 'finished'
}

function regularEpisodeCount(data: any): number | null {
  const planned = positiveInt(data?.eps)
  if (planned != null) return planned
  const infoboxCount = infoboxText(data?.infobox, /话数|話数|集数|集數/)
  const infoboxNumber = infoboxCount?.match(/\d+/)?.[0]
  if (infoboxNumber && positiveInt(infoboxNumber) != null) return positiveInt(infoboxNumber)
  const legacyCount = positiveInt(data?.eps_count)
  if (legacyCount != null) return legacyCount
  if (Array.isArray(data?.eps)) {
    const regular = data.eps.filter((ep: any) => ep?.type == null || ep.type === 0)
    const highest = regular.reduce((max: number, ep: any) => Math.max(max, Number(ep?.sort) || 0), 0)
    return positiveInt(highest) ?? positiveInt(regular.length)
  }
  return positiveInt(data?.total_episodes)
}

function bangumiSubjectId(data: any): number | null {
  if (typeof data?.id === 'number') return positiveInt(data.id)
  if (typeof data?.id === 'string' && /^\d+$/.test(data.id.trim())) return positiveInt(data.id.trim())
  return null
}

function bangumiSubjectType(data: any): 2 | 6 | null {
  const value = typeof data?.type === 'string' && /^\d+$/.test(data.type.trim()) ? Number(data.type.trim()) : data?.type
  return value === 2 || value === 6 ? value : null
}

function assertBangumiDetailIdentity(data: any, bgmId: number, expectedType?: 2 | 6): 2 | 6 {
  if (bangumiSubjectId(data) !== bgmId) {
    throw new BangumiDetailValidationError(`Bangumi 详情身份不匹配：请求 ${bgmId}，返回 ${String(data?.id ?? '缺失')}`, 'BANGUMI_DETAIL_ID_MISMATCH')
  }
  const type = bangumiSubjectType(data)
  if (type == null) {
    const rawType = data?.type
    throw new BangumiDetailValidationError(
      rawType == null || rawType === '' ? 'Bangumi 详情缺少可确认的媒介类型' : `Bangumi 详情媒介类型不受支持：${String(rawType)}`,
      rawType == null || rawType === '' ? 'BANGUMI_DETAIL_TYPE_UNKNOWN' : 'BANGUMI_DETAIL_TYPE_MISMATCH',
    )
  }
  if (expectedType != null && type !== expectedType) {
    throw new BangumiDetailValidationError(`Bangumi 详情媒介类型不匹配：期望 ${expectedType}，返回 ${type}`, 'BANGUMI_DETAIL_TYPE_MISMATCH')
  }
  return type
}

const nonEmptyDetailText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text : undefined
}

/** Merge only verified, non-empty detail fields so sparse upstream data cannot erase a candidate. */
export function mergeBangumiDetail(candidate: BangumiCandidate, detail: Partial<BangumiCandidate>): BangumiCandidate {
  const merged = { ...candidate }
  const textFields: Array<keyof BangumiCandidate> = ['title', 'titleZh', 'synopsis', 'posterUrl', 'posterPath', 'airDate']
  for (const field of textFields) {
    const value = nonEmptyDetailText(detail[field])
    if (value !== undefined) (merged as any)[field] = value
  }
  const numericFields: Array<keyof BangumiCandidate> = ['year', 'rating', 'episodes', 'airedEpisodes']
  for (const field of numericFields) {
    const value = detail[field]
    if (typeof value === 'number' && Number.isFinite(value)) (merged as any)[field] = value
  }
  if (detail.airStatus != null) merged.airStatus = detail.airStatus
  if (detail.type === 2 || detail.type === 6) merged.type = detail.type
  if (typeof detail.bgmId === 'number' && detail.bgmId > 0) merged.bgmId = detail.bgmId
  return merged
}

const QUERY = `
query ($search: String, $perPage: Int) {
  Page(perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      coverImage { extraLarge large }
      startDate { year }
      averageScore
      genres
      description(asHtml: false)
      episodes
    }
  }
}`

const ANILIST_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english native }
    coverImage { extraLarge large }
    startDate { year }
    averageScore
    genres
    description(asHtml: false)
    episodes
  }
}`

function mapAniListMedia(media: Record<string, any>): AniListCandidate {
  return {
    anilistId: media.id,
    title: media.title?.english ?? media.title?.romaji ?? '未知',
    originalTitle: media.title?.native ?? media.title?.romaji ?? null,
    year: media.startDate?.year ?? null,
    rating: media.averageScore == null ? null : media.averageScore / 10,
    genres: media.genres ?? [],
    synopsis: media.description ? String(media.description).replace(/<[^>]+>/g, '') : null,
    episodes: media.episodes ?? null,
    posterUrl: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
    posterPath: null,
  }
}

export interface MetadataRequestOptions {
  throwOnError?: boolean
  signal?: AbortSignal
  maxResponseBytes?: number
  /** When set, return only candidates in this media domain. */
  mediaDomain?: MediaDomain
  /** Known TMDB shape for poster refresh; absent keeps legacy movie/tv probing. */
  tmdbMediaType?: 'movie' | 'tv'
  /** Expected structured Bangumi subject type when enriching an already verified candidate. */
  expectedBangumiType?: 2 | 6
}

function metadataRequestConfig(options: MetadataRequestOptions) {
  return {
    signal: options.signal,
    ...(options.maxResponseBytes === undefined ? {} : { maxContentLength: options.maxResponseBytes }),
  }
}

export async function searchAniList(query: string, options: MetadataRequestOptions = {}): Promise<AniListCandidate[]> {
  // AniList's Media(type: ANIME) endpoint is never a live-action source.
  // Avoid a network call when the target library is explicitly live action.
  if (options.mediaDomain === 'live_action') return []
  try {
    const { data } = await providerRequest('anilist', requestSignal(processDb, options.signal), () => routedAxiosPost('https://graphql.anilist.co', { query: QUERY, variables: { search: query, perPage: 8 } }, {
      ...metadataRequestConfig(options),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }))
    const mediaList: unknown[] = data?.data?.Page?.media ?? []
    return mediaList.map(media => mapAniListMedia(media as Record<string, any>))
  } catch (e: any) {
    // 限流（429）抛出交由调用方等待重试；其余网络错误/无结果返回空
    if (options.signal?.aborted || e?.code === 'ERR_CANCELED') throw e
    if (isProviderRateLimitError(e) || e instanceof ProxyError || e?.response?.status === 429) throw e
    return []
  }
}

export async function getAniListDetail(anilistId: number, options: MetadataRequestOptions = {}): Promise<AniListCandidate | null> {
  try {
    const { data } = await providerRequest('anilist', requestSignal(processDb, options.signal), () => routedAxiosPost('https://graphql.anilist.co', {
      query: ANILIST_ID_QUERY,
      variables: { id: anilistId },
    }, { ...metadataRequestConfig(options), headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }))
    const media = data?.data?.Media
    return media?.id ? mapAniListMedia(media) : null
  } catch (e: any) {
    if (options.signal?.aborted || e?.code === 'ERR_CANCELED' || isProviderRateLimitError(e) || e instanceof ProxyError) throw e
    return null
  }
}

export function getTMDBKey(): string {
  return settingsDb.get('tmdb_key')?.trim() ?? ''
}

// Bangumi Access Token（仅在用户配置时发送；不承诺固定请求配额）
export function getBangumiToken(): string {
  return settingsDb.get('bangumi_token')?.trim() ?? ''
}

// Bangumi 请求配置：应用身份不含用户信息；带 token 时附加 Authorization 头
function bangumiCfg(cfg: any = {}) {
  const signal = requestSignal(processDb, cfg.signal)
  if (signal) cfg = { ...cfg, signal }
  const token = getBangumiToken()
  const merged = { ...cfg }
  merged.headers = { ...(merged.headers ?? {}), 'User-Agent': bangumiUserAgent }
  if (token) {
    merged.headers = { ...(merged.headers ?? {}), Authorization: `Bearer ${token}` }
  }
  return merged
}

async function bangumiGet(url: string, cfg: any = {}) {
  return routedAxiosGet(url, bangumiCfg({ timeout: 8000, ...cfg }))
}

async function bangumiPost(url: string, data: unknown, cfg: any = {}) {
  return routedAxiosPost(url, data, bangumiCfg({ timeout: 8000, ...cfg }))
}

const REMOTE_IMAGE_CACHE_TTL = 5 * 60 * 1000
const remoteImageCache = new Map<string, { expires: number; data: Buffer; contentType: string }>()
const remoteImageInFlight = new Map<string, Promise<{ data: Buffer; contentType: string }>>()

const IPV4_UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 0x00ffffff], // "this" network / unspecified
  [0x0a000000, 0x0affffff], // RFC 1918
  [0x64400000, 0x647fffff], // RFC 6598 shared address space
  [0x7f000000, 0x7fffffff], // loopback
  [0xa9fe0000, 0xa9feffff], // link-local
  [0xac100000, 0xac1fffff], // RFC 1918
  [0xc0000000, 0xc00000ff], // IETF protocol assignments
  [0xc0000200, 0xc00002ff], // TEST-NET-1
  [0xc0586300, 0xc05863ff], // 6to4 relay anycast
  [0xc0a80000, 0xc0a8ffff], // RFC 1918
  [0xc6120000, 0xc613ffff], // benchmarking
  [0xc6336400, 0xc63364ff], // TEST-NET-2
  [0xcb007100, 0xcb0071ff], // TEST-NET-3
  [0xe0000000, 0xffffffff], // multicast / reserved
]

const IPV6_UNSAFE_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 128], // unspecified
  [1n, 128], // loopback
  [0xfc000000000000000000000000000000n, 7], // unique local
  [0xfe800000000000000000000000000000n, 10], // link-local
  [0xfec000000000000000000000000000000n, 10], // site-local
  [0xff000000000000000000000000000000n, 8], // multicast
  [0x20010db8000000000000000000000000n, 32], // documentation
  [0x20010002000000000000000000000000n, 48], // benchmarking
  [0x20011000000000000000000000000000n, 28], // ORCHID
]

function ipv4Number(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(part => /^\d{1,3}$/.test(part) ? Number(part) : -1)
  if (octets.some(part => part < 0 || part > 255)) return null
  return octets[0] * 0x1000000 + octets[1] * 0x10000 + octets[2] * 0x100 + octets[3]
}

function ipv6Words(value: string): number[] | null {
  const sections = value.toLowerCase().split('::')
  if (sections.length > 2) return null
  const parseSection = (section: string): number[] | null => {
    if (!section) return []
    const words: number[] = []
    for (const part of section.split(':')) {
      if (part.includes('.')) {
        const ipv4 = ipv4Number(part)
        if (ipv4 == null) return null
        words.push(Math.floor(ipv4 / 0x10000), ipv4 % 0x10000)
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null
        words.push(Number.parseInt(part, 16))
      }
    }
    return words
  }
  const left = parseSection(sections[0])
  const right = parseSection(sections.length === 2 ? sections[1] : '')
  if (!left || !right) return null
  if (sections.length === 1) return left.length === 8 ? left : null
  if (left.length + right.length >= 8) return null
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
}

function ipv6Number(value: string): bigint | null {
  const words = ipv6Words(value)
  if (!words) return null
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n)
}

function inIpv6Range(value: bigint, network: bigint, prefixLength: number): boolean {
  const shift = 128 - prefixLength
  return (value >> BigInt(shift)) === (network >> BigInt(shift))
}

function isUnsafeIpAddress(value: string): boolean {
  const normalized = value.replace(/^\[|\]$/g, '').toLowerCase()
  const family = net.isIP(normalized)
  if (family === 4) {
    const number = ipv4Number(normalized)
    return number == null || IPV4_UNSAFE_RANGES.some(([start, end]) => number >= start && number <= end)
  }
  if (family !== 6) return true
  const number = ipv6Number(normalized)
  if (number == null || IPV6_UNSAFE_RANGES.some(([network, prefix]) => inIpv6Range(number, network, prefix))) return true

  // IPv4-mapped/compatible and 6to4 addresses can still target a private
  // IPv4 endpoint while being written as IPv6.
  const low32 = Number(number & 0xffffffffn)
  if ((number >> 32n) === 0xffffn) {
    return isUnsafeIpAddress(`${low32 >>> 24}.${(low32 >>> 16) & 0xff}.${(low32 >>> 8) & 0xff}.${low32 & 0xff}`)
  }
  if ((number >> 32n) === 0n) return true
  if ((number >> 112n) === 0x2002n) {
    const embedded = Number((number >> 80n) & 0xffffffffn)
    if (isUnsafeIpAddress(`${embedded >>> 24}.${(embedded >>> 16) & 0xff}.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`)) return true
  }
  return false
}

type ResolvedImageAddress = { address: string; family: 4 | 6 }

type ValidatedRemoteImageUrl = {
  url: URL
  addresses: ResolvedImageAddress[]
}

function normalizeImageHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function remoteImageAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('远程图片请求已取消')
  error.name = signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'
  return error
}

function throwIfRemoteImageAborted(signal: AbortSignal): void {
  if (signal.aborted) throw remoteImageAbortError(signal)
}

/**
 * Await a promise with a caller-owned abort signal without leaving a late
 * resolver rejection unhandled. DNS lookup itself cannot be cancelled on all
 * supported Node versions, so a late result is deliberately ignored.
 */
function awaitWithRemoteImageAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(remoteImageAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(remoteImageAbortError(signal))
    }
    const onResolve = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const onReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    Promise.resolve(promise).then(onResolve, onReject)
  })
}

type RemoteImageLifecycle = {
  signal: AbortSignal
  dispose: () => void
}

function createRemoteImageLifecycle(externalSignal?: AbortSignal): RemoteImageLifecycle {
  const parentSignal = requestSignal(processDb, externalSignal)
  const controller = new AbortController()
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason)
  }
  if (parentSignal?.aborted) abortFromParent()
  else if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true })

  let timer: ReturnType<typeof setTimeout> | null = null
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      const error = new Error('远程图片请求超时')
      error.name = 'TimeoutError'
      controller.abort(error)
    }, 6000)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = null
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

async function resolveSafeImageHost(hostname: string, signal?: AbortSignal): Promise<ResolvedImageAddress[]> {
  if (signal) throwIfRemoteImageAborted(signal)
  const normalized = normalizeImageHostname(hostname)
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new Error('远程图片主机不允许使用本机或局域网名称')
  }
  const literalFamily = net.isIP(normalized)
  if (literalFamily) {
    if (isUnsafeIpAddress(normalized)) throw new Error('远程图片地址不允许指向私人、保留或本机网络')
    return [{ address: normalized, family: literalFamily as 4 | 6 }]
  }
  let resolved: Array<{ address: string; family: number }>
  try {
    const lookup = dnsLookup(normalized, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: number }>>
    resolved = await (signal ? awaitWithRemoteImageAbort(lookup, signal) : lookup)
  } catch {
    if (signal?.aborted) throw remoteImageAbortError(signal)
    throw new Error('远程图片主机无法解析')
  }
  if (signal) throwIfRemoteImageAborted(signal)
  const addresses: ResolvedImageAddress[] = []
  for (const item of resolved) {
    const family = item.family === 4 || item.family === 6 ? item.family : net.isIP(item.address)
    if (family !== 4 && family !== 6) throw new Error('远程图片地址解析结果无效')
    addresses.push({ address: item.address, family })
  }
  if (!addresses.length || addresses.some(item => net.isIP(item.address) !== item.family || isUnsafeIpAddress(item.address))) {
    throw new Error('远程图片地址不允许指向私人、保留或本机网络')
  }
  return addresses
}

async function validateRemoteImageRequest(value: string, signal?: AbortSignal): Promise<ValidatedRemoteImageUrl> {
  if (signal) throwIfRemoteImageAborted(signal)
  const parsed = parseRemoteImageUrl(value)
  return { url: parsed, addresses: await resolveSafeImageHost(parsed.hostname, signal) }
}

function parseRemoteImageUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new Error('远程图片 URL 无效')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('远程图片 URL 无效') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('远程图片仅支持 HTTP 或 HTTPS')
  if (parsed.username || parsed.password) throw new Error('远程图片 URL 不允许携带凭据')
  return parsed
}

export async function validateRemoteImageUrl(value: string): Promise<URL> {
  return (await validateRemoteImageRequest(value)).url
}

// Built-in HTTPS CDNs use the normal route. Other images retain DNS validation
// and pass the validated address into the network transport.
export interface FetchRemoteImageOptions {
  force?: boolean
  signal?: AbortSignal
}

function responseHeader(headers: any, name: string): unknown {
  if (!headers) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    if (value != null) return value
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
}

function remoteImageValidationError(message: string): Error {
  const error = new Error(message)
  ;(error as any).code = 'ERR_REMOTE_IMAGE_VALIDATION'
  return error
}

export async function fetchRemoteImage(url: string, options: FetchRemoteImageOptions = {}): Promise<{ data: Buffer; contentType: string }> {
  const lifecycle = createRemoteImageLifecycle(options.signal)
  try {
    throwIfRemoteImageAborted(lifecycle.signal)
    const parsed = parseRemoteImageUrl(url)
    const requestUrl = parsed.href
    const cached = remoteImageCache.get(requestUrl)
    if (!options.force && cached && cached.expires > Date.now() && isValidPosterImage(cached.data)) {
      return { data: cached.data, contentType: cached.contentType }
    }
    if (cached && (!isValidPosterImage(cached.data) || cached.expires <= Date.now())) remoteImageCache.delete(requestUrl)
    const existing = options.force ? undefined : remoteImageInFlight.get(requestUrl)
    if (existing) return await awaitWithRemoteImageAbort(existing, lifecycle.signal)

    const decision = resolveProxy(requestUrl)
    const proxyResolvedTrustedOrigin = Boolean(decision.proxy && isTrustedImageOrigin(parsed))
    const addresses = proxyResolvedTrustedOrigin ? [] : await resolveSafeImageHost(parsed.hostname, lifecycle.signal)
    throwIfRemoteImageAborted(lifecycle.signal)
    const request = (async () => {
    const route = networkAxiosConfig(requestUrl, lifecycle.signal, {
      route: decision,
      pinnedAddress: addresses[0],
    })
    try {
      const resp = await http.get(requestUrl, {
        ...route.config,
        signal: lifecycle.signal,
        responseType: 'arraybuffer',
        maxContentLength: MAX_POSTER_BYTES,
        maxBodyLength: MAX_POSTER_BYTES,
        timeout: 6000,
        maxRedirects: 0,
        validateStatus: status => status === 200,
      })
      const status = Number(resp.status)
      if (Number.isFinite(status) && (status < 200 || status >= 300)) {
        const error = new Error(`远程图片响应状态无效：${status}`)
        ;(error as any).response = resp
        throw error
      }
      const contentLength = Number.parseInt(String(responseHeader(resp.headers, 'content-length') ?? ''), 10)
      if (Number.isFinite(contentLength) && contentLength > MAX_POSTER_BYTES) throw remoteImageValidationError('远程图片响应过大')
      const image = {
        data: Buffer.from(resp.data),
        contentType: String(responseHeader(resp.headers, 'content-type') ?? 'image/jpeg'),
      }
      if (image.data.length > MAX_POSTER_BYTES) throw remoteImageValidationError('远程图片响应过大')
      if (!isValidPosterImage(image.data)) throw remoteImageValidationError('海报响应不是有效图片')
      remoteImageCache.set(requestUrl, { ...image, expires: Date.now() + REMOTE_IMAGE_CACHE_TTL })
      if (remoteImageCache.size > 32) {
        const oldest = remoteImageCache.keys().next().value
        if (oldest) remoteImageCache.delete(oldest)
      }
      return image
    } catch (error: any) {
      if (lifecycle.signal.aborted) throw remoteImageAbortError(lifecycle.signal)
      if (error?.response || error?.code === 'ERR_REMOTE_IMAGE_VALIDATION') throw error
      throw networkFailure(error, Boolean(decision.proxy))
    } finally {
      route.dispose()
    }
    })().finally(() => { if (!options.force) remoteImageInFlight.delete(requestUrl) })
    if (!options.force) remoteImageInFlight.set(requestUrl, request)
    return await request
  } finally {
    lifecycle.dispose()
  }
}

// 按 TMDB id + 已知作品形态获取海报 URL；缺少形态时拒绝猜测 movie/tv。
export async function getTMDBPoster(tmdbId: number, options: MetadataRequestOptions = {}): Promise<string | null> {
  const key = getTMDBKey()
  if (!key) {
    if (options.throwOnError) throw Object.assign(new Error('TMDb 数据源尚未配置'), { code: 'SOURCE_CONFIGURATION' })
    return null
  }
  if (!options.tmdbMediaType) return null
  const kinds = [options.tmdbMediaType] as const
  for (const kind of kinds) {
    try {
      const url = `https://api.themoviedb.org/3/${kind}/${tmdbId}`
      const signal = requestSignal(processDb, options.signal, 6000)
      const { data } = await providerRequest('tmdb', signal, () => routedAxiosGet(url, {
        signal,
        timeout: 6000,
        params: { api_key: key, language: 'zh-CN' },
      }))
      return data?.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null
    } catch (error) {
      if (options.signal?.aborted || options.throwOnError || isProviderRateLimitError(error) || error instanceof ProxyError) throw error
    }
  }
  return null
}

// 按 TMDB id + 类型获取详情（海报 + 简介）——心愿单「更新元数据」TMDB 源用
export async function getTMDBDetail(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<{ posterUrl: string | null; synopsis: string | null; domainEvidence?: MediaDomainEvidence[] } | null> {
  const key = getTMDBKey()
  if (!key) return null
  try {
    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}`
    const signal = requestSignal(processDb, undefined, 6000)
    const { data } = await providerRequest('tmdb', signal, () => routedAxiosGet(url, {
      signal,
      timeout: 6000,
      params: { api_key: key, language: 'zh-CN' },
    }))
    return { posterUrl: data?.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null, synopsis: data?.overview || null,
      domainEvidence: data?.id === tmdbId ? candidateDomainEvidence('tmdb', { tmdbId, mediaType, genres: data.genres }) : undefined }
  } catch (error) {
    if (isProviderRateLimitError(error) || error instanceof ProxyError) throw error
    return null
  }
}

// TMDB 搜索（zh-CN 语言返回中文标题/简介；multi 同时覆盖电影与剧集）
export async function searchTMDB(query: string, key: string, options: MetadataRequestOptions = {}): Promise<TMDBCandidate[]> {
  const mapResults = (data: any): TMDBCandidate[] => {
    const results: any[] = data?.results ?? []
    const normalizedQuery = normalizeMatchTitle(query)
    const mediaResults = results
      .filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
      .map((result: any, index: number) => ({ result, index, mediaDomain: mediaDomainForTMDB({
        mediaType: result.media_type,
        genreIds: Array.isArray(result.genre_ids) ? result.genre_ids : null,
        genres: Array.isArray(result.genres) ? result.genres : null,
      }) }))
      .filter(({ mediaDomain }) => !options.mediaDomain || options.mediaDomain === 'unknown' || mediaDomain === options.mediaDomain)
      .map(({ result, index, mediaDomain }) => ({
        result,
        index,
        mediaDomain,
        exactTitle: [result.title, result.name, result.original_title, result.original_name]
          .some(title => typeof title === 'string' && normalizeMatchTitle(title) === normalizedQuery),
      }))
      .sort((left, right) => Number(right.exactTitle) - Number(left.exactTitle) || left.index - right.index)
      .slice(0, 8)

    return mediaResults.map(({ result: r, mediaDomain }) => ({
      tmdbId: r.id,
      mediaType: r.media_type,
      title: r.title ?? r.name ?? '未知',
      originalTitle: r.original_title ?? r.original_name ?? null,
      year: (r.release_date ?? r.first_air_date ?? '').slice(0, 4) || null,
      rating: typeof r.vote_average === 'number' ? Number(r.vote_average.toFixed(1)) : null,
      genres: [],
      synopsis: r.overview || null,
      seasons: typeof r.number_of_seasons === 'number' ? r.number_of_seasons : null,
      posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
      posterPath: null,
      genreIds: Array.isArray(r.genre_ids) ? r.genre_ids
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isInteger(value) && value > 0) : null,
      mediaDomain,
    }))
  }
  const url = 'https://api.themoviedb.org/3/search/multi'
  try {
    const signal = requestSignal(processDb, options.signal, 8000)
    const { data } = await providerRequest('tmdb', signal, () => routedAxiosGet(url, {
      ...metadataRequestConfig(options),
      signal,
      timeout: 8000,
      params: { query, api_key: key, language: 'zh-CN', include_adult: false },
    }))
    if (data?.status_message) throw new Error(data.status_message)
    return mapResults(data)
  } catch (e: any) {
    if (isProviderRateLimitError(e) || e instanceof ProxyError || options.signal?.aborted || e?.code === 'ERR_CANCELED') throw e
    if (e?.message === 'TMDB API Key 无效' || e?.response?.status === 401) throw new Error('TMDB API Key 无效')
    throw new Error('TMDB 网络不可达，请检查代理配置或网络')
  }
}

export interface CachePosterOptions {
  refresh?: boolean
  force?: boolean
  signal?: AbortSignal
  directory?: string
  /** Repair jobs need the original failure; legacy callers retain null fallback. */
  throwOnError?: boolean
}

const POSTER_EXTENSIONS = ['jpg', 'png', 'webp'] as const

function posterExtension(url: string, contentType?: string): typeof POSTER_EXTENSIONS[number] {
  const byType = contentType?.toLowerCase()
  if (byType?.includes('png')) return 'png'
  if (byType?.includes('webp')) return 'webp'
  if (byType?.includes('jpeg') || byType?.includes('jpg')) return 'jpg'
  const raw = url.split('.').pop()?.split('?')[0]?.toLowerCase()
  if (raw === 'png' || raw === 'webp') return raw
  return 'jpg'
}

function existingPoster(directory: string, id: string): { file: string; ext: typeof POSTER_EXTENSIONS[number] } | null {
  const candidates = POSTER_EXTENSIONS.flatMap(ext => {
    const file = path.join(directory, `${id}.${ext}`)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_POSTER_BYTES) return []
      return isValidPosterImage(fs.readFileSync(file)) ? [{ file, ext, modifiedAt: stat.mtimeMs }] : []
    } catch {
      return []
    }
  })
  const selected = candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
  return selected ? { file: selected.file, ext: selected.ext } : null
}

export function cachedPosterPath(id: string, directory = POSTER_DIR): string | null {
  const existing = existingPoster(directory, id)
  return existing ? `/posters/${id}.${existing.ext}` : null
}

function replacePoster(directory: string, id: string, ext: typeof POSTER_EXTENSIONS[number], data: Buffer): string {
  const file = path.join(directory, `${id}.${ext}`)
  const temporary = path.join(directory, `.${id}-${randomUUID()}.tmp`)
  let backup: string | null = null
  fs.writeFileSync(temporary, data)
  try {
    try {
      fs.renameSync(temporary, file)
    } catch (error: any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      backup = path.join(directory, `.${id}-${randomUUID()}.bak`)
      fs.renameSync(file, backup)
      try { fs.renameSync(temporary, file) }
      catch (replaceError) {
        fs.renameSync(backup, file)
        backup = null
        throw replaceError
      }
    }
    for (const alternate of POSTER_EXTENSIONS) {
      if (alternate !== ext) fs.rmSync(path.join(directory, `${id}.${alternate}`), { force: true })
    }
    if (backup) fs.rmSync(backup, { force: true })
    return `/posters/${id}.${ext}`
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    if (backup && fs.existsSync(backup) && !fs.existsSync(file)) fs.renameSync(backup, file)
    throw error
  }
}

export async function cachePoster(url: string, id: string, options: CachePosterOptions = {}): Promise<string | null> {
  const directory = options.directory ?? POSTER_DIR
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
  const existing = existingPoster(directory, id)
  if (existing && !options.refresh && !options.force) return `/posters/${id}.${existing.ext}`
  try {
    const image = await fetchRemoteImage(url, { force: options.force, signal: options.signal })
    return replacePoster(directory, id, posterExtension(url, image.contentType), image.data)
  } catch (error) {
    if (options.throwOnError || options.signal?.aborted || isProviderRateLimitError(error) || error instanceof ProxyError) throw error
    if (options.force) return null
    return existing ? `/posters/${id}.${existing.ext}` : null
  }
}

// 按 AniList id 获取海报 URL（缺失海报补抓用）——国内可直连
export async function getAnilistPosterUrl(anilistId: number, options: MetadataRequestOptions = {}): Promise<string | null> {
  try {
    const signal = requestSignal(processDb, options.signal, 8000)
    const resp = await providerRequest('anilist', signal, () => networkFetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'AnimeShelf/1.0 (local media manager)' },
      body: JSON.stringify({
        query: 'query ($id: Int) { Media(id: $id, type: ANIME) { coverImage { extraLarge large } } }',
        variables: { id: anilistId },
      }),
      signal,
    }))
    if (!resp.ok) {
      if (options.throwOnError) throw Object.assign(new Error('AniList 请求失败'), { response: { status: resp.status } })
      return null
    }
    const d: any = await readProviderJson('anilist', resp)
    if (options.throwOnError) {
      const upstreamStatus = Number(d?.errors?.find((error: { status?: unknown }) => error?.status)?.status)
      if (upstreamStatus && upstreamStatus !== 404) throw Object.assign(new Error('AniList 来源请求失败'), { response: { status: upstreamStatus } })
      if (upstreamStatus === 404 || d?.data?.Media === null) throw Object.assign(new Error('AniList 作品不存在或不是动画来源，请确认来源'), { code: 'SOURCE_CONFIRMATION_REQUIRED' })
      if (!d?.data?.Media || d?.errors?.length) throw Object.assign(new Error('AniList 来源响应不完整'), { code: 'ERR_BAD_RESPONSE' })
    }
    return d?.data?.Media?.coverImage?.extraLarge ?? d?.data?.Media?.coverImage?.large ?? null
  } catch (error) {
    if (options.signal?.aborted || options.throwOnError || isProviderRateLimitError(error) || error instanceof ProxyError) throw error
    return null
  }
}

export interface BindMetadataOptions {
  rebuildCatalog?: boolean
  automatic?: boolean
}

// 统一绑定入口：source = 'anilist' | 'tmdb'，externalId 存入 anilist_id 字段（复用，语义由 source 区分）
export async function bindAnilist(folderId: number, cand: AniListCandidate, db: Database, options: BindMetadataOptions = {}): Promise<Folder> {
  assertCandidateMatchesFolder(db, folderId, 'anilist', cand, options.automatic)
  const posterPath = cand.posterUrl ? await cachePoster(cand.posterUrl, `al_${cand.anilistId}`) : null
  assertCandidateMatchesFolder(db, folderId, 'anilist', cand, options.automatic)
  const updated = makeFolderDb(db).updateAnilist(folderId, {
    source: 'anilist',
    domainEvidence: candidateDomainEvidence('anilist', cand),
    tmdbMediaType: null,
    anilistId: cand.anilistId,
    hasPoster: Boolean(posterPath),
    rating: cand.rating,
    genres: cand.genres,
    synopsis: cand.synopsis,
    year: cand.year,
    episodes: cand.episodes,
  })
  if (options.rebuildCatalog !== false) rebuildMediaCatalogForFolder(db, folderId)
  return updated
}

export async function bindTMDB(folderId: number, cand: TMDBCandidate, db: Database, options: BindMetadataOptions = {}): Promise<Folder> {
  assertCandidateMatchesFolder(db, folderId, 'tmdb', cand, options.automatic)
  const posterPath = cand.posterUrl ? await cachePoster(cand.posterUrl, posterCacheKey('tmdb', cand.tmdbId, cand.mediaType)!) : null
  assertCandidateMatchesFolder(db, folderId, 'tmdb', cand, options.automatic)
  const updated = makeFolderDb(db).updateAnilist(folderId, {
    source: 'tmdb',
    domainEvidence: candidateDomainEvidence('tmdb', cand),
    tmdbMediaType: cand.mediaType,
    anilistId: cand.tmdbId,
    hasPoster: Boolean(posterPath),
    rating: cand.rating,
    genres: cand.genres,
    synopsis: cand.synopsis,
    year: cand.year,
    episodes: cand.seasons,
  })
  if (options.rebuildCatalog !== false) rebuildMediaCatalogForFolder(db, folderId)
  return updated
}

// ─── Bangumi（bgm.tv，中文元数据；需代理可达）────────────────────────────────

export async function searchBangumi(query: string, options: MetadataRequestOptions = {}): Promise<BangumiCandidate[]> {
  try {
    // v0 搜索可在服务端直接限定动画/真人类型，比旧接口更稳定地返回 TV 正片。
    // 旧接口仅作为兼容回退，最终仍做一次类型过滤，杜绝漫画/小说候选。
    let list: any[] = []
    try {
      const { data } = await bangumiPost('https://api.bgm.tv/v0/search/subjects', {
        keyword: query,
        filter: { type: [2, 6] },
        sort: 'match',
      }, metadataRequestConfig(options))
      list = data?.data ?? []
    } catch (e: any) {
      if (options.signal?.aborted || e?.code === 'ERR_CANCELED') throw e
      if (e?.response?.status === 429) throw e
      if (e instanceof ProxyError) throw e
      const { data } = await bangumiGet('https://api.bgm.tv/search/subject/' + encodeURIComponent(query), {
        ...metadataRequestConfig(options),
        params: { responseGroup: 'large' },
      })
      list = data?.list ?? []
    }
    list = list
      .filter((r: any) => r?.type === 2 || r?.type === 6)
      .filter((r: any) => !options.mediaDomain || options.mediaDomain === 'unknown' || mediaDomainForBangumiType(r.type) === options.mediaDomain)
    return list.slice(0, 8).map((r: any) => {
      const episodes = regularEpisodeCount(r)
      const rawAirDate = r.date ?? r.air_date
      const airDate = typeof rawAirDate === 'string' && rawAirDate ? rawAirDate : null
      const airStatus = inferBangumiAirStatus(airDate, null, episodes)
      return {
        bgmId: r.id,
        title: r.name ?? '未知',
        titleZh: r.name_cn || null,
        year: airDate?.match(/(19|20)\d{2}/)?.[0] ? Number(airDate.match(/(19|20)\d{2}/)![0]) : null,
        rating: typeof r.rating?.score === 'number' ? r.rating.score : null,
        synopsis: r.summary ? String(r.summary).replace(/<[^>]+>/g, '').trim().slice(0, 500) : null,
        posterUrl: r.images?.large ?? r.images?.common ?? null,
        posterPath: null,
        type: typeof r.type === 'number' ? r.type : null,
        episodes,
        airedEpisodes: airStatus === 'finished' && episodes != null ? episodes : airStatus === 'upcoming' ? 0 : null,
        airDate,
        airStatus,
        mediaDomain: mediaDomainForBangumiType(r.type),
      }
    })
  } catch (e: any) {
    if (options.signal?.aborted || e?.code === 'ERR_CANCELED') throw e
    if (e?.response?.status === 429) throw e
    if (e instanceof ProxyError) throw e
    return []
  }
}

// 补全 Bangumi 条目详情（评分/中文简介/封面/年份/集数/放送状态）
export async function getBangumiDetail(bgmId: number, options: MetadataRequestOptions = {}): Promise<Partial<BangumiCandidate>> {
  let data: any
  let legacyData: any = null
  try {
    // 新版详情 API 同时提供 wiki 计划集数（eps）与已建章节数（total_episodes）。
    ;({ data } = await bangumiGet(`https://api.bgm.tv/v0/subjects/${bgmId}`, metadataRequestConfig(options)))
  } catch (e: any) {
    if (options.signal?.aborted || e?.code === 'ERR_CANCELED') throw e
    if (e?.response?.status === 429) throw e
    if (e instanceof ProxyError) throw e
    // 无响应的超时/断网时，同一主机的 legacy 接口也不可达，不再额外等待一个超时周期。
    if (!e?.response) return {}
    // 兼容代理节点尚未放行 v0，但 legacy 接口仍可用的情况。
    try {
      ;({ data } = await bangumiGet(`https://api.bgm.tv/subject/${bgmId}`, { ...metadataRequestConfig(options), params: { responseGroup: 'large' } }))
      legacyData = data
    } catch (legacyError: any) {
      if (legacyError instanceof BangumiDetailValidationError) throw legacyError
      if (options.signal?.aborted || legacyError?.code === 'ERR_CANCELED') throw legacyError
      if (legacyError?.response?.status === 429) throw legacyError
      if (legacyError instanceof ProxyError) throw legacyError
      return {}
    }
  }

  const detailType = assertBangumiDetailIdentity(data, bgmId, options.expectedBangumiType)
  let episodes = regularEpisodeCount(data)
  if (episodes == null && legacyData == null) {
    // 部分 v0 部署/条目会省略 eps；只在确实缺集数时补一次 legacy 请求。
    try {
      ;({ data: legacyData } = await bangumiGet(`https://api.bgm.tv/subject/${bgmId}`, { ...metadataRequestConfig(options), params: { responseGroup: 'large' } }))
      assertBangumiDetailIdentity(legacyData, bgmId, detailType)
      episodes = regularEpisodeCount(legacyData)
    } catch (e: any) {
      if (e instanceof BangumiDetailValidationError) throw e
      if (options.signal?.aborted || e?.code === 'ERR_CANCELED') throw e
      if (e?.response?.status === 429) throw e
      if (e instanceof ProxyError) throw e
    }
  }
  const airDate = (typeof data?.date === 'string' && data.date.trim()) || (typeof data?.air_date === 'string' && data.air_date.trim()) || undefined
  const endDate = infoboxText(data?.infobox, /放送结束|播放结束|播出结束|上映结束/)
  const hasAirEvidence = Boolean(airDate || endDate || episodes != null)
  const airStatus = hasAirEvidence ? inferBangumiAirStatus(airDate ?? null, endDate, episodes) : undefined
  const year = airDate?.match(/(19|20)\d{2}/)?.[0]
  const synopsis = typeof data?.summary === 'string' ? data.summary.replace(/<[^>]+>/g, '').trim().slice(0, 1200) : undefined
  return {
    bgmId,
    type: detailType,
    title: nonEmptyDetailText(data?.name),
    titleZh: nonEmptyDetailText(data?.name_cn),
    year: year ? Number(year) : undefined,
    rating: typeof data?.rating?.score === 'number' && Number.isFinite(data.rating.score) ? data.rating.score : undefined,
    synopsis: synopsis || undefined,
    posterUrl: nonEmptyDetailText(data?.images?.large ?? data?.images?.common),
    episodes: episodes ?? undefined,
    airedEpisodes: hasAirEvidence && airStatus === 'finished' && episodes != null ? episodes : hasAirEvidence && airStatus === 'upcoming' ? 0 : undefined,
    airDate,
    airStatus,
  }
}

export async function findPreferredBangumiSynopsis(queries: string[], expectedYear: number | null): Promise<string | null> {
  const uniqueQueries = [...new Set(queries.map(value => value.trim()).filter(Boolean))]
  let best: BangumiCandidate | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const query of uniqueQueries) {
    let candidates: BangumiCandidate[]
    try { candidates = await searchBangumi(query) } catch (error) {
      if (error instanceof ProxyError) throw error
      continue
    }
    const picked = pickBangumiCandidate(candidates, query, 2, expectedYear)
    if (!picked) continue
    const score = scoreBangumiCandidate(picked, query, 2, expectedYear)
    if (score > bestScore) { best = picked; bestScore = score }
    if (score >= 220) break
  }
  if (!best) return null
  let detail: Partial<BangumiCandidate> = {}
  try { detail = await getBangumiDetail(best.bgmId, { expectedBangumiType: 2 }) } catch (error) {
    if (error instanceof ProxyError) throw error
    /* 使用搜索摘要继续判断 */
  }
  return [detail.synopsis, best.synopsis].find(isLikelyChineseSynopsis) ?? null
}

// 即使最终由 AniList 提供海报/评分/集数，也优先用 Bangumi 的中文简介。
// 只有用日文原名和 AniList 标题都找不到可靠的动画候选时，才保留 AniList 简介。
export async function preferBangumiSynopsis(cand: AniListCandidate): Promise<AniListCandidate> {
  const queries = [cand.originalTitle, cand.title].filter((value): value is string => Boolean(value?.trim()))
  const synopsis = await findPreferredBangumiSynopsis(queries, cand.year)
  return synopsis ? { ...cand, synopsis } : cand
}

export async function bindBangumi(folderId: number, cand: BangumiCandidate, db: Database, options: BindMetadataOptions = {}): Promise<Folder> {
  assertCandidateMatchesFolder(db, folderId, 'bangumi', cand, options.automatic)
  const posterPath = cand.posterUrl ? await cachePoster(cand.posterUrl, `bg_${cand.bgmId}`) : null
  assertCandidateMatchesFolder(db, folderId, 'bangumi', cand, options.automatic)
  const updated = makeFolderDb(db).updateAnilist(folderId, {
    source: 'bangumi',
    domainEvidence: candidateDomainEvidence('bangumi', cand),
    tmdbMediaType: null,
    anilistId: cand.bgmId,
    hasPoster: Boolean(posterPath),
    rating: cand.rating,
    genres: [],
    synopsis: cand.synopsis,
    year: cand.year,
    episodes: cand.episodes,
  })
  if (options.rebuildCatalog !== false) rebuildMediaCatalogForFolder(db, folderId)
  return updated
}
