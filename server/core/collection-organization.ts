import type { Database } from 'node-sqlite3-wasm'
import { sqlAll, sqlGet, sqlRun } from '../db/sql'
import { collectionMemberKey, removeCollectionMembers, resolveCollectionOrganization, validateCollectionOrganization, type CollectionOrganization } from '../../shared/collection-organization'
import { sameJson } from '../../shared/json-equality'

export class CollectionOrganizationError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_COLLECTION_ORGANIZATION') { super(message) }
}
export interface CollectionOrganizationSnapshot { organization: CollectionOrganization; revision: number }
interface Stored { organization_json: string; revision: number }

/** Same legacy grouping/list positions as the collection browser, flattened to real media identities. */
export function collectionMemberKeys(db: Database, rootId: number): string[] {
  const items = sqlAll<{ id: number; item_key: string; title: string; path: string | null; group_key: string | null; group_title: string | null }>(db, `
    SELECT i.id, i.item_key, i.title, (SELECT f.path FROM folder_media_mappings m JOIN folders f ON f.id=m.folder_id
      WHERE m.media_item_id=i.id AND m.root_folder_id=? ORDER BY m.id LIMIT 1) AS path,
      g.group_key, g.title AS group_title FROM media_items i
    LEFT JOIN media_work_group_members gm ON gm.media_item_id=i.id
    LEFT JOIN media_work_groups g ON g.id=gm.work_group_id AND g.root_folder_id=i.root_folder_id
    WHERE i.root_folder_id=? AND i.kind <> 'extras' ORDER BY i.id`, [rootId, rootId])
  const positions = new Map(sqlAll<{ entry_key: string; position: number | null }>(db,
    'SELECT entry_key, position FROM media_collection_presentation WHERE root_folder_id=?', rootId).map(row => [row.entry_key, row.position]))
  const compare = (a: { key: string; title: string }, b: { key: string; title: string }) =>
    (positions.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    || a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' }) || a.key.localeCompare(b.key)
  const blocks = new Map<string, { key: string; title: string; items: typeof items }>()
  for (const item of items) {
    const key = item.group_key ? `group:${item.group_key}` : collectionMemberKey(item.item_key)
    const block = blocks.get(key) ?? { key, title: item.group_title || item.path || item.title, items: [] }
    block.items.push(item); blocks.set(key, block)
  }
  return [...new Set([...blocks.values()].sort(compare).flatMap(block => block.items
    .map(item => ({ key: collectionMemberKey(item.item_key), title: item.path || item.title,
      legacyKey: `item:${item.item_key.replace(/^custom:[^:]+:/, '')}` }))
    .sort((a,b) => compare({ ...a,key:a.legacyKey },{ ...b,key:b.legacyKey })).map(item => item.key)))]
}

function storedOrganization(db: Database, rootId: number): { organization: CollectionOrganization | null; revision: number } {
  const row = sqlGet<Stored>(db, 'SELECT organization_json, revision FROM media_collection_organization WHERE root_folder_id=?', rootId)
  if (!row) return { organization: null, revision: 0 }
  try {
    const parsed = JSON.parse(row.organization_json) as CollectionOrganization
    return { organization: validateCollectionOrganization(parsed, [], parsed), revision: row.revision }
  }
  catch { throw new CollectionOrganizationError('合集组织记录无法读取，请恢复备份或修复记录', 409, 'COLLECTION_ORGANIZATION_CORRUPT') }
}

export function getCollectionOrganization(db: Database, rootId: number): CollectionOrganizationSnapshot {
  if (!Number.isSafeInteger(rootId) || rootId <= 0 || !sqlGet(db, 'SELECT id FROM folders WHERE id=?', rootId)) {
    throw new CollectionOrganizationError('合集不存在', 404, 'COLLECTION_NOT_FOUND')
  }
  const stored = storedOrganization(db, rootId)
  return { organization: resolveCollectionOrganization(stored.organization, collectionMemberKeys(db, rootId)), revision: stored.revision }
}

/** Persists one validated organization revision inside the caller's transaction. */
export function saveCollectionOrganization(db: Database, rootId: number, input: unknown, expectedRevision?: number): CollectionOrganizationSnapshot {
  const current = getCollectionOrganization(db, rootId)
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new CollectionOrganizationError('合集已在其他位置更新，请重新加载后再编辑', 409, 'COLLECTION_ORGANIZATION_CONFLICT')
  }
  let organization: CollectionOrganization
  try { organization = validateCollectionOrganization(input, collectionMemberKeys(db, rootId), current.organization) }
  catch (error) { throw new CollectionOrganizationError(error instanceof Error ? error.message : '合集组织配置无效') }
  const stored = storedOrganization(db, rootId)
  if (sameJson(stored.organization, organization)) return { organization, revision: current.revision }
  const revision = current.revision + 1
  sqlRun(db, `INSERT INTO media_collection_organization(root_folder_id, organization_json, revision) VALUES (?,?,?)
    ON CONFLICT(root_folder_id) DO UPDATE SET organization_json=excluded.organization_json, revision=excluded.revision`, [rootId, JSON.stringify(organization), revision])
  return { organization, revision }
}

/** Called at the end of catalog mutations. Refreshing metadata never sorts or deletes saved entries. */
export function appendNewCollectionMembers(db: Database, libraryId: number, rootId?: number): void {
  const roots = sqlAll<{ root_folder_id: number }>(db, `SELECT o.root_folder_id FROM media_collection_organization o
    JOIN folders f ON f.id=o.root_folder_id WHERE f.library_id=?${rootId === undefined ? '' : ' AND f.id=?'}`, rootId === undefined ? libraryId : [libraryId, rootId])
  for (const root of roots) {
    const current = getCollectionOrganization(db, root.root_folder_id)
    saveCollectionOrganization(db, root.root_folder_id, current.organization)
  }
}

export function explicitlyRemoveCollectionMembers(db: Database, rootId: number, keys: string[]): void {
  const stored = storedOrganization(db, rootId)
  if (!stored.organization) return
  const organization = removeCollectionMembers(stored.organization, keys)
  if (!sameJson(stored.organization, organization)) sqlRun(db,
    'UPDATE media_collection_organization SET organization_json=?, revision=revision+1 WHERE root_folder_id=?', [JSON.stringify(organization), rootId])
}

/** Only callers with proof of a same-item rekey/replacement may rebind a saved target. */
export function rekeyCollectionMember(db: Database, rootId: number, previousItemKey: string, nextItemKey: string): void {
  const previousKey=collectionMemberKey(previousItemKey), nextKey=collectionMemberKey(nextItemKey)
  if(previousKey===nextKey) return
  const stored=storedOrganization(db,rootId)
  if(!stored.organization) return
  const old=stored.organization.watchEntries.find(entry=>entry.targetKey===previousKey)
  const destination=stored.organization.watchEntries.find(entry=>entry.targetKey===nextKey)
  // A separately confirmed destination requires user reconciliation, never silently merge its position.
  if(old && destination && !destination.pending) return
  const organization:CollectionOrganization={...stored.organization,
    watchEntries:stored.organization.watchEntries.filter(entry=>!(old && entry.targetKey===nextKey)).map(entry=>entry.targetKey===previousKey?{...entry,targetKey:nextKey}:entry),
    groups:stored.organization.groups.map(group=>({...group,memberKeys:[...new Set(group.memberKeys.map(key=>key===previousKey?nextKey:key))]}))}
  if(!sameJson(stored.organization,organization)) sqlRun(db,
    'UPDATE media_collection_organization SET organization_json=?, revision=revision+1 WHERE root_folder_id=?',[JSON.stringify(organization),rootId])
}
