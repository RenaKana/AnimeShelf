// 心愿单媒体库状态检测：
// 1) 先按规范媒体条目的主 ID 精确匹配；
// 2) 再按同一收藏中的关联 ID 查找用户手动设为合集的目录；
// 3) 最后才使用严格标题匹配，并把未知/冲突候选保留为待确认。
import { db } from '../../../server/db/instance'
import { titlesLikelySame } from '../../../server/services/title-match'
import { moduleActive } from '../../../server/core/extensions'
import { resolveFolderMediaDomains } from '../../../server/services/folder-presentation'
import { resolveMediaDomain, type MediaDomain } from '../../../shared/media-domain'

export type FavoriteLibraryStatus = 'present' | 'related' | 'absent' | 'unknown'

export interface LibHit {
  // 保留旧接口语义：只有目标条目本身命中时 matched 才为 true。
  matched: boolean
  method: 'id' | 'name' | 'manual'
  folderName: string | null
  folderId: number | null
}

export interface LibHitSourceIds {
  // 旧调用方仍可传单值；数组值按“主 ID、关联 ID...”顺序解释。
  anilistId?: string | number | null
  bangumiId?: string | number | null
  tmdbId?: string | number | null
  anilistIds?: readonly (string | number | null | undefined)[]
  bangumiIds?: readonly (string | number | null | undefined)[]
  tmdbIds?: readonly (string | number | null | undefined)[]
  /** Unified favorite domain used to reject opposite-domain title matches. */
  mediaDomain?: MediaDomain
}

export interface LibStatusResult {
  status: FavoriteLibraryStatus
  hit: LibHit | null
}

type Source = 'anilist' | 'bangumi' | 'tmdb'

type FolderRow = {
  id: number
  name: string
  path?: string
  source: string | null
  anilist_id: number | null
  parent_id?: number | null
  pinned?: number
  has_video?: number
  media_domain_override?: MediaDomain | null
  media_domain_evidence?: string | null
}

type CanonicalRow = {
  folder_id: number
  folder_name: string
  folder_path?: string
  root_folder_id: number
  root_pinned: number
  media_item_id: number
  item_title: string | null
  item_title_zh: string | null
  source: string | null
  external_id: string | null
  kind: string | null
  conflict_reason: string | null
  confidence?: number | null
  manual_locked?: number
  folder_media_domain_override?: MediaDomain | null
  folder_media_domain_evidence?: string | null
}

type CachedRows = { folders: FolderRow[]; canonical: CanonicalRow[]; folderDomains: Map<number, MediaDomain> }
const folderCache: { rows: CachedRows; at: number } = {
  rows: { folders: [], canonical: [], folderDomains: new Map() },
  at: 0,
}
const CACHE_TTL = 30_000

function safeAll<T>(sql: string): T[] {
  try {
    const statement = db.prepare(sql)
    try { return statement.all() as T[] } finally { statement.finalize() }
  } catch {
    // Keep compatibility with databases created before the canonical catalog
    // migration. The legacy folder matcher remains usable in that case.
    return []
  }
}

function folderRows(forceRefresh = false): CachedRows {
  if (!forceRefresh && Date.now() - folderCache.at < CACHE_TTL && (folderCache.rows.folders.length > 0 || folderCache.rows.canonical.length > 0)) {
    return folderCache.rows
  }

  // Read all folders so a physical child can inherit pinned status from any
  // manually selected collection ancestor. The has_video expression keeps
  // collection roots/metadata folders available without treating every parent
  // directory as a physical media item during matching.
  const folders = safeAll<FolderRow>(`
    WITH RECURSIVE video_dirs(id) AS (
      SELECT DISTINCT file.folder_id
      FROM files file
      JOIN folders folder ON folder.id = file.folder_id
      WHERE file.path_missing = 0 AND folder.path_missing = 0
        AND LOWER(TRIM(file.ext)) IN ('mp4','mkv','avi','m4v','mov','wmv','flv','ts','m2ts','webm','rmvb')
      UNION
      SELECT parent.id
      FROM folders current
      JOIN video_dirs video ON current.id = video.id
      JOIN folders parent ON parent.id = current.parent_id
      WHERE parent.path_missing = 0
    )
    SELECT f.id, f.name, f.path, f.source, f.anilist_id, f.parent_id, f.pinned,
           f.media_domain_override, f.media_domain_evidence,
           CASE WHEN f.id IN (SELECT id FROM video_dirs) THEN 1 ELSE 0 END AS has_video
    FROM folders f
    WHERE f.path_missing = 0
  `)
  const canonical = !moduleActive(db, 'media-catalog') ? [] : safeAll<CanonicalRow>(`
    SELECT DISTINCT
      f.id AS folder_id, f.name AS folder_name, f.path AS folder_path,
      m.root_folder_id, COALESCE(root.pinned, 0) AS root_pinned,
      m.media_item_id, i.title AS item_title, i.title_zh AS item_title_zh,
      s.source, s.external_id, m.kind, m.conflict_reason,
      f.media_domain_override AS folder_media_domain_override,
      f.media_domain_evidence AS folder_media_domain_evidence,
      m.confidence, m.manual_locked
    FROM folder_media_mappings m
    JOIN folders f ON f.id = m.folder_id AND f.path_missing = 0
    JOIN files file ON file.folder_id = f.id AND file.path_missing = 0
      AND LOWER(TRIM(file.ext)) IN ('mp4','mkv','avi','m4v','mov','wmv','flv','ts','m2ts','webm','rmvb')
    JOIN media_items i ON i.id = m.media_item_id
    LEFT JOIN media_item_sources s ON s.media_item_id = m.media_item_id
    JOIN folders root ON root.id = m.root_folder_id AND root.path_missing = 0
  `)
  let folderDomains = new Map<number, MediaDomain>()
  try {
    folderDomains = new Map([...resolveFolderMediaDomains(db, folders.map(row => row.id))].map(([id, resolution]) => [id, resolution.media_domain]))
  } catch {
    // Older or test databases may not expose the presentation schema. The
    // evidence-based resolver below remains a conservative compatibility path.
  }
  folderCache.rows = { folders, canonical, folderDomains }
  folderCache.at = Date.now()
  return folderCache.rows
}

/** Clears the short-lived folder snapshot after a scan or metadata mutation. */
export function invalidateLibHitCache(): void {
  folderCache.rows = { folders: [], canonical: [], folderDomains: new Map() }
  folderCache.at = 0
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function sourceKey(value: unknown): Source | null {
  const source = String(value ?? '').trim().toLocaleLowerCase()
  return source === 'anilist' || source === 'bangumi' || source === 'tmdb' ? source : null
}

function normalizedSourceIds(source: Source, input: LibHitSourceIds, itemId: string): number[] {
  const plural = input[`${source}Ids` as 'anilistIds' | 'bangumiIds' | 'tmdbIds']
  const singular = input[`${source}Id` as 'anilistId' | 'bangumiId' | 'tmdbId']
  const values = Array.isArray(plural) ? plural : singular != null ? [singular] : [manualSourceId(itemId, source)]
  const ids: number[] = []
  for (const value of values) {
    const id = positiveId(value)
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) {
    const manual = manualSourceId(itemId, source)
    if (manual !== null) ids.push(manual)
  }
  return ids
}

function manualSourceId(itemId: string, source: Source): number | null {
  return positiveId(itemId.match(new RegExp(`^manual-${source}-(\\d+)$`))?.[1])
}

type Candidate = {
  folderId: number
  folderName: string
  inCollection: boolean
  source: Source | null
  externalId: string | null
  names: string[]
  unresolved: boolean
  conflicted: boolean
  domain: MediaDomain
}

function rowMediaDomain(row: { media_domain_override?: MediaDomain | null; media_domain_evidence?: unknown; source?: unknown; anilist_id?: unknown; external_id?: unknown }): MediaDomain {
  const hasMetadata = row.source != null || row.anilist_id != null || row.external_id != null
  return resolveMediaDomain({ override: row.media_domain_override, evidence: row.media_domain_evidence, hasMetadata }).media_domain
}

function folderDomain(folderDomains: Map<number, MediaDomain>, folderId: number, fallback: Parameters<typeof rowMediaDomain>[0]): MediaDomain {
  return folderDomains.get(folderId) ?? rowMediaDomain(fallback)
}

function isPinnedAncestor(row: FolderRow, byId: Map<number, FolderRow>): boolean {
  const seen = new Set<number>()
  let current: FolderRow | undefined = row
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.pinned === 1) return true
    current = current.parent_id == null ? undefined : byId.get(current.parent_id)
  }
  return false
}

function legacyCandidates(rows: FolderRow[], folderDomains: Map<number, MediaDomain>): Candidate[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  return rows
    .filter(row => row.has_video === 1 || (row.has_video == null && row.anilist_id != null))
    .map(row => {
      const source = sourceKey(row.source)
      const externalId = positiveId(row.anilist_id)
      return {
        folderId: row.id,
        folderName: row.name,
        inCollection: isPinnedAncestor(row, byId),
        source,
        externalId: externalId === null ? null : String(externalId),
        names: [row.name],
        // A name-only physical folder cannot prove an identity and therefore
        // remains a pending candidate instead of becoming an automatic hit.
        unresolved: source === null || externalId === null,
        conflicted: false,
        domain: folderDomain(folderDomains, row.id, row),
      }
    })
}

function canonicalCandidates(rows: CanonicalRow[], folderDomains: Map<number, MediaDomain>): Candidate[] {
  const byFolder = new Map<number, Candidate>()
  for (const row of rows) {
    const current = byFolder.get(row.folder_id)
    const source = sourceKey(row.source)
    const externalId = positiveId(row.external_id)
    const names = [row.item_title_zh, row.item_title, row.folder_name].filter((value): value is string => Boolean(value?.trim()))
    const unresolved = row.kind === 'unknown' || Boolean(row.conflict_reason) || source === null || externalId === null
    if (!current) {
      byFolder.set(row.folder_id, {
        folderId: row.folder_id,
        folderName: row.folder_name,
        inCollection: row.root_pinned === 1,
        source,
        externalId: externalId === null ? null : String(externalId),
        names: [...new Set(names)],
        unresolved,
        conflicted: Boolean(row.conflict_reason),
        domain: folderDomain(folderDomains, row.folder_id, {
          media_domain_override: row.folder_media_domain_override,
          media_domain_evidence: row.folder_media_domain_evidence,
          source: row.source,
          external_id: row.external_id,
        }),
      })
      continue
    }
    current.inCollection ||= row.root_pinned === 1
    current.names = [...new Set([...current.names, ...names])]
    if (current.domain !== folderDomain(folderDomains, row.folder_id, {
      media_domain_override: row.folder_media_domain_override,
      media_domain_evidence: row.folder_media_domain_evidence,
      source: row.source,
      external_id: row.external_id,
    })) current.domain = 'unknown'
    // A canonical item may contain several source IDs. Keep the first source
    // for the legacy-shaped candidate while ID matching below scans raw rows.
    current.unresolved &&= unresolved
    current.conflicted ||= Boolean(row.conflict_reason)
  }
  return [...byFolder.values()]
}

function hit(folder: Pick<Candidate, 'folderId' | 'folderName'>, matched: boolean, method: 'id' | 'name'): LibHit {
  return { matched, method, folderName: folder.folderName || null, folderId: folder.folderId }
}

function rawRowsForMatch(rows: CachedRows): Candidate[] {
  const byFolder = new Map<number, Candidate>()
  for (const candidate of [...legacyCandidates(rows.folders, rows.folderDomains), ...canonicalCandidates(rows.canonical, rows.folderDomains)]) {
    const current = byFolder.get(candidate.folderId)
    if (!current) {
      byFolder.set(candidate.folderId, candidate)
      continue
    }
    current.inCollection ||= candidate.inCollection
    current.unresolved &&= candidate.unresolved
    current.conflicted ||= candidate.conflicted
    current.names = [...new Set([...current.names, ...candidate.names])]
    if (current.domain !== candidate.domain) current.domain = 'unknown'
  }
  return [...byFolder.values()]
}

function sourceIdMatches(row: Candidate, source: Source, id: number): boolean {
  return row.source === source && row.externalId === String(id)
}

function canonicalIdMatch(rows: CanonicalRow[], source: Source, id: number, folderDomains: Map<number, MediaDomain>): Candidate | null {
  const match = rows.find(row => sourceKey(row.source) === source && positiveId(row.external_id) === id)
  if (!match) return null
  return {
    folderId: match.folder_id,
    folderName: match.folder_name,
    inCollection: match.root_pinned === 1,
    source,
    externalId: String(id),
    names: [match.item_title_zh, match.item_title, match.folder_name].filter((value): value is string => Boolean(value?.trim())),
    unresolved: match.kind === 'unknown',
    conflicted: Boolean(match.conflict_reason),
    domain: folderDomain(folderDomains, match.folder_id, {
      media_domain_override: match.folder_media_domain_override,
      media_domain_evidence: match.folder_media_domain_evidence,
      source: match.source,
      external_id: match.external_id,
    }),
  }
}

function findIdMatch(rows: CachedRows, source: Source, id: number): Candidate | null {
  const canonical = canonicalIdMatch(rows.canonical, source, id, rows.folderDomains)
  if (canonical) return canonical
  return rawRowsForMatch(rows).find(row => sourceIdMatches(row, source, id)) ?? null
}

function exactTitleMatch(rows: Candidate[], title: string, titleZh: string | null): Candidate[] {
  const names = [titleZh, title].filter((value): value is string => Boolean(value?.trim()))
  if (names.length === 0) return []
  return rows.filter(row => row.names.some(candidateName => names.some(name => titlesLikelySame(name, candidateName))))
}

function candidateDomainCompatible(target: MediaDomain | undefined, candidate: Candidate): boolean {
  if (!target || target === 'unknown' || candidate.domain === 'unknown') return true
  return target === candidate.domain
}

/**
 * Computes the four-state status. `sourceIds` arrays must put the primary
 * identity first; all remaining ids are treated as related identities.
 */
export function detectLibStatus(
  itemId: string,
  title: string,
  titleZh: string | null,
  sourceIds: LibHitSourceIds = {},
  forceRefresh = false,
): LibStatusResult {
  const rows = folderRows(forceRefresh)
  const candidates = rawRowsForMatch(rows)
  const bySource: Array<[Source, number[]]> = [
    ['bangumi', normalizedSourceIds('bangumi', sourceIds, itemId)],
    ['anilist', normalizedSourceIds('anilist', sourceIds, itemId)],
    ['tmdb', normalizedSourceIds('tmdb', sourceIds, itemId)],
  ]

  // Main identities always win, including when a related id points into a
  // collection. This prevents JOJO-like fallback IDs from becoming present.
  for (const [source, ids] of bySource) {
    const primaryId = ids[0]
    if (primaryId == null) continue
    const match = findIdMatch(rows, source, primaryId)
    if (match) return { status: 'present', hit: hit(match, true, 'id') }
  }

  for (const [source, ids] of bySource) {
    for (const relatedId of ids.slice(1)) {
      const match = findIdMatch(rows, source, relatedId)
      if (match?.inCollection) return { status: 'related', hit: hit(match, false, 'id') }
    }
  }

  const named = exactTitleMatch(candidates, title, titleZh).filter(candidate => candidateDomainCompatible(sourceIds.mediaDomain, candidate))
  const distinctNamed = [...new Map(named.map(row => [row.folderId, row])).values()]
  if (distinctNamed.length === 1) {
    const match = distinctNamed[0]
    if (match.unresolved || match.conflicted) return { status: 'unknown', hit: hit(match, false, 'name') }
    return { status: 'present', hit: hit(match, true, 'name') }
  }
  if (distinctNamed.length > 1) {
    return { status: 'unknown', hit: null }
  }

  const hasPrimaryId = bySource.some(([, ids]) => ids.length > 0)
  return { status: hasPrimaryId ? 'absent' : 'unknown', hit: null }
}

/** Backward-compatible matcher used by existing callers. */
export function detectLibHit(
  itemId: string,
  title: string,
  titleZh: string | null,
  sourceIds: LibHitSourceIds = {},
  forceRefresh = false,
): LibHit | null {
  return detectLibStatus(itemId, title, titleZh, sourceIds, forceRefresh).hit
}
