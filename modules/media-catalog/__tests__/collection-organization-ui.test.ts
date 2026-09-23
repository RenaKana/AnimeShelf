import { describe, expect, it } from 'vitest'
import { removeCollectionMembers, type CollectionOrganization } from '../../../shared/collection-organization'
import type { FolderDetail, MediaCatalogItem, MediaCatalogMapping, MediaCatalogV2 } from '../../../src/types'
import { buildCollectionNavigation } from '../client/collectionNavigation'
import {
  collectionFolderUrl,
  confirmWatchOrder,
  filterCollectionTargets,
  moveStructureGroup,
  moveStructureMember,
  moveWatchEntry,
  nextCollectionTarget,
  resolveCollectionViews,
  setStructureMembership,
} from '../client/collectionOrganization'
import { resolveCollectionNextState } from '../../../src/pages/FolderDetail'

const item = (id: number, title: string): MediaCatalogItem => ({ id, library_id: 1, root_folder_id: 1, item_key: `local:${id}`, title, title_zh: null, kind: 'unknown', season_number: null, part_number: null, manual_locked: 0, confidence: 1, conflict_reason: null, source_ids: [] })
const mapping = (id: number, folderId = id, seasonNumber: number | null = null): MediaCatalogMapping => ({ id: id * 10 + (seasonNumber ?? 0), folder_id: folderId, media_item_id: id, root_folder_id: 1, series_id: null, content_role: 'main', kind: seasonNumber ? 'season' : 'unknown', season_number: seasonNumber, part_number: null, folder_name: `folder-${folderId}`, folder_path: `root/folder-${folderId}`, manual_locked: 0, confidence: 1, conflict_reason: null, detected_by: 'test' })
const catalog = (): MediaCatalogV2 => ({ root_folder_id: 1, items: [item(1, 'A'), item(2, 'B'), item(3, 'C')], mappings: [mapping(1), mapping(2), mapping(3)], work_groups: [], ungrouped_item_ids: [1, 2, 3], summary: { root_folder_id: 1, item_count: 3, mapping_count: 3, season_numbers: [], manual_count: 0, conflict_count: 0, unknown_count: 3 } })
const organization = (): CollectionOrganization => ({ version: 1, orderSource: 'user', watchEntries: [
  { id: 'watch:a', targetKey: 'item:local:1' }, { id: 'watch:b', targetKey: 'item:local:2' }, { id: 'watch:c', targetKey: 'item:local:3' },
], groups: [
  { id: 'group:x', title: 'X', memberKeys: ['item:local:1', 'item:local:3'] },
  { id: 'group:y', title: 'Y', memberKeys: ['item:local:2'] },
] })
const folder = (mediaCatalog: MediaCatalogV2): FolderDetail => ({ id: 1, name: '合集', path: 'root', library_id: 1, parent_id: null, pinned: 1, is_series: 1, anilist_id: null, has_poster: 0, size: 0, file_count: 0, tags: [], created_at: '', updated_at: '', children: [], files: [], media_catalog: [], media_catalog_summary: null, media_catalog_candidates: [], media_catalog_v2: mediaCatalog })

describe('collection dual-view organization', () => {
  it('uses the full watch sequence for next even when structure groups and filters interleave A, B and C', () => {
    const views = resolveCollectionViews(buildCollectionNavigation(catalog()), organization())
    expect(views.groups.map(group => group.members.map(member => member.work?.title))).toEqual([['A', 'C'], ['B']])
    expect(filterCollectionTargets(views.watch, 'A').map(target => target.work?.title)).toEqual(['A'])
    expect(nextCollectionTarget(views, 'watch:a')?.work?.title).toBe('B')
  })

  it('keeps watch order unchanged while editing group order, membership and member order', () => {
    const before = organization()
    const changed = moveStructureMember(setStructureMembership(moveStructureGroup(before, 'group:y', -1), 'group:y', 'item:local:3', true), 'group:y', 'item:local:3', -1)
    expect(changed.watchEntries).toEqual(before.watchEntries)
    expect(changed.groups[0].id).toBe('group:y')
    expect(changed.groups[0].memberKeys).toEqual(['item:local:3', 'item:local:2'])
  })

  it('marks a moved watch entry as user-maintained without changing structure groups', () => {
    const before = { ...organization(), orderSource: 'existing' as const, watchEntries: organization().watchEntries.map((entry, index) => index === 0 ? { ...entry, pending: true } : entry) }
    const changed = moveWatchEntry(before, 'watch:a', 1)
    expect(changed.orderSource).toBe('user')
    expect(changed.watchEntries.map(entry => entry.id)).toEqual(['watch:b', 'watch:a', 'watch:c'])
    expect(changed.watchEntries[1].pending).toBe(false)
    expect(changed.groups).toEqual(before.groups)
  })

  it('confirms the current fallback order without moving entries and clears pending markers', () => {
    const before = { ...organization(), orderSource: 'existing' as const, watchEntries: organization().watchEntries.map((entry, index) => ({ ...entry, pending: index !== 1 })) }
    const confirmed = confirmWatchOrder(before)
    expect(confirmed.orderSource).toBe('user')
    expect(confirmed.watchEntries).toEqual(before.watchEntries.map(entry => ({ id: entry.id, targetKey: entry.targetKey })))
    expect(confirmed.groups).toEqual(before.groups)
  })

  it('removes a dangling reference only after an explicit edit and cleans its group memberships', () => {
    const before = organization()
    before.watchEntries.push({ id: 'watch:missing', targetKey: 'item:missing' })
    before.groups[0].memberKeys.push('item:missing')
    const removed = removeCollectionMembers(before, ['item:missing'])
    expect(removed.watchEntries.some(entry => entry.targetKey === 'item:missing')).toBe(false)
    expect(removed.groups.some(group => group.memberKeys.includes('item:missing'))).toBe(false)
    expect(removed.watchEntries.slice(0, 3)).toEqual(before.watchEntries.slice(0, 3))
  })

  it('retains missing references and counts a work once when groups reference it more than once', () => {
    const value = organization()
    value.watchEntries.push({ id: 'watch:missing', targetKey: 'item:missing', pending: true })
    value.groups[0].memberKeys.push('item:missing')
    value.groups[1].memberKeys.push('item:local:1')
    const views = resolveCollectionViews(buildCollectionNavigation(catalog()), value)
    expect(views.works.size).toBe(3)
    expect(views.watch.at(-1)).toMatchObject({ missing: true, pending: true })
  })

  it('keeps full canonical keys distinct when compatibility presentation keys collide', () => {
    const mediaCatalog = catalog()
    mediaCatalog.items = [item(1, 'Original'), { ...item(4, 'Custom'), item_key: 'custom:TV:local:1' }]
    mediaCatalog.mappings = [mapping(1), mapping(4)]
    mediaCatalog.ungrouped_item_ids = [1, 4]
    const views = resolveCollectionViews(buildCollectionNavigation(mediaCatalog), { version: 1, orderSource: 'existing', watchEntries: [], groups: [] })
    expect(new Set(views.works.keys())).toEqual(new Set(['item:local:1', 'item:custom:TV:local:1']))
    expect(new Set(views.watch.map(target => target.targetKey))).toEqual(new Set(['item:local:1', 'item:custom:TV:local:1']))
    expect(views.watch.every(target => !target.missing)).toBe(true)
  })

  it('carries collection and entry context in folder navigation', () => {
    expect(collectionFolderUrl(22, 1, 'watch:a', 'structure')).toBe('/folder/22?collection=1&entry=watch%3Aa&view=structure')
  })
})

describe('collection next content navigation', () => {
  it('resolves A to B from the full sequence and treats two season mappings in one real folder as one available target', () => {
    const mediaCatalog = catalog()
    mediaCatalog.items[1].kind = 'season'
    mediaCatalog.mappings = [mapping(1), mapping(2, 22, 1), mapping(2, 22, 2), mapping(3)]
    const next = resolveCollectionNextState(folder(mediaCatalog), organization(), 'watch:a')
    expect(next.next).toMatchObject({ entryId: 'watch:b', folderId: 22, status: 'available' })
  })

  it('requires an explicit choice for multiple directories and never skips a missing next reference', () => {
    const mediaCatalog = catalog()
    mediaCatalog.mappings.push(mapping(2, 23, 2))
    expect(resolveCollectionNextState(folder(mediaCatalog), organization(), 'watch:a').next).toMatchObject({ status: 'choose', folderId: null })
    const missing = organization()
    missing.watchEntries[1] = { id: 'watch:missing', targetKey: 'item:missing' }
    expect(resolveCollectionNextState(folder(mediaCatalog), missing, 'watch:a').next).toMatchObject({ entryId: 'watch:missing', status: 'missing', folderId: null })
  })
})