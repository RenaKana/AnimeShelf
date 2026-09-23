import { posterUrl } from '../../../src/lib/poster'

type ArtworkFolder = { id: number; poster_version?: string | null }
export function buildCollectionArtwork(item: { children: ArtworkFolder[]; collection_artwork?: ArtworkFolder[] }): Record<number, string | null> {
  return Object.fromEntries([...item.children, ...(item.collection_artwork ?? [])].map(folder => [folder.id, posterUrl(folder)]))
}

export function collectionWorkPoster(work: {
  folders: Array<{ id: number }>
  group: { anchor_folder_id: number | null; item_ids: number[]; members: Array<{ media_item_id: number }> } | null
}, artwork: Record<number, string | null>): string | null {
  for (const folder of work.folders) if (artwork[folder.id]) return artwork[folder.id]
  const group = work.group
  const members = group ? new Set(group.item_ids.length ? group.item_ids : group.members.map(member => member.media_item_id)) : null
  // A multi-work group poster need not represent this work.
  return members?.size === 1 && group?.anchor_folder_id != null ? artwork[group.anchor_folder_id] ?? null : null
}
