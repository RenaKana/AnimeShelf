import { createHash } from 'node:crypto'
import type { Database } from 'node-sqlite3-wasm'
import { VIDEO_EXTS } from '../../../server/services/everything'
import {
  getMediaCatalogForFolder,
  MediaCatalogValidationError,
  rebuildMediaCatalogForRootInTransaction,
  type MediaCatalogRebuildResult,
  type MediaCatalogSnapshot,
} from './media-catalog'

const SNAPSHOT_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/

interface CollectionRootRow {
  id: number
  library_id: number
  pinned: number
}

interface ScopeFolderRow {
  id: number
  source: string | null
  anilist_id: number | null
}

interface ScopeFileRow {
  folder_id: number
  name: string
  ext: string
}

export interface CollectionResetStatus {
  snapshot_version: string
}

export interface CollectionResetResult {
  root_folder_id: number
  before_snapshot_version: string
  after_snapshot_version: string
  rebuild: MediaCatalogRebuildResult
  catalog: MediaCatalogSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requirePinnedCollectionRoot(db: Database, folderId: number): CollectionRootRow {
  if (!Number.isSafeInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const root = db.prepare(`
    SELECT id, library_id, pinned FROM folders WHERE id = ?
  `).get(folderId) as CollectionRootRow | null
  if (!root) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  if (root.pinned !== 1) {
    throw new MediaCatalogValidationError(
      '完全重置仅适用于已标记的合集根目录',
      409,
      'COLLECTION_RESET_REQUIRES_PINNED_ROOT',
    )
  }
  return root
}

function scopeFolderRows(db: Database, rootFolderId: number): ScopeFolderRow[] {
  return db.prepare(`
    WITH RECURSIVE scope(id) AS (
      SELECT id FROM folders WHERE id = ?
      UNION ALL
      SELECT child.id
      FROM folders child
      JOIN scope parent ON child.parent_id = parent.id
      WHERE child.pinned <> 1
    )
    SELECT folder.id, folder.source, folder.anilist_id
    FROM folders folder
    WHERE folder.id IN (SELECT id FROM scope)
    ORDER BY folder.id
  `).all(rootFolderId) as unknown as ScopeFolderRow[]
}

function collectionResetState(db: Database, root: CollectionRootRow): unknown {
  const scopeFolders = scopeFolderRows(db, root.id)
  const scopeIds = scopeFolders.map(folder => folder.id)
  const placeholders = scopeIds.map(() => '?').join(', ')
  return {
    folders: db.prepare(`
      SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, pinned
      FROM folders WHERE id IN (${placeholders}) ORDER BY id
    `).all(scopeIds),
    files: db.prepare(`
      SELECT id, folder_id, library_id, name, path, ext
      FROM files WHERE folder_id IN (${placeholders}) ORDER BY id
    `).all(scopeIds),
    series: db.prepare(`
      SELECT id, library_id, root_folder_id, series_key, title, manual_locked
      FROM media_series WHERE root_folder_id = ? ORDER BY id
    `).all(root.id),
    entries: db.prepare(`
      SELECT entry.id, entry.folder_id, entry.series_id, entry.kind,
             entry.season_number, entry.part_number, entry.custom_label,
             entry.source, entry.external_id, entry.confidence, entry.detected_by,
             entry.conflict_reason, entry.manual_locked
      FROM folder_media_entries entry
      JOIN media_series series ON series.id = entry.series_id
      WHERE series.root_folder_id = ? ORDER BY entry.id
    `).all(root.id),
    items: db.prepare(`
      SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind,
             season_number, part_number, confidence, conflict_reason, manual_locked
      FROM media_items WHERE root_folder_id = ? ORDER BY id
    `).all(root.id),
    sources: db.prepare(`
      SELECT source.id, source.media_item_id, source.source, source.external_id, source.is_primary
      FROM media_item_sources source
      JOIN media_items item ON item.id = source.media_item_id
      WHERE item.root_folder_id = ? ORDER BY source.id
    `).all(root.id),
    groups: db.prepare(`
      SELECT id, library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked
      FROM media_work_groups WHERE root_folder_id = ? ORDER BY id
    `).all(root.id),
    members: db.prepare(`
      SELECT member.id, member.work_group_id, member.media_item_id,
             member.relation_role, member.manual_locked
      FROM media_work_group_members member
      JOIN media_work_groups work_group ON work_group.id = member.work_group_id
      WHERE work_group.root_folder_id = ? ORDER BY member.id
    `).all(root.id),
    work_group_exclusions: db.prepare(`
      SELECT id, root_folder_id, media_item_id
      FROM media_work_group_exclusions WHERE root_folder_id = ? ORDER BY id
    `).all(root.id),
    mappings: db.prepare(`
      SELECT id, folder_id, media_item_id, root_folder_id, series_id, content_role,
             kind, season_number, part_number, custom_label, confidence,
             conflict_reason, detected_by, manual_locked
      FROM folder_media_mappings WHERE root_folder_id = ? ORDER BY id
    `).all(root.id),
    folder_exclusions: db.prepare(`
      SELECT folder_id, manual_kind, manual_season_numbers, manual_part_number,
             manual_custom_label
      FROM folder_media_catalog_exclusions
      WHERE folder_id IN (${placeholders}) ORDER BY folder_id
    `).all(scopeIds),
    presentation: db.prepare(`
      SELECT root_folder_id, entry_key, display_title, position
      FROM media_collection_presentation WHERE root_folder_id = ? ORDER BY entry_key
    `).all(root.id),
    ai_undo: db.prepare(`
      SELECT root_folder_id, library_id, undo_id, state_format_version, changes_json,
             before_snapshot_version, after_snapshot_version
      FROM media_catalog_ai_undo_journal WHERE root_folder_id = ?
    `).all(root.id),
  }
}

function collectionResetSnapshotVersion(db: Database, root: CollectionRootRow): string {
  const state = collectionResetState(db, root)
  return `sha256:${createHash('sha256').update(JSON.stringify(state), 'utf8').digest('hex')}`
}

export function getCollectionResetStatus(db: Database, folderId: number): CollectionResetStatus {
  const root = requirePinnedCollectionRoot(db, folderId)
  return { snapshot_version: collectionResetSnapshotVersion(db, root) }
}

function validateResetInput(input: unknown): string {
  if (!isRecord(input) || Object.keys(input).some(key => !['confirm', 'expected_snapshot_version'].includes(key))) {
    throw new MediaCatalogValidationError(
      '合集重置参数必须只包含 confirm 和 expected_snapshot_version',
      400,
      'INVALID_COLLECTION_RESET_INPUT',
    )
  }
  if (input.confirm !== true) {
    throw new MediaCatalogValidationError(
      '必须明确确认完全重置合集',
      400,
      'COLLECTION_RESET_CONFIRMATION_REQUIRED',
    )
  }
  if (typeof input.expected_snapshot_version !== 'string' || !SNAPSHOT_VERSION_PATTERN.test(input.expected_snapshot_version)) {
    throw new MediaCatalogValidationError(
      '合集重置快照版本无效',
      400,
      'INVALID_COLLECTION_RESET_SNAPSHOT_VERSION',
    )
  }
  return input.expected_snapshot_version
}

function assertRootIsolation(db: Database, root: CollectionRootRow): void {
  const scopeFolders = scopeFolderRows(db, root.id)
  const scopeFolderIds = new Set(scopeFolders.map(folder => folder.id))
  const crossReference = db.prepare(`
    SELECT 1
    WHERE EXISTS (
      SELECT 1
      FROM folder_media_mappings mapping
      JOIN media_items item ON item.id = mapping.media_item_id
      WHERE (mapping.root_folder_id = ? AND item.root_folder_id <> ?)
         OR (mapping.root_folder_id <> ? AND item.root_folder_id = ?)
    ) OR EXISTS (
      SELECT 1
      FROM media_work_group_members member
      JOIN media_work_groups work_group ON work_group.id = member.work_group_id
      JOIN media_items item ON item.id = member.media_item_id
      WHERE (work_group.root_folder_id = ? AND item.root_folder_id <> ?)
         OR (work_group.root_folder_id <> ? AND item.root_folder_id = ?)
    ) OR EXISTS (
      SELECT 1
      FROM media_work_group_exclusions exclusion
      JOIN media_items item ON item.id = exclusion.media_item_id
      WHERE (exclusion.root_folder_id = ? AND item.root_folder_id <> ?)
         OR (exclusion.root_folder_id <> ? AND item.root_folder_id = ?)
    ) OR EXISTS (
      SELECT 1
      FROM folder_media_mappings mapping
      JOIN media_series series ON series.id = mapping.series_id
      WHERE mapping.root_folder_id <> ? AND series.root_folder_id = ?
    )
  `).get([
    root.id, root.id, root.id, root.id,
    root.id, root.id, root.id, root.id,
    root.id, root.id, root.id, root.id,
    root.id, root.id,
  ])
  if (crossReference) {
    throw new MediaCatalogValidationError(
      '合集目录存在跨根目录的目录关系，已拒绝重置',
      409,
      'COLLECTION_RESET_SCOPE_CONFLICT',
    )
  }

  const mappingScopeRows = db.prepare(`
    SELECT folder_id, root_folder_id
    FROM folder_media_mappings
    WHERE root_folder_id = ?
       OR folder_id IN (${scopeFolders.map(() => '?').join(', ')})
  `).all([root.id, ...scopeFolderIds]) as unknown as Array<{ folder_id: number; root_folder_id: number }>
  if (mappingScopeRows.some(row =>
    (row.root_folder_id === root.id) !== scopeFolderIds.has(row.folder_id))) {
    throw new MediaCatalogValidationError(
      '合集目录存在跨根目录的物理映射，已拒绝重置',
      409,
      'COLLECTION_RESET_SCOPE_CONFLICT',
    )
  }

  const entryScopeRows = db.prepare(`
    SELECT entry.folder_id, series.root_folder_id
    FROM folder_media_entries entry
    JOIN media_series series ON series.id = entry.series_id
    WHERE series.root_folder_id = ?
       OR entry.folder_id IN (${scopeFolders.map(() => '?').join(', ')})
  `).all([root.id, ...scopeFolderIds]) as unknown as Array<{ folder_id: number; root_folder_id: number }>
  if (entryScopeRows.some(row =>
    (row.root_folder_id === root.id) !== scopeFolderIds.has(row.folder_id))) {
    throw new MediaCatalogValidationError(
      '合集目录存在跨根目录的手动分类，已拒绝重置',
      409,
      'COLLECTION_RESET_SCOPE_CONFLICT',
    )
  }

  const files = db.prepare(`
    SELECT folder_id, name, ext FROM files
    WHERE folder_id IN (${scopeFolders.map(() => '?').join(', ')})
  `).all([...scopeFolderIds]) as unknown as ScopeFileRow[]
  const videoFolderIds = new Set(files.filter(file => {
    const ext = String(file.ext || file.name.split('.').pop() || '').replace(/^\./, '').toLowerCase()
    return VIDEO_EXTS.includes(ext)
  }).map(file => file.folder_id))
  const targetSources = new Set(scopeFolders
    .filter(folder => videoFolderIds.has(folder.id) && folder.anilist_id !== null)
    .map(folder => `${String(folder.source ?? '').trim().toLowerCase()}\0${String(folder.anilist_id).trim()}`)
    .filter(key => !key.startsWith('\0')))
  if (targetSources.size === 0) return
  const foreignSources = db.prepare(`
    SELECT source.source, source.external_id
    FROM media_item_sources source
    JOIN media_items item ON item.id = source.media_item_id
    WHERE item.library_id = ? AND item.root_folder_id <> ?
  `).all([root.library_id, root.id]) as Array<{ source: string; external_id: string }>
  if (foreignSources.some(source => targetSources.has(`${source.source.trim().toLowerCase()}\0${source.external_id.trim()}`))) {
    throw new MediaCatalogValidationError(
      '合集来源编号与其它根目录共享，无法保证隔离重建',
      409,
      'COLLECTION_RESET_SOURCE_SCOPE_CONFLICT',
    )
  }
}

function deleteRootState(db: Database, rootFolderId: number): void {
  db.prepare('DELETE FROM media_catalog_ai_undo_journal WHERE root_folder_id = ?').run(rootFolderId)
  db.prepare('DELETE FROM media_collection_presentation WHERE root_folder_id = ?').run(rootFolderId)
  db.prepare(`
    WITH RECURSIVE scope(id) AS (
      SELECT id FROM folders WHERE id = ?
      UNION ALL
      SELECT child.id
      FROM folders child
      JOIN scope parent ON child.parent_id = parent.id
      WHERE child.pinned <> 1
    )
    DELETE FROM folder_media_catalog_exclusions
    WHERE folder_id IN (SELECT id FROM scope)
  `).run(rootFolderId)
  db.prepare('DELETE FROM media_work_group_exclusions WHERE root_folder_id = ?').run(rootFolderId)
  db.prepare('DELETE FROM media_work_groups WHERE root_folder_id = ?').run(rootFolderId)
  db.prepare('DELETE FROM folder_media_mappings WHERE root_folder_id = ?').run(rootFolderId)
  db.prepare('DELETE FROM media_items WHERE root_folder_id = ?').run(rootFolderId)
  db.prepare('DELETE FROM media_series WHERE root_folder_id = ?').run(rootFolderId)
}

export function resetCollectionCatalog(
  db: Database,
  folderId: number,
  input: unknown,
): CollectionResetResult {
  const expectedSnapshotVersion = validateResetInput(input)
  let transactionStarted = false
  try {
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const root = requirePinnedCollectionRoot(db, folderId)
    const beforeSnapshotVersion = collectionResetSnapshotVersion(db, root)
    if (beforeSnapshotVersion !== expectedSnapshotVersion) {
      throw new MediaCatalogValidationError(
        '合集内容已发生变化，请刷新后重试',
        409,
        'COLLECTION_RESET_STALE',
      )
    }
    assertRootIsolation(db, root)
    deleteRootState(db, root.id)
    const rebuild = rebuildMediaCatalogForRootInTransaction(db, root.id)
    const afterSnapshotVersion = collectionResetSnapshotVersion(db, root)
    const catalog = getMediaCatalogForFolder(db, root.id)
    db.exec('COMMIT')
    transactionStarted = false
    return {
      root_folder_id: root.id,
      before_snapshot_version: beforeSnapshotVersion,
      after_snapshot_version: afterSnapshotVersion,
      rebuild,
      catalog,
    }
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    }
    throw error
  }
}
