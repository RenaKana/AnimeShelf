import type { FolderView, MediaCatalogCandidate, MediaCatalogEntry, MediaCatalogItem, MediaCatalogMapping, MediaCatalogKind, MediaCatalogV2, MediaCatalogWorkGroup, MediaCatalogWorkGroupMember } from '../../../src/types'

export interface MediaCatalogFolderGroup {
  folderId: number
  folderName: string
  folderPath: string
  entries: MediaCatalogEntry[]
  seasonNumbers: number[]
}

export interface MediaCatalogDirectoryRow {
  folder: FolderView | null
  group: MediaCatalogFolderGroup | null
}

export interface MediaCatalogCanonicalGroup {
  item: MediaCatalogItem
  mappings: MediaCatalogMapping[]
}

export interface MediaCatalogPhysicalFolder {
  folderId: number
  folderName: string
  folderPath: string
  mappings: MediaCatalogMapping[]
  seasonNumbers: number[]
}

export interface MediaCatalogWorkGroupDisplayMember extends MediaCatalogWorkGroupMember {
  item: MediaCatalogItem
  mappings: MediaCatalogMapping[]
  physicalFolders: MediaCatalogPhysicalFolder[]
  seasonNumbers: number[]
}

export interface MediaCatalogWorkGroupDisplay extends Omit<MediaCatalogWorkGroup, 'members'> {
  members: MediaCatalogWorkGroupDisplayMember[]
}

export type MediaCatalogConfirmationStatus = 'confirmed' | 'pending' | 'automatic'

export function shouldUseMediaCatalogWorkGroups(
  pinned: number | undefined,
  catalog: MediaCatalogV2 | null | undefined,
): boolean {
  return pinned === 1 && Boolean(catalog)
}

export function shouldApplyMediaCatalogSnapshot(
  currentFolderId: number | null | undefined,
  expectedFolderId: number,
): boolean {
  return currentFolderId === expectedFolderId
}

const kindOrder: Record<MediaCatalogKind, number> = {
  season: 0,
  custom: 1,
  movie: 2,
  ova: 3,
  special: 4,
  extras: 5,
  unknown: 6,
}

const canonicalMappingKindOrder: Record<MediaCatalogKind, number> = {
  season: 0,
  custom: 1,
  ova: 2,
  special: 2,
  movie: 3,
  extras: 3,
  unknown: 4,
}

const uniquePositiveIntegers = (values: Iterable<number>) => [...new Set(values)]
  .filter(value => Number.isInteger(value) && value > 0)
  .sort((left, right) => left - right)

export function formatSeasonNumbers(numbers: number[]): string {
  const sorted = uniquePositiveIntegers(numbers)
  if (sorted.length === 0) return '未指定季号'

  const ranges: string[] = []
  let start = sorted[0]
  let previous = sorted[0]
  for (const current of sorted.slice(1)) {
    if (current === previous + 1) {
      previous = current
      continue
    }
    ranges.push(start === previous ? `S${start}` : `S${start}–S${previous}`)
    start = previous = current
  }
  ranges.push(start === previous ? `S${start}` : `S${start}–S${previous}`)
  return ranges.join('、')
}

export function parseSeasonNumbersInput(value: string): { values: number[]; error: string | null } {
  const input = value.trim()
  if (!input) return { values: [], error: null }
  const tokens = input.split(/[,，\s]+/).filter(Boolean)
  if (tokens.some(token => !/^\d+$/.test(token) || Number(token) <= 0)) {
    return { values: [], error: '季号必须是正整数，可用逗号分隔' }
  }
  return { values: uniquePositiveIntegers(tokens.map(Number)), error: null }
}

export function mediaCatalogKindLabel(kind: MediaCatalogKind): string {
  switch (kind) {
    case 'season': return '季度'
    case 'movie': return '剧场版'
    case 'ova': return 'OVA'
    case 'special': return 'SP'
    case 'custom': return '自定义'
    case 'extras': return '附加内容'
    case 'unknown': return '待确认'
  }
}

export function mediaCatalogDisplayLabel(kind: MediaCatalogKind, customLabel?: string | null): string {
  if (kind === 'custom') return customLabel?.trim() || mediaCatalogKindLabel(kind)
  return mediaCatalogKindLabel(kind)
}

/**
 * Returns the distinct non-season labels represented by one physical folder.
 * Season numbers already have their own badge, but a folder can also contain
 * OVA/SP/movie/custom mappings that must remain visible beside that badge.
 */
export function physicalFolderTypeLabels(
  folder: Pick<MediaCatalogPhysicalFolder, 'mappings'>,
): string[] {
  return [...new Set(folder.mappings
    .filter(mapping => mapping.kind !== 'season' && mapping.kind !== 'unknown')
    .map(mapping => mediaCatalogDisplayLabel(mapping.kind, mapping.custom_label).trim())
    .filter(Boolean))]
}

export function groupMediaCatalogEntries(entries: MediaCatalogEntry[]): MediaCatalogFolderGroup[] {
  const byFolder = new Map<number, MediaCatalogFolderGroup>()
  for (const entry of entries) {
    const existing = byFolder.get(entry.folder_id)
    if (existing) {
      existing.entries.push(entry)
      if (entry.kind === 'season' && entry.season_number !== null) existing.seasonNumbers.push(entry.season_number)
      continue
    }
    byFolder.set(entry.folder_id, {
      folderId: entry.folder_id,
      folderName: entry.folder_name,
      folderPath: entry.folder_path,
      entries: [entry],
      seasonNumbers: entry.kind === 'season' && entry.season_number !== null ? [entry.season_number] : [],
    })
  }

  return [...byFolder.values()]
    .map(group => ({
      ...group,
      entries: [...group.entries].sort((left, right) => {
        const byKind = kindOrder[left.kind] - kindOrder[right.kind]
        if (byKind !== 0) return byKind
        const leftSeason = left.season_number ?? Number.MAX_SAFE_INTEGER
        const rightSeason = right.season_number ?? Number.MAX_SAFE_INTEGER
        if (leftSeason !== rightSeason) return leftSeason - rightSeason
        const leftPart = left.part_number ?? Number.MAX_SAFE_INTEGER
        const rightPart = right.part_number ?? Number.MAX_SAFE_INTEGER
        if (leftPart !== rightPart) return leftPart - rightPart
        return left.id - right.id
      }),
      seasonNumbers: uniquePositiveIntegers(group.seasonNumbers),
    }))
    .sort((left, right) => {
      const leftKind = Math.min(...left.entries.map(entry => kindOrder[entry.kind]))
      const rightKind = Math.min(...right.entries.map(entry => kindOrder[entry.kind]))
      if (leftKind !== rightKind) return leftKind - rightKind
      const leftSeason = left.seasonNumbers[0] ?? Number.MAX_SAFE_INTEGER
      const rightSeason = right.seasonNumbers[0] ?? Number.MAX_SAFE_INTEGER
      if (leftSeason !== rightSeason) return leftSeason - rightSeason
      return left.folderPath.localeCompare(right.folderPath, 'zh')
    })
}

/**
 * Combines the scanned child directories with persisted catalog groups into a
 * single physical-directory list. A directory can be present in both inputs,
 * but it must only produce one row and keep the original object references so
 * callers can still use their existing mutation data.
 */
export function buildMediaCatalogDirectoryRows(
  children: FolderView[],
  catalogGroups: MediaCatalogFolderGroup[],
  candidates: MediaCatalogCandidate[],
): MediaCatalogDirectoryRow[] {
  const candidateIds = new Set(candidates.map(candidate => candidate.folder_id))
  const foldersById = new Map<number, FolderView>()
  for (const folder of children) {
    if (!candidateIds.has(folder.id) && !foldersById.has(folder.id)) foldersById.set(folder.id, folder)
  }

  const groupsById = new Map(catalogGroups.map(group => [group.folderId, group]))
  const rows: MediaCatalogDirectoryRow[] = []
  const rowIds = new Set<number>()

  for (const folder of foldersById.values()) {
    const group = groupsById.get(folder.id) ?? null
    rows.push({ folder, group })
    rowIds.add(folder.id)
  }

  for (const group of catalogGroups) {
    if (candidateIds.has(group.folderId) || rowIds.has(group.folderId)) continue
    rows.push({ folder: null, group })
    rowIds.add(group.folderId)
  }

  const seasonKey = (row: MediaCatalogDirectoryRow) => row.group?.seasonNumbers[0] ?? Number.MAX_SAFE_INTEGER
  const partKey = (row: MediaCatalogDirectoryRow) => {
    if (!row.group || row.group.entries.length === 0) return 0
    return Math.min(...row.group.entries.map(entry => entry.part_number ?? 0))
  }
  const pathKey = (row: MediaCatalogDirectoryRow) => row.folder?.path ?? row.group?.folderPath ?? ''
  const idKey = (row: MediaCatalogDirectoryRow) => row.folder?.id ?? row.group?.folderId ?? Number.MAX_SAFE_INTEGER

  return rows.sort((left, right) => {
    const bySeason = seasonKey(left) - seasonKey(right)
    if (bySeason !== 0) return bySeason
    const byPart = partKey(left) - partKey(right)
    if (byPart !== 0) return byPart
    const byPath = pathKey(left).localeCompare(pathKey(right), 'zh')
    return byPath !== 0 ? byPath : idKey(left) - idKey(right)
  })
}

/** Groups V2 physical mappings under their stable canonical media item. */
export function groupCanonicalMediaCatalog(catalog: MediaCatalogV2 | null | undefined): MediaCatalogCanonicalGroup[] {
  if (!catalog) return []
  const mappingsByItem = new Map<number, MediaCatalogMapping[]>()
  for (const mapping of catalog.mappings) {
    const mappings = mappingsByItem.get(mapping.media_item_id) ?? []
    mappings.push(mapping)
    mappingsByItem.set(mapping.media_item_id, mappings)
  }
  return catalog.items.map(item => ({
    item,
    mappings: mappingsByItem.get(item.id) ?? [],
  }))
}

/** Keeps intentionally detached collection items visible without inventing a synthetic work group. */
export function groupCanonicalUngroupedMediaItems(
  catalog: MediaCatalogV2 | null | undefined,
): MediaCatalogCanonicalGroup[] {
  if (!catalog?.ungrouped_item_ids.length) return []
  const ungroupedIds = new Set(catalog.ungrouped_item_ids)
  return groupCanonicalMediaCatalog(catalog).filter(group => ungroupedIds.has(group.item.id))
}

function compareCanonicalMappings(left: MediaCatalogMapping, right: MediaCatalogMapping): number {
  const byKind = canonicalMappingKindOrder[left.kind] - canonicalMappingKindOrder[right.kind]
  if (byKind !== 0) return byKind
  const leftSeason = left.season_number ?? Number.MAX_SAFE_INTEGER
  const rightSeason = right.season_number ?? Number.MAX_SAFE_INTEGER
  if (leftSeason !== rightSeason) return leftSeason - rightSeason
  const leftPart = left.part_number ?? (left.kind === 'season' ? 0 : Number.MAX_SAFE_INTEGER)
  const rightPart = right.part_number ?? (right.kind === 'season' ? 0 : Number.MAX_SAFE_INTEGER)
  if (leftPart !== rightPart) return leftPart - rightPart
  const byPath = left.folder_path.localeCompare(right.folder_path, 'zh')
  return byPath !== 0 ? byPath : left.id - right.id
}

export function groupCanonicalPhysicalFolders(mappings: MediaCatalogMapping[]): MediaCatalogPhysicalFolder[] {
  const byFolder = new Map<number, MediaCatalogPhysicalFolder>()
  for (const mapping of mappings) {
    const current = byFolder.get(mapping.folder_id)
    if (current) {
      current.mappings.push(mapping)
      if (mapping.kind === 'season' && mapping.season_number !== null) current.seasonNumbers.push(mapping.season_number)
      continue
    }
    byFolder.set(mapping.folder_id, {
      folderId: mapping.folder_id,
      folderName: mapping.folder_name,
      folderPath: mapping.folder_path,
      mappings: [mapping],
      seasonNumbers: mapping.kind === 'season' && mapping.season_number !== null ? [mapping.season_number] : [],
    })
  }
  return [...byFolder.values()]
    .map(folder => ({
      ...folder,
      mappings: [...folder.mappings].sort(compareCanonicalMappings),
      seasonNumbers: uniquePositiveIntegers(folder.seasonNumbers),
    }))
    .sort((left, right) => compareCanonicalMappings(left.mappings[0], right.mappings[0]))
}

/** Builds the display model directly from persisted V2 work groups. */
export function groupCanonicalMediaWorkGroups(catalog: MediaCatalogV2 | null | undefined): MediaCatalogWorkGroupDisplay[] {
  if (!catalog?.work_groups?.length) return []
  const itemById = new Map(catalog.items.map(item => [item.id, item]))
  const mappingsByItem = new Map<number, MediaCatalogMapping[]>()
  for (const mapping of catalog.mappings) {
    const current = mappingsByItem.get(mapping.media_item_id) ?? []
    current.push(mapping)
    mappingsByItem.set(mapping.media_item_id, current)
  }

  return catalog.work_groups.map(group => {
    const membersByItem = new Map(group.members.map(member => [member.media_item_id, member]))
    const itemIds = group.item_ids.length > 0 ? group.item_ids : group.members.map(member => member.media_item_id)
    const members = itemIds.flatMap(mediaItemId => {
      const item = itemById.get(mediaItemId)
      if (!item) return []
      const member = membersByItem.get(mediaItemId) ?? {
        id: mediaItemId,
        media_item_id: mediaItemId,
        relation_role: 'unknown' as const,
        manual_locked: 0 as const,
      }
      const mappings = [...(mappingsByItem.get(mediaItemId) ?? [])].sort(compareCanonicalMappings)
      const seasonNumbers = uniquePositiveIntegers(
        mappings
          .filter(mapping => mapping.kind === 'season' && mapping.season_number !== null)
          .map(mapping => mapping.season_number as number),
      )
      return [{
        ...member,
        item,
        mappings,
        physicalFolders: groupCanonicalPhysicalFolders(mappings),
        seasonNumbers,
      }]
    })
    return { ...group, members }
  })
}

/** Manual state on the work-group itself does not confirm every member. */
export function isMediaCatalogWorkGroupMemberConfirmed(
  _group: Pick<MediaCatalogWorkGroup, 'manual_locked'>,
  member: Pick<MediaCatalogWorkGroupMember, 'manual_locked'> & {
    item: Pick<MediaCatalogItem, 'manual_locked'>
    mappings: Array<Pick<MediaCatalogMapping, 'manual_locked'>>
  },
): boolean {
  return member.manual_locked === 1 ||
    member.item.manual_locked === 1 ||
    member.mappings.some(mapping => mapping.manual_locked === 1)
}

export function mediaCatalogWorkGroupMemberStatus(
  group: Pick<MediaCatalogWorkGroup, 'manual_locked'>,
  member: Pick<MediaCatalogWorkGroupMember, 'relation_role' | 'manual_locked'> & {
    item: Pick<MediaCatalogItem, 'kind' | 'manual_locked'>
    mappings: Array<Pick<MediaCatalogMapping, 'kind' | 'manual_locked'>>
  },
): MediaCatalogConfirmationStatus {
  if (member.item.kind === 'unknown' || member.mappings.some(mapping => mapping.kind === 'unknown')) return 'pending'
  if (isMediaCatalogWorkGroupMemberConfirmed(group, member)) return 'confirmed'
  if (member.relation_role === 'unknown') return 'pending'
  return 'automatic'
}

export function mediaCatalogPhysicalFolderStatus(
  folder: { mappings: Array<Pick<MediaCatalogMapping, 'kind' | 'manual_locked'>> },
): MediaCatalogConfirmationStatus {
  if (folder.mappings.some(mapping => mapping.kind === 'unknown')) return 'pending'
  if (folder.mappings.some(mapping => mapping.manual_locked === 1)) return 'confirmed'
  return 'automatic'
}

/**
 * A single canonical mapping whose folder name is already the item title is
 * redundant in the detail view. Keep the name for multi-release items or
 * when the physical directory provides useful distinguishing context.
 */
export function shouldShowCanonicalMappingFolderName(
  item: Pick<MediaCatalogItem, 'title'>,
  mappings: MediaCatalogMapping[],
  mapping: Pick<MediaCatalogMapping, 'folder_name'>,
): boolean {
  return mappings.length !== 1 || mapping.folder_name !== item.title
}

/** Avoid repeating the editable series title as the only item heading. */
export function shouldShowCanonicalItemTitle(
  seriesTitle: string,
  itemCount: number,
  item: Pick<MediaCatalogItem, 'title'>,
): boolean {
  return itemCount !== 1 || item.title.trim() !== seriesTitle.trim()
}
