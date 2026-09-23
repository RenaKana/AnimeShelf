import type { Database } from 'node-sqlite3-wasm'

type SqlParam = string | number | null

interface CatalogFolderRow {
  id: number
  library_id: number
  parent_id: number | null
  name: string
  is_series: number
  pinned: number
}

interface CanonicalItemRow {
  id: number
  library_id: number
  root_folder_id: number
  item_key: string
  title: string
  title_zh: string | null
  kind: string
  season_number: number | null
  part_number: number | null
  manual_locked: number
  confidence: number
  conflict_reason: string | null
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

interface MediaWorkGroupMemberStateRow extends MediaWorkGroupMemberRow {
  item_library_id: number
  item_root_folder_id: number
}

interface MediaWorkGroupMappingFolderRow {
  work_group_id: number
  folder_id: number
}

interface CanonicalRehomeMappingRow {
  id: number
  folder_id: number
  media_item_id: number
}

interface CanonicalWorkGroupRehomePlan {
  group: MediaWorkGroupRow
  members: MediaWorkGroupMemberRow[]
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
  } finally {
    statement.finalize()
  }
}

function uniqueLibraryIds(libraryIds: Iterable<number>): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  for (const libraryId of libraryIds) {
    if (!Number.isInteger(libraryId) || libraryId <= 0 || seen.has(libraryId)) continue
    seen.add(libraryId)
    result.push(libraryId)
  }
  return result
}

function ensureCatalogDirtyTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_dirty_libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL UNIQUE REFERENCES libraries(id) ON DELETE CASCADE,
      dirty_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_dirty_libraries_dirty
      ON catalog_dirty_libraries(id);
  `)
}

export function markCatalogDirty(db: Database, libraryIds: Iterable<number>): void {
  ensureCatalogDirtyTable(db)
  for (const libraryId of uniqueLibraryIds(libraryIds)) {
    if (!queryOne<{ id: number }>(db, 'SELECT id FROM libraries WHERE id = ?', [libraryId])) continue
    run(db, `
      INSERT INTO catalog_dirty_libraries (library_id, dirty_at)
      VALUES (?, datetime('now'))
      ON CONFLICT(library_id) DO UPDATE SET dirty_at = excluded.dirty_at
    `, [libraryId])
  }
}

export function listDirtyCatalogLibraries(db: Database): number[] {
  ensureCatalogDirtyTable(db)
  return queryAll<{ library_id: number }>(db, `
    SELECT dirty.library_id
    FROM catalog_dirty_libraries dirty
    JOIN libraries library ON library.id = dirty.library_id
    ORDER BY dirty.id
  `).map(row => row.library_id)
}

export function clearCatalogDirty(db: Database, libraryIds?: Iterable<number>): void {
  ensureCatalogDirtyTable(db)
  if (libraryIds === undefined) {
    run(db, 'DELETE FROM catalog_dirty_libraries')
    return
  }
  for (const libraryId of uniqueLibraryIds(libraryIds)) {
    run(db, 'DELETE FROM catalog_dirty_libraries WHERE library_id = ?', [libraryId])
  }
}

function nearestCatalogRoot(
  folder: CatalogFolderRow,
  foldersById: Map<number, CatalogFolderRow>,
): CatalogFolderRow | null {
  let current: CatalogFolderRow | undefined = folder
  const seen = new Set<number>()
  let nearestSeries: CatalogFolderRow | null = null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.pinned === 1) return current
    if (!nearestSeries && current.is_series === 1) nearestSeries = current
    current = current.parent_id === null ? undefined : foldersById.get(current.parent_id)
  }
  return nearestSeries
}

function catalogFolders(db: Database, libraryId: number): Map<number, CatalogFolderRow> {
  const rows = queryAll<CatalogFolderRow>(db, `
    SELECT id, library_id, parent_id, name, is_series, pinned
    FROM folders
    WHERE library_id = ?
    ORDER BY id
  `, [libraryId])
  return new Map(rows.map(folder => [folder.id, folder]))
}

function canonicalItemById(db: Database, itemId: number): CanonicalItemRow | undefined {
  return queryOne<CanonicalItemRow>(db, `
    SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind,
           season_number, part_number, manual_locked, confidence, conflict_reason
    FROM media_items
    WHERE id = ?
  `, [itemId])
}

function canonicalItemByKey(db: Database, libraryId: number, itemKey: string): CanonicalItemRow | undefined {
  return queryOne<CanonicalItemRow>(db, `
    SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind,
           season_number, part_number, manual_locked, confidence, conflict_reason
    FROM media_items
    WHERE library_id = ? AND item_key = ?
  `, [libraryId, itemKey])
}

function copyCanonicalItemSources(db: Database, sourceItemId: number, targetItemId: number): void {
  run(db, `
    INSERT OR IGNORE INTO media_item_sources
      (media_item_id, source, external_id, is_primary, updated_at)
    SELECT ?, source, external_id, is_primary, datetime('now')
    FROM media_item_sources
    WHERE media_item_id = ?
  `, [targetItemId, sourceItemId])
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

interface CompatibilitySeriesRow {
  id: number
  library_id: number
  root_folder_id: number
  series_key: string
  title: string
  manual_locked: number
}

function compatibilitySeriesForRoot(
  db: Database,
  libraryId: number,
  rootFolderId: number,
): CompatibilitySeriesRow | undefined {
  return queryOne<CompatibilitySeriesRow>(db, `
    SELECT id, library_id, root_folder_id, series_key, title, manual_locked
    FROM media_series
    WHERE library_id = ? AND root_folder_id = ?
    ORDER BY manual_locked DESC, id
    LIMIT 1
  `, [libraryId, rootFolderId])
}

function ensureCompatibilitySeries(
  db: Database,
  libraryId: number,
  root: CatalogFolderRow,
  source?: CompatibilitySeriesRow,
): CompatibilitySeriesRow {
  const existing = compatibilitySeriesForRoot(db, libraryId, root.id)
  if (existing) {
    if (source?.manual_locked === 1 && existing.manual_locked !== 1) {
      run(db, `
        UPDATE media_series
        SET title = ?, manual_locked = 1, updated_at = datetime('now')
        WHERE id = ?
      `, [source.title, existing.id])
    }
    return compatibilitySeriesForRoot(db, libraryId, root.id)!
  }

  const stableKey = `folder:${root.id}`
  const sourceKey = source?.series_key ?? stableKey
  const keyConflict = canonicalSeriesByKey(db, libraryId, sourceKey)
  const stableConflict = sourceKey === stableKey ? keyConflict : canonicalSeriesByKey(db, libraryId, stableKey)
  let seriesKey = keyConflict ? stableKey : sourceKey
  if (stableConflict) seriesKey = `${stableKey}#integrity:${source?.id ?? root.id}`
  const inserted = run(db, `
    INSERT INTO media_series
      (library_id, root_folder_id, series_key, title, manual_locked)
    VALUES (?, ?, ?, ?, ?)
  `, [libraryId, root.id, seriesKey, source?.title ?? root.name, source?.manual_locked ?? 0])
  return queryOne<CompatibilitySeriesRow>(db, `
    SELECT id, library_id, root_folder_id, series_key, title, manual_locked
    FROM media_series WHERE id = ?
  `, [Number(inserted.lastInsertRowid)])!
}

function canonicalSeriesByKey(
  db: Database,
  libraryId: number,
  seriesKey: string,
): CompatibilitySeriesRow | undefined {
  return queryOne<CompatibilitySeriesRow>(db, `
    SELECT id, library_id, root_folder_id, series_key, title, manual_locked
    FROM media_series
    WHERE library_id = ? AND series_key = ?
  `, [libraryId, seriesKey])
}

function rehomeCompatibilityCatalog(
  db: Database,
  libraryId: number,
  foldersById: Map<number, CatalogFolderRow>,
): void {
  const staleSeries = queryAll<CompatibilitySeriesRow>(db, `
    SELECT series.id, series.library_id, series.root_folder_id,
           series.series_key, series.title, series.manual_locked
    FROM media_series series
    JOIN folders root ON root.id = series.root_folder_id
    WHERE root.library_id = ? AND series.library_id <> ?
    ORDER BY series.id
  `, [libraryId, libraryId])

  for (const series of staleSeries) {
    const foreignEntry = queryOne<{ id: number }>(db, `
      SELECT entry.id
      FROM folder_media_entries entry
      JOIN folders folder ON folder.id = entry.folder_id
      WHERE entry.series_id = ? AND folder.library_id <> ?
      LIMIT 1
    `, [series.id, libraryId])
    const keyConflict = canonicalSeriesByKey(db, libraryId, series.series_key)
    const rootConflict = compatibilitySeriesForRoot(db, libraryId, series.root_folder_id)
    if (!foreignEntry && !keyConflict && !rootConflict) {
      run(db, `
        UPDATE media_series
        SET library_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [libraryId, series.id])
      continue
    }

    const root = foldersById.get(series.root_folder_id)
    if (!root) continue
    const target = ensureCompatibilitySeries(db, libraryId, root, series)
    run(db, `
      UPDATE folder_media_entries
      SET series_id = ?, updated_at = datetime('now')
      WHERE series_id = ?
        AND folder_id IN (SELECT id FROM folders WHERE library_id = ?)
    `, [target.id, series.id, libraryId])
    run(db, `
      DELETE FROM media_series
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM folder_media_entries WHERE series_id = media_series.id
        )
    `, [series.id])
  }

  const entries = queryAll<{
    id: number
    folder_id: number
    series_id: number
    manual_locked: number
  }>(db, `
    SELECT entry.id, entry.folder_id, entry.series_id, entry.manual_locked
    FROM folder_media_entries entry
    JOIN folders folder ON folder.id = entry.folder_id
    WHERE folder.library_id = ?
    ORDER BY entry.id
  `, [libraryId])
  for (const entry of entries) {
    const folder = foldersById.get(entry.folder_id)
    if (!folder) continue
    const source = queryOne<CompatibilitySeriesRow>(db, `
      SELECT id, library_id, root_folder_id, series_key, title, manual_locked
      FROM media_series WHERE id = ?
    `, [entry.series_id])
    if (!source) continue
    const root = nearestCatalogRoot(folder, foldersById) ?? (entry.manual_locked === 1 ? folder : null)
    if (!root) {
      run(db, 'DELETE FROM folder_media_entries WHERE id = ?', [entry.id])
      continue
    }
    if (source.library_id === libraryId && source.root_folder_id === root.id) continue
    const target = ensureCompatibilitySeries(db, libraryId, root, source)
    run(db, `
      UPDATE folder_media_entries
      SET series_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [target.id, entry.id])
  }

  run(db, `
    DELETE FROM media_series
    WHERE NOT EXISTS (
        SELECT 1 FROM folder_media_entries WHERE series_id = media_series.id
      )
      AND (
        manual_locked = 0
        OR (SELECT library_id FROM folders WHERE id = root_folder_id) IS NOT library_id
      )
  `)
}

function canonicalItemNeedsClone(db: Database, item: CanonicalItemRow): boolean {
  if (item.manual_locked === 1) return true
  if (queryOne<{ id: number }>(db, `
    SELECT id
    FROM folder_media_mappings
    WHERE media_item_id = ? AND manual_locked = 1
    LIMIT 1
  `, [item.id])) return true
  if (queryOne<{ id: number }>(db, `
    SELECT id
    FROM media_work_group_members
    WHERE media_item_id = ?
    LIMIT 1
  `, [item.id])) return true
  return Boolean(queryOne<{ id: number }>(db, `
    SELECT id
    FROM media_work_group_exclusions
    WHERE media_item_id = ?
    LIMIT 1
  `, [item.id]))
}

function canonicalItemHasOutOfScopeRelationship(
  db: Database,
  itemId: number,
  libraryId: number,
  rootFolderId: number,
): boolean {
  if (queryOne<{ id: number }>(db, `
    SELECT member.id
    FROM media_work_group_members member
    JOIN media_work_groups work_group ON work_group.id = member.work_group_id
    WHERE member.media_item_id = ?
      AND (work_group.library_id <> ? OR work_group.root_folder_id <> ?)
    LIMIT 1
  `, [itemId, libraryId, rootFolderId])) return true
  return Boolean(queryOne<{ id: number }>(db, `
    SELECT exclusion.id
    FROM media_work_group_exclusions exclusion
    JOIN folders root ON root.id = exclusion.root_folder_id
    WHERE exclusion.media_item_id = ?
      AND (root.library_id <> ? OR exclusion.root_folder_id <> ?)
    LIMIT 1
  `, [itemId, libraryId, rootFolderId]))
}

function folderBelongsToCatalogRoot(
  folderId: number,
  rootFolderId: number,
  foldersById: Map<number, CatalogFolderRow>,
): boolean {
  let current = foldersById.get(folderId)
  const seen = new Set<number>()
  while (current && !seen.has(current.id)) {
    if (current.id === rootFolderId) return true
    seen.add(current.id)
    current = current.parent_id === null ? undefined : foldersById.get(current.parent_id)
  }
  return false
}

/**
 * Returns the one physical root now owning every mapped member of a group.
 * A group is left in place when any mapping still belongs to its current root
 * or when its members have diverged across multiple roots.
 */
function canonicalWorkGroupMappingRoot(
  group: MediaWorkGroupRow,
  mappingFolders: MediaWorkGroupMappingFolderRow[],
  foldersById: Map<number, CatalogFolderRow>,
): number | null {
  let targetRootFolderId: number | null = null
  for (const mapping of mappingFolders) {
    const folder = foldersById.get(mapping.folder_id)
    const root = folder ? nearestCatalogRoot(folder, foldersById) : null
    if (!root) continue
    if (root.id === group.root_folder_id) return null
    if (targetRootFolderId !== null && targetRootFolderId !== root.id) return null
    targetRootFolderId = root.id
  }
  return targetRootFolderId
}

function prepareCanonicalWorkGroupRehome(
  db: Database,
  libraryId: number,
  foldersById: Map<number, CatalogFolderRow>,
): Map<number, CanonicalWorkGroupRehomePlan> {
  const groups = queryAll<MediaWorkGroupRow>(db, `
    SELECT work_group.id, work_group.library_id, work_group.root_folder_id,
           work_group.anchor_folder_id, work_group.group_key,
           work_group.title, work_group.manual_locked
    FROM media_work_groups work_group
    JOIN folders root ON root.id = work_group.root_folder_id
    WHERE root.library_id = ?
    ORDER BY work_group.id
  `, [libraryId])
  const memberStates = queryAll<MediaWorkGroupMemberStateRow>(db, `
    SELECT member.id, member.work_group_id, member.media_item_id,
           member.relation_role, member.manual_locked,
           item.library_id AS item_library_id,
           item.root_folder_id AS item_root_folder_id
    FROM media_work_group_members member
    JOIN media_work_groups work_group ON work_group.id = member.work_group_id
    JOIN folders root ON root.id = work_group.root_folder_id
    JOIN media_items item ON item.id = member.media_item_id
    WHERE root.library_id = ?
    ORDER BY member.work_group_id, member.id
  `, [libraryId])
  const mappingFolders = queryAll<MediaWorkGroupMappingFolderRow>(db, `
    SELECT member.work_group_id, mapping.folder_id
    FROM media_work_group_members member
    JOIN media_work_groups work_group ON work_group.id = member.work_group_id
    JOIN folders root ON root.id = work_group.root_folder_id
    JOIN folder_media_mappings mapping ON mapping.media_item_id = member.media_item_id
    JOIN folders folder ON folder.id = mapping.folder_id
    WHERE root.library_id = ? AND folder.library_id = ?
    ORDER BY member.work_group_id, member.id, mapping.id
  `, [libraryId, libraryId])
  const membersByGroup = new Map<number, MediaWorkGroupMemberStateRow[]>()
  for (const member of memberStates) {
    const members = membersByGroup.get(member.work_group_id) ?? []
    members.push(member)
    membersByGroup.set(member.work_group_id, members)
  }
  const mappingFoldersByGroup = new Map<number, MediaWorkGroupMappingFolderRow[]>()
  for (const mapping of mappingFolders) {
    const groupMappings = mappingFoldersByGroup.get(mapping.work_group_id) ?? []
    groupMappings.push(mapping)
    mappingFoldersByGroup.set(mapping.work_group_id, groupMappings)
  }
  const plans = new Map<number, CanonicalWorkGroupRehomePlan>()
  for (const group of groups) {
    const members = membersByGroup.get(group.id) ?? []
    const scopeMismatch = group.library_id !== libraryId || members.some(member => {
      return member.item_library_id !== group.library_id
        || member.item_root_folder_id !== group.root_folder_id
    })
    const mappingRootFolderId = scopeMismatch
      ? null
      : canonicalWorkGroupMappingRoot(
        group,
        mappingFoldersByGroup.get(group.id) ?? [],
        foldersById,
      )
    if (!scopeMismatch && mappingRootFolderId === null) continue

    const targetRootFolderId = mappingRootFolderId ?? group.root_folder_id
    run(db, 'DELETE FROM media_work_group_members WHERE work_group_id = ?', [group.id])
    const anchorFolderId = group.anchor_folder_id !== null
      && folderBelongsToCatalogRoot(group.anchor_folder_id, targetRootFolderId, foldersById)
      ? group.anchor_folder_id
      : null
    run(db, `
      UPDATE media_work_groups
      SET library_id = ?, root_folder_id = ?, anchor_folder_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `, [libraryId, targetRootFolderId, anchorFolderId, group.id])
    plans.set(group.id, {
      group: {
        ...group,
        library_id: libraryId,
        root_folder_id: targetRootFolderId,
        anchor_folder_id: anchorFolderId,
      },
      members,
    })
  }
  return plans
}

function copyLockedCanonicalItemState(
  db: Database,
  source: CanonicalItemRow,
  target: CanonicalItemRow,
): void {
  if (source.manual_locked !== 1 || target.manual_locked === 1) return
  run(db, `
    UPDATE media_items
    SET title = ?, title_zh = ?, kind = ?, season_number = ?, part_number = ?,
        confidence = ?, conflict_reason = ?, manual_locked = 1,
        updated_at = datetime('now')
    WHERE id = ?
  `, [
    source.title,
    source.title_zh,
    source.kind,
    source.season_number,
    source.part_number,
    source.confidence,
    source.conflict_reason,
    target.id,
  ])
}

function insertCanonicalClone(
  db: Database,
  item: CanonicalItemRow,
  libraryId: number,
  rootFolderId: number,
  itemKey: string,
): number {
  const inserted = run(db, `
    INSERT INTO media_items (
      library_id, root_folder_id, item_key, title, title_zh, kind,
      season_number, part_number, confidence, conflict_reason, manual_locked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    libraryId,
    rootFolderId,
    itemKey,
    item.title,
    item.title_zh,
    item.kind,
    item.season_number,
    item.part_number,
    item.confidence,
    item.conflict_reason,
    item.manual_locked,
  ])
  const itemId = Number(inserted.lastInsertRowid)
  copyCanonicalItemSources(db, item.id, itemId)
  return itemId
}

interface WorkGroupExclusionRow {
  id: number
  root_folder_id: number
  media_item_id: number
}

function rehomeCanonicalCatalog(
  db: Database,
  libraryId: number,
  foldersById: Map<number, CatalogFolderRow>,
): void {
  const mappings = queryAll<CanonicalRehomeMappingRow>(db, `
    SELECT mapping.id, mapping.folder_id, mapping.media_item_id
    FROM folder_media_mappings mapping
    JOIN folders folder ON folder.id = mapping.folder_id
    WHERE folder.library_id = ?
    ORDER BY mapping.media_item_id, mapping.id
  `, [libraryId])
  const workGroupPlans = prepareCanonicalWorkGroupRehome(db, libraryId, foldersById)
  const exclusions = queryAll<WorkGroupExclusionRow>(db, `
    SELECT exclusion.id, exclusion.root_folder_id, exclusion.media_item_id
    FROM media_work_group_exclusions exclusion
    JOIN folders root ON root.id = exclusion.root_folder_id
    JOIN media_items item ON item.id = exclusion.media_item_id
    WHERE root.library_id = ?
      AND (item.library_id <> ? OR item.root_folder_id <> exclusion.root_folder_id)
    ORDER BY exclusion.id
  `, [libraryId, libraryId])

  const byItem = new Map<number, CanonicalRehomeMappingRow[]>()
  for (const mapping of mappings) {
    const current = byItem.get(mapping.media_item_id) ?? []
    current.push(mapping)
    byItem.set(mapping.media_item_id, current)
  }
  const groupRootByItem = new Map<number, number>()
  for (const plan of workGroupPlans.values()) {
    for (const member of plan.members) {
      if (!byItem.has(member.media_item_id)) byItem.set(member.media_item_id, [])
      if (!groupRootByItem.has(member.media_item_id)) {
        groupRootByItem.set(member.media_item_id, plan.group.root_folder_id)
      }
    }
  }
  const exclusionRootsByItem = new Map<number, number[]>()
  for (const exclusion of exclusions) {
    if (!byItem.has(exclusion.media_item_id)) byItem.set(exclusion.media_item_id, [])
    const roots = exclusionRootsByItem.get(exclusion.media_item_id) ?? []
    roots.push(exclusion.root_folder_id)
    exclusionRootsByItem.set(exclusion.media_item_id, roots)
  }

  const targetItemBySourceItem = new Map<number, number>()
  const possibleOrphanItemIds = new Set<number>()
  for (const [sourceItemId, itemMappings] of byItem) {
    const item = canonicalItemById(db, sourceItemId)
    if (!item) continue
    const relationshipRootId = groupRootByItem.get(sourceItemId)
      ?? exclusionRootsByItem.get(sourceItemId)?.[0]
    const mappingRoots = itemMappings
      .map(mapping => {
        const folder = foldersById.get(mapping.folder_id)
        return folder ? nearestCatalogRoot(folder, foldersById) : null
      })
      .filter((root): root is CatalogFolderRow => Boolean(root))
    const root = (relationshipRootId === undefined ? undefined : foldersById.get(relationshipRootId))
      ?? mappingRoots[0]
      ?? null
    if (!root) continue

    const foreignMapping = queryOne<{ id: number }>(db, `
      SELECT mapping.id
      FROM folder_media_mappings mapping
      JOIN folders folder ON folder.id = mapping.folder_id
      WHERE mapping.media_item_id = ? AND folder.library_id <> ?
      LIMIT 1
    `, [sourceItemId, libraryId])
    const foreignRelationship = canonicalItemHasOutOfScopeRelationship(
      db,
      sourceItemId,
      libraryId,
      root.id,
    )

    let targetItemId = sourceItemId
    if (item.library_id !== libraryId) {
      const existingTarget = canonicalItemByKey(db, libraryId, item.item_key)
      const scopedRelationship = relationshipRootId !== undefined
      const cloneTarget = existingTarget
        ? canonicalItemNeedsClone(db, existingTarget)
          || (scopedRelationship && existingTarget.root_folder_id !== root.id)
        : false
      if (existingTarget && !cloneTarget && !foreignRelationship) {
        targetItemId = existingTarget.id
        copyCanonicalItemSources(db, sourceItemId, targetItemId)
        copyLockedCanonicalItemState(db, item, existingTarget)
      } else if (foreignMapping || foreignRelationship || cloneTarget) {
        const itemKey = existingTarget
          ? canonicalCloneItemKey(db, libraryId, item.item_key, root.id)
          : item.item_key
        targetItemId = insertCanonicalClone(db, item, libraryId, root.id, itemKey)
      } else {
        run(db, `
          UPDATE media_items
          SET library_id = ?, root_folder_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `, [libraryId, root.id, sourceItemId])
      }
    }
    targetItemBySourceItem.set(sourceItemId, targetItemId)
    if (targetItemId !== sourceItemId) possibleOrphanItemIds.add(sourceItemId)

    const previousRootFolderId = canonicalItemById(db, targetItemId)?.root_folder_id ?? null
    const seriesByRoot = new Map<number, number | null>()
    for (const mapping of itemMappings) {
      const folder = foldersById.get(mapping.folder_id)
      const mappingRoot = folder ? nearestCatalogRoot(folder, foldersById) : null
      if (!mappingRoot) {
        run(db, 'DELETE FROM folder_media_mappings WHERE id = ?', [mapping.id])
        continue
      }
      let seriesId = seriesByRoot.get(mappingRoot.id)
      if (seriesId === undefined) {
        seriesId = compatibilitySeriesForRoot(db, libraryId, mappingRoot.id)?.id ?? null
        seriesByRoot.set(mappingRoot.id, seriesId)
      }
      run(db, `
        UPDATE folder_media_mappings
        SET media_item_id = ?, root_folder_id = ?, series_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `, [targetItemId, mappingRoot.id, seriesId, mapping.id])
    }

    const target = canonicalItemById(db, targetItemId)
    const previousRootStillMapped = previousRootFolderId === null ? undefined : queryOne<{ id: number }>(db, `
      SELECT id
      FROM folder_media_mappings
      WHERE media_item_id = ? AND root_folder_id = ?
      LIMIT 1
    `, [targetItemId, previousRootFolderId])
    if (target && target.root_folder_id !== root.id && !previousRootStillMapped) {
      run(db, `
        UPDATE media_items
        SET root_folder_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [root.id, targetItemId])
    }
  }

  for (const plan of workGroupPlans.values()) {
    for (const member of plan.members) {
      const targetItemId = targetItemBySourceItem.get(member.media_item_id) ?? member.media_item_id
      if (!canonicalItemById(db, targetItemId)) continue
      const existingMember = queryOne<{ id: number }>(db, `
        SELECT id
        FROM media_work_group_members
        WHERE media_item_id = ?
      `, [targetItemId])
      if (existingMember) {
        run(db, `
          UPDATE media_work_group_members
          SET work_group_id = ?, relation_role = ?, manual_locked = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `, [plan.group.id, member.relation_role, member.manual_locked, existingMember.id])
      } else {
        run(db, `
          INSERT INTO media_work_group_members
            (work_group_id, media_item_id, relation_role, manual_locked)
          VALUES (?, ?, ?, ?)
        `, [plan.group.id, targetItemId, member.relation_role, member.manual_locked])
      }
    }
  }

  for (const exclusion of exclusions) {
    const targetItemId = targetItemBySourceItem.get(exclusion.media_item_id) ?? exclusion.media_item_id
    if (!canonicalItemById(db, targetItemId)) continue
    run(db, `
      INSERT OR IGNORE INTO media_work_group_exclusions
        (root_folder_id, media_item_id, updated_at)
      VALUES (?, ?, datetime('now'))
    `, [exclusion.root_folder_id, targetItemId])
    if (targetItemId !== exclusion.media_item_id) {
      run(db, 'DELETE FROM media_work_group_exclusions WHERE id = ?', [exclusion.id])
      possibleOrphanItemIds.add(exclusion.media_item_id)
    }
  }

  for (const itemId of possibleOrphanItemIds) {
    run(db, `
      DELETE FROM media_items
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM folder_media_mappings WHERE media_item_id = media_items.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_work_group_members WHERE media_item_id = media_items.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_work_group_exclusions WHERE media_item_id = media_items.id
        )
    `, [itemId])
  }
}

function pruneCatalogOrphans(db: Database, libraryId: number): void {
  run(db, `
    DELETE FROM media_items
    WHERE library_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM folder_media_mappings WHERE media_item_id = media_items.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM media_work_group_members WHERE media_item_id = media_items.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM media_work_group_exclusions WHERE media_item_id = media_items.id
      )
  `, [libraryId])
  run(db, `
    DELETE FROM media_work_groups
    WHERE library_id = ? AND manual_locked = 0
      AND NOT EXISTS (
        SELECT 1 FROM media_work_group_members
        WHERE work_group_id = media_work_groups.id
      )
  `, [libraryId])
  run(db, `
    DELETE FROM media_series
    WHERE library_id = ? AND manual_locked = 0
      AND NOT EXISTS (
        SELECT 1 FROM folder_media_entries WHERE series_id = media_series.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM folder_media_mappings WHERE series_id = media_series.id
      )
  `, [libraryId])
}

/**
 * Repairs durable catalog ownership after core folder rows have moved. The
 * caller owns the surrounding transaction and must pass target libraries
 * before source libraries for cross-library moves.
 */
export function maintainCatalogIntegrity(db: Database, libraryIds: number[]): void {
  const orderedLibraryIds = uniqueLibraryIds(libraryIds)
  for (const libraryId of orderedLibraryIds) {
    if (!queryOne<{ id: number }>(db, 'SELECT id FROM libraries WHERE id = ?', [libraryId])) continue
    const foldersById = catalogFolders(db, libraryId)
    rehomeCompatibilityCatalog(db, libraryId, foldersById)
    rehomeCanonicalCatalog(db, libraryId, foldersById)
    pruneCatalogOrphans(db, libraryId)
    markCatalogDirty(db, [libraryId])
  }
}
