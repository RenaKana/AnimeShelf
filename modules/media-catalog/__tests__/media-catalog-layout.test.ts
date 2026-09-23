import { describe, expect, it } from 'vitest'
import type { FolderView, MediaCatalogCandidate, MediaCatalogEntry, MediaCatalogItem, MediaCatalogMapping, MediaCatalogV2, MediaCatalogWorkGroup } from '../../../src/types'
import * as mediaCatalogHelpers from '../client/mediaCatalog'
import {
  formatSeasonNumbers,
  groupCanonicalMediaWorkGroups,
  groupCanonicalMediaCatalog,
  groupMediaCatalogEntries,
  isMediaCatalogWorkGroupMemberConfirmed,
  mediaCatalogDisplayLabel,
  mediaCatalogKindLabel,
  parseSeasonNumbersInput,
  physicalFolderTypeLabels,
  shouldShowCanonicalItemTitle,
  shouldShowCanonicalMappingFolderName,
} from '../client/mediaCatalog'

type MediaCatalogDirectoryRow = {
  folder: FolderView | null
  group: ReturnType<typeof groupMediaCatalogEntries>[number] | null
}

type BuildMediaCatalogDirectoryRows = (
  children: FolderView[],
  catalogGroups: ReturnType<typeof groupMediaCatalogEntries>,
  candidates: MediaCatalogCandidate[],
) => MediaCatalogDirectoryRow[]

const entry = (patch: Partial<MediaCatalogEntry> = {}): MediaCatalogEntry => ({
  id: 1,
  folder_id: 10,
  series_id: 1,
  kind: 'season',
  season_number: 1,
  part_number: null,
  folder_name: '第一季',
  folder_path: 'D:\\Anime\\作品\\第一季',
  series_title: '作品',
  series_key: 'folder:1',
  manual_locked: 0,
  confidence: 0.95,
  conflict_reason: null,
  detected_by: 'directory',
  source: null,
  external_id: null,
  ...patch,
})

const folder = (patch: Partial<FolderView> = {}): FolderView => ({
  id: 10,
  library_id: 1,
  parent_id: 1,
  name: '第一季',
  path: 'D:\\Anime\\作品\\第一季',
  is_series: 0,
  anilist_id: null,
  has_poster: 0,
  size: 1024,
  file_count: 1,
  tags: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...patch,
})

const candidate = (patch: Partial<MediaCatalogCandidate> = {}): MediaCatalogCandidate => ({
  folder_id: 20,
  folder_name: 'SP',
  folder_path: 'D:\\Anime\\作品\\SP',
  suggested_kind: 'special',
  suggested_season_numbers: [],
  suggested_part_number: null,
  confidence: 0.8,
  reason: 'extras',
  source: null,
  external_id: null,
  ...patch,
})

describe('media catalog layout helpers', () => {
  it('builds one sorted row per physical directory while excluding candidates and retaining catalog-only folders', () => {
    const helper = (mediaCatalogHelpers as Record<string, unknown>).buildMediaCatalogDirectoryRows as
      | BuildMediaCatalogDirectoryRows
      | undefined
    expect(typeof helper).toBe('function')

    const children = [
      folder({ id: 40, name: 'S2 Part 1', path: 'D:\\Anime\\作品\\d' }),
      folder({ id: 30, name: 'S1 Part 2', path: 'D:\\Anime\\作品\\c' }),
      folder({ id: 10, name: 'S1 Part 1', path: 'D:\\Anime\\作品\\z' }),
      folder({ id: 20, name: 'SP', path: 'D:\\Anime\\作品\\SP' }),
      folder({ id: 11, name: 'S1 Part 1', path: 'D:\\Anime\\作品\\a' }),
    ]
    const groups = groupMediaCatalogEntries([
      entry({ id: 4, folder_id: 40, folder_name: 'S2 Part 1', folder_path: 'D:\\Anime\\作品\\d', season_number: 2, part_number: 1 }),
      entry({ id: 3, folder_id: 30, folder_name: 'S1 Part 2', folder_path: 'D:\\Anime\\作品\\c', season_number: 1, part_number: 2 }),
      entry({ id: 2, folder_id: 10, folder_name: 'S1 Part 1', folder_path: 'D:\\Anime\\作品\\z', season_number: 1, part_number: 1 }),
      entry({ id: 1, folder_id: 10, folder_name: 'S1 Part 1', folder_path: 'D:\\Anime\\作品\\z', season_number: 1, part_number: 1, kind: 'movie' }),
      entry({ id: 5, folder_id: 11, folder_name: 'S1 Part 1', folder_path: 'D:\\Anime\\作品\\a', season_number: 1, part_number: 1 }),
      entry({ id: 6, folder_id: 99, folder_name: '仅目录', folder_path: 'D:\\Anime\\作品\\only-catalog', season_number: 3, part_number: null }),
    ])
    const candidates = [
      candidate({ folder_id: 20, reason: 'excluded' }),
      candidate({ folder_id: 21, reason: 'extras', folder_name: '附加内容', folder_path: 'D:\\Anime\\作品\\extras' }),
      candidate({ folder_id: 22, reason: 'insufficient_evidence', folder_name: '待确认', folder_path: 'D:\\Anime\\作品\\unknown' }),
    ]

    const rows = helper!(children, groups, candidates)

    expect(rows.map(row => row.folder?.id ?? row.group?.folderId)).toEqual([11, 10, 30, 40, 99])
    expect(rows.filter(row => row.folder?.id === 10)).toHaveLength(1)
    expect(rows.find(row => row.folder?.id === 10)?.folder).toBe(children[2])
    expect(rows.find(row => row.folder?.id === 10)?.group?.folderId).toBe(10)
    expect(rows.filter(row => [20, 21, 22].includes(row.folder?.id ?? row.group?.folderId ?? -1))).toHaveLength(0)

    const catalogOnly = rows.find(row => row.group?.folderId === 99)
    expect(catalogOnly?.folder).toBeNull()
    expect(catalogOnly?.group).toBe(groups.find(group => group.folderId === 99))
  })

  it('builds work-group display members from service order and aggregates physical folders', () => {
    const canonical: MediaCatalogV2 = {
      root_folder_id: 1,
      items: [
        {
          id: 12,
          library_id: 1,
          root_folder_id: 1,
          item_key: 'bangumi:12',
          title: 'OVA',
          title_zh: '特别篇',
          kind: 'ova',
          season_number: null,
          part_number: null,
          manual_locked: 0,
          confidence: 0.9,
          conflict_reason: null,
          source_ids: [{ source: 'bangumi', external_id: '12', is_primary: 1 }],
        },
        {
          id: 11,
          library_id: 1,
          root_folder_id: 1,
          item_key: 'bangumi:11',
          title: 'Fate/Zero',
          title_zh: null,
          kind: 'season',
          season_number: null,
          part_number: null,
          manual_locked: 0,
          confidence: 0.9,
          conflict_reason: null,
          source_ids: [],
        },
      ],
      mappings: [
        { id: 5, folder_id: 40, media_item_id: 11, root_folder_id: 1, series_id: null, content_role: 'unknown', kind: 'unknown', season_number: null, part_number: null, folder_name: '待确认', folder_path: 'D:\\Anime\\Z', manual_locked: 0, confidence: 0.2, conflict_reason: null, detected_by: 'unknown' },
        { id: 4, folder_id: 41, media_item_id: 11, root_folder_id: 1, series_id: null, content_role: 'main', kind: 'movie', season_number: null, part_number: null, folder_name: '剧场版', folder_path: 'D:\\Anime\\Y', manual_locked: 0, confidence: 0.8, conflict_reason: null, detected_by: 'directory' },
        { id: 3, folder_id: 42, media_item_id: 11, root_folder_id: 1, series_id: null, content_role: 'side_story', kind: 'ova', season_number: null, part_number: null, folder_name: 'OVA', folder_path: 'D:\\Anime\\X', manual_locked: 0, confidence: 0.8, conflict_reason: null, detected_by: 'directory' },
        { id: 2, folder_id: 43, media_item_id: 11, root_folder_id: 1, series_id: null, content_role: 'main', kind: 'season', season_number: 2, part_number: null, folder_name: '合集', folder_path: 'D:\\Anime\\W', manual_locked: 0, confidence: 0.9, conflict_reason: null, detected_by: 'directory' },
        { id: 1, folder_id: 43, media_item_id: 11, root_folder_id: 1, series_id: null, content_role: 'main', kind: 'season', season_number: 1, part_number: null, folder_name: '合集', folder_path: 'D:\\Anime\\W', manual_locked: 1, confidence: 1, conflict_reason: null, detected_by: 'manual' },
        { id: 6, folder_id: 44, media_item_id: 12, root_folder_id: 1, series_id: null, content_role: 'side_story', kind: 'ova', season_number: null, part_number: null, folder_name: 'OVA 2', folder_path: 'D:\\Anime\\OVA 2', manual_locked: 0, confidence: 0.9, conflict_reason: null, detected_by: 'directory' },
      ],
      summary: {
        root_folder_id: 1,
        item_count: 2,
        mapping_count: 6,
        season_numbers: [1, 2],
        manual_count: 1,
        conflict_count: 0,
        unknown_count: 0,
      },
      work_groups: [{
        id: 9,
        key: 'root:1',
        group_key: 'root:1',
        title: '作品组',
        anchor: 1,
        anchor_folder_id: 1,
        manual_locked: 0,
        item_ids: [12, 11],
        members: [
          { id: 91, work_group_id: 9, media_item_id: 11, relation_role: 'main', manual_locked: 1 },
          { id: 92, work_group_id: 9, media_item_id: 12, relation_role: 'side_story', manual_locked: 0 },
        ],
        summary: { item_count: 2, physical_folder_count: 5, season_numbers: [1, 2], manual_count: 1, conflict_count: 0, unknown_count: 0 },
      }],
      ungrouped_item_ids: [],
    }

    const groups = groupCanonicalMediaWorkGroups(canonical)
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe(9)
    expect(groups[0].members.map(member => member.item.id)).toEqual([12, 11])
    expect(groups[0].members[0]).toMatchObject({ relation_role: 'side_story', manual_locked: 0 })
    expect(groups[0].members[1]).toMatchObject({ relation_role: 'main', manual_locked: 1 })
    expect(groups[0].members[1].item.title).toBe('Fate/Zero')
    expect(groups[0].members[1].seasonNumbers).toEqual([1, 2])
    expect(groups[0].members[1].physicalFolders.map(folder => folder.folderId)).toEqual([43, 42, 41, 40])
    expect(groups[0].members[1].physicalFolders[0].seasonNumbers).toEqual([1, 2])
    expect(groups[0].members[1].physicalFolders[0].mappings.map(mapping => mapping.id)).toEqual([1, 2])
  })

  it('returns no V2 display groups when the service has no work_groups', () => {
    const emptyCatalog: MediaCatalogV2 = {
      root_folder_id: 1,
      items: [],
      mappings: [],
      summary: {
        root_folder_id: 1,
        item_count: 0,
        mapping_count: 0,
        season_numbers: [],
        manual_count: 0,
        conflict_count: 0,
        unknown_count: 0,
      },
      work_groups: [],
      ungrouped_item_ids: [],
    }
    expect(groupCanonicalMediaWorkGroups(emptyCatalog)).toEqual([])
  })

  it('keeps deliberately ungrouped items visible outside collection work groups', () => {
    const helper = (mediaCatalogHelpers as Record<string, unknown>).groupCanonicalUngroupedMediaItems as
      | ((catalog: MediaCatalogV2 & { ungrouped_item_ids: number[] }) => Array<{ item: MediaCatalogItem; mappings: MediaCatalogMapping[] }>)
      | undefined
    const catalog = {
      root_folder_id: 1,
      items: [
        { id: 11, title: '已分组' },
        { id: 12, title: '未分组' },
      ],
      mappings: [
        { id: 21, media_item_id: 11 },
        { id: 22, media_item_id: 12 },
      ],
      summary: { root_folder_id: 1, item_count: 2, mapping_count: 2, season_numbers: [], manual_count: 0, conflict_count: 0, unknown_count: 0 },
      work_groups: [{ item_ids: [11] }],
      ungrouped_item_ids: [12],
    } as unknown as MediaCatalogV2 & { ungrouped_item_ids: number[] }

    expect(helper?.(catalog).map(group => ({ id: group.item.id, mappingIds: group.mappings.map(mapping => mapping.id) })))
      .toEqual([{ id: 12, mappingIds: [22] }])
  })

  it('groups canonical items with all physical mappings for the V2 view', () => {
    const canonical: MediaCatalogV2 = {
      root_folder_id: 1,
      items: [{
        id: 20,
        library_id: 1,
        root_folder_id: 1,
        item_key: 'bangumi:100',
        title: '作品 S1',
        title_zh: '作品第一季',
        kind: 'season',
        season_number: 1,
        part_number: null,
        manual_locked: 0,
        confidence: 0.95,
        conflict_reason: null,
        source_ids: [{ source: 'bangumi', external_id: '100', is_primary: 1 }],
      }],
      mappings: [{
        id: 30,
        folder_id: 10,
        media_item_id: 20,
        root_folder_id: 1,
        series_id: null,
        content_role: 'main',
        kind: 'season',
        season_number: 1,
        part_number: null,
        folder_name: '第一季',
        folder_path: 'D:\\Anime\\作品\\第一季',
        manual_locked: 0,
        confidence: 0.95,
        conflict_reason: null,
        detected_by: 'directory',
      }],
      summary: {
        root_folder_id: 1,
        item_count: 1,
        mapping_count: 1,
        season_numbers: [1],
        manual_count: 0,
        conflict_count: 0,
        unknown_count: 0,
      },
      work_groups: [],
      ungrouped_item_ids: [],
    }

    const groups = groupCanonicalMediaCatalog(canonical)
    expect(groups).toHaveLength(1)
    expect(groups[0].item.title_zh).toBe('作品第一季')
    expect(groups[0].item.source_ids).toEqual([{ source: 'bangumi', external_id: '100', is_primary: 1 }])
    expect(groups[0].mappings.map(mapping => mapping.folder_id)).toEqual([10])
  })

  it('groups multiple catalog rows from one physical folder and keeps folders separate', () => {
    const groups = groupMediaCatalogEntries([
      entry({ id: 2, season_number: 2 }),
      entry({ id: 1, season_number: 1 }),
      entry({ id: 3, folder_id: 11, folder_name: '剧场版', folder_path: 'D:\\Anime\\作品\\剧场版', kind: 'movie', season_number: null }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].folderId).toBe(10)
    expect(groups[0].seasonNumbers).toEqual([1, 2])
    expect(groups[0].entries.map(item => item.season_number)).toEqual([1, 2])
    expect(groups[1].folderId).toBe(11)
  })

  it('orders season folders by persisted season number instead of folder-name collation', () => {
    const groups = groupMediaCatalogEntries([
      entry({ id: 7, folder_id: 17, folder_name: '第七季', folder_path: 'D:\\Anime\\作品\\第七季', season_number: 7 }),
      entry({ id: 2, folder_id: 12, folder_name: '第二季', folder_path: 'D:\\Anime\\作品\\第二季', season_number: 2 }),
      entry({ id: 1, folder_id: 11, folder_name: '第一季', folder_path: 'D:\\Anime\\作品\\第一季', season_number: 1 }),
    ])

    expect(groups.map(group => group.seasonNumbers[0])).toEqual([1, 2, 7])
  })

  it('formats consecutive seasons as a compact range on one line', () => {
    expect(formatSeasonNumbers([1, 2, 3, 5, 7, 8])).toBe('S1–S3、S5、S7–S8')
    expect(formatSeasonNumbers([])).toBe('未指定季号')
  })

  it('parses comma-separated positive season numbers and reports invalid input', () => {
    expect(parseSeasonNumbersInput('1, 2，2, 3')).toEqual({ values: [1, 2, 3], error: null })
    expect(parseSeasonNumbersInput('1,abc')).toEqual({ values: [], error: '季号必须是正整数，可用逗号分隔' })
    expect(parseSeasonNumbersInput('0,-1')).toEqual({ values: [], error: '季号必须是正整数，可用逗号分隔' })
  })

  it('uses clear Chinese labels for every persisted catalog kind', () => {
    expect(mediaCatalogKindLabel('season')).toBe('季度')
    expect(mediaCatalogKindLabel('movie')).toBe('剧场版')
    expect(mediaCatalogKindLabel('ova')).toBe('OVA')
    expect(mediaCatalogKindLabel('special')).toBe('SP')
    expect(mediaCatalogKindLabel('extras')).toBe('附加内容')
    expect(mediaCatalogKindLabel('unknown')).toBe('待确认')
    expect(mediaCatalogKindLabel('custom')).toBe('自定义')
  })

  it('uses custom labels without hiding fixed non-season kinds', () => {
    expect(mediaCatalogDisplayLabel('custom', ' 礼 ')).toBe('礼')
    expect(mediaCatalogDisplayLabel('custom', null)).toBe('自定义')
    expect(mediaCatalogDisplayLabel('ova', null)).toBe('OVA')
    expect(mediaCatalogDisplayLabel('movie', '不会覆盖固定类型')).toBe('剧场版')
  })

  it('shows every distinct non-season type on mixed physical folders', () => {
    expect(physicalFolderTypeLabels({ mappings: [
      { kind: 'season', custom_label: null },
      { kind: 'ova', custom_label: null },
      { kind: 'special', custom_label: null },
      { kind: 'movie', custom_label: null },
      { kind: 'ova', custom_label: null },
      { kind: 'custom', custom_label: ' 礼 ' },
      { kind: 'custom', custom_label: '礼' },
      { kind: 'unknown', custom_label: null },
    ] } as unknown as Parameters<typeof physicalFolderTypeLabels>[0])).toEqual(['OVA', 'SP', '剧场版', '礼'])
  })

  it('confirms only member, item, or mapping manual state, not a group-only title lock', () => {
    const group: Pick<MediaCatalogWorkGroup, 'manual_locked'> = { manual_locked: 1 }
    const automaticMember = { manual_locked: 0 as const, item: { manual_locked: 0 as const }, mappings: [] }
    expect(isMediaCatalogWorkGroupMemberConfirmed(group, automaticMember)).toBe(false)
    expect(isMediaCatalogWorkGroupMemberConfirmed({ manual_locked: 0 }, { ...automaticMember, manual_locked: 1 })).toBe(true)
    expect(isMediaCatalogWorkGroupMemberConfirmed({ manual_locked: 0 }, { ...automaticMember, item: { manual_locked: 1 } })).toBe(true)
    expect(isMediaCatalogWorkGroupMemberConfirmed({ manual_locked: 0 }, { ...automaticMember, mappings: [{ manual_locked: 1 }] })).toBe(true)
  })

  it('uses work-group controls only for folders explicitly marked as collections', () => {
    const helper = (mediaCatalogHelpers as Record<string, unknown>).shouldUseMediaCatalogWorkGroups as
      | ((pinned: number | undefined, catalog: MediaCatalogV2 | null) => boolean)
      | undefined
    const catalog = {
      root_folder_id: 1,
      items: [],
      mappings: [],
      summary: { root_folder_id: 1, item_count: 0, mapping_count: 0, season_numbers: [], manual_count: 0, conflict_count: 0, unknown_count: 0 },
      work_groups: [{ id: 1 }],
    } as unknown as MediaCatalogV2

    expect(helper?.(0, catalog)).toBe(false)
    expect(helper?.(undefined, catalog)).toBe(false)
    expect(helper?.(1, catalog)).toBe(true)
    expect(helper?.(1, { ...catalog, work_groups: [] })).toBe(true)
    expect(helper?.(1, null)).toBe(false)
  })

  it('returns one mutually exclusive member status instead of confirmed and pending together', () => {
    const helper = (mediaCatalogHelpers as Record<string, unknown>).mediaCatalogWorkGroupMemberStatus as
      | ((group: Pick<MediaCatalogWorkGroup, 'manual_locked'>, member: {
          relation_role: string
          manual_locked: 0 | 1
          item: Pick<MediaCatalogItem, 'kind' | 'manual_locked'>
          mappings: Array<Pick<MediaCatalogMapping, 'kind' | 'manual_locked'>>
        }) => 'confirmed' | 'pending' | 'automatic')
      | undefined
    const group = { manual_locked: 0 as const }

    expect(helper?.(group, {
      relation_role: 'unknown',
      manual_locked: 1,
      item: { kind: 'unknown', manual_locked: 0 },
      mappings: [],
    })).toBe('pending')
    expect(helper?.(group, {
      relation_role: 'unknown',
      manual_locked: 1,
      item: { kind: 'season', manual_locked: 0 },
      mappings: [{ kind: 'season', manual_locked: 1 }],
    })).toBe('confirmed')
    expect(helper?.(group, {
      relation_role: 'unknown',
      manual_locked: 0,
      item: { kind: 'season', manual_locked: 0 },
      mappings: [],
    })).toBe('pending')
    expect(helper?.(group, {
      relation_role: 'main',
      manual_locked: 0,
      item: { kind: 'season', manual_locked: 0 },
      mappings: [],
    })).toBe('automatic')
  })

  it('returns one mutually exclusive physical-folder status', () => {
    const helper = (mediaCatalogHelpers as Record<string, unknown>).mediaCatalogPhysicalFolderStatus as
      | ((folder: { mappings: Array<Pick<MediaCatalogMapping, 'kind' | 'manual_locked'>> }) => 'confirmed' | 'pending' | 'automatic')
      | undefined

    expect(helper?.({ mappings: [{ kind: 'unknown', manual_locked: 1 }] })).toBe('pending')
    expect(helper?.({ mappings: [{ kind: 'unknown', manual_locked: 0 }] })).toBe('pending')
    expect(helper?.({ mappings: [{ kind: 'season', manual_locked: 0 }] })).toBe('automatic')
  })

  it('hides a canonical mapping name when it duplicates the only item title', () => {
    const item = {
      id: 20,
      library_id: 1,
      root_folder_id: 1,
      item_key: 'bangumi:100',
      title: 'Fate Zero',
      title_zh: null,
      kind: 'unknown',
      season_number: null,
      part_number: null,
      manual_locked: 0,
      confidence: 0.25,
      conflict_reason: null,
      source_ids: [],
    } satisfies MediaCatalogItem
    const mapping = {
      id: 30,
      folder_id: 10,
      media_item_id: 20,
      root_folder_id: 1,
      series_id: null,
      content_role: 'unknown',
      kind: 'unknown',
      season_number: null,
      part_number: null,
      folder_name: 'Fate Zero',
      folder_path: 'D:\\Anime\\Fate Zero',
      manual_locked: 0,
      confidence: 0.25,
      conflict_reason: null,
      detected_by: 'unknown',
    } satisfies MediaCatalogMapping

    expect(shouldShowCanonicalMappingFolderName(item, [mapping], mapping)).toBe(false)
    expect(shouldShowCanonicalMappingFolderName(item, [mapping, { ...mapping, id: 31, folder_id: 11 }], mapping)).toBe(true)
    const differentlyNamedMapping = { ...mapping, folder_name: 'Fate Zero Season 1' }
    expect(shouldShowCanonicalMappingFolderName(item, [differentlyNamedMapping], differentlyNamedMapping)).toBe(true)
  })

  it('hides the only canonical item title when the editable series title already shows it', () => {
    expect(shouldShowCanonicalItemTitle('Fate Zero', 1, { title: 'Fate Zero' })).toBe(false)
    expect(shouldShowCanonicalItemTitle('Fate Series', 1, { title: 'Fate Zero' })).toBe(true)
    expect(shouldShowCanonicalItemTitle('Fate Zero', 2, { title: 'Fate Zero' })).toBe(true)
  })
})
