import { describe, expect, it } from 'vitest'
import type { MediaCatalogItem, MediaCatalogMapping, MediaCatalogV2 } from '../../../src/types'

const item = (id: number, title: string): MediaCatalogItem => ({ id, library_id: 1, root_folder_id: 1, item_key: `local:${id}`, title, title_zh: null, kind: 'unknown', season_number: null, part_number: null, manual_locked: 0, confidence: 0, conflict_reason: null, source_ids: [] })
const mapping = (id: number, folderId = id): MediaCatalogMapping => ({ id, folder_id: folderId, media_item_id: id, root_folder_id: 1, series_id: null, content_role: 'main', kind: 'unknown', season_number: null, part_number: null, folder_name: `release-${id}`, folder_path: `Collection/release-${id}`, manual_locked: 0, confidence: 0, conflict_reason: null, detected_by: 'rule' })
export const collectionFixture = (): MediaCatalogV2 => ({
  root_folder_id: 1, items: [item(10, 'release10'), item(2, 'release2'), item(1, 'release1')], mappings: [mapping(10), mapping(2), mapping(1)],
  work_groups: [10, 2, 1].map(id => ({ id, key: `anchor:${id}`, group_key: `anchor:${id}`, title: `${id}${id === 10 ? '终物语' : id === 2 ? '伪物语' : '化物语'}`, anchor: id, anchor_folder_id: id, manual_locked: 0, item_ids: [id], members: [], summary: { item_count: 1, physical_folder_count: 1, season_numbers: [], manual_count: 0, conflict_count: 0, unknown_count: 1 } })),
  ungrouped_item_ids: [], summary: { root_folder_id: 1, item_count: 3, mapping_count: 3, season_numbers: [], manual_count: 0, conflict_count: 0, unknown_count: 3 },
})

describe('collection navigation', () => {
  it('allows named TV content with no forced season and preserves explicit ranges', async () => {
    const { collectionClassification } = await import('../client/collectionNavigation')
    expect(collectionClassification('tv', '', '', '')).toEqual({ kind: 'custom', customLabel: 'TV', seasonNumbers: [], partNumber: null })
    expect(collectionClassification('tv', '1,2', '2', '')).toEqual({ kind: 'season', seasonNumbers: [1, 2], partNumber: 2 })
    expect(() => collectionClassification('tv', 'oops', '', '')).toThrow()
    expect(() => collectionClassification('ova', '', '-1', '')).toThrow()
  })
  it('flattens single-member groups and uses natural collection order without inventing S1', async () => {
    const { buildCollectionNavigation } = await import('../client/collectionNavigation')
    const rows = buildCollectionNavigation(collectionFixture())
    expect(rows.map(row => row.title)).toEqual(['1化物语', '2伪物语', '10终物语'])
    expect(rows.every(row => row.type === 'work')).toBe(true)
    expect(rows.map(row => row.label)).toEqual(['作品', '作品', '作品'])
  })
  it('keeps optional groups and unique folders while preserving explicit season ranges and OVA', async () => {
    const { buildCollectionNavigation } = await import('../client/collectionNavigation')
    const catalog = collectionFixture()
    catalog.work_groups = [{ ...catalog.work_groups[0], title: '物语 Second Season', item_ids: [1, 2] }]
    catalog.items[2].kind = 'season'
    catalog.mappings[2] = { ...mapping(1), kind: 'season', season_number: 1 }
    catalog.mappings.push({ ...mapping(1), id: 77, kind: 'season', season_number: 2 })
    catalog.items[1].kind = 'ova'
    catalog.mappings[1].kind = 'ova'
    const rows = buildCollectionNavigation(catalog)
    const group = rows.find(row => row.type === 'group')!
    expect(group.works).toHaveLength(2)
    expect(group.works.find(row => row.item.id === 1)?.label).toBe('S1–S2')
    expect(group.works.find(row => row.item.id === 1)?.folders).toHaveLength(1)
    expect(group.works.find(row => row.item.id === 2)?.label).toBe('OVA')
    expect(rows.filter(row => row.type === 'work')).toHaveLength(1)
  })
  it('uses distinct physical season folders as the chooser boundary without inventing a split inside one folder', async () => {
    const { buildCollectionNavigation } = await import('../client/collectionNavigation')
    const catalog = collectionFixture()
    catalog.items = [{ ...item(1, 'Fate/Zero'), kind: 'season' }]
    catalog.work_groups = []
    catalog.ungrouped_item_ids = [1]
    catalog.mappings = [
      { ...mapping(1, 617), id: 101, kind: 'season', season_number: 1 },
      { ...mapping(1, 617), id: 102, kind: 'season', season_number: 2 },
    ]
    const combined = buildCollectionNavigation(catalog)[0]
    expect(combined.type).toBe('work')
    if (combined.type !== 'work') throw new Error('expected work row')
    expect(combined.label).toBe('S1–S2')
    expect(combined.folders.map(folder => folder.id)).toEqual([617])
    expect(combined.folders[0].mappings.map(row => row.season_number)).toEqual([1, 2])

    catalog.mappings[1] = { ...catalog.mappings[1], folder_id: 618, folder_name: 'Fate Zero S2', folder_path: 'Collection/Fate Zero S2' }
    const separated = buildCollectionNavigation(catalog)[0]
    expect(separated.type).toBe('work')
    if (separated.type !== 'work') throw new Error('expected work row')
    expect(separated.label).toBe('S1–S2')
    expect(separated.folders).toHaveLength(2)
    expect(new Set(separated.folders.map(folder => folder.id))).toEqual(new Set([617, 618]))
  })

  it('uses persisted display names and positions without modifying catalog titles or disk names', async () => {
    const { buildCollectionNavigation } = await import('../client/collectionNavigation')
    const catalog = collectionFixture()
    const before = JSON.stringify(catalog)
    const rows = buildCollectionNavigation(catalog, { entries: [{ key: 'group:anchor:10', title: null, position: 0 }, { key: 'item:local:10', title: '终物语（上）', position: null }] })
    expect(rows[0].title).toBe('终物语（上）')
    expect(JSON.stringify(catalog)).toBe(before)
  })
  it('retains item presentation when a custom classification replaces the canonical key', async () => {
    const { buildCollectionNavigation } = await import('../client/collectionNavigation')
    const catalog = collectionFixture()
    catalog.items[0].item_key = 'custom:TV:local:10'
    const rows = buildCollectionNavigation(catalog, { entries: [{ key: 'item:local:10', title: '终物语（上）', position: null }] })
    expect(rows.find(row => row.orderKey === 'group:anchor:10')?.title).toBe('终物语（上）')
  })
  it('preserves numbers that belong to a work title instead of guessing they are ordering prefixes', async () => {
    const { buildCollectionNavigation } = await import('../client/collectionNavigation')
    const catalog = collectionFixture()
    catalog.work_groups[0].title = '3月的狮子'
    catalog.work_groups[1].title = '86 不存在的战区'
    const titles = buildCollectionNavigation(catalog).map(row => row.title)
    expect(titles).toContain('3月的狮子')
    expect(titles).toContain('86 不存在的战区')
  })
})
