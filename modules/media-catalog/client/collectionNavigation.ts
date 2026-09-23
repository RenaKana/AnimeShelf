import type { CollectionPresentation, MediaCatalogItem, MediaCatalogKind, MediaCatalogManualPayload, MediaCatalogMapping, MediaCatalogV2, MediaCatalogWorkGroup } from '../../../src/types'
import { formatSeasonNumbers, parseSeasonNumbersInput } from './mediaCatalog'

type Mapping = Omit<MediaCatalogMapping, 'folder_path'> & { folder_path?: string }
export type CollectionCatalog = Pick<MediaCatalogV2, 'items' | 'work_groups'> & { mappings: Mapping[] }
export interface CollectionWork {
  type: 'work'; key: string; orderKey: string; title: string; label: string; sortName: string
  item: MediaCatalogItem; group: MediaCatalogWorkGroup | null
  folders: Array<{ id: number; name: string; path: string; mappings: Mapping[] }>
}
export interface CollectionGroup {
  type: 'group'; key: string; orderKey: string; title: string; label: string; sortName: string
  group: MediaCatalogWorkGroup; works: CollectionWork[]
}
export type CollectionRow = CollectionWork | CollectionGroup
// Custom classifications use a replaceable key prefix; presentation belongs to
// the underlying work, not the current type label.
export const collectionItemKey = (item: MediaCatalogItem) => `item:${item.item_key.replace(/^custom:[^:]+:/, '')}`
export const collectionGroupKey = (group: MediaCatalogWorkGroup) => `group:${group.group_key}`
export const naturalCompare = (left: string, right: string) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' })
export function collectionClassification(kind: MediaCatalogKind | 'tv', seasons: string, part: string, custom: string): MediaCatalogManualPayload {
  const parsed = parseSeasonNumbersInput(kind === 'tv' || kind === 'season' ? seasons : '')
  if (parsed.error) throw new Error(parsed.error)
  const partNumber = part.trim() ? Number(part) : null
  if (partNumber !== null && (!/^\d+$/.test(part.trim()) || !Number.isSafeInteger(partNumber) || partNumber <= 0)) throw new Error('Part 需为正整数，或留空')
  if ((kind === 'tv' || kind === 'season') && parsed.values.length === 0) return { kind: 'custom', customLabel: 'TV', seasonNumbers: [], partNumber }
  if (kind === 'custom' && !custom.trim()) throw new Error('请填写自定义类型名称')
  return { kind: kind === 'tv' ? 'season' : kind, seasonNumbers: parsed.values, partNumber, ...(kind === 'custom' ? { customLabel: custom.trim() } : {}) }
}
const displayName = (title: string) => title.trim() || title

export function collectionWorkLabel(item: MediaCatalogItem, mappings: Mapping[]): string {
  const seasons = [...new Set(mappings.filter(row => row.kind === 'season' && row.season_number).map(row => row.season_number!))]
  const labels = { season: 'TV', movie: '剧场版', ova: 'OVA', special: 'SP', custom: item.custom_label || '自定义', extras: '附加内容', unknown: '作品' }
  const label = item.kind === 'season' && seasons.length ? formatSeasonNumbers(seasons) : labels[item.kind]
  return item.part_number ? `${label} · Part ${item.part_number}` : label
}

/** Collections describe named works, not directory depth or a global season sequence. */
export function buildCollectionNavigation(catalog: CollectionCatalog | null | undefined, presentation?: CollectionPresentation): CollectionRow[] {
  if (!catalog) return []
  const prefs = new Map(presentation?.entries.map(entry => [entry.key, entry]) ?? [])
  const compare = (a: CollectionRow, b: CollectionRow) => {
    const left = prefs.get(a.orderKey)?.position ?? Number.MAX_SAFE_INTEGER
    const right = prefs.get(b.orderKey)?.position ?? Number.MAX_SAFE_INTEGER
    return left - right || naturalCompare(a.sortName, b.sortName) || naturalCompare(a.key, b.key)
  }
  const makeWork = (item: MediaCatalogItem, group: MediaCatalogWorkGroup | null, standalone: boolean): CollectionWork => {
    const mappings = catalog.mappings.filter(row => row.media_item_id === item.id)
    const folderMap = new Map<number, CollectionWork['folders'][number]>()
    for (const mapping of mappings) {
      const folder = folderMap.get(mapping.folder_id) ?? { id: mapping.folder_id, name: mapping.folder_name, path: mapping.folder_path ?? mapping.folder_name, mappings: [] }
      folder.mappings.push(mapping)
      folderMap.set(folder.id, folder)
    }
    const key = collectionItemKey(item)
    const title = prefs.get(key)?.title || (standalone && group?.manual_locked ? group.title : item.title_zh?.trim()) || (standalone && group ? displayName(group.title) : item.title)
    return {
      type: 'work', key, orderKey: standalone && group ? collectionGroupKey(group) : key, title,
      label: collectionWorkLabel(item, mappings), sortName: standalone && group ? group.title : mappings[0]?.folder_path ?? mappings[0]?.folder_name ?? item.title,
      item, group, folders: [...folderMap.values()].sort((a, b) => naturalCompare(a.path, b.path)),
    }
  }
  const used = new Set<number>()
  const byId = new Map(catalog.items.filter(item => item.kind !== 'extras').map(item => [item.id, item]))
  const rows: CollectionRow[] = []
  for (const group of catalog.work_groups) {
    const ids = group.item_ids.length ? group.item_ids : group.members.map(member => member.media_item_id)
    const items = [...new Set(ids)].flatMap(id => byId.has(id) && !used.has(id) ? [byId.get(id)!] : [])
    items.forEach(item => used.add(item.id))
    if (items.length === 1) rows.push(makeWork(items[0], group, true))
    else if (items.length > 1) rows.push({ type: 'group', key: collectionGroupKey(group), orderKey: collectionGroupKey(group), title: group.manual_locked ? group.title : displayName(group.title), label: `${items.length} 部作品`, sortName: group.title, group, works: items.map(item => makeWork(item, group, false)).sort(compare) })
  }
  for (const item of byId.values()) if (!used.has(item.id)) rows.push(makeWork(item, null, true))
  return rows.sort(compare)
}
