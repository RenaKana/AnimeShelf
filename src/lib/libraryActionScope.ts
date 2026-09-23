import type { FolderView } from '../types'

/** Never accept stale selection or widen an explicit empty result to a whole library. */
export function libraryActionTargets(items: FolderView[], selected: ReadonlySet<number>): number[] {
  const valid = items.filter(item => selected.has(item.id))
  return [...new Set((selected.size ? valid : items).map(item => item.id))]
}
export function groupLibraryActionTargets(items: FolderView[], folderIds: readonly number[]): Map<number, number[]> {
  if (!folderIds.length) throw new Error('当前范围没有作品')
  const byId = new Map(items.map(item => [item.id, item]))
  const groups = new Map<number, number[]>()
  for (const id of new Set(folderIds)) {
    const item = byId.get(id)
    if (!item || !Number.isSafeInteger(item.library_id) || item.library_id <= 0) throw new Error('作品范围已失效，请重新读取后再试')
    const ids = groups.get(item.library_id) ?? []
    ids.push(id); groups.set(item.library_id, ids)
  }
  return groups
}
