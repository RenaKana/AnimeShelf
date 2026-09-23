import { win32 as path } from 'path'
import type { Database } from 'node-sqlite3-wasm'
import {
  clearCatalogDirty,
  listDirtyCatalogLibraries,
  maintainCatalogIntegrity,
} from '../../../server/core/catalog-integrity'
import { VIDEO_EXTS } from '../../../server/services/everything'
import { appendNewCollectionMembers, collectionMemberKeys, explicitlyRemoveCollectionMembers, rekeyCollectionMember } from '../../../server/core/collection-organization'
import { collectionMemberKey } from '../../../shared/collection-organization'
import { resolveFolderMediaDomain, resolveFolderMediaDomains } from '../../../server/services/folder-presentation'
import type { MediaDomainResolution } from '../../../shared/media-domain'

export type MediaCatalogKind = 'season' | 'movie' | 'ova' | 'special' | 'extras' | 'custom' | 'unknown'

export interface IdentifyMediaFolderInput {
  name: string
  ancestorNames?: string[]
  fileNames?: string[]
}

export interface IdentifiedMediaFolder {
  kind: MediaCatalogKind
  seasonNumbers: number[]
  partNumber: number | null
  confidence: number
  detectedBy: string
  conflictReason: string | null
  directorySeasonNumbers: number[]
  fileSeasonNumbers: number[]
}

export interface MediaCatalogRebuildResult {
  rootCount: number
  foldersProcessed: number
  inserted: number
  removedAutomatic: number
  preservedManual: number
  seasonEntries: number
  unknownEntries: number
  conflicts: number
  canonicalItems?: number
  canonicalMappings?: number
  canonicalUnknownItems?: number
  canonicalConflicts?: number
}

// V9 separates automatically grouped animation/live adaptations by resolved
// item evidence. Manual mappings and relationships survive the rebuild.
export const MEDIA_CATALOG_RULE_VERSION = '9'
const MEDIA_CATALOG_RULE_VERSION_KEY = 'media_catalog_rule_version'

export interface MediaCatalogEntryView extends Partial<MediaDomainResolution> {
  id: number
  folder_id: number
  series_id: number
  kind: MediaCatalogKind
  season_number: number | null
  part_number: number | null
  custom_label: string | null
  folder_name: string
  folder_path: string
  series_title: string
  series_key: string
  manual_locked: number
  confidence: number
  conflict_reason: string | null
  detected_by: string
  source: string | null
  external_id: string | null
}

export interface MediaCatalogSummary extends Partial<MediaDomainResolution> {
  root_folder_id: number
  series_id: number
  series_key: string
  series_title: string
  entry_count: number
  season_numbers: number[]
  manual_count: number
  conflict_count: number
  unknown_count: number
}

export interface MediaCatalogSnapshot {
  entries: MediaCatalogEntryView[]
  summary: MediaCatalogSummary | null
  canonical?: CanonicalMediaCatalogSnapshot
  candidates: MediaCatalogCandidateView[]
}

export type MediaCatalogCandidateReason = 'excluded' | 'extras' | 'insufficient_evidence'

export interface MediaCatalogCandidateView extends Partial<MediaDomainResolution> {
  folder_id: number
  folder_name: string
  folder_path: string
  suggested_kind: MediaCatalogKind
  suggested_season_numbers: number[]
  suggested_part_number: number | null
  suggested_custom_label: string | null
  confidence: number
  reason: MediaCatalogCandidateReason
  source: string | null
  external_id: string | null
}

interface MediaCatalogExclusionRow {
  folder_id: number
  manual_kind: MediaCatalogKind | null
  manual_season_numbers: string | null
  manual_part_number: number | null
  manual_custom_label: string | null
}

export interface MediaItemSourceInput {
  source: string
  externalId: string
  isPrimary?: boolean
}

export interface MediaItemSourceView {
  source: string
  external_id: string
  is_primary: number
}

export interface MediaCatalogItemView extends Partial<MediaDomainResolution> {
  id: number
  library_id: number
  root_folder_id: number
  item_key: string
  title: string
  title_zh: string | null
  kind: MediaCatalogKind
  season_number: number | null
  part_number: number | null
  custom_label: string | null
  manual_locked: number
  confidence: number
  conflict_reason: string | null
  source_ids: MediaItemSourceView[]
}

export interface MediaCatalogMappingView extends Partial<MediaDomainResolution> {
  id: number
  folder_id: number
  media_item_id: number
  root_folder_id: number
  series_id: number | null
  content_role: string
  kind: MediaCatalogKind
  season_number: number | null
  part_number: number | null
  custom_label: string | null
  folder_name: string
  folder_path: string
  manual_locked: number
  confidence: number
  conflict_reason: string | null
  detected_by: string
}

export interface CanonicalMediaCatalogSummary {
  root_folder_id: number
  item_count: number
  mapping_count: number
  season_numbers: number[]
  manual_count: number
  conflict_count: number
  unknown_count: number
}

export interface CanonicalMediaWorkGroupSummary {
  item_count: number
  physical_folder_count: number
  season_numbers: number[]
  manual_count: number
  conflict_count: number
  unknown_count: number
}

export interface CanonicalMediaWorkGroupMemberView {
  id: number
  media_item_id: number
  relation_role: string
  manual_locked: number
}

export interface CanonicalMediaWorkGroupView extends Partial<MediaDomainResolution> {
  id: number
  key: string
  group_key: string
  title: string
  anchor: number | null
  anchor_folder_id: number | null
  manual_locked: number
  item_ids: number[]
  members: CanonicalMediaWorkGroupMemberView[]
  summary: CanonicalMediaWorkGroupSummary
}

export interface CanonicalMediaCatalogSnapshot {
  root_folder_id: number
  items: MediaCatalogItemView[]
  mappings: MediaCatalogMappingView[]
  summary: CanonicalMediaCatalogSummary
  work_groups: CanonicalMediaWorkGroupView[]
  /** Items deliberately left outside every automatic work group for this root. */
  ungrouped_item_ids: number[]
}

export interface SetManualMediaCatalogInput {
  kind?: MediaCatalogKind
  seasonNumbers?: number[] | null
  partNumber?: number | null
  customLabel?: string | null
  clearManual?: boolean
  excluded?: boolean
}

export interface EnsureCanonicalMediaItemInput {
  libraryId: number
  rootFolderId: number
  itemKey: string
  title: string
  titleZh?: string | null
  kind: MediaCatalogKind
  customLabel?: string | null
  seasonNumber?: number | null
  partNumber?: number | null
  confidence?: number
  conflictReason?: string | null
  sourceIds?: MediaItemSourceInput[]
}

export interface CanonicalMediaCatalogRebuildResult {
  rootCount: number
  foldersProcessed: number
  itemCount: number
  mappingCount: number
  unknownCount: number
  conflictCount: number
}

export class MediaCatalogValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'INVALID_MEDIA_CATALOG',
  ) {
    super(message)
    this.name = 'MediaCatalogValidationError'
  }
}

const MEDIA_CATALOG_KINDS: MediaCatalogKind[] = ['season', 'movie', 'ova', 'special', 'extras', 'custom', 'unknown']
const CUSTOM_LABEL_MAX_LENGTH = 32

interface FolderRow {
  id: number
  library_id: number
  parent_id: number | null
  name: string
  path: string
  is_series: number
  anilist_id: number | null
  source: string | null
  tmdb_media_type: 'movie' | 'tv' | null
  pinned: number
}

interface FileRow {
  folder_id: number
  name: string
  path: string
  ext: string | null
}

type SqlParam = string | number | null

interface MarkerResult {
  kind: MediaCatalogKind | null
  source: 'directory' | 'ancestor' | null
}

const asNumberArray = (values: Iterable<number>): number[] => [...new Set(values)].filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b)

function normalizeFolderName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function isTokenBoundary(value: string): string {
  return `(^|[\\s._()[\\]{}【】（）《》<>-])${value}(?=$|[\\s._()[\\]{}【】（）《》<>-])`
}

function classifyFolderMarker(rawName: string): MarkerResult {
  const name = normalizeFolderName(rawName)
  if (!name) return { kind: null, source: null }

  // Extras markers are authoritative only when this directory is itself an
  // extras container. Long release names often advertise bundled material
  // (for example "+ 特典" or "+ NCOP&NCED") while still containing the main
  // episodes, so a marker embedded in such a name must not override them.
  const extrasContainer =
    /^(?:extras?|bonus|pv|cm|previews?|samples?|menus?|cds?|scans?|fonts?|trailers?|bd[\s._-]*menus?)(?:[\s._-]*(?:vol(?:ume)?|disc)?\s*\d+(?:\s*[-~]\s*\d+)?)?$/i.test(name) ||
    /^(?:特典(?:映像|影像|视频)?|ncop|nced|ncop\s*[&+/_-]\s*nced|clean[ _-]*(?:opening|ending)|(?:opening|ending)[ _-]*clean)(?:[\s._-]*\d+)?$/i.test(name)

  // SPs are conventionally a bag of supplementary videos in anime folders.
  // A singular SP is kept as a special so it remains distinguishable from a
  // generic extras directory.
  if (new RegExp(isTokenBoundary('sps'), 'i').test(name)) {
    return { kind: 'extras', source: 'directory' }
  }
  if (new RegExp(isTokenBoundary('sp'), 'i').test(name)) {
    return { kind: 'special', source: 'directory' }
  }
  if (extrasContainer) {
    return { kind: 'extras', source: 'directory' }
  }
  if (new RegExp(isTokenBoundary('(?:ova|oad)'), 'i').test(name) || /(?:^|[s._()[]{}-])(?:ova|oad)(?=$|[s._()[]{}-])/i.test(name)) {
    return { kind: 'ova', source: 'directory' }
  }
  if (/剧场版|映画|theatrical/i.test(name) || new RegExp(isTokenBoundary('movies?|films?'), 'i').test(name)) {
    return { kind: 'movie', source: 'directory' }
  }
  if (/特别篇|特別編/i.test(name) || new RegExp(isTokenBoundary('specials?'), 'i').test(name)) {
    return { kind: 'special', source: 'directory' }
  }
  return { kind: null, source: null }
}

function parseDirectorySeasons(rawName: string): { numbers: number[]; hasSeasonMarker: boolean } {
  const name = rawName.normalize('NFKC')
  const rangeNumbers: number[] = []
  const rangePatterns = [
    /\bS(?:eason)?\s*0?(\d{1,2})\s*[-~–—]\s*S?\s*0?(\d{1,2})\b/gi,
    /\b(?:Season\s*)?0?(\d{1,2})\s*(?:to|至)\s*(?:Season\s*)?0?(\d{1,2})\b/gi,
    /第\s*0?(\d{1,2})\s*(?:季|期)\s*[-~～至]\s*第?\s*0?(\d{1,2})\s*(?:季|期)?/gi,
  ]
  for (const pattern of rangePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(name))) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) continue
      const step = start <= end ? 1 : -1
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) rangeNumbers.push(n)
    }
  }
  if (rangeNumbers.length > 0) return { numbers: asNumberArray(rangeNumbers), hasSeasonMarker: true }

  const numbers: number[] = []
  let hasSeasonMarker = false
  const chineseNumber = (value: string): number | null => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    if (/^[零〇一二两三四五六七八九]$/.test(value)) return digits[value]
    if (!/^[零〇一二两三四五六七八九十百]+$/.test(value)) return null
    if (value === '十') return 10
    const ten = value.indexOf('十')
    if (ten >= 0) {
      const tens = ten === 0 ? 1 : digits[value[ten - 1]]
      const ones = ten === value.length - 1 ? 0 : digits[value[ten + 1]]
      return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : null
    }
    return null
  }
  const chinesePattern = /第\s*([零〇一二两三四五六七八九十百]+)\s*(?:季|期)/gi
  let chineseMatch: RegExpExecArray | null
  while ((chineseMatch = chinesePattern.exec(name))) {
    hasSeasonMarker = true
    const season = chineseNumber(chineseMatch[1])
    if (season !== null && season > 0) numbers.push(season)
  }
  const patterns: RegExp[] = [
    /\bS(?:eason)?[\s._-]*0?(\d{1,2})\b/gi,
    /\b(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+season\b/gi,
    /第\s*0?(\d{1,2})\s*(?:季|期)/gi,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(name))) {
      hasSeasonMarker = true
      if (match[1]) {
        const n = Number(match[1])
        if (Number.isInteger(n) && n > 0) numbers.push(n)
        continue
      }
      const ordinal = match[0].toLowerCase().split(/\s+/)[0]
      const ordinalNumbers: Record<string, number> = {
        first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
        '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
      }
      if (ordinalNumbers[ordinal]) numbers.push(ordinalNumbers[ordinal])
    }
  }
  return { numbers: asNumberArray(numbers), hasSeasonMarker }
}

function parsePartNumber(rawName: string): number | null {
  const name = rawName.normalize('NFKC')
  const match = name.match(/(?:^|[\s._()[\]{}【】（）《》<>-])part[\s._-]*0?(\d{1,2})(?=$|[\s._()[\]{}【】（）《》<>-])/i)
  if (!match) return null
  const part = Number(match[1])
  return Number.isInteger(part) && part > 0 ? part : null
}

function parseFileSeasons(fileNames: string[]): number[] {
  const numbers: number[] = []
  for (const fileName of fileNames) {
    const value = String(fileName).normalize('NFKC')
    const pattern = /\bS\s*0?(\d{1,2})\s*E\s*0?\d+\b/gi
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      const season = Number(match[1])
      if (Number.isInteger(season) && season > 0) numbers.push(season)
    }
  }
  return asNumberArray(numbers)
}

function formatSeasonList(numbers: number[]): string {
  return numbers.length === 1 ? `season ${numbers[0]}` : `seasons ${numbers.join(', ')}`
}

/**
 * Classifies one physical folder using only local evidence. The function is
 * deliberately conservative: a bare number or an unlabelled Part does not
 * become a guessed season, and is persisted as unknown by the rebuild step.
 */
export function identifyMediaFolder(input: IdentifyMediaFolderInput | string): IdentifiedMediaFolder {
  const value: IdentifyMediaFolderInput = typeof input === 'string' ? { name: input } : input
  const name = String(value.name ?? '')
  const ancestors = value.ancestorNames ?? []
  const fileNames = value.fileNames ?? []
  const directorySeasons = parseDirectorySeasons(name)
  const fileSeasons = parseFileSeasons(fileNames)
  const partNumber = parsePartNumber(name)

  const directMarker = classifyFolderMarker(name).kind
  const normalizedName = normalizeFolderName(name)
  const mixedTvAndSpecial = directMarker === 'special' && (
    /(?:^|[\s._()[\]{}【】（）《》<>-])tv\s*(?:[+&/]|and|with)\s*(?:sp|specials?)(?=$|[\s._()[\]{}【】（）《》<>-])/i.test(normalizedName) ||
    /(?:^|[\s._()[\]{}【】（）《》<>-])(?:sp|specials?)\s*(?:[+&/]|and|with)\s*tv(?=$|[\s._()[\]{}【】（）《》<>-])/i.test(normalizedName)
  )
  // A mixed whole-release label describes included formats, not the format of
  // every video in the folder. Let explicit season/file evidence classify the
  // main release; without such evidence it stays conservative unknown.
  const directKind = mixedTvAndSpecial ? null : directMarker
  // Ancestor markers are intentionally conservative. A generic movie/OVA/SP
  // name higher in the tree may be a series title or a library grouping, so it
  // must not reclassify a child folder. Only an immediate, explicit extras
  // container (for example `Show/SPs/Vol.1`) is inherited.
  const nearestAncestor = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null
  const nearestAncestorMarker = nearestAncestor ? classifyFolderMarker(nearestAncestor) : null
  const inheritedKind: MediaCatalogKind | null = nearestAncestorMarker?.kind === 'extras' ? 'extras' : null
  let kind: MediaCatalogKind
  let seasonNumbers: number[]
  // A marker on the folder itself is the strongest classification. When the
  // folder has no direct media marker, an explicit season number outranks the
  // inherited extras context; file-name seasons are the final fallback.
  if (directKind) {
    kind = directKind
    seasonNumbers = []
  } else if (directorySeasons.numbers.length > 0) {
    kind = 'season'
    seasonNumbers = directorySeasons.numbers
  } else if (inheritedKind) {
    kind = inheritedKind
    seasonNumbers = []
  } else if (fileSeasons.length > 0) {
    kind = 'season'
    seasonNumbers = fileSeasons
  } else {
    kind = 'unknown'
    seasonNumbers = []
  }

  const conflict = directorySeasons.numbers.length > 0 && fileSeasons.length > 0 &&
    directorySeasons.numbers.length !== fileSeasons.length ||
    (directorySeasons.numbers.length > 0 && fileSeasons.length > 0 &&
      directorySeasons.numbers.some((number, index) => number !== fileSeasons[index]))
  const conflictReason = conflict
    ? `directory ${formatSeasonList(directorySeasons.numbers)} conflicts with file ${formatSeasonList(fileSeasons)}`
    : null

  const evidence: string[] = []
  if (inheritedKind) evidence.push('ancestor')
  if (directKind || directorySeasons.hasSeasonMarker) evidence.push('directory')
  if (fileSeasons.length > 0) evidence.push('file')
  if (partNumber !== null) evidence.push('part')
  if (evidence.length === 0) evidence.push('unknown')

  let confidence = kind === 'unknown' ? 0.25 : (inheritedKind || directKind ? 0.95 : fileSeasons.length > 0 ? 0.88 : 0.95)
  if (directorySeasons.numbers.length > 0 && fileSeasons.length > 0 && !conflict) confidence = 0.99
  if (conflict) confidence = 0.55
  if (kind === 'unknown' && partNumber !== null) confidence = 0.35

  return {
    kind,
    seasonNumbers,
    partNumber,
    confidence,
    detectedBy: [...new Set(evidence)].join('+'),
    conflictReason,
    directorySeasonNumbers: directorySeasons.numbers,
    fileSeasonNumbers: fileSeasons,
  }
}

function queryAll<T>(db: Database, sql: string, params: SqlParam[] = []): T[] {
  const statement = db.prepare(sql)
  try { return statement.all(params) as T[] } finally { statement.finalize() }
}

function queryOne<T>(db: Database, sql: string, params: SqlParam[] = []): T | undefined {
  const statement = db.prepare(sql)
  try { return statement.get(params) as T | undefined } finally { statement.finalize() }
}

function run(db: Database, sql: string, params: SqlParam[] = []): { lastInsertRowid?: number; changes?: number } {
  const statement = db.prepare(sql)
  try {
    const result = statement.run(params) as { lastInsertRowid?: number | bigint; changes?: number }
    return {
      lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
      changes: result.changes,
    }
  } finally { statement.finalize() }
}

function ancestorNames(folder: FolderRow, foldersById: Map<number, FolderRow>): string[] {
  const names: string[] = []
  const seen = new Set<number>()
  let parentId = folder.parent_id
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = foldersById.get(parentId)
    if (!parent) break
    names.push(parent.name)
    parentId = parent.parent_id
  }
  return names.reverse()
}

function isVideoFile(file: FileRow): boolean {
  const ext = String(file.ext ?? path.extname(file.name || file.path).slice(1)).replace(/^\./, '').toLowerCase()
  return VIDEO_EXTS.includes(ext)
}

interface CanonicalItemRow {
  id: number
  library_id: number
  root_folder_id: number
  item_key: string
  title: string
  title_zh: string | null
  kind: MediaCatalogKind
  season_number: number | null
  part_number: number | null
  custom_label: string | null
  manual_locked: number
  confidence: number
  conflict_reason: string | null
}

interface CanonicalMappingRow {
  id: number
  folder_id: number
  media_item_id: number
  root_folder_id: number
  series_id: number | null
  content_role: string
  kind: MediaCatalogKind
  season_number: number | null
  part_number: number | null
  custom_label: string | null
  folder_name: string
  folder_path: string
  manual_locked: number
  confidence: number
  conflict_reason: string | null
  detected_by: string
}

interface MediaWorkGroupRow {
  id: number
  library_id: number
  root_folder_id: number
  anchor_folder_id: number | null
  group_key: string
  title: string
  manual_locked: number
}

interface MediaWorkGroupMemberRow {
  id: number
  work_group_id: number
  media_item_id: number
  relation_role: string
  manual_locked: number
}

function normalizeSourceIdentity(source: string, externalId: string): MediaItemSourceInput | null {
  const normalizedSource = String(source ?? '').trim().toLowerCase()
  const normalizedId = String(externalId ?? '').trim()
  if (!normalizedSource || !normalizedId) return null
  return { source: normalizedSource, externalId: normalizedId }
}

function normalizeCustomLabel(value: unknown, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new MediaCatalogValidationError('customLabel 必须填写', 400, 'INVALID_CUSTOM_LABEL')
    return null
  }
  if (typeof value !== 'string') {
    throw new MediaCatalogValidationError('customLabel 必须是字符串', 400, 'INVALID_CUSTOM_LABEL')
  }
  const normalized = value.trim()
  const length = Array.from(normalized).length
  if (length < 1 || length > CUSTOM_LABEL_MAX_LENGTH) {
    throw new MediaCatalogValidationError(
      `customLabel 必须是 1 到 ${CUSTOM_LABEL_MAX_LENGTH} 个字符`,
      400,
      'INVALID_CUSTOM_LABEL',
    )
  }
  return normalized
}

function projectedMediaCatalogKind(kind: MediaCatalogKind, customLabel: string | null | undefined): MediaCatalogKind {
  return customLabel && customLabel.trim().length > 0 ? 'custom' : kind
}

function customCanonicalItemKey(baseKey: string, customLabel: string): string {
  return `custom:${encodeURIComponent(customLabel)}:${baseKey}`
}

function collectionPresentationItemKey(itemKey: string): string {
  return `item:${itemKey.replace(/^custom:[^:]+:/, '')}`
}

function copyCollectionPresentationAlias(
  db: Database,
  rootFolderId: number,
  previousItemKey: string,
  nextItemKey: string,
): void {
  const previousEntryKey = collectionPresentationItemKey(previousItemKey)
  const nextEntryKey = collectionPresentationItemKey(nextItemKey)
  if (previousEntryKey === nextEntryKey) return
  run(db, `
    INSERT INTO media_collection_presentation
      (root_folder_id, entry_key, display_title, position)
    SELECT root_folder_id, ?, display_title, position
    FROM media_collection_presentation
    WHERE root_folder_id = ? AND entry_key = ?
    ON CONFLICT(root_folder_id, entry_key) DO NOTHING
  `, [nextEntryKey, rootFolderId, previousEntryKey])
}

function canonicalItemById(db: Database, itemId: number): CanonicalItemRow | undefined {
  return queryOne<CanonicalItemRow>(db, `
    SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind,
           season_number, part_number, NULL AS custom_label,
           manual_locked, confidence, conflict_reason
    FROM media_items WHERE id = ?
  `, [itemId])
}

function canonicalItemByKey(db: Database, libraryId: number, itemKey: string): CanonicalItemRow | undefined {
  return queryOne<CanonicalItemRow>(db, `
    SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind,
           season_number, part_number, NULL AS custom_label,
           manual_locked, confidence, conflict_reason
    FROM media_items WHERE library_id = ? AND item_key = ?
  `, [libraryId, itemKey])
}

function canonicalItemsBySource(
  db: Database,
  libraryId: number,
  source: string,
  externalId: string,
): CanonicalItemRow[] {
  return queryAll<CanonicalItemRow>(db, `
    SELECT DISTINCT m.id, m.library_id, m.root_folder_id, m.item_key, m.title,
           m.title_zh, m.kind, m.season_number, m.part_number, NULL AS custom_label, m.manual_locked,
           m.confidence, m.conflict_reason
    FROM media_items m
    JOIN media_item_sources s ON s.media_item_id = m.id
    WHERE m.library_id = ? AND s.source = ? AND s.external_id = ?
      AND m.item_key NOT LIKE 'custom:%'
      AND NOT EXISTS (
        SELECT 1
        FROM folder_media_mappings custom_mapping
        WHERE custom_mapping.media_item_id = m.id
          AND custom_mapping.custom_label IS NOT NULL
          AND length(trim(custom_mapping.custom_label)) > 0
      )
    ORDER BY m.id
  `, [libraryId, source, externalId])
}

function canonicalItemIdsWithManualState(db: Database, libraryId: number): Set<number> {
  return new Set(queryAll<{ id: number }>(db, `
    SELECT DISTINCT item.id
    FROM media_items item
    WHERE item.library_id = ?
      AND (
        item.manual_locked = 1
        OR EXISTS (
          SELECT 1 FROM folder_media_mappings mapping
          WHERE mapping.media_item_id = item.id AND mapping.manual_locked = 1
        )
        OR EXISTS (
          SELECT 1
          FROM media_work_group_members member
          JOIN media_work_groups work_group ON work_group.id = member.work_group_id
          WHERE member.media_item_id = item.id
            AND (member.manual_locked = 1 OR work_group.manual_locked = 1)
        )
        OR EXISTS (
          SELECT 1 FROM media_work_group_exclusions exclusion
          WHERE exclusion.media_item_id = item.id
        )
      )
  `, [libraryId]).map(row => row.id))
}

function hasLocallyScopedCanonicalIdentity(item: CanonicalItemRow): boolean {
  return /#(?:folder:\d+|content:)/.test(item.item_key)
}

function canonicalCloneItemKey(
  db: Database,
  libraryId: number,
  itemKey: string,
  rootFolderId: number,
): string {
  const base = `${itemKey}#clone:${rootFolderId}`
  let candidate = base
  let suffix = 2
  while (canonicalItemByKey(db, libraryId, candidate)) {
    candidate = `${base}:${suffix}`
    suffix++
  }
  return candidate
}

function mergeCanonicalMediaItems(db: Database, targetId: number, duplicateId: number): void {
  if (targetId === duplicateId) return
  const target = canonicalItemById(db, targetId)
  const duplicate = canonicalItemById(db, duplicateId)
  if (!target || !duplicate) return

  const sources = queryAll<{ source: string; external_id: string; is_primary: number }>(db, `
    SELECT source, external_id, is_primary
    FROM media_item_sources WHERE media_item_id = ?
  `, [duplicateId])
  for (const source of sources) {
    run(db, `
      INSERT OR IGNORE INTO media_item_sources
        (media_item_id, source, external_id, is_primary, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `, [targetId, source.source, source.external_id, source.is_primary])
  }

  const mappings = queryAll<{ id: number; folder_id: number; root_folder_id: number; series_id: number | null; content_role: string; season_number: number | null; part_number: number | null; manual_locked: number }>(db, `
    SELECT id, folder_id, root_folder_id, series_id, content_role,
           season_number, part_number, manual_locked
    FROM folder_media_mappings WHERE media_item_id = ?
  `, [duplicateId])
  for (const mapping of mappings) {
    const existing = queryOne<{ id: number; manual_locked: number }>(db, `
      SELECT id, manual_locked FROM folder_media_mappings
      WHERE folder_id = ? AND media_item_id = ? AND root_folder_id = ?
        AND content_role = ?
        AND ((season_number = ?) OR (season_number IS NULL AND ? IS NULL))
        AND ((part_number = ?) OR (part_number IS NULL AND ? IS NULL))
    `, [mapping.folder_id, targetId, mapping.root_folder_id, mapping.content_role,
      mapping.season_number, mapping.season_number, mapping.part_number, mapping.part_number])
    if (existing) {
      if (mapping.manual_locked === 1 && existing.manual_locked !== 1) {
        run(db, `
          UPDATE folder_media_mappings
          SET manual_locked = 1, detected_by = 'manual', updated_at = datetime('now')
          WHERE id = ?
        `, [existing.id])
      }
      run(db, 'DELETE FROM folder_media_mappings WHERE id = ?', [mapping.id])
    } else {
      run(db, 'UPDATE folder_media_mappings SET media_item_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [targetId, mapping.id])
    }
  }

  if (duplicate.manual_locked === 1 && target.manual_locked !== 1) {
    run(db, "UPDATE media_items SET manual_locked = 1, updated_at = datetime('now') WHERE id = ?", [targetId])
  }
  run(db, 'DELETE FROM media_items WHERE id = ?', [duplicateId])
}

function attachCanonicalMediaItemSource(
  db: Database,
  mediaItemId: number,
  input: MediaItemSourceInput,
): MediaItemSourceView {
  const identity = normalizeSourceIdentity(input.source, input.externalId)
  if (!identity) throw new MediaCatalogValidationError('来源和外部编号不能为空', 400, 'INVALID_MEDIA_ITEM_SOURCE')
  const existingPrimary = queryOne<{ is_primary: number }>(db, `
    SELECT is_primary FROM media_item_sources
    WHERE media_item_id = ? ORDER BY is_primary DESC, id LIMIT 1
  `, [mediaItemId])
  const isPrimary = input.isPrimary === true || !existingPrimary
  run(db, `
    INSERT INTO media_item_sources
      (media_item_id, source, external_id, is_primary, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_item_id, source, external_id) DO UPDATE SET
      is_primary = CASE WHEN excluded.is_primary = 1 THEN 1 ELSE media_item_sources.is_primary END,
      updated_at = datetime('now')
  `, [mediaItemId, identity.source, identity.externalId, isPrimary ? 1 : 0])
  return queryOne<MediaItemSourceView>(db, `
    SELECT source, external_id, is_primary
    FROM media_item_sources WHERE media_item_id = ? AND source = ? AND external_id = ?
  `, [mediaItemId, identity.source, identity.externalId])!
}

/**
 * Adds a source identity to a canonical item. Ordinary canonical items with a
 * shared source are merged, while collection items carrying an explicit local
 * content discriminator keep that source as a non-unique metadata link.
 */
export function addMediaItemSource(
  db: Database,
  mediaItemId: number,
  input: MediaItemSourceInput,
): MediaItemSourceView {
  const item = canonicalItemById(db, mediaItemId)
  if (!item) throw new MediaCatalogValidationError('规范媒体条目不存在', 404, 'MEDIA_ITEM_NOT_FOUND')
  const identity = normalizeSourceIdentity(input.source, input.externalId)
  if (!identity) throw new MediaCatalogValidationError('来源和外部编号不能为空', 400, 'INVALID_MEDIA_ITEM_SOURCE')

  const matches = canonicalItemsBySource(db, item.library_id, identity.source, identity.externalId)
  for (const match of matches) {
    // Pinned collections deliberately retain folder-scoped identities even
    // when a metadata provider maps several named works to one subject.
    if (match.id !== item.id && !hasLocallyScopedCanonicalIdentity(item) && !hasLocallyScopedCanonicalIdentity(match)) {
      mergeCanonicalMediaItems(db, item.id, match.id)
    }
  }
  return attachCanonicalMediaItemSource(db, item.id, identity)
}

interface EnsureCanonicalMediaItemOptions {
  preferItemKey?: boolean
  preserveSourceItemIds?: ReadonlySet<number>
  preferredSourceItemId?: number
}

/** Creates or updates a stable canonical item and attaches all supplied ids. */
export function ensureCanonicalMediaItem(
  db: Database,
  input: EnsureCanonicalMediaItemInput,
  options: EnsureCanonicalMediaItemOptions = {},
): CanonicalItemRow {
  const baseKey = String(input.itemKey ?? '').trim()
  if (!baseKey) throw new MediaCatalogValidationError('规范媒体条目 key 不能为空', 400, 'INVALID_MEDIA_ITEM_KEY')
  const customLabel = input.kind === 'custom'
    ? normalizeCustomLabel(input.customLabel, true)
    : normalizeCustomLabel(input.customLabel, false)
  if (input.kind !== 'custom' && customLabel !== null) {
    throw new MediaCatalogValidationError('只有 custom 类型可以提供 customLabel', 400, 'INVALID_CUSTOM_LABEL')
  }
  const key = customLabel === null ? baseKey : customCanonicalItemKey(baseKey, customLabel)
  const storageKind: Exclude<MediaCatalogKind, 'custom'> = input.kind === 'custom' ? 'unknown' : input.kind
  const sourceIds = (input.sourceIds ?? [])
    .map(source => normalizeSourceIdentity(source.source, source.externalId))
    .filter((source): source is MediaItemSourceInput => source !== null)
  let item: CanonicalItemRow | undefined
  let preserveAutomaticFields = false
  if (customLabel === null) {
    if (options.preferItemKey) {
      item = canonicalItemByKey(db, input.libraryId, key)
      preserveAutomaticFields = Boolean(item && options.preserveSourceItemIds?.has(item.id))
      if (!item) {
        for (const source of sourceIds) {
          item = canonicalItemsBySource(db, input.libraryId, source.source, source.externalId)
            .find(match => match.root_folder_id === input.rootFolderId && options.preserveSourceItemIds?.has(match.id))
          if (item) {
            preserveAutomaticFields = true
            break
          }
        }
      }
      if (!item && options.preferredSourceItemId !== undefined) {
        for (const source of sourceIds) {
          item = canonicalItemsBySource(db, input.libraryId, source.source, source.externalId)
            .find(match => match.id === options.preferredSourceItemId && match.root_folder_id === input.rootFolderId)
          if (item) break
        }
      }
    } else {
      for (const source of sourceIds) {
        const sourceMatches = canonicalItemsBySource(db, input.libraryId, source.source, source.externalId)
        item = sourceMatches.find(match => match.root_folder_id === input.rootFolderId) ?? sourceMatches[0]
        if (item) break
      }
    }
  }
  if (!item) item = canonicalItemByKey(db, input.libraryId, key)
  if (!item) {
    const insert = run(db, `
      INSERT INTO media_items (
        library_id, root_folder_id, item_key, title, title_zh, kind,
        season_number, part_number, confidence, conflict_reason, manual_locked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `, [
      input.libraryId, input.rootFolderId, key, input.title,
      input.titleZh ?? null, storageKind, input.seasonNumber ?? null,
      input.partNumber ?? null, input.confidence ?? 0,
      input.conflictReason ?? null,
    ])
    item = canonicalItemById(db, Number(insert.lastInsertRowid))
  } else if (item.manual_locked !== 1 && !preserveAutomaticFields) {
    const keyOwner = canonicalItemByKey(db, input.libraryId, key)
    const nextItemKey = keyOwner && keyOwner.id !== item.id ? item.item_key : key
    if (options.preferItemKey && item.root_folder_id === input.rootFolderId && nextItemKey !== item.item_key) {
      // Presentation keys intentionally have no semantic FK so undo can keep
      // the old alias. Copy the user's title/order forward before rekeying and
      // leave an existing destination override untouched.
      copyCollectionPresentationAlias(db, input.rootFolderId, item.item_key, nextItemKey)
    }
    if (item.root_folder_id === input.rootFolderId && nextItemKey !== item.item_key) {
      rekeyCollectionMember(db, input.rootFolderId, item.item_key, nextItemKey)
    }
    run(db, `
      UPDATE media_items SET
        root_folder_id = ?, item_key = ?, title = ?, title_zh = ?, kind = ?,
        season_number = ?, part_number = ?, confidence = ?, conflict_reason = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `, [
      item.root_folder_id || input.rootFolderId, nextItemKey, input.title,
      input.titleZh ?? null, storageKind, input.seasonNumber ?? null,
      input.partNumber ?? null, input.confidence ?? 0,
      input.conflictReason ?? null, item.id,
    ])
    item = canonicalItemById(db, item.id)
  }
  if (!item) throw new MediaCatalogValidationError('无法建立规范媒体条目', 409, 'MEDIA_ITEM_CREATE_FAILED')
  // A custom label is a deliberate identity split. Its source id belongs to
  // the physical folder metadata, but must not make later automatic rebuilds
  // resolve this custom item by source and then mutate it back into a normal
  // item. Legacy rows are also filtered in canonicalItemsBySource above.
  if (customLabel === null) {
    for (const source of sourceIds) attachCanonicalMediaItemSource(db, item.id, source)
  }
  return canonicalItemById(db, item.id)!
}

function nearestCanonicalRoot(folder: FolderRow, foldersById: Map<number, FolderRow>): FolderRow | null {
  let current: FolderRow | undefined = folder
  const seen = new Set<number>()
  let nearestSeries: FolderRow | null = null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    // A manually selected collection is a logical boundary even when the
    // scanner did not mark that folder as a series. Keep walking after an
    // inner series marker so an outer pinned ancestor still wins.
    if (current.pinned === 1) return current
    if (!nearestSeries && current.is_series === 1) nearestSeries = current
    current = current.parent_id === null ? undefined : foldersById.get(current.parent_id)
  }
  return nearestSeries
}

function copyCanonicalItemSources(db: Database, sourceItemId: number, targetItemId: number): void {
  const sources = queryAll<{ source: string; external_id: string; is_primary: number }>(db, `
    SELECT source, external_id, is_primary
    FROM media_item_sources WHERE media_item_id = ?
  `, [sourceItemId])
  for (const source of sources) {
    run(db, `
      INSERT OR IGNORE INTO media_item_sources
        (media_item_id, source, external_id, is_primary, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `, [targetItemId, source.source, source.external_id, source.is_primary])
  }
}

function canonicalItemBySourceInRoot(
  db: Database,
  sourceItemId: number,
  libraryId: number,
  rootFolderId: number,
): CanonicalItemRow | undefined {
  const sources = queryAll<{ source: string; external_id: string }>(db, `
    SELECT source, external_id
    FROM media_item_sources
    WHERE media_item_id = ?
    ORDER BY is_primary DESC, id
  `, [sourceItemId])
  for (const source of sources) {
    const match = queryOne<CanonicalItemRow>(db, `
      SELECT m.id, m.library_id, m.root_folder_id, m.item_key, m.title,
             m.title_zh, m.kind, m.season_number, m.part_number, NULL AS custom_label,
             m.manual_locked, m.confidence, m.conflict_reason
      FROM media_items m
      JOIN media_item_sources s ON s.media_item_id = m.id
      WHERE m.library_id = ? AND m.root_folder_id = ? AND m.id <> ?
        AND m.item_key NOT LIKE 'custom:%'
        AND s.source = ? AND s.external_id = ?
      ORDER BY m.id
      LIMIT 1
    `, [libraryId, rootFolderId, sourceItemId, source.source, source.external_id])
    if (match) return match
  }
  return undefined
}

function cloneCanonicalMediaItem(
  db: Database,
  item: CanonicalItemRow,
  libraryId: number,
  rootFolderId: number,
): CanonicalItemRow {
  const cloneKey = canonicalCloneItemKey(db, libraryId, item.item_key, rootFolderId)
  const insert = run(db, `
    INSERT INTO media_items (
      library_id, root_folder_id, item_key, title, title_zh, kind,
      season_number, part_number, confidence, conflict_reason, manual_locked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    libraryId, rootFolderId, cloneKey, item.title, item.title_zh, item.kind,
    item.season_number, item.part_number, item.confidence, item.conflict_reason,
    item.manual_locked,
  ])
  const cloneId = Number(insert.lastInsertRowid)
  copyCanonicalItemSources(db, item.id, cloneId)
  const clone = canonicalItemById(db, cloneId)
  if (!clone) throw new MediaCatalogValidationError('无法复制规范媒体条目', 409, 'MEDIA_ITEM_CLONE_FAILED')
  return clone
}

function redirectCanonicalMappingsInRoot(
  db: Database,
  sourceItemId: number,
  targetItemId: number,
  rootFolderId: number,
): void {
  if (sourceItemId === targetItemId) return
  const mappings = queryAll<{
    id: number
    folder_id: number
    content_role: string
    season_number: number | null
    part_number: number | null
    manual_locked: number
  }>(db, `
    SELECT id, folder_id, content_role, season_number, part_number, manual_locked
    FROM folder_media_mappings
    WHERE root_folder_id = ? AND media_item_id = ?
    ORDER BY id
  `, [rootFolderId, sourceItemId])
  for (const mapping of mappings) {
    const existing = queryOne<{ id: number; manual_locked: number }>(db, `
      SELECT id, manual_locked
      FROM folder_media_mappings
      WHERE folder_id = ? AND media_item_id = ? AND root_folder_id = ?
        AND content_role = ?
        AND ((season_number = ?) OR (season_number IS NULL AND ? IS NULL))
        AND ((part_number = ?) OR (part_number IS NULL AND ? IS NULL))
    `, [mapping.folder_id, targetItemId, rootFolderId, mapping.content_role,
      mapping.season_number, mapping.season_number, mapping.part_number, mapping.part_number])
    if (existing) {
      if (mapping.manual_locked === 1 && existing.manual_locked !== 1) {
        run(db, `
          UPDATE folder_media_mappings
          SET manual_locked = 1, detected_by = 'manual', updated_at = datetime('now')
          WHERE id = ?
        `, [existing.id])
      }
      run(db, 'DELETE FROM folder_media_mappings WHERE id = ?', [mapping.id])
    } else {
      run(db, `
        UPDATE folder_media_mappings
        SET media_item_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [targetItemId, mapping.id])
    }
  }
}

function removeCanonicalMappingsWithoutRoot(
  db: Database,
  libraryId: number,
  foldersById: Map<number, FolderRow>,
): void {
  const mappings = queryAll<{ id: number; folder_id: number }>(db, `
    SELECT m.id, m.folder_id
    FROM folder_media_mappings m
    JOIN folders f ON f.id = m.folder_id
    WHERE f.library_id = ?
  `, [libraryId])
  for (const mapping of mappings) {
    const folder = foldersById.get(mapping.folder_id)
    if (!folder || !nearestCanonicalRoot(folder, foldersById)) {
      run(db, 'DELETE FROM folder_media_mappings WHERE id = ?', [mapping.id])
    }
  }
}

interface LegacyDetachedOrphan {
  rootFolderId: number
  mediaItemId: number
}

interface LegacyDetachedFolderState {
  folderIds: Set<number>
  explicitlyExcluded: boolean
}

function foldersInCanonicalRoot(
  rootFolderId: number,
  foldersById: Map<number, FolderRow>,
): Set<number> {
  const folderIds = new Set<number>()
  for (const folder of foldersById.values()) {
    if (nearestCanonicalRoot(folder, foldersById)?.id === rootFolderId) folderIds.add(folder.id)
  }
  return folderIds
}

/**
 * Finds the physical folder that an old synthetic detach group represented.
 * Current mappings are the strongest signal; legacy entries and the stable
 * source-less `folder:<id>` key cover databases where canonical mappings were
 * already removed before the migration ran.
 */
function legacyDetachedFolderState(
  db: Database,
  rootFolderId: number,
  item: CanonicalItemRow,
  foldersById: Map<number, FolderRow>,
): LegacyDetachedFolderState {
  const rootFolderIds = foldersInCanonicalRoot(rootFolderId, foldersById)
  const folderIds = new Set<number>()
  const mappings = queryAll<{ folder_id: number }>(db, `
    SELECT DISTINCT folder_id
    FROM folder_media_mappings
    WHERE root_folder_id = ? AND media_item_id = ?
  `, [rootFolderId, item.id])
  for (const mapping of mappings) {
    if (rootFolderIds.has(mapping.folder_id)) folderIds.add(mapping.folder_id)
  }

  const folderKey = item.item_key.match(/^folder:(\d+)$/)
  if (folderKey) {
    const folderId = Number(folderKey[1])
    if (rootFolderIds.has(folderId)) folderIds.add(folderId)
  }

  const sources = queryAll<{ source: string; external_id: string }>(db, `
    SELECT source, external_id
    FROM media_item_sources
    WHERE media_item_id = ?
  `, [item.id])
  for (const source of sources) {
    const rows = queryAll<{ folder_id: number }>(db, `
      SELECT DISTINCT e.folder_id
      FROM folder_media_entries e
      JOIN media_series s ON s.id = e.series_id
      WHERE s.root_folder_id = ? AND e.source = ? AND e.external_id = ?
    `, [rootFolderId, source.source, source.external_id])
    for (const row of rows) {
      if (rootFolderIds.has(row.folder_id)) folderIds.add(row.folder_id)
    }
  }

  // A source-less item normally carries the physical folder name as its
  // title. Use this only when the legacy table identifies one unambiguous
  // folder, so a repeated folder name cannot detach the wrong item.
  const titleRows = queryAll<{ folder_id: number }>(db, `
    SELECT DISTINCT e.folder_id
    FROM folder_media_entries e
    JOIN media_series s ON s.id = e.series_id
    JOIN folders f ON f.id = e.folder_id
    WHERE s.root_folder_id = ? AND f.name = ?
  `, [rootFolderId, item.title])
  if (titleRows.length === 1 && rootFolderIds.has(titleRows[0].folder_id)) {
    folderIds.add(titleRows[0].folder_id)
  }

  const excludedFolderIds = new Set(queryAll<{ folder_id: number }>(db, `
    SELECT folder_id
    FROM folder_media_catalog_exclusions
  `).map(row => row.folder_id).filter(folderId => rootFolderIds.has(folderId)))
  return {
    folderIds,
    explicitlyExcluded: [...folderIds].some(folderId => excludedFolderIds.has(folderId)),
  }
}

/**
 * Converts the pre-V8 synthetic one-item detach groups into the durable
 * ungrouped marker. Explicitly excluded folders are handled separately after
 * automatic mappings have been cleared; a scan that temporarily loses a
 * mapping must keep the marker and item alive for the next scan.
 */
function migrateLegacyDetachedWorkGroups(
  db: Database,
  libraryId: number,
  foldersById: Map<number, FolderRow>,
): LegacyDetachedOrphan[] {
  const groups = queryAll<MediaWorkGroupRow>(db, `
    SELECT g.id, g.library_id, g.root_folder_id, g.anchor_folder_id,
           g.group_key, g.title, g.manual_locked
    FROM media_work_groups g
    JOIN folders root ON root.id = g.root_folder_id
    WHERE g.library_id = ? AND g.group_key LIKE 'manual:detach:%'
    ORDER BY g.id
  `, [libraryId])
  const explicitOrphans: LegacyDetachedOrphan[] = []
  for (const group of groups) {
    const match = group.group_key.match(/^manual:detach:(\d+):(\d+)(?::\d+)?$/)
    if (!match || Number(match[1]) !== group.root_folder_id) continue
    const mediaItemId = Number(match[2])
    const members = mediaWorkGroupMembers(db, group.id)
    if (!members.some(member => member.media_item_id === mediaItemId)) continue
    const item = canonicalItemById(db, mediaItemId)
    if (!item || item.library_id !== libraryId || item.root_folder_id !== group.root_folder_id) continue

    const folderState = legacyDetachedFolderState(db, group.root_folder_id, item, foldersById)
    run(db, `
      INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(root_folder_id, media_item_id) DO UPDATE SET updated_at = datetime('now')
    `, [group.root_folder_id, mediaItemId])
    run(db, `
      DELETE FROM media_work_group_members
      WHERE work_group_id = ? AND media_item_id = ?
    `, [group.id, mediaItemId])
    run(db, `
      DELETE FROM media_work_groups
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM media_work_group_members WHERE work_group_id = media_work_groups.id
        )
    `, [group.id])
    if (folderState.explicitlyExcluded) {
      explicitOrphans.push({ rootFolderId: group.root_folder_id, mediaItemId })
    }
  }
  return explicitOrphans
}

function removeMigratedExplicitOrphans(
  db: Database,
  orphanedItems: LegacyDetachedOrphan[],
): void {
  for (const orphan of orphanedItems) {
    const hasMapping = queryOne<{ id: number }>(db, `
      SELECT id
      FROM folder_media_mappings
      WHERE root_folder_id = ? AND media_item_id = ?
      LIMIT 1
    `, [orphan.rootFolderId, orphan.mediaItemId])
    if (hasMapping) continue
    run(db, `
      DELETE FROM media_work_group_exclusions
      WHERE root_folder_id = ? AND media_item_id = ?
    `, [orphan.rootFolderId, orphan.mediaItemId])
    run(db, `
      DELETE FROM media_items
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM folder_media_mappings WHERE media_item_id = media_items.id)
        AND NOT EXISTS (SELECT 1 FROM media_work_group_members WHERE media_item_id = media_items.id)
        AND NOT EXISTS (SELECT 1 FROM media_work_group_exclusions WHERE media_item_id = media_items.id)
    `, [orphan.mediaItemId])
  }
}

function removeOrphanedCanonicalMediaItems(db: Database, libraryId: number, rootFolderId?: number): void {
  run(db, `
    DELETE FROM media_items
    WHERE library_id = ?
      ${rootFolderId === undefined ? '' : 'AND root_folder_id = ?'}
      AND NOT EXISTS (
        SELECT 1
        FROM folder_media_mappings
        WHERE folder_media_mappings.media_item_id = media_items.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM media_work_group_members m
        WHERE m.media_item_id = media_items.id AND m.manual_locked = 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM media_work_group_exclusions e
        WHERE e.media_item_id = media_items.id
      )
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId])
}

function previousCanonicalMediaItemIds(db: Database, folderId: number): number[] {
  return queryAll<{ media_item_id: number }>(db, `
    SELECT DISTINCT media_item_id
    FROM folder_media_mappings
    WHERE folder_id = ?
    ORDER BY media_item_id
  `, [folderId]).map(row => row.media_item_id)
}

/**
 * A custom manual identity is intentionally replaced when its label changes,
 * and restoring automatic detection can replace it with a source-backed
 * identity. Rebuilds preserve locked work-group members by design, so carry
 * the old folder identity's durable relationship onto the new item before
 * sweeping the old item. This is deliberately limited to an item that no
 * longer has mappings elsewhere; shared identities must remain untouched.
 */
function reconcileReplacedCanonicalMediaItems(
  db: Database,
  folderId: number,
  rootFolderId: number,
  libraryId: number,
  previousItemIds: number[],
): void {
  const replacements = queryAll<{ media_item_id: number }>(db, `
    SELECT DISTINCT media_item_id
    FROM folder_media_mappings
    WHERE folder_id = ? AND root_folder_id = ?
    ORDER BY id
  `, [folderId, rootFolderId]).map(row => row.media_item_id)
  if (previousItemIds.length === 0 || replacements.length === 0) return

  const replacementIdSet = new Set(replacements)
  let targetItemId = replacements[0]
  const targetItem = canonicalItemById(db, targetItemId)
  if (!targetItem || targetItem.library_id !== libraryId) return
  if (targetItem.root_folder_id !== rootFolderId) {
    // A shared source identity can be owned by another root after rebuild.
    // Keep that item and its foreign mappings intact; use a root-scoped item
    // for this folder's replacement and migrate only current-root mappings.
    const scopedItem = canonicalItemBySourceInRoot(db, targetItem.id, libraryId, rootFolderId)
    const replacement = scopedItem ?? cloneCanonicalMediaItem(db, targetItem, libraryId, rootFolderId)
    redirectCanonicalMappingsInRoot(db, targetItem.id, replacement.id, rootFolderId)
    targetItemId = replacement.id
  }
  for (const previousItemId of [...new Set(previousItemIds)]) {
    if (replacementIdSet.has(previousItemId)) continue
    const previousItem = canonicalItemById(db, previousItemId)
    if (!previousItem) continue

    // If this identity is still mapped by another physical folder, replacing
    // its group member here would detach that folder from its durable item.
    const hasRemainingMapping = queryOne<{ id: number }>(db, `
      SELECT id
      FROM folder_media_mappings
      WHERE media_item_id = ?
      LIMIT 1
    `, [previousItemId])
    if (hasRemainingMapping) continue

    const previousMember = queryOne<MediaWorkGroupMemberRow>(db, `
      SELECT media_work_group_members.id, media_work_group_members.work_group_id,
             media_work_group_members.media_item_id, media_work_group_members.relation_role,
             media_work_group_members.manual_locked
      FROM media_work_group_members
      JOIN media_work_groups g ON g.id = media_work_group_members.work_group_id
      WHERE media_work_group_members.media_item_id = ?
        AND g.library_id = ? AND g.root_folder_id = ?
      LIMIT 1
    `, [previousItemId, libraryId, rootFolderId])
    const targetMember = queryOne<MediaWorkGroupMemberRow>(db, `
      SELECT media_work_group_members.id, media_work_group_members.work_group_id,
             media_work_group_members.media_item_id, media_work_group_members.relation_role,
             media_work_group_members.manual_locked
      FROM media_work_group_members
      JOIN media_work_groups g ON g.id = media_work_group_members.work_group_id
      WHERE media_work_group_members.media_item_id = ?
        AND g.library_id = ? AND g.root_folder_id = ?
      LIMIT 1
    `, [targetItemId, libraryId, rootFolderId])
    let replacementHasMember = Boolean(targetMember)
    if (previousMember) {
      if (targetMember) {
        const previousMemberLocked = previousMember.manual_locked === 1
        const targetMemberLocked = targetMember.manual_locked === 1
        const shouldMoveToPreviousGroup = previousMemberLocked && !targetMemberLocked
        run(db, `
          UPDATE media_work_group_members
          SET work_group_id = ?, manual_locked = ?, relation_role = ?, updated_at = datetime('now')
          WHERE id = ?
        `, [
          shouldMoveToPreviousGroup ? previousMember.work_group_id : targetMember.work_group_id,
          previousMemberLocked || targetMemberLocked ? 1 : 0,
          targetMemberLocked ? targetMember.relation_role : previousMember.relation_role,
          targetMember.id,
        ])
        run(db, 'DELETE FROM media_work_group_members WHERE id = ?', [previousMember.id])
      } else {
        run(db, `
          UPDATE media_work_group_members
          SET media_item_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `, [targetItemId, previousMember.id])
        replacementHasMember = true
      }
    }

    // An exclusion is root-scoped. Preserve it only when the replacement is
    // still ungrouped; a locked membership is the stronger explicit choice.
    const previousExclusions = queryAll<{ id: number }>(db, `
      SELECT id
      FROM media_work_group_exclusions
      WHERE root_folder_id = ? AND media_item_id = ?
      ORDER BY id
    `, [rootFolderId, previousItemId])
    if (previousExclusions.length > 0) {
      const targetHasExclusion = queryOne<{ id: number }>(db, `
        SELECT id
        FROM media_work_group_exclusions
        WHERE root_folder_id = ? AND media_item_id = ?
        LIMIT 1
      `, [rootFolderId, targetItemId])
      if (!replacementHasMember && !targetHasExclusion) {
        run(db, `
          INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id, updated_at)
          VALUES (?, ?, datetime('now'))
        `, [rootFolderId, targetItemId])
      }
      run(db, `
        DELETE FROM media_work_group_exclusions
        WHERE root_folder_id = ? AND media_item_id = ?
      `, [rootFolderId, previousItemId])
    }

    run(db, `
      DELETE FROM media_items
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM folder_media_mappings WHERE media_item_id = media_items.id)
        AND NOT EXISTS (SELECT 1 FROM media_work_group_members WHERE media_item_id = media_items.id)
        AND NOT EXISTS (SELECT 1 FROM media_work_group_exclusions WHERE media_item_id = media_items.id)
    `, [previousItemId])
  }

  // The migration can remove the last member from the old locked group. Do
  // not leave an empty group shell behind after the identity replacement.
  run(db, `
    DELETE FROM media_work_groups
    WHERE root_folder_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM media_work_group_members
        WHERE work_group_id = media_work_groups.id
      )
  `, [rootFolderId])
  removeOrphanedCanonicalMediaItems(db, libraryId)
}

function folderMetadataSource(folder: FolderRow): MediaItemSourceInput | null {
  const own = normalizeSourceIdentity(folder.source ?? '', folder.anilist_id == null ? '' : String(folder.anilist_id))
  // External identity is intentionally local to the physical directory. A
  // parent series/collection may be a container for unrelated movie, SP, OVA,
  // or season entries and must not collapse them into its own item.
  if (!own) return null
  // TMDB uses separate movie and TV namespaces. Persisted shape evidence keeps
  // equal numeric IDs from being merged across those namespaces while leaving
  // legacy rows without the new field readable as the old untyped identity.
  if (own.source === 'tmdb' && folder.tmdb_media_type) {
    return { source: `tmdb:${folder.tmdb_media_type}`, externalId: own.externalId }
  }
  return own
}

function isReleaseGroupPrefix(value: string): boolean {
  const normalized = normalizeFolderName(value)
  if (/^(?:movies?|films?|parts?|seasons?|s\s*\d+|ova|oad|sp|specials?|tv)\b/i.test(normalized)) return false
  return /(?:studio|raws?|fansubs?|encodes?)\b/i.test(normalized)
    || /^(?:vcb|moozzi2|reinforce|dbd-raws|d-z0n3|loli-house)$/i.test(normalized)
    || /^(?:4320p|2160p|1440p|1080p|720p|576p|480p|[248]k|uhd|fhd)$/i.test(normalized)
}

function normalizedCollectionContentName(value: string): string {
  // Release groups conventionally prefix the real title in ASCII brackets.
  // Remove only recognized technical/group prefixes; semantic prefixes such
  // as Movie 1, Part 2, or Season 3 remain part of the content identity.
  let withoutReleasePrefix = value.normalize('NFKC').trim()
  let prefix = withoutReleasePrefix.match(/^\[([^\]]+)\]\s*(?=\S)/u)
  while (prefix && isReleaseGroupPrefix(prefix[1])) {
    withoutReleasePrefix = withoutReleasePrefix.slice(prefix[0].length).trimStart()
    prefix = withoutReleasePrefix.match(/^\[([^\]]+)\]\s*(?=\S)/u)
  }
  let normalized = normalizeFolderName(withoutReleasePrefix)
  normalized = normalized
    .replace(/\b(?:4320p|2160p|1440p|1080p|720p|576p|480p|[248]k|uhd|fhd)\b/gi, ' ')
    .replace(/\b(?:x26[45]|h[._-]?26[45]|hevc|av1|10[._-]?bit|8[._-]?bit)\b/gi, ' ')
    .replace(/\b(?:bd[._-]?rip|blu[._-]?ray|web[._-]?(?:dl|rip)|remux)\b/gi, ' ')
    .replace(/\b(?:disc|disk|vol(?:ume)?|cd)\s*0?\d+\b/gi, ' ')
    .replace(/[\s._()[\]{}【】（）《》<>+&/-]+/g, ' ')
    .trim()
  const genericWords = new Set(['release', 'releases', 'video', 'videos', 'media', 'main', 'batch', 'complete', 'encode'])
  normalized = normalized.split(/\s+/).filter(word => word && !genericWords.has(word)).join(' ')
  return normalized
}

function collectionContentIdentity(
  folder: FolderRow,
  root: FolderRow,
  foldersById: Map<number, FolderRow>,
): string {
  let current: FolderRow | undefined = folder
  const seen = new Set<number>()
  while (current && current.id !== root.id && !seen.has(current.id)) {
    seen.add(current.id)
    const bracketOnlyMatch = current.name.normalize('NFKC').trim().match(/^\[([^\]]+)\]$/u)
    const bracketOnlyIntermediate = bracketOnlyMatch !== null
      && isReleaseGroupPrefix(bracketOnlyMatch[1])
      && current.parent_id !== root.id
    if (!bracketOnlyIntermediate) {
      const normalized = normalizedCollectionContentName(current.name)
      if (normalized) return normalized
    }
    current = current.parent_id === null ? undefined : foldersById.get(current.parent_id)
  }
  return 'unnamed'
}

function canonicalItemKeyForFolder(
  root: FolderRow,
  folder: FolderRow,
  source: MediaItemSourceInput | null,
  scopedContentIdentity: string | null = null,
): string {
  if (!source) return `folder:${folder.id}`
  const sourceKey = `${source.source}:${source.externalId}`
  // A provider subject remains attached as metadata, but a pinned collection
  // adds a cleaned local content discriminator only when the same subject is
  // shared by genuinely different named works. Release variants stay merged.
  return root.pinned === 1 && scopedContentIdentity !== null
    ? `${sourceKey}#content:${encodeURIComponent(scopedContentIdentity)}`
    : sourceKey
}

function sourceIdentityNeedsFolderScope(
  db: Database,
  root: FolderRow,
  folder: FolderRow,
  source: MediaItemSourceInput | null,
): string | null {
  if (root.pinned !== 1 || !source) return null
  const folders = queryAll<FolderRow>(db, `
    SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, tmdb_media_type, pinned
    FROM folders WHERE library_id = ? ORDER BY path
  `, [root.library_id])
  const foldersById = new Map(folders.map(folder => [folder.id, folder]))
  const contentIdentity = collectionContentIdentity(folder, root, foldersById)
  const stableLocalKey = canonicalItemKeyForFolder(root, folder, source, contentIdentity)
  if (canonicalItemByKey(db, root.library_id, stableLocalKey)) return contentIdentity
  const videoFolderIds = new Set(queryAll<FileRow>(db, `
    SELECT folder_id, name, path, ext FROM files WHERE library_id = ?
  `, [root.library_id]).filter(isVideoFile).map(file => file.folder_id))
  const identities = new Set(folders.filter(candidate => {
    if (!videoFolderIds.has(candidate.id)) return false
    const candidateSource = folderMetadataSource(candidate)
    return candidateSource?.source === source.source
      && candidateSource.externalId === source.externalId
      && nearestCanonicalRoot(candidate, foldersById)?.id === root.id
  }).map(candidate => collectionContentIdentity(candidate, root, foldersById)))
  return identities.size > 1 ? contentIdentity : null
}

function shouldIncludeAutomaticCatalogEntry(
  identified: IdentifiedMediaFolder,
  _source: MediaItemSourceInput | null,
  _options: { allowUnidentifiedPinnedMember?: boolean } = {},
): boolean {
  if (identified.kind === 'extras') return false
  // A source-less, unnumbered folder is still a plausible main release. Keep
  // it in the durable catalog so the work-group fallback can decide whether a
  // single candidate is safe to call season 1; only explicit extras remain out
  // of the automatic projection.
  return true
}

function catalogExclusionRows(db: Database, libraryId: number): Map<number, MediaCatalogExclusionRow> {
  const rows = queryAll<MediaCatalogExclusionRow>(db, `
    SELECT e.folder_id, e.manual_kind, e.manual_season_numbers, e.manual_part_number,
           e.manual_custom_label
    FROM folder_media_catalog_exclusions e
    JOIN folders f ON f.id = e.folder_id
    WHERE f.library_id = ?
  `, [libraryId])
  return new Map(rows.map(row => [row.folder_id, row]))
}

function catalogExclusionFolderIds(db: Database, libraryId: number): Set<number> {
  return new Set(catalogExclusionRows(db, libraryId).keys())
}

function parseSavedSeasonNumbers(value: string | null): number[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return asNumberArray(parsed.map(item => Number(item)))
  } catch {
    return []
  }
}

function manualCatalogExclusionMetadata(
  db: Database,
  folderId: number,
): { kind: MediaCatalogKind; seasonNumbers: number[]; partNumber: number | null; customLabel: string | null } | null {
  const legacyRows = queryAll<{ kind: MediaCatalogKind; season_number: number | null; part_number: number | null; custom_label: string | null }>(db, `
    SELECT kind, season_number, part_number, custom_label
    FROM folder_media_entries
    WHERE folder_id = ? AND manual_locked = 1
    ORDER BY id
  `, [folderId])
  const rows = legacyRows.length > 0
    ? legacyRows
    : queryAll<{ kind: MediaCatalogKind; season_number: number | null; part_number: number | null; custom_label: string | null }>(db, `
      SELECT kind, season_number, part_number, custom_label
      FROM folder_media_mappings
      WHERE folder_id = ? AND manual_locked = 1
      ORDER BY id
    `, [folderId])
  if (rows.length === 0 || !MEDIA_CATALOG_KINDS.includes(rows[0].kind)) return null
  const customLabel = rows.find(row => row.custom_label)?.custom_label ?? null
  const kind = projectedMediaCatalogKind(rows[0].kind, customLabel)
  const seasonNumbers = kind === 'season'
    ? asNumberArray(rows.map(row => row.season_number).filter((value): value is number => value !== null))
    : []
  const partNumber = rows.find(row => row.part_number !== null)?.part_number ?? null
  return { kind, seasonNumbers, partNumber, customLabel }
}

function getMediaCatalogCandidates(
  db: Database,
  root: FolderRow,
): MediaCatalogCandidateView[] {
  const folders = queryAll<FolderRow>(db, `
    SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, tmdb_media_type, pinned
    FROM folders WHERE library_id = ? ORDER BY path
  `, [root.library_id])
  const foldersById = new Map(folders.map(folder => [folder.id, folder]))
  const files = queryAll<FileRow>(db, `
    SELECT folder_id, name, path, ext
    FROM files WHERE library_id = ?
  `, [root.library_id]).filter(isVideoFile)
  const filesByFolder = new Map<number, FileRow[]>()
  for (const file of files) {
    const current = filesByFolder.get(file.folder_id) ?? []
    current.push(file)
    filesByFolder.set(file.folder_id, current)
  }
  const visibleFolderIds = new Set(queryAll<{ folder_id: number }>(db, `
    SELECT DISTINCT folder_id
    FROM folder_media_mappings
    WHERE root_folder_id = ?
  `, [root.id]).map(row => row.folder_id))
  // Keep legacy rows in the visible set while older databases are being
  // upgraded, so a candidate is never duplicated in the compatibility view.
  for (const row of queryAll<{ folder_id: number }>(db, `
    SELECT DISTINCT e.folder_id
    FROM folder_media_entries e
    JOIN media_series s ON s.id = e.series_id
    WHERE s.root_folder_id = ?
  `, [root.id])) visibleFolderIds.add(row.folder_id)

  const exclusionRows = catalogExclusionRows(db, root.library_id)
  const excludedFolderIds = new Set(exclusionRows.keys())
  const candidates: MediaCatalogCandidateView[] = []
  for (const folder of folders) {
    if (!filesByFolder.has(folder.id) || nearestCanonicalRoot(folder, foldersById)?.id !== root.id) continue
    const excluded = excludedFolderIds.has(folder.id)
    // An excluded folder may retain its previous manual values in the
    // exclusion record, but it must remain visible as a reversible candidate.
    if (!excluded && visibleFolderIds.has(folder.id)) continue
    const identified = identifyMediaFolder({
      name: folder.name,
      ancestorNames: ancestorNames(folder, foldersById),
      fileNames: (filesByFolder.get(folder.id) ?? []).map(file => file.name || file.path),
    })
    const source = folderMetadataSource(folder)
    const allowUnidentifiedPinnedMember = root.pinned === 1 && folder.parent_id === root.id
    if (!excluded && shouldIncludeAutomaticCatalogEntry(identified, source, { allowUnidentifiedPinnedMember })) continue
    const reason: MediaCatalogCandidateReason = excluded
      ? 'excluded'
      : identified.kind === 'extras' ? 'extras' : 'insufficient_evidence'
    const saved = exclusionRows.get(folder.id)
    const hasSavedManual = saved?.manual_kind !== null && saved?.manual_kind !== undefined
    const suggestedKind = hasSavedManual && MEDIA_CATALOG_KINDS.includes(saved!.manual_kind as MediaCatalogKind)
      ? projectedMediaCatalogKind(saved!.manual_kind as MediaCatalogKind, saved?.manual_custom_label)
      : identified.kind
    const suggestedSeasonNumbers = hasSavedManual
      ? (suggestedKind === 'season' ? parseSavedSeasonNumbers(saved!.manual_season_numbers) : [])
      : (identified.kind === 'season' ? identified.seasonNumbers : [])
    const suggestedPartNumber = hasSavedManual ? (saved!.manual_part_number ?? null) : identified.partNumber
    const suggestedCustomLabel = hasSavedManual ? (saved!.manual_custom_label ?? null) : null
    candidates.push({
      ...resolveFolderMediaDomain(db, folder.id),
      folder_id: folder.id,
      folder_name: folder.name,
      folder_path: folder.path,
      suggested_kind: suggestedKind,
      suggested_season_numbers: suggestedSeasonNumbers,
      suggested_part_number: suggestedPartNumber,
      suggested_custom_label: suggestedCustomLabel,
      confidence: identified.confidence,
      reason,
      source: source?.source ?? null,
      external_id: source?.externalId ?? null,
    })
  }
  return candidates.sort((left, right) => left.folder_path.localeCompare(right.folder_path, 'zh'))
}

function canonicalRole(kind: MediaCatalogKind): string {
  return kind === 'season' || kind === 'custom' ? 'main' : kind
}

type MediaWorkGroupRelationRole = 'main' | 'side_story' | 'spin_off' | 'unknown'

function workGroupAnchorForFolder(
  folderId: number,
  root: FolderRow,
  foldersById: Map<number, FolderRow>,
): number {
  if (root.pinned !== 1) return root.id
  let current = foldersById.get(folderId)
  let firstChild: FolderRow | null = null
  const seen = new Set<number>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.id === root.id) return firstChild?.id ?? root.id
    firstChild = current
    current = current.parent_id === null ? undefined : foldersById.get(current.parent_id)
  }
  return root.id
}

function workGroupRelationRole(kind: MediaCatalogKind, title: string): MediaWorkGroupRelationRole {
  const normalized = normalizeFolderName(title)
  if (/(?:外传|外傳|外伝|番外)/u.test(normalized)) {
    return 'side_story'
  }
  if (/(?:^|[\s._()[\]{}【】（）《》<>-])gaiden(?:$|[\s._()[\]{}【】（）《》<>-])/.test(normalized)) {
    return 'spin_off'
  }
  if (/(?:^|[\s._()[\]{}【】（）《》<>-])spin[\s._-]*off(?:$|[\s._()[\]{}【】（）《》<>-])/.test(normalized)) {
    return 'spin_off'
  }
  if (/(?:^|[\s._()[\]{}【】（）《》<>-])side[\s._-]*stor(?:y|ies)(?:$|[\s._()[\]{}【】（）《》<>-])/.test(normalized)) {
    return 'side_story'
  }
  return kind === 'unknown' ? 'unknown' : 'main'
}

function prepareMediaWorkGroupsForRebuild(db: Database, libraryId: number, rootFolderId?: number): void {
  // Automatic memberships are projections of the current folder mappings. A
  // locked member is the user's durable relationship and must survive. The
  // item condition also catches a subtree that has just crossed libraries,
  // before the core integrity custodian updates the item's ownership.
  if (rootFolderId !== undefined) {
    run(db, `
      DELETE FROM media_work_group_members
      WHERE manual_locked = 0
        AND work_group_id IN (
          SELECT id FROM media_work_groups
          WHERE library_id = ? AND root_folder_id = ?
        )
    `, [libraryId, rootFolderId])
    return
  }
  run(db, `
    DELETE FROM media_work_group_members
    WHERE manual_locked = 0
      AND (
        work_group_id IN (
          SELECT id FROM media_work_groups WHERE library_id = ?
        )
        OR media_item_id IN (
          SELECT DISTINCT m.media_item_id
          FROM folder_media_mappings m
          JOIN folders f ON f.id = m.folder_id
          WHERE f.library_id = ?
        )
      )
  `, [libraryId, libraryId])
}

function mediaWorkGroupExclusionsByRoot(
  db: Database,
  libraryId: number,
  rootFolderId?: number,
): Map<number, Set<number>> {
  const rows = queryAll<{ root_folder_id: number; media_item_id: number }>(db, `
    SELECT e.root_folder_id, e.media_item_id
    FROM media_work_group_exclusions e
    JOIN folders root ON root.id = e.root_folder_id
    WHERE root.library_id = ?
      ${rootFolderId === undefined ? '' : 'AND e.root_folder_id = ?'}
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId])
  const result = new Map<number, Set<number>>()
  for (const row of rows) {
    const itemIds = result.get(row.root_folder_id) ?? new Set<number>()
    itemIds.add(row.media_item_id)
    result.set(row.root_folder_id, itemIds)
  }
  return result
}

/**
 * Explicitly excluding a physical folder is a destructive catalog action. It
 * is different from a scan temporarily losing files: only this path removes
 * locked relationships that no longer have any physical mapping in the root.
 */
function removeExplicitlyOrphanedWorkGroupState(db: Database, rootFolderId: number): void {
  const orphanMembers = queryAll<{ id: number; media_item_id: number }>(db, `
    SELECT m.id, m.media_item_id
    FROM media_work_group_members m
    JOIN media_work_groups g ON g.id = m.work_group_id
    WHERE g.root_folder_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM folder_media_mappings mapping
        WHERE mapping.root_folder_id = g.root_folder_id
          AND mapping.media_item_id = m.media_item_id
      )
  `, [rootFolderId])
  const orphanItemIds = [...new Set(orphanMembers.map(member => member.media_item_id))]
  for (const member of orphanMembers) {
    run(db, 'DELETE FROM media_work_group_members WHERE id = ?', [member.id])
  }

  // A group cannot be useful once its last physical member was explicitly
  // removed. This also cleans old synthetic groups left by detach.
  run(db, `
    DELETE FROM media_work_groups
    WHERE root_folder_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM media_work_group_members m WHERE m.work_group_id = media_work_groups.id
      )
  `, [rootFolderId])

  // An ungrouped marker without a physical mapping is stale as well. It is
  // safe to remove only within this explicit root cleanup path.
  run(db, `
    DELETE FROM media_work_group_exclusions
    WHERE root_folder_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM folder_media_mappings mapping
        WHERE mapping.root_folder_id = media_work_group_exclusions.root_folder_id
          AND mapping.media_item_id = media_work_group_exclusions.media_item_id
      )
  `, [rootFolderId])

  for (const itemId of orphanItemIds) {
    run(db, `
      DELETE FROM media_items
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM folder_media_mappings WHERE media_item_id = media_items.id)
        AND NOT EXISTS (SELECT 1 FROM media_work_group_members WHERE media_item_id = media_items.id)
    `, [itemId])
  }
}

interface MediaWorkGroupCandidate {
  rootFolderId: number
  anchorFolderId: number | null
  groupKey: string
  title: string
  itemIds: Set<number>
}

function rebuildMediaWorkGroups(
  db: Database,
  libraryId: number,
  foldersById: Map<number, FolderRow>,
  rootFolderId?: number,
): void {
  const mappings = queryAll<{
    id: number
    root_folder_id: number
    folder_id: number
    media_item_id: number
    kind: MediaCatalogKind
    custom_label: string | null
    folder_name: string
    folder_path: string
  }>(db, `
    SELECT m.id, m.root_folder_id, m.folder_id, m.media_item_id, m.kind, m.custom_label,
           f.name AS folder_name, f.path AS folder_path
    FROM folder_media_mappings m
    JOIN folders f ON f.id = m.folder_id
    WHERE f.library_id = ?
      ${rootFolderId === undefined ? '' : 'AND m.root_folder_id = ?'}
    ORDER BY f.path, m.id
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId])
  const excludedItemsByRoot = mediaWorkGroupExclusionsByRoot(db, libraryId, rootFolderId)
  const lockedItemIds = new Set(queryAll<{ media_item_id: number }>(db, `
    SELECT DISTINCT m.media_item_id
    FROM media_work_group_members m
    JOIN media_work_groups g ON g.id = m.work_group_id
    WHERE g.library_id = ? AND m.manual_locked = 1
      ${rootFolderId === undefined ? '' : 'AND g.root_folder_id = ?'}
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId]).map(row => row.media_item_id))
  const candidates = new Map<string, MediaWorkGroupCandidate>()
  const itemGroupKeys = new Map<number, string>()
  const domains = resolveFolderMediaDomains(db, mappings.map(mapping => mapping.folder_id))
  const domainsByAnchor = new Map<string, Set<string>>()
  for (const mapping of mappings) {
    const root = foldersById.get(mapping.root_folder_id)
    if (!root || lockedItemIds.has(mapping.media_item_id)) continue
    const key = `${root.id}:${root.pinned === 1 ? workGroupAnchorForFolder(mapping.folder_id, root, foldersById) : root.id}`
    const domain = domains.get(mapping.folder_id)
    if (!domain || domain.media_domain === 'unknown' || domain.media_domain_source === 'library_default') continue
    const known = domainsByAnchor.get(key) ?? new Set<string>()
    known.add(domain.media_domain)
    domainsByAnchor.set(key, known)
  }

  for (const mapping of mappings) {
    const root = foldersById.get(mapping.root_folder_id)
    if (!root) continue
    if (excludedItemsByRoot.get(root.id)?.has(mapping.media_item_id)) continue
    if (lockedItemIds.has(mapping.media_item_id)) continue
    const logicalAnchorFolderId = workGroupAnchorForFolder(mapping.folder_id, root, foldersById)
    // The root group has no separate anchor. Leaving this FK null also lets a
    // scanner safely cascade-delete a non-pinned series root; pinned groups
    // retain their first-child anchor when it is distinct from the root.
    const anchorFolderId = root.pinned === 1 && logicalAnchorFolderId !== root.id
      ? logicalAnchorFolderId
      : null
    const baseGroupKey = root.pinned === 1 ? `anchor:${logicalAnchorFolderId}` : `root:${root.id}`
    const mixed = (domainsByAnchor.get(`${root.id}:${root.pinned === 1 ? logicalAnchorFolderId : root.id}`)?.size ?? 0) > 1
    // Physical containment and similar names do not make animation and its
    // live adaptation the same work. Manual relationships remain untouched.
    const groupKey = mixed ? `${baseGroupKey}:domain:${domains.get(mapping.folder_id)?.media_domain ?? 'unknown'}` : baseGroupKey
    const scopedKey = `${root.id}:${groupKey}`
    const assignedKey = itemGroupKeys.get(mapping.media_item_id)
    if (assignedKey && assignedKey !== scopedKey) continue
    const item = canonicalItemById(db, mapping.media_item_id)
    if (!item) continue
    if (item.library_id === libraryId && item.root_folder_id !== root.id) {
      const existingRootMapping = queryOne<{ id: number }>(db, `
        SELECT id FROM folder_media_mappings
        WHERE media_item_id = ? AND root_folder_id = ? LIMIT 1
      `, [mapping.media_item_id, root.id])
      const currentRootMapping = queryOne<{ id: number }>(db, `
        SELECT id FROM folder_media_mappings
        WHERE media_item_id = ? AND root_folder_id = ? LIMIT 1
      `, [mapping.media_item_id, item.root_folder_id])
      if (!currentRootMapping && existingRootMapping) {
        run(db, `
          UPDATE media_items SET root_folder_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `, [root.id, mapping.media_item_id])
      }
    }
    // A source identity may legitimately be mapped from multiple roots, but
    // a work-group member is root-scoped. If ownership still belongs to a
    // different root after the rehome attempt above, do not insert a member
    // that the scope trigger would reject or overwrite the other root's group.
    const scopedItem = canonicalItemById(db, mapping.media_item_id)
    if (!scopedItem || scopedItem.library_id !== libraryId || scopedItem.root_folder_id !== root.id) continue
    itemGroupKeys.set(mapping.media_item_id, scopedKey)
    const anchor = anchorFolderId === null ? root : foldersById.get(anchorFolderId)
    const candidate = candidates.get(scopedKey) ?? {
      rootFolderId: root.id,
      anchorFolderId,
      groupKey,
      title: anchor?.name ?? root.name,
      itemIds: new Set<number>(),
    }
    candidate.itemIds.add(mapping.media_item_id)
    candidates.set(scopedKey, candidate)
  }

  const existingGroups = queryAll<MediaWorkGroupRow>(db, `
    SELECT id, library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked
    FROM media_work_groups
    WHERE library_id = ?
      ${rootFolderId === undefined ? '' : 'AND root_folder_id = ?'}
    ORDER BY id
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId])
  const groupsByKey = new Map(existingGroups.map(group => [`${group.root_folder_id}:${group.group_key}`, group]))

  for (const candidate of [...candidates.values()].sort((left, right) =>
    left.rootFolderId - right.rootFolderId || left.groupKey.localeCompare(right.groupKey))) {
    const scopedKey = `${candidate.rootFolderId}:${candidate.groupKey}`
    let group = groupsByKey.get(scopedKey)
    if (!group) {
      const inserted = run(db, `
        INSERT INTO media_work_groups
          (library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked)
        VALUES (?, ?, ?, ?, ?, 0)
      `, [libraryId, candidate.rootFolderId, candidate.anchorFolderId, candidate.groupKey, candidate.title])
      group = queryOne<MediaWorkGroupRow>(db, `
        SELECT id, library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked
        FROM media_work_groups WHERE id = ?
      `, [Number(inserted.lastInsertRowid)])
      if (group) groupsByKey.set(scopedKey, group)
    } else if (group.manual_locked !== 1) {
      run(db, `
        UPDATE media_work_groups
        SET anchor_folder_id = ?, title = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [candidate.anchorFolderId, candidate.title, group.id])
      group = { ...group, anchor_folder_id: candidate.anchorFolderId, title: candidate.title }
      groupsByKey.set(scopedKey, group)
    }
    if (!group) continue

    for (const itemId of [...candidate.itemIds].sort((a, b) => a - b)) {
      const existingMember = queryOne<MediaWorkGroupMemberRow>(db, `
        SELECT id, work_group_id, media_item_id, relation_role, manual_locked
        FROM media_work_group_members WHERE media_item_id = ?
      `, [itemId])
      if (existingMember?.manual_locked === 1) continue
      const item = canonicalItemById(db, itemId)
      if (!item) continue
      const itemMapping = mappings.find(mapping => mapping.media_item_id === itemId)
      const relationRole = workGroupRelationRole(projectedMediaCatalogKind(item.kind, itemMapping?.custom_label), item.title)
      if (existingMember) {
        run(db, `
          UPDATE media_work_group_members
          SET work_group_id = ?, relation_role = ?, manual_locked = 0,
              updated_at = datetime('now')
          WHERE id = ?
        `, [group.id, relationRole, existingMember.id])
      } else {
        run(db, `
          INSERT INTO media_work_group_members
            (work_group_id, media_item_id, relation_role, manual_locked)
          VALUES (?, ?, ?, 0)
        `, [group.id, itemId, relationRole])
      }
    }
  }

  // Automatic groups that no longer have generated members are stale. A
  // group with a locked member remains durable even when its automatic anchor
  // disappears, so the user can still see and repair that relationship.
  run(db, `
    DELETE FROM media_work_groups
    WHERE library_id = ?
      ${rootFolderId === undefined ? '' : 'AND root_folder_id = ?'}
      AND manual_locked = 0
      AND NOT EXISTS (
        SELECT 1 FROM media_work_group_members m WHERE m.work_group_id = media_work_groups.id
      )
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId])
}

const SINGLE_MAIN_SEASON_FALLBACK_DETECTED_BY = 'single-main-season-fallback (season 1)'

function applySingleMainSeasonFallback(db: Database, libraryId: number, rootFolderId?: number): void {
  const groups = queryAll<{ id: number; root_folder_id: number; pinned: number; anchor_folder_id: number | null }>(db, `
    SELECT g.id, g.root_folder_id, f.pinned, g.anchor_folder_id
    FROM media_work_groups g
    JOIN folders f ON f.id = g.root_folder_id
    WHERE g.library_id = ?
      ${rootFolderId === undefined ? '' : 'AND g.root_folder_id = ?'}
    ORDER BY g.id
  `, rootFolderId === undefined ? [libraryId] : [libraryId, rootFolderId])
  for (const group of groups) {
    const members = queryAll<{ media_item_id: number; manual_locked: number }>(db, `
      SELECT media_item_id, manual_locked
      FROM media_work_group_members WHERE work_group_id = ? ORDER BY id
    `, [group.id])
    if (members.some(member => member.manual_locked === 1)) continue
    const itemIds = [...new Set(members.map(member => member.media_item_id))]
    if (itemIds.length === 0) continue
    const placeholders = itemIds.map(() => '?').join(', ')
    const mappings = queryAll<{
      id: number
      folder_id: number
      media_item_id: number
      content_role: string
      kind: MediaCatalogKind
      season_number: number | null
      part_number: number | null
      manual_locked: number
      conflict_reason: string | null
    }>(db, `
      SELECT id, folder_id, media_item_id, content_role, kind, season_number,
             part_number, manual_locked, conflict_reason
      FROM folder_media_mappings
      WHERE root_folder_id = ? AND media_item_id IN (${placeholders})
      ORDER BY id
    `, [group.root_folder_id, ...itemIds])
    // Named folders inside a pinned collection are independent content, not
    // implicit seasons. Explicit season labels were already classified before
    // this fallback; leave every remaining unnumbered collection item unknown.
    if (group.pinned === 1) continue
    const automatic = mappings.filter(mapping => mapping.manual_locked === 0)
    const isUnnumberedUnknown = (mapping: typeof automatic[number]) =>
      mapping.kind === 'unknown' && mapping.content_role === 'unknown'
      && mapping.season_number === null && mapping.part_number === null
      && mapping.conflict_reason === null
    const unknownMappings = automatic.filter(isUnnumberedUnknown)
    const unknownItemIds = new Set(unknownMappings.map(mapping => mapping.media_item_id))
    const hasExplicitSeason = automatic.some(mapping => mapping.kind === 'season')
    // A single physical, unnumbered main candidate is safe to call season 1;
    // multiple candidates stay unknown, while OVA/movie/special entries can
    // coexist as separate formats in the same work group.
    if (unknownItemIds.size !== 1 || hasExplicitSeason) continue
    const itemId = [...unknownItemIds][0]
    const fallbackMappings = unknownMappings.filter(mapping => mapping.media_item_id === itemId)
    const itemMappings = automatic.filter(mapping => mapping.media_item_id === itemId)
    const hasManualMapping = Boolean(queryOne<{ id: number }>(db, `
      SELECT id
      FROM folder_media_mappings
      WHERE media_item_id = ? AND manual_locked = 1
      LIMIT 1
    `, [itemId]))
    // Do not project a mixed-format or already-conflicted canonical item. A
    // fallback must update every physical mapping for the item, otherwise the
    // item is projected as unknown again by the cross-mapping conflict check.
    if (hasManualMapping || fallbackMappings.length === 0 || itemMappings.some(mapping => !isUnnumberedUnknown(mapping))) continue
    for (const mapping of fallbackMappings) {
      run(db, `
        UPDATE folder_media_mappings
        SET content_role = 'main', kind = 'season', season_number = 1,
            confidence = CASE WHEN confidence < 0.65 THEN 0.65 ELSE confidence END,
            conflict_reason = NULL, detected_by = ?, updated_at = datetime('now')
        WHERE id = ? AND manual_locked = 0
      `, [SINGLE_MAIN_SEASON_FALLBACK_DETECTED_BY, mapping.id])
    }
    run(db, `
      UPDATE media_items
      SET kind = 'season', season_number = 1, part_number = NULL,
          confidence = CASE WHEN confidence < 0.65 THEN 0.65 ELSE confidence END,
          conflict_reason = NULL, updated_at = datetime('now')
      WHERE id = ? AND manual_locked = 0
    `, [itemId])
    const item = canonicalItemById(db, itemId)
    const relationRole = item ? workGroupRelationRole('season', item.title) : 'main'
    run(db, `
      UPDATE media_work_group_members
      SET relation_role = ?, updated_at = datetime('now')
      WHERE work_group_id = ? AND media_item_id = ? AND manual_locked = 0
    `, [relationRole, group.id, itemId])
    // Keep the compatibility response in lockstep with every canonical
    // mapping whenever the legacy rows are present in the same rebuild.
    for (const mapping of fallbackMappings) {
      run(db, `
        UPDATE folder_media_entries
        SET kind = 'season', season_number = 1, part_number = NULL,
            confidence = CASE WHEN confidence < 0.65 THEN 0.65 ELSE confidence END,
            conflict_reason = NULL, detected_by = ?, updated_at = datetime('now')
        WHERE folder_id = ? AND manual_locked = 0 AND kind = 'unknown'
          AND season_number IS NULL AND part_number IS NULL
      `, [SINGLE_MAIN_SEASON_FALLBACK_DETECTED_BY, mapping.folder_id])
    }
  }
}

function upsertCanonicalMapping(
  db: Database,
  input: {
    folderId: number
    mediaItemId: number
    rootFolderId: number
    seriesId: number | null
    contentRole: string
    kind: MediaCatalogKind
    seasonNumber: number | null
    partNumber: number | null
    customLabel?: string | null
    confidence: number
    conflictReason: string | null
    detectedBy: string
  },
): void {
  const existing = queryOne<{ id: number }>(db, `
    SELECT id FROM folder_media_mappings
    WHERE folder_id = ? AND media_item_id = ? AND root_folder_id = ?
      AND content_role = ?
      AND ((season_number = ?) OR (season_number IS NULL AND ? IS NULL))
      AND ((part_number = ?) OR (part_number IS NULL AND ? IS NULL))
  `, [input.folderId, input.mediaItemId, input.rootFolderId, input.contentRole,
    input.seasonNumber, input.seasonNumber, input.partNumber, input.partNumber])
  if (existing) {
    run(db, `
      UPDATE folder_media_mappings SET
        series_id = ?, kind = ?, custom_label = ?, confidence = ?, conflict_reason = ?,
        detected_by = ?, updated_at = datetime('now')
      WHERE id = ? AND manual_locked = 0
    `, [input.seriesId, input.kind, input.customLabel ?? null, input.confidence, input.conflictReason, input.detectedBy, existing.id])
    return
  }
  run(db, `
    INSERT INTO folder_media_mappings (
      folder_id, media_item_id, root_folder_id, series_id, content_role, kind,
      season_number, part_number, custom_label, confidence, conflict_reason, detected_by, manual_locked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `, [
    input.folderId, input.mediaItemId, input.rootFolderId, input.seriesId,
    input.contentRole, input.kind, input.seasonNumber, input.partNumber,
    input.customLabel ?? null, input.confidence, input.conflictReason, input.detectedBy,
  ])
}

interface CanonicalRebuildOptions {
  manageTransaction?: boolean
  rootFolderId?: number
  integrityPrepared?: boolean
}

function rebuildCanonicalMediaCatalogInternal(
  db: Database,
  libraryId: number,
  options: CanonicalRebuildOptions = {},
): CanonicalMediaCatalogRebuildResult {
  const manageTransaction = options.manageTransaction !== false
  const folders = queryAll<FolderRow>(db, `
    SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, tmdb_media_type, pinned
    FROM folders WHERE library_id = ? ORDER BY path
  `, [libraryId])
  const files = queryAll<FileRow>(db, `
    SELECT folder_id, name, path, ext FROM files WHERE library_id = ?
  `, [libraryId]).filter(isVideoFile)
  const foldersById = new Map(folders.map(folder => [folder.id, folder]))
  const filesByFolder = new Map<number, FileRow[]>()
  for (const file of files) {
    const current = filesByFolder.get(file.folder_id) ?? []
    current.push(file)
    filesByFolder.set(file.folder_id, current)
  }
  const foldersByRoot = new Map<number, FolderRow[]>()
  for (const folder of folders) {
    if (!filesByFolder.has(folder.id)) continue
    const root = nearestCanonicalRoot(folder, foldersById)
    if (!root) continue
    if (options.rootFolderId !== undefined && root.id !== options.rootFolderId) continue
    const current = foldersByRoot.get(root.id) ?? []
    current.push(folder)
    foldersByRoot.set(root.id, current)
  }
  const collectionContentIdentityByFolder = new Map<number, string>()
  const contentIdentitiesBySourceKey = new Map<string, Set<string>>()
  for (const [rootId, rootFolders] of foldersByRoot) {
    const root = foldersById.get(rootId)
    if (root?.pinned !== 1) continue
    for (const folder of rootFolders) {
      const source = folderMetadataSource(folder)
      if (!source) continue
      const contentIdentity = collectionContentIdentity(folder, root, foldersById)
      collectionContentIdentityByFolder.set(folder.id, contentIdentity)
      const sourceKey = `${rootId}:${source.source}:${source.externalId}`
      const identities = contentIdentitiesBySourceKey.get(sourceKey) ?? new Set<string>()
      identities.add(contentIdentity)
      contentIdentitiesBySourceKey.set(sourceKey, identities)
    }
  }
  const folderScopedSourceKeys = new Set([...contentIdentitiesBySourceKey.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([sourceKey]) => sourceKey))
  const result: CanonicalMediaCatalogRebuildResult = {
    rootCount: foldersByRoot.size,
    foldersProcessed: 0,
    itemCount: 0,
    mappingCount: 0,
    unknownCount: 0,
    conflictCount: 0,
  }

  if (manageTransaction) run(db, 'BEGIN')
  try {
    if (options.rootFolderId === undefined && options.integrityPrepared !== true) {
      maintainCatalogIntegrity(db, [libraryId])
    }
    // Capture manual intent before automatic members/mappings are cleared.
    // An old source-collapsed item with a locked relationship remains one
    // confirmed item instead of being eagerly split during migration.
    const preserveSourceItemIds = canonicalItemIdsWithManualState(db, libraryId)
    const previousAutomaticItemIdsByFolder = new Map<number, number[]>()
    for (const row of queryAll<{ folder_id: number; media_item_id: number }>(db, `
      SELECT mapping.folder_id, mapping.media_item_id
      FROM folder_media_mappings mapping
      JOIN folders folder ON folder.id = mapping.folder_id
      WHERE folder.library_id = ? AND mapping.manual_locked = 0
        ${options.rootFolderId === undefined ? '' : 'AND mapping.root_folder_id = ?'}
      ORDER BY mapping.id
    `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId])) {
      const itemIds = previousAutomaticItemIdsByFolder.get(row.folder_id) ?? []
      if (!itemIds.includes(row.media_item_id)) itemIds.push(row.media_item_id)
      previousAutomaticItemIdsByFolder.set(row.folder_id, itemIds)
    }
    const migratedExplicitOrphans = options.rootFolderId === undefined
      ? migrateLegacyDetachedWorkGroups(db, libraryId, foldersById)
      : []
    prepareMediaWorkGroupsForRebuild(db, libraryId, options.rootFolderId)
    if (options.rootFolderId === undefined) {
      for (const folder of folders) {
        run(db, 'DELETE FROM folder_media_mappings WHERE folder_id = ? AND manual_locked = 0', [folder.id])
      }
    } else {
      run(db, `
        DELETE FROM folder_media_mappings
        WHERE root_folder_id = ? AND manual_locked = 0
      `, [options.rootFolderId])
    }
    const excludedFolderIds = catalogExclusionFolderIds(db, libraryId)
    const scopedFolderIds = options.rootFolderId === undefined
      ? null
      : foldersInCanonicalRoot(options.rootFolderId, foldersById)
    for (const folderId of excludedFolderIds) {
      if (scopedFolderIds && !scopedFolderIds.has(folderId)) continue
      run(db, 'DELETE FROM folder_media_mappings WHERE folder_id = ?', [folderId])
    }
    // A manual row can outlive its series marker when a collection is
    // unpinned. It no longer has a canonical boundary and must not keep an
    // obsolete item alive.
    if (options.rootFolderId === undefined) removeCanonicalMappingsWithoutRoot(db, libraryId, foldersById)
    removeMigratedExplicitOrphans(db, migratedExplicitOrphans)
    const manualFolderIds = new Set(queryAll<{ folder_id: number }>(db, `
      SELECT DISTINCT m.folder_id
      FROM folder_media_mappings m
      JOIN folders f ON f.id = m.folder_id
      WHERE f.library_id = ? AND m.manual_locked = 1
        ${options.rootFolderId === undefined ? '' : 'AND m.root_folder_id = ?'}
    `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId]).map(row => row.folder_id))
    const claimedPreferredSourceItemIds = new Set<number>()
    for (const [rootId, rootFolders] of foldersByRoot) {
      const root = foldersById.get(rootId)
      if (!root) continue
      const series = queryOne<{ id: number }>(db, `
        SELECT id FROM media_series WHERE library_id = ? AND root_folder_id = ?
        ORDER BY id DESC LIMIT 1
      `, [libraryId, root.id])
      for (const folder of rootFolders.sort((a, b) => a.path.localeCompare(b.path))) {
        result.foldersProcessed++
        if (manualFolderIds.has(folder.id) || excludedFolderIds.has(folder.id)) continue
        const identified = identifyMediaFolder({
          name: folder.name,
          ancestorNames: ancestorNames(folder, foldersById),
          fileNames: (filesByFolder.get(folder.id) ?? []).map(file => file.name || file.path),
        })
        const source = folderMetadataSource(folder)
        const allowUnidentifiedPinnedMember = root.pinned === 1 && folder.parent_id === root.id
        if (!shouldIncludeAutomaticCatalogEntry(identified, source, { allowUnidentifiedPinnedMember })) continue
        const contentIdentity = collectionContentIdentityByFolder.get(folder.id)
          ?? collectionContentIdentity(folder, root, foldersById)
        const stableLocalItem = source && root.pinned === 1
          ? canonicalItemByKey(db, libraryId, canonicalItemKeyForFolder(root, folder, source, contentIdentity))
          : undefined
        const scopedContentIdentity = source !== null && root.pinned === 1 && (
          Boolean(stableLocalItem)
          || folderScopedSourceKeys.has(`${root.id}:${source.source}:${source.externalId}`)
        ) ? contentIdentity : null
        if (stableLocalItem) claimedPreferredSourceItemIds.add(stableLocalItem.id)
        const preferredSourceItemId = scopedContentIdentity !== null && !stableLocalItem
          ? (previousAutomaticItemIdsByFolder.get(folder.id) ?? []).find(itemId =>
              !preserveSourceItemIds.has(itemId) && !claimedPreferredSourceItemIds.has(itemId))
          : undefined
        if (preferredSourceItemId !== undefined) claimedPreferredSourceItemIds.add(preferredSourceItemId)
        const key = canonicalItemKeyForFolder(root, folder, source, scopedContentIdentity)
        const seasonNumbers = identified.kind === 'season' && identified.seasonNumbers.length > 0
          ? identified.seasonNumbers : [null]
        const item = ensureCanonicalMediaItem(db, {
          libraryId,
          rootFolderId: root.id,
          itemKey: key,
          title: folder.name,
          kind: identified.kind,
          seasonNumber: seasonNumbers.length === 1 ? seasonNumbers[0] : null,
          partNumber: identified.partNumber,
          confidence: identified.confidence,
          conflictReason: identified.conflictReason,
          sourceIds: source ? [source] : [],
        }, {
          preferItemKey: scopedContentIdentity !== null,
          preserveSourceItemIds,
          preferredSourceItemId,
        })
        for (const seasonNumber of seasonNumbers) {
          upsertCanonicalMapping(db, {
            folderId: folder.id,
            mediaItemId: item.id,
            rootFolderId: root.id,
            seriesId: series?.id ?? null,
            contentRole: canonicalRole(identified.kind),
            kind: identified.kind,
            seasonNumber,
            partNumber: identified.partNumber,
            confidence: identified.confidence,
            conflictReason: identified.conflictReason,
            detectedBy: identified.detectedBy,
          })
          result.mappingCount++
          if (identified.kind === 'unknown') result.unknownCount++
          if (identified.conflictReason) result.conflictCount++
        }
      }
    }
    removeOrphanedCanonicalMediaItems(db, libraryId, options.rootFolderId)
    rebuildMediaWorkGroups(db, libraryId, foldersById, options.rootFolderId)
    applySingleMainSeasonFallback(db, libraryId, options.rootFolderId)
    appendNewCollectionMembers(db, libraryId, options.rootFolderId)
    if (manageTransaction) run(db, 'COMMIT')
  } catch (error) {
    if (manageTransaction) {
      try { run(db, 'ROLLBACK') } catch { /* preserve original error */ }
    }
    throw error
  }
  result.itemCount = Number(queryOne<{ count: number }>(db, `
    SELECT COUNT(DISTINCT m.id) AS count
    FROM media_items m JOIN folder_media_mappings x ON x.media_item_id = m.id
    WHERE m.library_id = ?
      ${options.rootFolderId === undefined ? '' : 'AND x.root_folder_id = ?'}
  `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId])?.count ?? 0)
  result.unknownCount = Number(queryOne<{ count: number }>(db, `
    SELECT COUNT(*) AS count
    FROM folder_media_mappings m
    JOIN folders f ON f.id = m.folder_id
    WHERE f.library_id = ? AND m.kind = 'unknown'
      ${options.rootFolderId === undefined ? '' : 'AND m.root_folder_id = ?'}
  `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId])?.count ?? 0)
  result.conflictCount = Number(queryOne<{ count: number }>(db, `
    SELECT COUNT(*) AS count
    FROM folder_media_mappings m
    JOIN folders f ON f.id = m.folder_id
    WHERE f.library_id = ? AND m.conflict_reason IS NOT NULL
      ${options.rootFolderId === undefined ? '' : 'AND m.root_folder_id = ?'}
  `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId])?.count ?? 0)
  return result
}

/** Rebuilds the canonical inventory for one library. */
export function rebuildCanonicalMediaCatalog(db: Database, libraryId: number): CanonicalMediaCatalogRebuildResult {
  return rebuildCanonicalMediaCatalogInternal(db, libraryId)
}

interface RebuildOptions {
  manageTransaction?: boolean
  rootFolderId?: number
}

/**
 * Rebuilds the durable folder-to-media catalog from the current scanner rows.
 * Only direct-video folders beneath an is_series root are materialized; the
 * root relationship itself is recursive through the folder parent chain.
 */
function rebuildLibraryMediaCatalogInternal(
  db: Database,
  libraryId: number,
  options: RebuildOptions = {},
): MediaCatalogRebuildResult {
  const manageTransaction = options.manageTransaction !== false
  const folders = queryAll<FolderRow>(db, `
    SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, tmdb_media_type, pinned
    FROM folders WHERE library_id = ? ORDER BY path
  `, [libraryId])
  const files = queryAll<FileRow>(db, `
    SELECT folder_id, name, path, ext FROM files WHERE library_id = ?
  `, [libraryId]).filter(isVideoFile)
  const foldersById = new Map(folders.map(folder => [folder.id, folder]))
  const filesByFolder = new Map<number, FileRow[]>()
  for (const file of files) {
    if (!foldersById.has(file.folder_id)) continue
    const current = filesByFolder.get(file.folder_id) ?? []
    current.push(file)
    filesByFolder.set(file.folder_id, current)
  }

  // Keep the compatibility catalog on the same logical boundary as V2:
  // manually pinned collections must not be split again at an inner
  // scanner-detected series folder.
  const rootForFolder = (folder: FolderRow): FolderRow | null => nearestCanonicalRoot(folder, foldersById)

  const foldersByRoot = new Map<number, FolderRow[]>()
  for (const folder of folders) {
    if (!filesByFolder.has(folder.id)) continue
    const root = rootForFolder(folder)
    if (!root) continue
    if (options.rootFolderId !== undefined && root.id !== options.rootFolderId) continue
    const current = foldersByRoot.get(root.id) ?? []
    current.push(folder)
    foldersByRoot.set(root.id, current)
  }

  const result: MediaCatalogRebuildResult = {
    rootCount: foldersByRoot.size,
    foldersProcessed: 0,
    inserted: 0,
    removedAutomatic: 0,
    preservedManual: 0,
    seasonEntries: 0,
    unknownEntries: 0,
    conflicts: 0,
    canonicalItems: 0,
    canonicalMappings: 0,
    canonicalUnknownItems: 0,
    canonicalConflicts: 0,
  }

  if (manageTransaction) run(db, 'BEGIN')
  try {
    if (options.rootFolderId === undefined) maintainCatalogIntegrity(db, [libraryId])
    const existingCounts = queryOne<{ automatic: number; manual: number }>(db, `
      SELECT
        COALESCE(SUM(CASE WHEN e.manual_locked = 0 THEN 1 ELSE 0 END), 0) AS automatic,
        COALESCE(SUM(CASE WHEN e.manual_locked = 1 THEN 1 ELSE 0 END), 0) AS manual
      FROM folder_media_entries e
      JOIN media_series s ON s.id = e.series_id
      WHERE s.library_id = ?
        ${options.rootFolderId === undefined ? '' : 'AND s.root_folder_id = ?'}
    `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId]) ?? { automatic: 0, manual: 0 }
    result.removedAutomatic = Number(existingCounts.automatic)
    result.preservedManual = Number(existingCounts.manual)
    run(db, `
      DELETE FROM folder_media_entries
      WHERE manual_locked = 0
        AND series_id IN (
          SELECT id FROM media_series WHERE library_id = ?
            ${options.rootFolderId === undefined ? '' : 'AND root_folder_id = ?'}
        )
    `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId])
    const excludedFolderIds = catalogExclusionFolderIds(db, libraryId)
    const scopedFolderIds = options.rootFolderId === undefined
      ? null
      : foldersInCanonicalRoot(options.rootFolderId, foldersById)
    for (const folderId of excludedFolderIds) {
      if (scopedFolderIds && !scopedFolderIds.has(folderId)) continue
      run(db, 'DELETE FROM folder_media_entries WHERE folder_id = ?', [folderId])
    }

    const seriesByRoot = new Map<number, { id: number; root_folder_id: number; title: string }>()
    for (const rootId of [...foldersByRoot.keys()].sort((a, b) => a - b)) {
      const root = foldersById.get(rootId)
      if (!root) continue
      run(db, `
        INSERT INTO media_series (library_id, root_folder_id, series_key, title, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(library_id, series_key) DO UPDATE SET
          root_folder_id = excluded.root_folder_id,
          title = CASE WHEN media_series.manual_locked = 1 THEN media_series.title ELSE excluded.title END,
          updated_at = datetime('now')
      `, [libraryId, root.id, `folder:${root.id}`, root.name])
      const series = queryOne<{ id: number; root_folder_id: number; title: string }>(db, `
        SELECT id, root_folder_id, title FROM media_series WHERE library_id = ? AND series_key = ?
      `, [libraryId, `folder:${root.id}`])
      if (series) seriesByRoot.set(root.id, series)
    }

    // A cross-library move keeps the physical folder and manual rows intact,
    // but its media_series belongs to the old library. Reattach manual rows to
    // the series now owning the folder before inserting fresh automatic rows.
    for (const folder of folders) {
      const root = rootForFolder(folder)
      if (!root) continue
      if (options.rootFolderId !== undefined && root.id !== options.rootFolderId) continue
      const series = seriesByRoot.get(root.id)
      if (!series) continue
      run(db, `
        UPDATE folder_media_entries
        SET series_id = ?, updated_at = datetime('now')
        WHERE folder_id = ? AND manual_locked = 1
      `, [series.id, folder.id])
    }

    const manualFolderIds = new Set(queryAll<{ folder_id: number }>(db, `
      SELECT DISTINCT e.folder_id
      FROM folder_media_entries e
      JOIN media_series s ON s.id = e.series_id
      WHERE s.library_id = ? AND e.manual_locked = 1
        ${options.rootFolderId === undefined ? '' : 'AND s.root_folder_id = ?'}
    `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId]).map(row => row.folder_id))

    const insert = db.prepare(`
      INSERT INTO folder_media_entries (
        folder_id, series_id, kind, season_number, part_number,
        custom_label, source, external_id, confidence, detected_by, conflict_reason, manual_locked
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0)
    `)
    try {
      for (const [rootId, rootFolders] of foldersByRoot) {
        const root = foldersById.get(rootId)
        if (!root) continue
        const series = seriesByRoot.get(rootId)
        if (!series) continue
        for (const folder of rootFolders.sort((a, b) => a.path.localeCompare(b.path))) {
          result.foldersProcessed++
          // A manual classification is an override, not an additional opinion:
          // keep only the locked rows until the user explicitly restores auto.
          if (manualFolderIds.has(folder.id) || excludedFolderIds.has(folder.id)) continue
          const folderFiles = filesByFolder.get(folder.id) ?? []
          const identified = identifyMediaFolder({
            name: folder.name,
            ancestorNames: ancestorNames(folder, foldersById),
            fileNames: folderFiles.map(file => file.name || file.path),
          })
          const entrySeasonNumbers = identified.kind === 'season' && identified.seasonNumbers.length > 0
            ? identified.seasonNumbers
            : [null]
          const source = folder.anilist_id === null || folder.anilist_id === undefined ? null : folder.source || null
          const externalId = folder.anilist_id === null || folder.anilist_id === undefined ? null : String(folder.anilist_id)
          const allowUnidentifiedPinnedMember = root.pinned === 1 && folder.parent_id === root.id
          if (!shouldIncludeAutomaticCatalogEntry(
            identified,
            source ? { source, externalId: externalId! } : null,
            { allowUnidentifiedPinnedMember },
          )) continue
          for (const seasonNumber of entrySeasonNumbers) {
            insert.run([
              folder.id,
              series.id,
              identified.kind,
              seasonNumber,
              identified.partNumber,
              source,
              externalId,
              identified.confidence,
              identified.detectedBy,
              identified.conflictReason,
            ])
            result.inserted++
            if (identified.kind === 'season') result.seasonEntries++
            if (identified.kind === 'unknown') result.unknownEntries++
            if (identified.conflictReason) result.conflicts++
          }
        }
      }
    } finally {
      insert.finalize()
    }
    // Remove automatic series shells left behind by deleted folders, renamed
    // roots, or cross-library moves. Manual series rows remain available even
    // when they currently have no entries.
    run(db, `
      DELETE FROM media_series
      WHERE manual_locked = 0
        ${options.rootFolderId === undefined ? '' : 'AND root_folder_id = ?'}
        AND NOT EXISTS (
          SELECT 1 FROM folder_media_entries e WHERE e.series_id = media_series.id
        )
    `, options.rootFolderId === undefined ? [] : [options.rootFolderId])
    const canonical = rebuildCanonicalMediaCatalogInternal(db, libraryId, {
      manageTransaction: false,
      rootFolderId: options.rootFolderId,
      integrityPrepared: options.rootFolderId === undefined,
    })
    result.canonicalItems = canonical.itemCount
    result.canonicalMappings = canonical.mappingCount
    result.canonicalUnknownItems = canonical.unknownCount
    result.canonicalConflicts = canonical.conflictCount
    const finalLegacyCounts = queryOne<{ seasons: number; unknowns: number; conflicts: number }>(db, `
      SELECT
        COALESCE(SUM(CASE WHEN e.manual_locked = 0 AND e.kind = 'season' THEN 1 ELSE 0 END), 0) AS seasons,
        COALESCE(SUM(CASE WHEN e.manual_locked = 0 AND e.kind = 'unknown' THEN 1 ELSE 0 END), 0) AS unknowns,
        COALESCE(SUM(CASE WHEN e.manual_locked = 0 AND e.conflict_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS conflicts
      FROM folder_media_entries e
      JOIN media_series s ON s.id = e.series_id
      WHERE s.library_id = ?
        ${options.rootFolderId === undefined ? '' : 'AND s.root_folder_id = ?'}
    `, options.rootFolderId === undefined ? [libraryId] : [libraryId, options.rootFolderId])
    result.seasonEntries = Number(finalLegacyCounts?.seasons ?? result.seasonEntries)
    result.unknownEntries = Number(finalLegacyCounts?.unknowns ?? result.unknownEntries)
    result.conflicts = Number(finalLegacyCounts?.conflicts ?? result.conflicts)
    if (options.rootFolderId === undefined) clearCatalogDirty(db, [libraryId])
    if (manageTransaction) run(db, 'COMMIT')
    return result
  } catch (error) {
    if (manageTransaction) {
      try { run(db, 'ROLLBACK') } catch { /* preserve the original rebuild error */ }
    }
    throw error
  }
}

export function rebuildLibraryMediaCatalog(db: Database, libraryId: number): MediaCatalogRebuildResult {
  return rebuildLibraryMediaCatalogInternal(db, libraryId)
}

/** Rebuilds a library catalog inside a transaction owned by the caller. */
export function rebuildLibraryMediaCatalogInTransaction(db: Database, libraryId: number): MediaCatalogRebuildResult {
  return rebuildLibraryMediaCatalogInternal(db, libraryId, { manageTransaction: false })
}

/** Rebuilds exactly one canonical root inside a transaction owned by the caller. */
export function rebuildMediaCatalogForRootInTransaction(
  db: Database,
  rootFolderId: number,
): MediaCatalogRebuildResult {
  const root = folderById(db, rootFolderId)
  if (!root) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  return rebuildLibraryMediaCatalogInternal(db, root.library_id, {
    manageTransaction: false,
    rootFolderId,
  })
}

const catalogKindOrder: Record<MediaCatalogKind, number> = {
  season: 0,
  custom: 1,
  ova: 2,
  special: 3,
  movie: 4,
  extras: 5,
  unknown: 6,
}

function folderById(db: Database, folderId: number): FolderRow | undefined {
  return queryOne<FolderRow>(db, `
    SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, tmdb_media_type, pinned
    FROM folders WHERE id = ?
  `, [folderId])
}

/**
 * Resolves the canonical V2 boundary for one physical folder. A pinned
 * ancestor always wins over an inner scanner-detected series marker; when no
 * collection boundary exists, the nearest is_series ancestor is used.
 */
function nearestCanonicalRootByDb(db: Database, folderId: number): FolderRow | null {
  let current = folderById(db, folderId)
  const seen = new Set<number>()
  let nearestSeries: FolderRow | null = null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.pinned === 1) return current
    if (!nearestSeries && current.is_series === 1) nearestSeries = current
    current = current.parent_id === null ? undefined : folderById(db, current.parent_id)
  }
  return nearestSeries
}

function emptyCanonicalSnapshot(rootFolderId: number): CanonicalMediaCatalogSnapshot {
  return {
    root_folder_id: rootFolderId,
    items: [],
    mappings: [],
    work_groups: [],
    ungrouped_item_ids: [],
    summary: {
      root_folder_id: rootFolderId,
      item_count: 0,
      mapping_count: 0,
      season_numbers: [],
      manual_count: 0,
      conflict_count: 0,
      unknown_count: 0,
    },
  }
}

const CANONICAL_MAPPING_CONFLICT_REASON = '多个物理目录的识别结果不一致'

interface CanonicalMappingIdentity {
  kind: MediaCatalogKind
  season_number: number | null
  part_number: number | null
  custom_label: string | null
}

function canonicalMappingIdentity(mapping: Pick<CanonicalMappingRow, 'kind' | 'season_number' | 'part_number' | 'custom_label'>): CanonicalMappingIdentity {
  const customLabel = mapping.custom_label?.trim() || null
  return {
    kind: projectedMediaCatalogKind(mapping.kind, customLabel),
    season_number: mapping.season_number,
    part_number: mapping.part_number,
    custom_label: customLabel,
  }
}

function canonicalMappingKey(mapping: Pick<CanonicalMappingRow, 'kind' | 'season_number' | 'part_number' | 'custom_label'>): string {
  return JSON.stringify(canonicalMappingIdentity(mapping))
}

function parseCanonicalMappingKey(value: string): CanonicalMappingIdentity {
  return JSON.parse(value) as CanonicalMappingIdentity
}

function projectCanonicalItem(
  item: CanonicalItemRow,
  mappings: CanonicalMappingRow[],
): CanonicalItemRow {
  const byFolder = new Map<number, Set<string>>()
  for (const mapping of mappings) {
    const keys = byFolder.get(mapping.folder_id) ?? new Set<string>()
    keys.add(canonicalMappingKey(mapping))
    byFolder.set(mapping.folder_id, keys)
  }
  const folderSignatures = [...byFolder.values()]
    .map(keys => [...keys]
      .map(key => {
        const identity = parseCanonicalMappingKey(key)
        const label = identity.kind === 'custom' ? identity.custom_label ?? '' : ''
        // Part numbers describe release layout and do not make two folders
        // different seasons for the folder-level conflict check.
        return `${identity.kind}:${identity.season_number ?? ''}:${label}`
      })
      .sort()
      .join('|'))
  const hasFolderConflict = new Set(folderSignatures).size > 1
  const mappingKeys = [...new Set(mappings.map(mapping => canonicalMappingKey(mapping)))]
  const parsed = mappingKeys.map(parseCanonicalMappingKey)
  const sameKind = parsed.length > 0 && parsed.every(value => value.kind === parsed[0].kind)
  const seasonOnly = sameKind && parsed[0]?.kind === 'season'
  const seasonValues = [...new Set(parsed
    .filter(value => value.kind === 'season')
    .map(value => value.season_number))]
  const partValues = [...new Set(parsed
    .filter(value => value.kind === 'season')
    .map(value => value.part_number))]
  // Part numbers describe physical release layout, not a second logical
  // season. If every folder agrees on season N, differing parts are still one
  // confirmed season and the part is retained only on each mapping row.
  const isSeasonRange = seasonOnly
  const hasClassificationConflict = hasFolderConflict || (mappingKeys.length > 1 && !isSeasonRange)
  let kind = item.kind
  let seasonNumber = item.season_number
  let partNumber = item.part_number
  let customLabel = item.custom_label
  if (hasClassificationConflict) {
    kind = 'unknown'
    seasonNumber = null
    partNumber = null
    customLabel = null
  } else if (parsed.length === 1) {
    kind = parsed[0].kind
    seasonNumber = parsed[0].season_number
    partNumber = parsed[0].part_number
    customLabel = parsed[0].custom_label
  } else if (isSeasonRange) {
    kind = 'season'
    seasonNumber = seasonValues.length === 1 ? seasonValues[0] ?? null : null
    partNumber = partValues.length === 1 ? partValues[0] ?? null : null
    customLabel = null
  }
  return {
    ...item,
    kind,
    season_number: seasonNumber,
    part_number: partNumber,
    custom_label: customLabel,
    conflict_reason: hasClassificationConflict
      ? (item.conflict_reason ?? CANONICAL_MAPPING_CONFLICT_REASON)
      : item.conflict_reason,
  }
}

interface CanonicalItemSortData {
  kindOrder: number
  season: number
  part: number
  path: string
}

function canonicalItemSortData(
  item: MediaCatalogItemView,
  mappings: CanonicalMappingRow[],
): CanonicalItemSortData {
  const projectedItemKind = projectedMediaCatalogKind(item.kind, item.custom_label)
  const kindOrder = projectedItemKind === 'unknown'
    ? catalogKindOrder.unknown
    : mappings.length > 0
    ? Math.min(...mappings.map(mapping => catalogKindOrder[projectedMediaCatalogKind(mapping.kind, mapping.custom_label)]))
    : catalogKindOrder[projectedItemKind]
  const seasonValues = mappings
    .filter(mapping => mapping.kind === 'season' && mapping.season_number !== null)
    .map(mapping => mapping.season_number as number)
  const season = seasonValues.length > 0
    ? Math.min(...seasonValues)
    : (item.season_number ?? Number.MAX_SAFE_INTEGER)
  const partValues = mappings
    .filter(mapping => mapping.season_number === season && mapping.part_number !== null)
    .map(mapping => mapping.part_number as number)
  const part = partValues.length > 0
    ? Math.min(...partValues)
    : (item.part_number ?? (season !== Number.MAX_SAFE_INTEGER ? 0 : Number.MAX_SAFE_INTEGER))
  const pathValues = mappings.map(mapping => mapping.folder_path).filter(Boolean).sort()
  return {
    kindOrder,
    season,
    part,
    path: pathValues[0] ?? '',
  }
}

function compareCanonicalItems(
  left: MediaCatalogItemView,
  right: MediaCatalogItemView,
  mappingsByItem: Map<number, CanonicalMappingRow[]>,
): number {
  const leftSort = canonicalItemSortData(left, mappingsByItem.get(left.id) ?? [])
  const rightSort = canonicalItemSortData(right, mappingsByItem.get(right.id) ?? [])
  return leftSort.kindOrder - rightSort.kindOrder ||
    leftSort.season - rightSort.season ||
    leftSort.part - rightSort.part ||
    leftSort.path.localeCompare(rightSort.path) ||
    left.id - right.id
}

function readCanonicalMediaWorkGroups(
  db: Database,
  rootFolderId: number,
  itemViews: MediaCatalogItemView[],
  mappings: CanonicalMappingRow[],
): CanonicalMediaWorkGroupView[] {
  const groups = queryAll<MediaWorkGroupRow & { anchor_path: string | null }>(db, `
    SELECT g.id, g.library_id, g.root_folder_id, g.anchor_folder_id,
           g.group_key, g.title, g.manual_locked,
           f.path AS anchor_path
    FROM media_work_groups g
    LEFT JOIN folders f ON f.id = g.anchor_folder_id
    WHERE g.root_folder_id = ?
    ORDER BY COALESCE(f.path, ''), g.group_key, g.id
  `, [rootFolderId])
  const members = queryAll<MediaWorkGroupMemberRow>(db, `
    SELECT m.id, m.work_group_id, m.media_item_id, m.relation_role, m.manual_locked
    FROM media_work_group_members m
    JOIN media_work_groups g ON g.id = m.work_group_id
    WHERE g.root_folder_id = ?
    ORDER BY m.work_group_id, m.id
  `, [rootFolderId])
  const membersByGroup = new Map<number, MediaWorkGroupMemberRow[]>()
  for (const member of members) {
    const current = membersByGroup.get(member.work_group_id) ?? []
    current.push(member)
    membersByGroup.set(member.work_group_id, current)
  }
  const itemById = new Map(itemViews.map(item => [item.id, item]))
  return groups.map(group => {
    const groupMembers = membersByGroup.get(group.id) ?? []
    const memberItemIds = [...new Set(groupMembers.map(member => member.media_item_id))]
    const memberItemIdSet = new Set(memberItemIds)
    const itemIds = itemViews
      .filter(item => memberItemIdSet.has(item.id))
      .map(item => item.id)
    for (const itemId of memberItemIds.sort((left, right) => left - right)) {
      if (!itemIds.includes(itemId)) itemIds.push(itemId)
    }
    const groupMappings = mappings.filter(mapping => memberItemIdSet.has(mapping.media_item_id))
    const seasonNumbers = asNumberArray(groupMappings
      .filter(mapping => mapping.kind === 'season' && mapping.season_number !== null)
      .map(mapping => mapping.season_number as number))
    const unknownItemIds = new Set(groupMappings
      .filter(mapping => mapping.kind === 'unknown')
      .map(mapping => mapping.media_item_id))
    const unknownCount = itemIds.filter(itemId =>
      itemById.get(itemId)?.kind === 'unknown' || unknownItemIds.has(itemId)).length
    const logicalAnchor = group.anchor_folder_id ??
      (group.group_key === `root:${rootFolderId}` ? rootFolderId : null)
    return {
      ...resolveFolderMediaDomain(db, groupMappings[0]?.folder_id ?? logicalAnchor ?? rootFolderId),
      id: group.id,
      key: group.group_key,
      group_key: group.group_key,
      title: group.title,
      anchor: logicalAnchor,
      anchor_folder_id: group.anchor_folder_id,
      manual_locked: group.manual_locked,
      item_ids: itemIds,
      members: groupMembers.map(member => ({
        id: member.id,
        media_item_id: member.media_item_id,
        relation_role: member.relation_role,
        manual_locked: member.manual_locked,
      })),
      summary: {
        item_count: itemIds.length,
        physical_folder_count: new Set(groupMappings.map(mapping => mapping.folder_id)).size,
        season_numbers: seasonNumbers,
        manual_count: groupMembers.filter(member => member.manual_locked === 1).length,
        conflict_count: groupMappings.filter(mapping => Boolean(mapping.conflict_reason)).length,
        unknown_count: unknownCount,
      },
    }
  })
}

/** Reads canonical items and all physical mappings below one series root. */
export function getCanonicalMediaCatalogForRoot(db: Database, rootFolderId: number): CanonicalMediaCatalogSnapshot {
  if (!Number.isInteger(rootFolderId) || rootFolderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = folderById(db, rootFolderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const root = nearestCanonicalRootByDb(db, rootFolderId)
  if (!root) return emptyCanonicalSnapshot(folder.id)

  const mappings = queryAll<CanonicalMappingRow>(db, `
    SELECT m.id, m.folder_id, m.media_item_id, m.root_folder_id, m.series_id,
           m.content_role, m.kind, m.season_number, m.part_number, m.custom_label,
           f.name AS folder_name, f.path AS folder_path,
           m.manual_locked, m.confidence, m.conflict_reason, m.detected_by
    FROM folder_media_mappings m
    JOIN folders f ON f.id = m.folder_id
    WHERE m.root_folder_id = ?
    ORDER BY m.id
  `, [root.id])
  const groupedItemIds = queryAll<{ media_item_id: number }>(db, `
    SELECT DISTINCT m.media_item_id
    FROM media_work_group_members m
    JOIN media_work_groups g ON g.id = m.work_group_id
    WHERE g.root_folder_id = ?
  `, [root.id]).map(member => member.media_item_id)
  const ungroupedItemIds = queryAll<{ media_item_id: number }>(db, `
    SELECT DISTINCT e.media_item_id
    FROM media_work_group_exclusions e
    JOIN folder_media_mappings mapping
      ON mapping.root_folder_id = e.root_folder_id
     AND mapping.media_item_id = e.media_item_id
    WHERE e.root_folder_id = ?
    ORDER BY e.media_item_id
  `, [root.id]).map(row => row.media_item_id)
  const itemIds = [...new Set([
    ...mappings.map(mapping => mapping.media_item_id),
    ...groupedItemIds,
  ])]
  if (itemIds.length === 0) {
    return {
      ...emptyCanonicalSnapshot(root.id),
      work_groups: readCanonicalMediaWorkGroups(db, root.id, [], mappings),
      ungrouped_item_ids: ungroupedItemIds,
    }
  }
  const itemPlaceholders = itemIds.map(() => '?').join(', ')
  const items = queryAll<CanonicalItemRow>(db, `
    SELECT m.id, m.library_id, m.root_folder_id, m.item_key, m.title,
           m.title_zh, m.kind, m.season_number, m.part_number, NULL AS custom_label, m.manual_locked,
           m.confidence, m.conflict_reason
    FROM media_items m
    WHERE m.id IN (${itemPlaceholders})
    ORDER BY m.id
  `, itemIds)
  const sources = queryAll<{ media_item_id: number; source: string; external_id: string; is_primary: number }>(db, `
    SELECT s.media_item_id, s.source, s.external_id, s.is_primary
    FROM media_item_sources s
    WHERE s.media_item_id IN (${itemPlaceholders})
    ORDER BY s.media_item_id, s.is_primary DESC, s.source, s.external_id
  `, itemIds)
  const sourcesByItem = new Map<number, MediaItemSourceView[]>()
  for (const source of sources) {
    const list = sourcesByItem.get(source.media_item_id) ?? []
    list.push({ source: source.source, external_id: source.external_id, is_primary: source.is_primary })
    sourcesByItem.set(source.media_item_id, list)
  }
  const mappingsByItem = new Map<number, CanonicalMappingRow[]>()
  for (const mapping of mappings) {
    const list = mappingsByItem.get(mapping.media_item_id) ?? []
    list.push(mapping)
    mappingsByItem.set(mapping.media_item_id, list)
  }
  const itemViews: MediaCatalogItemView[] = items.map(item => ({
    ...projectCanonicalItem(item, mappingsByItem.get(item.id) ?? []),
    ...resolveFolderMediaDomain(db, mappingsByItem.get(item.id)?.[0]?.folder_id ?? root.id),
    source_ids: sourcesByItem.get(item.id) ?? [],
  }))
  itemViews.sort((left, right) => compareCanonicalItems(left, right, mappingsByItem))
  const mappingDomains = resolveFolderMediaDomains(db, mappings.map(mapping => mapping.folder_id))
  const projectedMappings = mappings.map(mapping => ({
    ...mapping,
    ...mappingDomains.get(mapping.folder_id),
    kind: projectedMediaCatalogKind(mapping.kind, mapping.custom_label),
  }))
  projectedMappings.sort((left, right) => {
    const kind = catalogKindOrder[left.kind] - catalogKindOrder[right.kind]
    if (kind !== 0) return kind
    const season = (left.season_number ?? Number.MAX_SAFE_INTEGER) - (right.season_number ?? Number.MAX_SAFE_INTEGER)
    if (season !== 0) return season
    const leftSeason = left.season_number ?? Number.MAX_SAFE_INTEGER
    const rightSeason = right.season_number ?? Number.MAX_SAFE_INTEGER
    const part = (left.part_number ?? (leftSeason !== Number.MAX_SAFE_INTEGER ? 0 : Number.MAX_SAFE_INTEGER)) -
      (right.part_number ?? (rightSeason !== Number.MAX_SAFE_INTEGER ? 0 : Number.MAX_SAFE_INTEGER))
    if (part !== 0) return part
    const pathOrder = left.folder_path.localeCompare(right.folder_path)
    return pathOrder !== 0 ? pathOrder : left.id - right.id
  })
  const seasonNumbers = asNumberArray(projectedMappings
    .filter(mapping => mapping.kind === 'season' && mapping.season_number !== null)
    .map(mapping => mapping.season_number as number))
  return {
    root_folder_id: root.id,
    items: itemViews,
    mappings: projectedMappings,
    summary: {
      root_folder_id: root.id,
      item_count: itemViews.length,
      mapping_count: projectedMappings.length,
      season_numbers: seasonNumbers,
      manual_count: projectedMappings.filter(mapping => mapping.manual_locked === 1).length,
      conflict_count: projectedMappings.filter(mapping => Boolean(mapping.conflict_reason)).length,
      unknown_count: itemViews.filter(item => item.kind === 'unknown').length,
    },
    work_groups: readCanonicalMediaWorkGroups(db, root.id, itemViews, projectedMappings),
    ungrouped_item_ids: ungroupedItemIds,
  }
}

/** Rebuilds the library containing one series root and returns its snapshot. */
export function rebuildMediaCatalogForRoot(db: Database, rootFolderId: number): MediaCatalogRebuildResult {
  if (!Number.isInteger(rootFolderId) || rootFolderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = folderById(db, rootFolderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  return rebuildLibraryMediaCatalog(db, folder.library_id)
}

/** Saves a user-facing title for the canonical series represented by a folder. */
export function setMediaCatalogTitle(
  db: Database,
  folderId: number,
  title: string,
): MediaCatalogSnapshot {
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = folderById(db, folderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const root = nearestCanonicalRootByDb(db, folderId)
  if (!root) throw new MediaCatalogValidationError('文件夹不属于任何系列根目录', 409, 'MEDIA_CATALOG_ROOT_NOT_FOUND')
  const normalizedTitle = String(title ?? '').trim()
  if (!normalizedTitle) throw new MediaCatalogValidationError('系列标题不能为空', 400, 'INVALID_MEDIA_CATALOG_TITLE')

  run(db, 'BEGIN')
  try {
    run(db, `
      INSERT INTO media_series (library_id, root_folder_id, series_key, title, manual_locked, updated_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(library_id, series_key) DO UPDATE SET
        root_folder_id = excluded.root_folder_id,
        title = excluded.title,
        manual_locked = 1,
        updated_at = datetime('now')
    `, [folder.library_id, root.id, `folder:${root.id}`, normalizedTitle])
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, folder.id)
}

interface MediaWorkGroupMutationContext {
  folder: FolderRow
  root: FolderRow
  group: MediaWorkGroupRow
}

function mediaWorkGroupById(db: Database, groupId: number): MediaWorkGroupRow | undefined {
  return queryOne<MediaWorkGroupRow>(db, `
    SELECT id, library_id, root_folder_id, anchor_folder_id,
           group_key, title, manual_locked
    FROM media_work_groups WHERE id = ?
  `, [groupId])
}

function mediaWorkGroupMembers(db: Database, groupId: number): MediaWorkGroupMemberRow[] {
  return queryAll<MediaWorkGroupMemberRow>(db, `
    SELECT id, work_group_id, media_item_id, relation_role, manual_locked
    FROM media_work_group_members
    WHERE work_group_id = ?
    ORDER BY id
  `, [groupId])
}

function mediaWorkGroupMutationContext(
  db: Database,
  folderId: number,
  groupId: number,
): MediaWorkGroupMutationContext {
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  if (!Number.isInteger(groupId) || groupId <= 0) {
    throw new MediaCatalogValidationError('作品组编号无效', 400, 'INVALID_MEDIA_WORK_GROUP_ID')
  }
  const folder = folderById(db, folderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const root = nearestCanonicalRootByDb(db, folderId)
  if (!root) throw new MediaCatalogValidationError('文件夹不属于任何系列根目录', 409, 'MEDIA_CATALOG_ROOT_NOT_FOUND')
  const group = mediaWorkGroupById(db, groupId)
  if (!group) throw new MediaCatalogValidationError('作品组不存在', 404, 'MEDIA_WORK_GROUP_NOT_FOUND')
  if (group.library_id !== folder.library_id || group.root_folder_id !== root.id) {
    throw new MediaCatalogValidationError('作品组不属于当前文件夹的系列范围', 409, 'MEDIA_WORK_GROUP_SCOPE_MISMATCH')
  }
  return { folder, root, group }
}

function uniqueManualMediaWorkGroupKey(
  db: Database,
  libraryId: number,
  rootFolderId: number,
  baseKey: string,
): string {
  let key = baseKey
  let suffix = 2
  while (queryOne<{ id: number }>(db, `
    SELECT id
    FROM media_work_groups
    WHERE library_id = ? AND root_folder_id = ? AND group_key = ?
  `, [libraryId, rootFolderId, key])) {
    key = `${baseKey}:${suffix}`
    suffix += 1
  }
  return key
}

function normalizedMediaWorkGroupTitle(value: unknown, fallback?: unknown): string {
  const candidate = value === undefined || value === null ? fallback : value
  if (typeof candidate !== 'string') {
    throw new MediaCatalogValidationError('作品组标题不能为空', 400, 'INVALID_MEDIA_WORK_GROUP_TITLE')
  }
  const normalized = candidate.trim()
  if (!normalized) {
    throw new MediaCatalogValidationError('作品组标题不能为空', 400, 'INVALID_MEDIA_WORK_GROUP_TITLE')
  }
  return normalized
}

/** Renames one canonical work group and makes the title durable across rebuilds. */
export function setMediaWorkGroupTitle(
  db: Database,
  folderId: number,
  groupId: number,
  title: string,
): MediaCatalogSnapshot {
  const context = mediaWorkGroupMutationContext(db, folderId, groupId)
  const normalizedTitle = normalizedMediaWorkGroupTitle(title)
  run(db, 'BEGIN')
  try {
    run(db, `
      UPDATE media_work_groups
      SET title = ?, manual_locked = 1, updated_at = datetime('now')
      WHERE id = ?
    `, [normalizedTitle, context.group.id])
    rebuildLibraryMediaCatalogInTransaction(db, context.folder.library_id)
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, context.folder.id)
}

/** Merges all members of one scoped source group into a distinct target group. */
export function mergeMediaWorkGroups(
  db: Database,
  folderId: number,
  targetGroupId: number,
  sourceGroupId: number,
): MediaCatalogSnapshot {
  const targetContext = mediaWorkGroupMutationContext(db, folderId, targetGroupId)
  const sourceContext = mediaWorkGroupMutationContext(db, folderId, sourceGroupId)
  if (targetContext.group.id === sourceContext.group.id) {
    throw new MediaCatalogValidationError('目标作品组和来源作品组必须不同', 400, 'MEDIA_WORK_GROUPS_MUST_DIFFER')
  }

  run(db, 'BEGIN')
  try {
    run(db, `
      UPDATE media_work_group_members
      SET manual_locked = 1, updated_at = datetime('now')
      WHERE work_group_id = ?
    `, [targetContext.group.id])
    run(db, `
      UPDATE media_work_group_members
      SET work_group_id = ?, manual_locked = 1, updated_at = datetime('now')
      WHERE work_group_id = ?
    `, [targetContext.group.id, sourceContext.group.id])
    run(db, `
      UPDATE media_work_groups
      SET manual_locked = 1, updated_at = datetime('now')
      WHERE id = ?
    `, [targetContext.group.id])
    run(db, 'DELETE FROM media_work_groups WHERE id = ?', [sourceContext.group.id])
    rebuildLibraryMediaCatalogInTransaction(db, targetContext.folder.library_id)
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, targetContext.folder.id)
}

/** Detaches one member into a new independent locked work group. */
export function detachMediaWorkGroupItem(
  db: Database,
  folderId: number,
  groupId: number,
  mediaItemId: number,
  title?: string,
): MediaCatalogSnapshot {
  const context = mediaWorkGroupMutationContext(db, folderId, groupId)
  if (!Number.isInteger(mediaItemId) || mediaItemId <= 0) {
    throw new MediaCatalogValidationError('媒体条目编号无效', 400, 'INVALID_MEDIA_ITEM_ID')
  }
  const members = mediaWorkGroupMembers(db, context.group.id)
  const member = members.find(candidate => candidate.media_item_id === mediaItemId)
  if (!member) {
    throw new MediaCatalogValidationError('媒体条目不属于来源作品组', 409, 'MEDIA_ITEM_NOT_IN_MEDIA_WORK_GROUP')
  }
  const item = canonicalItemById(db, mediaItemId)
  if (!item) throw new MediaCatalogValidationError('规范媒体条目不存在', 404, 'MEDIA_ITEM_NOT_FOUND')
  // Keep validating the legacy optional title argument for API compatibility,
  // but detaching no longer creates a synthetic one-item group.
  if (title !== undefined) normalizedMediaWorkGroupTitle(title, item.title)

  run(db, 'BEGIN')
  try {
    run(db, `
      DELETE FROM media_work_group_members WHERE id = ?
    `, [member.id])
    run(db, `
      DELETE FROM media_work_groups
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM media_work_group_members
          WHERE work_group_id = media_work_groups.id
        )
    `, [context.group.id])
    run(db, `
      INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(root_folder_id, media_item_id) DO UPDATE SET updated_at = datetime('now')
    `, [context.root.id, item.id])
    rebuildLibraryMediaCatalogInTransaction(db, context.folder.library_id)
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, context.folder.id)
}

/** Reattaches one explicitly ungrouped item to an existing scoped group. */
export function attachMediaWorkGroupItem(
  db: Database,
  folderId: number,
  groupId: number,
  mediaItemId: number,
): MediaCatalogSnapshot {
  const context = mediaWorkGroupMutationContext(db, folderId, groupId)
  if (!Number.isInteger(mediaItemId) || mediaItemId <= 0) {
    throw new MediaCatalogValidationError('媒体条目编号无效', 400, 'INVALID_MEDIA_ITEM_ID')
  }
  const item = canonicalItemById(db, mediaItemId)
  if (!item) throw new MediaCatalogValidationError('规范媒体条目不存在', 404, 'MEDIA_ITEM_NOT_FOUND')
  const mapping = queryOne<{ id: number }>(db, `
    SELECT id
    FROM folder_media_mappings
    WHERE root_folder_id = ? AND media_item_id = ?
    LIMIT 1
  `, [context.root.id, mediaItemId])
  if (!mapping) {
    throw new MediaCatalogValidationError('媒体条目不属于当前系列范围', 409, 'MEDIA_ITEM_SCOPE_MISMATCH')
  }
  const existingMember = queryOne<{ id: number; work_group_id: number }>(db, `
    SELECT id, work_group_id
    FROM media_work_group_members
    WHERE media_item_id = ?
    LIMIT 1
  `, [mediaItemId])
  if (existingMember) {
    if (existingMember.work_group_id === context.group.id) return getMediaCatalogForFolder(db, context.folder.id)
    throw new MediaCatalogValidationError('媒体条目已经属于其他作品组', 409, 'MEDIA_ITEM_ALREADY_IN_MEDIA_WORK_GROUP')
  }

  run(db, 'BEGIN')
  try {
    run(db, `
      DELETE FROM media_work_group_exclusions
      WHERE root_folder_id = ? AND media_item_id = ?
    `, [context.root.id, mediaItemId])
    run(db, `
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role, manual_locked, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'))
    `, [context.group.id, mediaItemId, workGroupRelationRole(item.kind, item.title)])
    rebuildLibraryMediaCatalogInTransaction(db, context.folder.library_id)
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, context.folder.id)
}

/** Splits a proper, non-empty subset into a new independent locked work group. */
export function splitMediaWorkGroup(
  db: Database,
  folderId: number,
  groupId: number,
  mediaItemIds: number[],
  title: string,
): MediaCatalogSnapshot {
  const context = mediaWorkGroupMutationContext(db, folderId, groupId)
  const normalizedTitle = normalizedMediaWorkGroupTitle(title)
  if (!Array.isArray(mediaItemIds) || mediaItemIds.length === 0) {
    throw new MediaCatalogValidationError('mediaItemIds 必须是非空数组', 400, 'INVALID_MEDIA_ITEM_IDS')
  }
  const selectedIds = [...new Set(mediaItemIds)]
  if (selectedIds.some(itemId => !Number.isInteger(itemId) || itemId <= 0)) {
    throw new MediaCatalogValidationError('mediaItemIds 必须是正整数数组', 400, 'INVALID_MEDIA_ITEM_IDS')
  }
  const members = mediaWorkGroupMembers(db, context.group.id)
  if (selectedIds.length >= members.length) {
    throw new MediaCatalogValidationError('只能拆分来源作品组的部分成员', 400, 'MEDIA_WORK_GROUP_SPLIT_REQUIRES_PROPER_SUBSET')
  }
  const selectedMembers = members.filter(member => selectedIds.includes(member.media_item_id))
  if (selectedMembers.length !== selectedIds.length) {
    throw new MediaCatalogValidationError('所选媒体条目不属于来源作品组', 409, 'MEDIA_ITEM_NOT_IN_MEDIA_WORK_GROUP')
  }

  run(db, 'BEGIN')
  try {
    const groupKey = uniqueManualMediaWorkGroupKey(
      db,
      context.folder.library_id,
      context.root.id,
      `manual:split:${context.root.id}:${selectedIds.slice().sort((a, b) => a - b).join('-')}`,
    )
    const inserted = run(db, `
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked)
      VALUES (?, ?, NULL, ?, ?, 1)
    `, [context.folder.library_id, context.root.id, groupKey, normalizedTitle])
    const newGroupId = Number(inserted.lastInsertRowid)
    for (const member of selectedMembers) {
      run(db, `
        UPDATE media_work_group_members
        SET work_group_id = ?, manual_locked = 1, updated_at = datetime('now')
        WHERE id = ?
      `, [newGroupId, member.id])
    }
    rebuildLibraryMediaCatalogInTransaction(db, context.folder.library_id)
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, context.folder.id)
}

/**
 * Reads the durable catalog belonging to the nearest is_series ancestor of a
 * physical folder. The returned rows deliberately keep snake_case names so
 * the response can be passed through without losing the database vocabulary.
 */
export function getMediaCatalogForFolder(db: Database, folderId: number): MediaCatalogSnapshot {
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = folderById(db, folderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const canonicalRoot = nearestCanonicalRootByDb(db, folderId)
  // The legacy compatibility rows intentionally follow the same boundary as
  // V2 so pinned non-series collections remain editable and readable.
  const legacyRoot = canonicalRoot
  const canonical = canonicalRoot ? getCanonicalMediaCatalogForRoot(db, canonicalRoot.id) : emptyCanonicalSnapshot(folder.id)
  if (!legacyRoot) return { entries: [], summary: null, canonical, candidates: [] }
  const series = queryOne<{ id: number; series_key: string; title: string }>(db, `
    SELECT id, series_key, title
    FROM media_series
    WHERE library_id = ? AND root_folder_id = ?
    ORDER BY id DESC LIMIT 1
  `, [legacyRoot.library_id, legacyRoot.id])
  if (!series) return { entries: [], summary: null, canonical, candidates: getMediaCatalogCandidates(db, legacyRoot) }

  const entries = queryAll<MediaCatalogEntryView>(db, `
    SELECT
      e.id, e.folder_id, e.series_id, e.kind, e.season_number, e.part_number, e.custom_label,
      f.name AS folder_name, f.path AS folder_path,
      s.title AS series_title, s.series_key,
      e.manual_locked, e.confidence, e.conflict_reason, e.detected_by,
      e.source, e.external_id
    FROM folder_media_entries e
    JOIN folders f ON f.id = e.folder_id
    JOIN media_series s ON s.id = e.series_id
    WHERE e.series_id = ?
  `, [series.id])
  const entryDomains = resolveFolderMediaDomains(db, entries.map(entry => entry.folder_id))
  const projectedEntries = entries.map(entry => ({
    ...entry,
    ...entryDomains.get(entry.folder_id),
    kind: projectedMediaCatalogKind(entry.kind, entry.custom_label),
  }))
  projectedEntries.sort((left, right) => {
    const kindOrder = catalogKindOrder[left.kind] - catalogKindOrder[right.kind]
    if (kindOrder !== 0) return kindOrder
    const seasonLeft = left.season_number ?? Number.MAX_SAFE_INTEGER
    const seasonRight = right.season_number ?? Number.MAX_SAFE_INTEGER
    if (seasonLeft !== seasonRight) return seasonLeft - seasonRight
    const partLeft = left.part_number ?? (seasonLeft !== Number.MAX_SAFE_INTEGER ? 0 : Number.MAX_SAFE_INTEGER)
    const partRight = right.part_number ?? (seasonRight !== Number.MAX_SAFE_INTEGER ? 0 : Number.MAX_SAFE_INTEGER)
    if (partLeft !== partRight) return partLeft - partRight
    const folderOrder = left.folder_path.localeCompare(right.folder_path)
    return folderOrder !== 0 ? folderOrder : left.id - right.id
  })

  const seasonNumbers = asNumberArray(projectedEntries
    .filter(entry => entry.kind === 'season' && entry.season_number !== null)
    .map(entry => entry.season_number as number))
  return {
    entries: projectedEntries,
    summary: {
      ...resolveFolderMediaDomain(db, legacyRoot.id),
      root_folder_id: legacyRoot.id,
      series_id: series.id,
      series_key: series.series_key,
      series_title: series.title,
      entry_count: projectedEntries.length,
      season_numbers: seasonNumbers,
      manual_count: projectedEntries.filter(entry => entry.manual_locked === 1).length,
      conflict_count: projectedEntries.filter(entry => Boolean(entry.conflict_reason)).length,
      unknown_count: projectedEntries.filter(entry => entry.kind === 'unknown').length,
    },
    canonical,
    candidates: getMediaCatalogCandidates(db, legacyRoot),
  }
}

/** Rebuilds the catalog for the library that owns one physical folder. */
export function rebuildMediaCatalogForFolder(db: Database, folderId: number): MediaCatalogRebuildResult {
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = folderById(db, folderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  return rebuildLibraryMediaCatalog(db, folder.library_id)
}

interface MediaCatalogBatchRebuildResult {
  libraryCount: number
  results: Record<number, MediaCatalogRebuildResult>
  foldersProcessed: number
  inserted: number
  removedAutomatic: number
  preservedManual: number
  seasonEntries: number
  unknownEntries: number
  conflicts: number
}

function rebuildMediaCatalogLibraries(
  db: Database,
  libraryIds: number[],
): MediaCatalogBatchRebuildResult {
  const libraries = [...new Set(libraryIds)]
    .filter(libraryId => Boolean(queryOne<{ id: number }>(db, 'SELECT id FROM libraries WHERE id = ?', [libraryId])))
  const results: Record<number, MediaCatalogRebuildResult> = {}
  const totals = {
    foldersProcessed: 0,
    inserted: 0,
    removedAutomatic: 0,
    preservedManual: 0,
    seasonEntries: 0,
    unknownEntries: 0,
    conflicts: 0,
  }
  for (const libraryId of libraries) {
    const result = rebuildLibraryMediaCatalog(db, libraryId)
    results[libraryId] = result
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key]
  }
  return { libraryCount: libraries.length, results, ...totals }
}

/** Rebuilds every existing library, used for startup/backfill migration. */
export function rebuildAllMediaCatalogs(db: Database): MediaCatalogBatchRebuildResult {
  const libraryIds = queryAll<{ id: number }>(db, 'SELECT id FROM libraries ORDER BY id')
    .map(library => library.id)
  return rebuildMediaCatalogLibraries(db, libraryIds)
}

/**
 * Backfills existing databases for recognition-rule changes and rebuilds any
 * libraries marked dirty while the optional classifier was unavailable.
 */
export function ensureMediaCatalogsCurrent(
  db: Database,
  ruleVersion = MEDIA_CATALOG_RULE_VERSION,
): { rebuilt: boolean; ruleVersion: string; result: ReturnType<typeof rebuildAllMediaCatalogs> | null } {
  const stored = queryOne<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [MEDIA_CATALOG_RULE_VERSION_KEY])
  const dirtyLibraryIds = listDirtyCatalogLibraries(db)
  if (stored?.value === ruleVersion && dirtyLibraryIds.length === 0) {
    return { rebuilt: false, ruleVersion, result: null }
  }

  const ruleChanged = stored?.value !== ruleVersion
  const result = ruleChanged
    ? rebuildAllMediaCatalogs(db)
    : rebuildMediaCatalogLibraries(db, dirtyLibraryIds)
  if (ruleChanged) {
    run(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [MEDIA_CATALOG_RULE_VERSION_KEY, ruleVersion])
  }
  return { rebuilt: true, ruleVersion, result }
}

function validateManualKind(value: unknown): MediaCatalogKind {
  if (typeof value !== 'string' || !MEDIA_CATALOG_KINDS.includes(value as MediaCatalogKind)) {
    throw new MediaCatalogValidationError('kind 必须是有效的媒体目录类型', 400, 'INVALID_MEDIA_CATALOG_KIND')
  }
  return value as MediaCatalogKind
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new MediaCatalogValidationError(`${field} 必须是正整数`, 400, `INVALID_${field.toUpperCase()}`)
  }
  return value as number
}

function validateSeasonNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new MediaCatalogValidationError('seasonNumbers 必须是正整数数组', 400, 'INVALID_SEASON_NUMBERS')
  }
  return asNumberArray(value.map(item => validatePositiveInteger(item, 'seasonNumber')))
}

function setManualCanonicalMediaCatalog(
  db: Database,
  folder: FolderRow,
  root: FolderRow,
  input: SetManualMediaCatalogInput,
): void {
  run(db, 'DELETE FROM folder_media_mappings WHERE folder_id = ? AND manual_locked = 1', [folder.id])
  if (input.clearManual === true) return

  const kind = input.kind!
  const customLabel = kind === 'custom' ? normalizeCustomLabel(input.customLabel, true) : null
  const existing = queryOne<{ media_item_id: number; series_id: number | null }>(db, `
    SELECT media_item_id, series_id
    FROM folder_media_mappings
    WHERE folder_id = ? AND manual_locked = 0
    ORDER BY id LIMIT 1
  `, [folder.id])
  const source = folderMetadataSource(folder)
  const scopedContentIdentity = sourceIdentityNeedsFolderScope(db, root, folder, source)
  const item = kind !== 'custom' && existing
    ? canonicalItemById(db, existing.media_item_id)
    : ensureCanonicalMediaItem(db, {
      libraryId: folder.library_id,
      rootFolderId: root.id,
      itemKey: canonicalItemKeyForFolder(root, folder, source, scopedContentIdentity),
      title: folder.name,
      kind,
      customLabel,
      confidence: 1,
      sourceIds: source ? [source] : [],
    }, {
      preferItemKey: scopedContentIdentity !== null,
      preserveSourceItemIds: canonicalItemIdsWithManualState(db, folder.library_id),
    })
  if (!item) throw new MediaCatalogValidationError('无法建立规范媒体条目', 409, 'MEDIA_ITEM_CREATE_FAILED')
  run(db, 'DELETE FROM folder_media_mappings WHERE folder_id = ? AND manual_locked = 0', [folder.id])
  const series = queryOne<{ id: number }>(db, `
    SELECT id FROM media_series WHERE library_id = ? AND root_folder_id = ?
    ORDER BY id DESC LIMIT 1
  `, [folder.library_id, root.id])
  const seasonNumbers: Array<number | null> = kind === 'season' ? (input.seasonNumbers ?? []) : [null]
  for (const seasonNumber of seasonNumbers) {
    run(db, `
      INSERT INTO folder_media_mappings (
        folder_id, media_item_id, root_folder_id, series_id, content_role, kind,
        season_number, part_number, custom_label, confidence, conflict_reason, detected_by, manual_locked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'manual', 1)
    `, [
      folder.id, item.id, root.id, series?.id ?? existing?.series_id ?? null,
      canonicalRole(kind), kind === 'custom' ? 'unknown' : kind, seasonNumber, input.partNumber ?? null,
      customLabel,
    ])
  }
  if (kind === 'season' && seasonNumbers.length === 0) {
    throw new MediaCatalogValidationError('season 类型必须提供 seasonNumbers', 400, 'INVALID_SEASON_NUMBERS')
  }
}

function excludeMediaCatalogFolder(
  db: Database,
  folder: FolderRow,
): MediaCatalogSnapshot {
  const manual = manualCatalogExclusionMetadata(db, folder.id)
  const root = nearestCanonicalRootByDb(db, folder.id)
  if (!root) throw new MediaCatalogValidationError('文件夹不属于任何系列根目录', 409, 'MEDIA_CATALOG_ROOT_NOT_FOUND')
  run(db, 'BEGIN')
  try {
    const previousMembers = queryAll<{ item_key:string }>(db, `SELECT DISTINCT i.item_key FROM media_items i
      JOIN folder_media_mappings m ON m.media_item_id=i.id WHERE m.folder_id=? AND m.root_folder_id=?`,[folder.id,root.id]).map(item=>collectionMemberKey(item.item_key))
    run(db, `
      INSERT INTO folder_media_catalog_exclusions (
        folder_id, manual_kind, manual_season_numbers, manual_part_number, manual_custom_label, updated_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(folder_id) DO UPDATE SET
        manual_kind = COALESCE(excluded.manual_kind, folder_media_catalog_exclusions.manual_kind),
        manual_season_numbers = COALESCE(excluded.manual_season_numbers, folder_media_catalog_exclusions.manual_season_numbers),
        manual_part_number = COALESCE(excluded.manual_part_number, folder_media_catalog_exclusions.manual_part_number),
        manual_custom_label = COALESCE(excluded.manual_custom_label, folder_media_catalog_exclusions.manual_custom_label),
        updated_at = datetime('now')
    `, [
      folder.id,
      manual?.kind === 'custom' ? 'unknown' : manual?.kind ?? null,
      manual ? JSON.stringify(manual.seasonNumbers) : null,
      manual?.partNumber ?? null,
      manual?.customLabel ?? null,
    ])
    run(db, 'DELETE FROM folder_media_entries WHERE folder_id = ?', [folder.id])
    run(db, 'DELETE FROM folder_media_mappings WHERE folder_id = ?', [folder.id])
    removeExplicitlyOrphanedWorkGroupState(db, root.id)
    rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
    const remaining = new Set(collectionMemberKeys(db, root.id))
    explicitlyRemoveCollectionMembers(db, root.id, previousMembers.filter(key => !remaining.has(key)))
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, folder.id)
}

/**
 * Sets or clears a folder's manual classification. The manual mutation and
 * automatic rebuild share one transaction, so a rebuild failure restores the
 * previous manual override instead of leaving the catalog half-updated.
 */
export function setManualMediaCatalog(
  db: Database,
  folderId: number,
  input: SetManualMediaCatalogInput,
): MediaCatalogSnapshot {
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = folderById(db, folderId)
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const root = nearestCanonicalRootByDb(db, folderId)
  if (!root) throw new MediaCatalogValidationError('文件夹不属于任何系列根目录', 409, 'MEDIA_CATALOG_ROOT_NOT_FOUND')

  if (!input || typeof input !== 'object') {
    throw new MediaCatalogValidationError('媒体目录识别参数无效', 400, 'INVALID_MEDIA_CATALOG_INPUT')
  }
  if (input.excluded === true) return excludeMediaCatalogFolder(db, folder)
  const clearManual = input.clearManual === true
  const previousItemIds = previousCanonicalMediaItemIds(db, folder.id)
  const previousExclusive = previousItemIds.length === 1 ? queryOne<{ item_key:string }>(db, `SELECT item_key FROM media_items i WHERE id=?
    AND NOT EXISTS(SELECT 1 FROM folder_media_mappings m WHERE m.media_item_id=i.id AND m.folder_id<>?)`,[previousItemIds[0],folder.id]) : undefined

  let kind: MediaCatalogKind | undefined
  let seasonNumbers: number[] = []
  let partNumber: number | null = null
  let customLabel: string | null = null
  const source = folderMetadataSource(folder)
  if (!clearManual) {
    kind = validateManualKind(input.kind)
    customLabel = kind === 'custom'
      ? normalizeCustomLabel(input.customLabel, true)
      : normalizeCustomLabel(input.customLabel, false)
    if (kind !== 'custom' && customLabel !== null) {
      throw new MediaCatalogValidationError('只有 custom 类型可以提供 customLabel', 400, 'INVALID_CUSTOM_LABEL')
    }
    seasonNumbers = input.seasonNumbers == null ? [] : validateSeasonNumbers(input.seasonNumbers)
    partNumber = input.partNumber == null ? null : validatePositiveInteger(input.partNumber, 'partNumber')
    if (kind === 'season' && seasonNumbers.length === 0) {
      throw new MediaCatalogValidationError('season 类型必须提供 seasonNumbers', 400, 'INVALID_SEASON_NUMBERS')
    }
    if (kind !== 'season' && seasonNumbers.length > 0) {
      throw new MediaCatalogValidationError('只有 season 类型可以提供 seasonNumbers', 400, 'INVALID_SEASON_NUMBERS')
    }
  }

  run(db, 'BEGIN')
  try {
    // Manual edits and restoring automatic detection both release a previous
    // exclusion. Keep this inside the transaction so a failed rebuild does
    // not silently make the folder eligible again.
    run(db, 'DELETE FROM folder_media_catalog_exclusions WHERE folder_id = ?', [folder.id])
    // A folder that was excluded may be the only physical directory below a
    // root, so the normal rebuild is allowed to remove its empty series shell.
    // Create the shell before inserting the manual row and let the rebuild
    // preserve it through that row.
    run(db, `
        INSERT INTO media_series (library_id, root_folder_id, series_key, title, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(library_id, series_key) DO UPDATE SET
          root_folder_id = excluded.root_folder_id,
          title = CASE WHEN media_series.manual_locked = 1 THEN media_series.title ELSE excluded.title END,
          updated_at = datetime('now')
    `, [folder.library_id, root.id, `folder:${root.id}`, root.name])
    const series = queryOne<{ id: number }>(db, `
      SELECT id FROM media_series WHERE library_id = ? AND root_folder_id = ? ORDER BY id DESC LIMIT 1
    `, [folder.library_id, root.id])
    if (!series) throw new MediaCatalogValidationError('无法建立系列目录记录', 409, 'MEDIA_CATALOG_SERIES_NOT_FOUND')
    run(db, 'DELETE FROM folder_media_entries WHERE folder_id = ? AND manual_locked = 1', [folder.id])
    if (!clearManual) {
      const numbers: Array<number | null> = kind === 'season' ? seasonNumbers : [null]
      const insert = db.prepare(`
        INSERT INTO folder_media_entries (
          folder_id, series_id, kind, season_number, part_number,
          custom_label, source, external_id, confidence, detected_by, conflict_reason, manual_locked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', NULL, 1)
      `)
      try {
        for (const seasonNumber of numbers) {
          insert.run([
            folder.id,
            series.id,
            kind === 'custom' ? 'unknown' : kind!,
            seasonNumber,
            partNumber,
            customLabel,
            source?.source ?? 'manual',
            source?.externalId ?? null,
          ])
        }
      } finally {
        insert.finalize()
      }
    }
    setManualCanonicalMediaCatalog(db, folder, root, input)
    rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
    reconcileReplacedCanonicalMediaItems(
      db,
      folder.id,
      root.id,
      folder.library_id,
      previousItemIds,
    )
    if(previousExclusive) {
      const replacements=queryAll<{ item_key:string }>(db, `SELECT DISTINCT i.item_key FROM media_items i JOIN folder_media_mappings m ON m.media_item_id=i.id
        WHERE m.folder_id=? AND m.root_folder_id=?`,[folder.id,root.id])
      if(replacements.length===1) rekeyCollectionMember(db,root.id,previousExclusive.item_key,replacements[0].item_key)
    }
    run(db, 'COMMIT')
  } catch (error) {
    try { run(db, 'ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
  return getMediaCatalogForFolder(db, folder.id)
}
