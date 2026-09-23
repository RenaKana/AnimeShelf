import crypto from 'crypto'
import bangumiData from 'bangumi-data'

// bangumi-data（https://github.com/bangumi-data/bangumi-data）——bgmlist 同款数据源：
// 日本动画放送信息（标题多语言翻译、放送时间、各平台条目链接），由社区持续维护。
// 通过 npm 包安装（npmmirror 镜像），数据随包更新。

export interface SeasonItem {
  id: string                    // 稳定 id（bgmlist 同款算法：md5(YYYY-MM + 日文标题)）
  title: string                 // 日文原标题
  titleZh: string | null        // 中文译名（zh-Hans）
  begin: string                 // 首播时间 ISO（UTC）
  day: string                   // 放送星期 MON..SUN（按本地时区）
  time: string | null           // 放送时刻 HH:mm（本地时区）
  links: { name: string; url: string }[] // 资料站链接（官网/AniList/AniDB/番组计划/MAL/TMDB）
  isNew: boolean                // 是否本季开播
}

const DAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const
const pad = (n: number) => String(n).padStart(2, '0')

export function currentQuarter(): { season: string; year: number; quarter: number } {
  const d = new Date()
  const m = d.getMonth() + 1
  const quarter = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4
  return { season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'][quarter - 1], year: d.getFullYear(), quarter }
}

function itemId(begin: Date, title: string): string {
  return crypto.createHash('md5')
    .update(`${begin.getFullYear()}-${pad(begin.getMonth() + 1)}${title}`)
    .digest('hex')
}

/** Return the exact calendar identity generated for a canonical season entry. */
export function seasonItemIdForEntry(begin: string | null | undefined, title: string | null | undefined): string | null {
  if (!begin || !title?.trim()) return null
  const date = new Date(begin)
  return Number.isNaN(date.getTime()) ? null : itemId(date, title)
}

// 资料站链接映射（bangumi-data sites 字段，大小写不敏感匹配）
const SITE_LINKS: Record<string, { name: string; url: (id: string) => string }> = {
  bangumi: { name: '番组计划', url: id => `https://bgm.tv/subject/${id}` },
  anilist: { name: 'AniList', url: id => `https://anilist.co/anime/${id}` },
  anidb: { name: 'AniDB', url: id => `https://anidb.net/anime/${id}` },
  mal: { name: 'MyAnimeList', url: id => `https://myanimelist.net/anime/${id}` },
  tmdb: { name: 'TMDB', url: id => `https://www.themoviedb.org/${id}` },
}

export interface BangumiSeasonQuery {
  bangumiId?: string | number | null
  title?: string | null
  titleZh?: string | null
  begin?: string | null
}

export interface BangumiSeasonMatch {
  bangumiId: string | null
  title: string
  titleZh: string | null
  begin: string | null
  day: string | null
  time: string | null
  links: { name: string; url: string }[]
}

export interface FavoriteScheduleRecord {
  begin?: string | null
  air_day?: string | null
  air_time?: string | null
}

export interface FavoriteScheduleBackfill {
  begin: string | null
  air_day: string | null
  air_time: string | null
  changed: boolean
}

function rawItems(value: unknown): any[] {
  const data: any = (value as any)?.default ?? value
  return Array.isArray(data) ? data : (data?.items ?? [])
}

function normalizeTitle(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function rawTitleZhs(raw: any): string[] {
  const translations = raw?.titleTranslate?.['zh-Hans']
  if (!Array.isArray(translations)) return []
  return translations.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
}

function rawTitleZh(raw: any): string | null {
  return rawTitleZhs(raw)[0] ?? null
}

function isTvSeasonEntry(raw: any): boolean {
  return String(raw?.type ?? '').toLocaleLowerCase() === 'tv'
}

function rawSiteId(raw: any, site: string): string | null {
  const target = site.toLocaleLowerCase()
  const match = (raw?.sites ?? []).find((entry: any) => String(entry?.site ?? '').toLocaleLowerCase() === target)
  return match?.id == null ? null : String(match.id).replace(/^\D+\//, '')
}

function rawBeginMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

type TitleFormatQualifier = 'ova' | 'oad' | 'ona' | 'special' | 'movie' | 'extra'

const TITLE_FORMAT_QUALIFIERS: readonly (readonly [TitleFormatQualifier, RegExp])[] = [
  ['ova', /\bova\b/iu],
  ['oad', /\boad\b/iu],
  ['ona', /\bona\b/iu],
  ['special', /\b(?:sp|special)\b|スペシャル/iu],
  ['movie', /\b(?:movie|film)\b|剧场版|劇場版/iu],
  ['extra', /特别篇|特別篇|番外篇|番外編|总集篇|總集篇|特別編|総集編|総集篇/iu],
]

function titleFormatQualifiers(values: readonly (string | null | undefined)[]): Set<TitleFormatQualifier> {
  const result = new Set<TitleFormatQualifier>()
  for (const value of values) {
    if (!value) continue
    for (const [qualifier, pattern] of TITLE_FORMAT_QUALIFIERS) {
      if (pattern.test(value)) result.add(qualifier)
    }
  }
  return result
}

function sameTitleFormatQualifiers(left: Set<TitleFormatQualifier>, right: Set<TitleFormatQualifier>): boolean {
  if (left.size !== right.size) return false
  for (const qualifier of left) {
    if (!right.has(qualifier)) return false
  }
  return true
}

function toSeasonMatch(raw: any): BangumiSeasonMatch {
  const begin = typeof raw?.begin === 'string' && raw.begin ? raw.begin : null
  const date = begin ? new Date(begin) : null
  return {
    bangumiId: rawSiteId(raw, 'bangumi'),
    title: String(raw?.title ?? ''),
    titleZh: rawTitleZh(raw),
    begin,
    day: date && !Number.isNaN(date.getTime()) ? DAY_KEYS[date.getDay()] : null,
    time: date && !Number.isNaN(date.getTime()) ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : null,
    links: buildLinks(raw),
  }
}

function hasScheduleValue(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function fillScheduleValue(existing: string | null | undefined, canonical: string | null | undefined): string | null {
  if (hasScheduleValue(existing)) return existing
  if (hasScheduleValue(canonical)) return canonical
  return existing ?? null
}

/**
 * 只用已确认的 canonical 条目补齐收藏缺失的播出字段；已有值（包括用户手动修正）永不覆盖。
 * 该函数保持纯函数，路由层负责保证传入的 canonical 来自高置信度匹配。
 */
export function backfillFavoriteSchedule(
  current: FavoriteScheduleRecord,
  canonical: Pick<BangumiSeasonMatch, 'begin' | 'day' | 'time'> | null | undefined,
): FavoriteScheduleBackfill {
  const currentBegin = current.begin ?? null
  const currentAirDay = current.air_day ?? null
  const currentAirTime = current.air_time ?? null
  const begin = fillScheduleValue(currentBegin, canonical?.begin)
  const air_day = fillScheduleValue(currentAirDay, canonical?.day)
  const air_time = fillScheduleValue(currentAirTime, canonical?.time)
  return {
    begin,
    air_day,
    air_time,
    changed: begin !== currentBegin || air_day !== currentAirDay || air_time !== currentAirTime,
  }
}

/** 按 Bangumi ID、原名或中文名匹配完整季番条目；ID 优先，标题匹配兼顾播出日期。 */
export function matchBangumiSeasonEntry(items: readonly any[], query: BangumiSeasonQuery): BangumiSeasonMatch | null {
  const bangumiId = query.bangumiId == null ? '' : String(query.bangumiId).trim()
  const title = normalizeTitle(query.title)
  const titleZh = normalizeTitle(query.titleZh)
  const queryBegin = rawBeginMs(query.begin)
  if (!bangumiId && !title && !titleZh) return null

  const idHit = bangumiId ? items.find(raw => rawSiteId(raw, 'bangumi') === bangumiId) : undefined
  if (idHit) return toSeasonMatch(idHit)

  // 没有明确 Bangumi ID 时，只允许 TV 主条目参与标题匹配；
  // OVA、剧场版、special 等同名条目不能被弱匹配自动选中。
  const titleItems = bangumiId ? items : items.filter(isTvSeasonEntry)
  const queryTitleFormats = titleFormatQualifiers([query.title])
  const queryTitleZhFormats = titleFormatQualifiers([query.titleZh])
  const scored = titleItems.map(raw => {
    const rawTitle = normalizeTitle(typeof raw?.title === 'string' ? raw.title : null)
    const rawZhsValues = rawTitleZhs(raw)
    const rawZhs = rawZhsValues.map(normalizeTitle)
    const rawTitleFormats = titleFormatQualifiers([raw?.title])
    const rawZhFormats = rawZhsValues.map(value => titleFormatQualifiers([value]))
    let score = 0
    if (title && rawTitle === title) score = Math.max(score, 100)
    else if (title && rawTitle && sameTitleFormatQualifiers(queryTitleFormats, rawTitleFormats) && (rawTitle.includes(title) || title.includes(rawTitle))) score = Math.max(score, 40)
    if (titleZh && rawZhs.some(value => value === titleZh)) score = Math.max(score, 110)
    else if (titleZh && rawZhs.some((value, index) => value && sameTitleFormatQualifiers(queryTitleZhFormats, rawZhFormats[index]) && (value.includes(titleZh) || titleZh.includes(value)))) score = Math.max(score, 45)
    if (score === 0) return { raw, score }
    const beginMs = rawBeginMs(raw?.begin)
    if (queryBegin != null && beginMs != null) {
      const distance = Math.abs(beginMs - queryBegin)
      score += distance === 0 ? 30 : distance <= 370 * 24 * 60 * 60_000 ? 8 : -20
    }
    if (raw?.type === 'tv') score += 4
    return { raw, score }
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score)
  return scored[0] ? toSeasonMatch(scored[0].raw) : null
}

type BangumiSeasonIndex = {
  items: readonly any[]
  byBangumiId: Map<string, any>
  byTitle: Map<string, any[]>
  byTitleZh: Map<string, any[]>
}

let cachedSeasonIndex: BangumiSeasonIndex | null = null

function appendIndex(map: Map<string, any[]>, key: string, raw: any): void {
  if (!key) return
  const entries = map.get(key)
  if (entries) entries.push(raw)
  else map.set(key, [raw])
}

function createSeasonIndex(items: readonly any[]): BangumiSeasonIndex {
  const byBangumiId = new Map<string, any>()
  const byTitle = new Map<string, any[]>()
  const byTitleZh = new Map<string, any[]>()
  for (const raw of items) {
    const bangumiId = rawSiteId(raw, 'bangumi')
    if (bangumiId) byBangumiId.set(bangumiId, raw)
    // 标题反查只建立 TV 主条目索引，避免无 ID 的旧收藏被 OVA/剧场版抢走。
    if (!isTvSeasonEntry(raw)) continue
    appendIndex(byTitle, normalizeTitle(typeof raw?.title === 'string' ? raw.title : null), raw)
    for (const titleZh of rawTitleZhs(raw)) appendIndex(byTitleZh, normalizeTitle(titleZh), raw)
  }
  return { items, byBangumiId, byTitle, byTitleZh }
}

function getSeasonIndex(): BangumiSeasonIndex {
  if (cachedSeasonIndex) return cachedSeasonIndex
  cachedSeasonIndex = createSeasonIndex(rawItems(bangumiData))
  return cachedSeasonIndex
}

function closestSeasonEntry(candidates: readonly any[], begin: string | null | undefined): any | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  const queryBegin = rawBeginMs(begin)
  if (queryBegin == null) return null
  const maxDistance = 370 * 24 * 60 * 60_000
  const ambiguityMargin = 31 * 24 * 60 * 60_000
  const ranked = candidates
    .map(candidate => ({ candidate, beginMs: rawBeginMs(candidate?.begin) }))
    .filter((entry): entry is { candidate: any; beginMs: number } => entry.beginMs != null)
    .map(entry => ({ ...entry, distance: Math.abs(entry.beginMs - queryBegin) }))
    .sort((left, right) => left.distance - right.distance)
  const best = ranked[0]
  if (!best || best.distance > maxDistance) return null
  const second = ranked[1]
  if (second && second.distance - best.distance < ambiguityMargin) return null
  return best.candidate
}

function findBangumiSeasonEntryFromIndex(index: BangumiSeasonIndex, query: BangumiSeasonQuery): BangumiSeasonMatch | null {
  const bangumiId = query.bangumiId == null ? '' : String(query.bangumiId).trim()
  if (bangumiId) {
    const raw = index.byBangumiId.get(bangumiId)
    if (raw) return toSeasonMatch(raw)
    // An explicit identity is authoritative. Never reinterpret a miss as a
    // title match and persist a different Bangumi entry.
    return null
  }

  const titleZh = normalizeTitle(query.titleZh)
  if (titleZh) {
    const candidates = index.byTitleZh.get(titleZh) ?? []
    if (candidates.length > 0) {
      const raw = closestSeasonEntry(candidates, query.begin)
      return raw ? toSeasonMatch(raw) : null
    }
  }

  const title = normalizeTitle(query.title)
  if (title) {
    const candidates = index.byTitle.get(title) ?? []
    if (candidates.length > 0) {
      const raw = closestSeasonEntry(candidates, query.begin)
      return raw ? toSeasonMatch(raw) : null
    }
  }

  // Persistent canonicalization is deliberately exact. Call
  // matchBangumiSeasonEntry explicitly when a one-off fuzzy lookup is desired.
  return null
}

/**
 * Resolve a season against a supplied bangumi-data collection using only
 * explicit IDs or exact normalized TV titles. This pure helper keeps tests
 * deterministic and prevents fuzzy matches from being persisted.
 */
export function findBangumiSeasonEntryFromItems(items: readonly any[], query: BangumiSeasonQuery): BangumiSeasonMatch | null {
  return findBangumiSeasonEntryFromIndex(createSeasonIndex(items), query)
}

export function findBangumiSeasonEntry(query: BangumiSeasonQuery): BangumiSeasonMatch | null {
  return findBangumiSeasonEntryFromIndex(getSeasonIndex(), query)
}

export type FavoriteAirStatus = 'airing' | 'finished' | 'upcoming' | null

/** Prefer authoritative incoming/detail state before an existing row or date fallback. */
export function resolveFavoriteAirStatus(
  authoritative: FavoriteAirStatus | undefined,
  detail: FavoriteAirStatus | undefined,
  existing: FavoriteAirStatus | undefined,
  fallback: FavoriteAirStatus | undefined,
): FavoriteAirStatus {
  return authoritative ?? detail ?? existing ?? fallback ?? null
}

export function mergeFavoriteLinks(...groups: readonly ({ name: string; url: string }[] | null | undefined)[]): { name: string; url: string }[] {
  const out = new Map<string, { name: string; url: string }>()
  for (const group of groups) {
    for (const link of group ?? []) {
      if (!link?.url) continue
      const key = link.url.trim().replace(/\/+$/, '').toLocaleLowerCase()
      if (!out.has(key)) out.set(key, { name: link.name, url: link.url })
    }
  }
  return [...out.values()]
}

export interface FavoriteIdentityRecord {
  item_id?: string | null
  bangumi_id?: string | number | null
  links?: readonly { name?: string | null; url?: string | null }[] | null
}

function normalizedFavoriteUrl(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '').toLocaleLowerCase()
}

function bangumiIdFromUrl(value: string | null | undefined): string | null {
  const normalized = normalizedFavoriteUrl(value)
  const match = normalized.match(/(?:bangumi\.tv|bgm\.tv)\/subject\/(\d+)/)
  return match?.[1] ?? null
}

export function bangumiIdFromFavorite(record: FavoriteIdentityRecord): string | null {
  const direct = record.bangumi_id == null ? '' : String(record.bangumi_id).trim()
  if (/^\d+$/.test(direct) && Number(direct) > 0) return direct
  const fromLink = (record.links ?? [])
    .map(link => bangumiIdFromUrl(link?.url))
    .find(Boolean)
  if (fromLink) return fromLink
  const fromItem = String(record.item_id ?? '').match(/^manual-bangumi-(\d+)$/)?.[1]
  return fromItem ?? null
}

export interface FavoriteTitleRecord extends FavoriteIdentityRecord {
  title?: string | null
  title_zh?: string | null
}

export interface ReconciledFavoriteTitles {
  title: string
  titleZh: string | null
  changed: boolean
}

function sameNormalizedTitle(left: string, right: string): boolean {
  return Boolean(left && right) && normalizeTitle(left) === normalizeTitle(right)
}

/**
 * Recover the canonical original/Chinese title for an explicitly identified
 * Bangumi favorite. Weak title matches are intentionally not allowed to write
 * title fields, and reasonable existing values are preserved.
 */
export function reconcileFavoriteTitles(
  record: FavoriteTitleRecord,
  canonical: Pick<BangumiSeasonMatch, 'title' | 'titleZh'> | null | undefined,
): ReconciledFavoriteTitles {
  const currentTitle = typeof record.title === 'string' ? record.title : ''
  const currentTitleZh = typeof record.title_zh === 'string' && record.title_zh.trim() ? record.title_zh : null
  if (!bangumiIdFromFavorite(record) || !canonical?.title) {
    return { title: currentTitle, titleZh: currentTitleZh, changed: false }
  }

  const oldTitle = currentTitle.trim()
  const oldTitleZh = currentTitleZh?.trim() ?? ''
  let title = currentTitle
  let titleZh = currentTitleZh

  // A blank title, a title duplicated from the old Chinese title, or a
  // title-only legacy row that already equals Bangumi's Chinese title can
  // safely be replaced by Bangumi's original title.
  const titleIsCanonicalChinese = Boolean(canonical.titleZh) && !oldTitleZh && sameNormalizedTitle(oldTitle, canonical.titleZh ?? '')
  if (!oldTitle || sameNormalizedTitle(oldTitle, oldTitleZh) || titleIsCanonicalChinese) title = canonical.title
  // Only fill a missing Chinese title, or one that was the duplicated old
  // title. Never overwrite a distinct user-selected Chinese title.
  if (canonical.titleZh && (!oldTitleZh || sameNormalizedTitle(oldTitleZh, oldTitle))) titleZh = canonical.titleZh

  return { title, titleZh, changed: title !== currentTitle || titleZh !== currentTitleZh }
}

function favoriteUrlSet(record: FavoriteIdentityRecord): Set<string> {
  return new Set((record.links ?? []).map(link => normalizedFavoriteUrl(link?.url)).filter(Boolean))
}

/** 比较两个收藏是否指向同一资料；优先 Bangumi ID，再比较规范化后的资料链接。 */
export function favoriteIdentityMatches(left: FavoriteIdentityRecord, right: FavoriteIdentityRecord): boolean {
  if (left.item_id && right.item_id && left.item_id === right.item_id) return true
  const leftBangumiId = bangumiIdFromFavorite(left)
  const rightBangumiId = bangumiIdFromFavorite(right)
  if (leftBangumiId && rightBangumiId) return leftBangumiId === rightBangumiId
  const rightUrls = favoriteUrlSet(right)
  return [...favoriteUrlSet(left)].some(url => rightUrls.has(url))
}

export function isSeasonItemFavorited(
  item: Pick<SeasonItem, 'id' | 'links'>,
  favorites: readonly FavoriteIdentityRecord[],
): boolean {
  const identity: FavoriteIdentityRecord = { item_id: item.id, links: item.links }
  return favorites.some(favorite => favoriteIdentityMatches(identity, favorite))
}

function buildLinks(raw: any): { name: string; url: string }[] {
  const links: { name: string; url: string }[] = []
  if (raw.officialSite) links.push({ name: '官网', url: raw.officialSite })
  for (const s of raw.sites ?? []) {
    const def = SITE_LINKS[String(s.site ?? '').toLowerCase()]
    if (def && s.id) links.push({ name: def.name, url: def.url(String(s.id)) })
  }
  return links
}

// 按原名或中文名反查多平台链接（收藏快照补全用）
export function findByTitleLinks(title: string, titleZh?: string | null): { name: string; url: string }[] | null {
  return findBangumiSeasonEntry({ title, titleZh })?.links ?? null
}

export function getSeasonItems(year: number, quarter: number): SeasonItem[] {
  const items = rawItems(bangumiData)
  const out: SeasonItem[] = []
  for (const raw of items) {
    const begin = new Date(raw.begin)
    if (Number.isNaN(begin.getTime())) continue
    if (begin.getFullYear() !== year || Math.floor(begin.getMonth() / 3) + 1 !== quarter) continue
    out.push({
      id: itemId(begin, raw.title),
      title: raw.title,
      titleZh: raw.titleTranslate?.['zh-Hans']?.[0] ?? null,
      begin: raw.begin,
      day: DAY_KEYS[begin.getDay()],
      time: `${pad(begin.getHours())}:${pad(begin.getMinutes())}`,
      links: buildLinks(raw),
      isNew: true,
    })
  }
  return out
}
