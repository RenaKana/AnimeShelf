import type { Database } from 'node-sqlite3-wasm'
import { as } from '../../../server/db/schema'
import {
  getMediaCatalogForFolder,
  MediaCatalogValidationError,
  type MediaCatalogSnapshot,
} from './media-catalog'

export interface CollectionPresentationEntry {
  key: string
  title: string | null
  position: number | null
}

export interface CollectionPresentationSnapshot {
  entries: CollectionPresentationEntry[]
}

interface CollectionRootRow {
  id: number
  library_id: number
  pinned: number
}

interface PresentationRow {
  entry_key: string
  display_title: string | null
  position: number | null
}

interface ValidatedPresentationUpdate {
  key: string
  hasTitle: boolean
  title: string | null
  hasPosition: boolean
  position: number | null
}

interface MediaItemScopeRow {
  id: number
  library_id: number
  root_folder_id: number
  has_root_mapping: number
}

interface WorkGroupScopeRow {
  id: number
  library_id: number
  root_folder_id: number
}

const MAX_UPDATES = 2000
const MAX_TITLE_LENGTH = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every(key => allowedKeys.has(key))
}

function presentationItemKey(itemKey: string): string {
  return `item:${itemKey.replace(/^custom:[^:]+:/, '')}`
}

function requirePinnedCollectionRoot(db: Database, folderId: number): CollectionRootRow {
  if (!Number.isSafeInteger(folderId) || folderId <= 0) {
    throw new MediaCatalogValidationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = db.prepare(`
    SELECT id, library_id, pinned FROM folders WHERE id = ?
  `).get(folderId) as CollectionRootRow | null
  if (!folder) throw new MediaCatalogValidationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  if (folder.pinned !== 1) {
    throw new MediaCatalogValidationError(
      '合集展示设置仅适用于已标记的合集根目录',
      409,
      'COLLECTION_PRESENTATION_REQUIRES_PINNED_ROOT',
    )
  }
  return folder
}

function readCollectionPresentation(db: Database, rootFolderId: number): CollectionPresentationSnapshot {
  const rows = as<PresentationRow[]>(db.prepare(`
    SELECT entry_key, display_title, position
    FROM media_collection_presentation
    WHERE root_folder_id = ?
    ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END, position, entry_key
  `).all(rootFolderId))
  return {
    entries: rows.map(row => ({
      key: row.entry_key,
      title: row.display_title,
      position: row.position,
    })),
  }
}

export function getCollectionPresentation(db: Database, folderId: number): CollectionPresentationSnapshot {
  const root = requirePinnedCollectionRoot(db, folderId)
  return readCollectionPresentation(db, root.id)
}

function validatePresentationUpdates(
  db: Database,
  rootFolderId: number,
  input: unknown,
): ValidatedPresentationUpdate[] {
  if (!isRecord(input) || !hasOnlyKeys(input, ['updates']) || !Array.isArray(input.updates)) {
    throw new MediaCatalogValidationError(
      '合集展示参数必须只包含 updates 数组',
      400,
      'INVALID_COLLECTION_PRESENTATION_INPUT',
    )
  }
  if (input.updates.length > MAX_UPDATES) {
    throw new MediaCatalogValidationError(
      `单次最多更新 ${MAX_UPDATES} 个合集展示条目`,
      400,
      'COLLECTION_PRESENTATION_TOO_MANY_UPDATES',
    )
  }

  const itemKeys = new Set((db.prepare(`
    SELECT i.item_key
    FROM media_items i
    WHERE i.root_folder_id = ?
      AND EXISTS (
        SELECT 1 FROM folder_media_mappings m
        WHERE m.media_item_id = i.id AND m.root_folder_id = ?
      )
  `).all([rootFolderId, rootFolderId]) as Array<{ item_key: string }>).map(row => presentationItemKey(row.item_key)))
  const groupKeys = new Set((db.prepare(`
    SELECT group_key FROM media_work_groups WHERE root_folder_id = ?
  `).all(rootFolderId) as Array<{ group_key: string }>).map(row => `group:${row.group_key}`))
  const seen = new Set<string>()
  const updates: ValidatedPresentationUpdate[] = []

  for (const candidate of input.updates) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['key', 'title', 'position'])) {
      throw new MediaCatalogValidationError(
        '合集展示更新包含未知字段',
        400,
        'INVALID_COLLECTION_PRESENTATION_UPDATE',
      )
    }
    if (typeof candidate.key !== 'string' || candidate.key.length === 0) {
      throw new MediaCatalogValidationError('合集展示 key 无效', 400, 'INVALID_COLLECTION_PRESENTATION_KEY')
    }
    if (seen.has(candidate.key)) {
      throw new MediaCatalogValidationError(
        '同一合集展示 key 不能重复更新',
        400,
        'DUPLICATE_COLLECTION_PRESENTATION_KEY',
      )
    }
    seen.add(candidate.key)

    const isItem = itemKeys.has(candidate.key)
    const isGroup = groupKeys.has(candidate.key)
    if (!isItem && !isGroup) {
      throw new MediaCatalogValidationError(
        '合集展示条目不属于当前合集根目录',
        409,
        'COLLECTION_PRESENTATION_SCOPE_MISMATCH',
      )
    }

    const hasTitle = hasOwn(candidate, 'title')
    let title: string | null = null
    if (hasTitle) {
      if (candidate.title === null) {
        title = null
      } else if (typeof candidate.title === 'string') {
        title = candidate.title.trim()
        if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
          throw new MediaCatalogValidationError(
            `合集展示标题必须为 1-${MAX_TITLE_LENGTH} 个字符`,
            400,
            'INVALID_COLLECTION_PRESENTATION_TITLE',
          )
        }
      } else {
        throw new MediaCatalogValidationError(
          '合集展示标题必须是字符串或 null',
          400,
          'INVALID_COLLECTION_PRESENTATION_TITLE',
        )
      }
      if (isGroup && title !== null) {
        throw new MediaCatalogValidationError(
          '作品组标题请使用专用的作品组重命名接口',
          400,
          'COLLECTION_PRESENTATION_GROUP_TITLE_UNSUPPORTED',
        )
      }
    }

    const hasPosition = hasOwn(candidate, 'position')
    let position: number | null = null
    if (hasPosition) {
      if (candidate.position === null) {
        position = null
      } else if (Number.isSafeInteger(candidate.position) && (candidate.position as number) >= 0) {
        position = candidate.position as number
      } else {
        throw new MediaCatalogValidationError(
          '合集展示顺序必须是非负整数或 null',
          400,
          'INVALID_COLLECTION_PRESENTATION_POSITION',
        )
      }
    }

    updates.push({ key: candidate.key, hasTitle, title, hasPosition, position })
  }
  return updates
}

export function patchCollectionPresentation(
  db: Database,
  folderId: number,
  input: unknown,
): CollectionPresentationSnapshot {
  const root = requirePinnedCollectionRoot(db, folderId)
  const updates = validatePresentationUpdates(db, root.id, input)
  let inTransaction = false
  db.exec('BEGIN IMMEDIATE')
  inTransaction = true
  try {
    const readCurrent = db.prepare(`
      SELECT display_title, position
      FROM media_collection_presentation
      WHERE root_folder_id = ? AND entry_key = ?
    `)
    const upsert = db.prepare(`
      INSERT INTO media_collection_presentation
        (root_folder_id, entry_key, display_title, position)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(root_folder_id, entry_key) DO UPDATE SET
        display_title = excluded.display_title,
        position = excluded.position
    `)
    const remove = db.prepare(`
      DELETE FROM media_collection_presentation
      WHERE root_folder_id = ? AND entry_key = ?
    `)
    try {
      for (const update of updates) {
        const current = readCurrent.get([root.id, update.key]) as {
          display_title: string | null
          position: number | null
        } | null
        const title = update.hasTitle ? update.title : current?.display_title ?? null
        const position = update.hasPosition ? update.position : current?.position ?? null
        if (title === null && position === null) {
          remove.run([root.id, update.key])
        } else {
          upsert.run([root.id, update.key, title, position])
        }
      }
    } finally {
      readCurrent.finalize()
      upsert.finalize()
      remove.finalize()
    }
    db.exec('COMMIT')
    inTransaction = false
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    }
    throw error
  }
  return readCollectionPresentation(db, root.id)
}

function validateMemberGroupInput(input: unknown): number | null {
  if (!isRecord(input) || !hasOnlyKeys(input, ['groupId']) || !hasOwn(input, 'groupId')) {
    throw new MediaCatalogValidationError(
      '合集成员分组参数必须只包含 groupId',
      400,
      'INVALID_COLLECTION_MEMBER_GROUP_INPUT',
    )
  }
  if (input.groupId === null) return null
  if (!Number.isSafeInteger(input.groupId) || (input.groupId as number) <= 0) {
    throw new MediaCatalogValidationError('作品组编号无效', 400, 'INVALID_MEDIA_WORK_GROUP_ID')
  }
  return input.groupId as number
}

export function setCollectionMemberGroup(
  db: Database,
  folderId: number,
  itemId: number,
  input: unknown,
): MediaCatalogSnapshot {
  const root = requirePinnedCollectionRoot(db, folderId)
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new MediaCatalogValidationError('媒体条目编号无效', 400, 'INVALID_MEDIA_ITEM_ID')
  }
  const groupId = validateMemberGroupInput(input)
  const item = db.prepare(`
    SELECT i.id, i.library_id, i.root_folder_id,
           EXISTS (
             SELECT 1 FROM folder_media_mappings m
             WHERE m.media_item_id = i.id AND m.root_folder_id = ?
           ) AS has_root_mapping
    FROM media_items i WHERE i.id = ?
  `).get([root.id, itemId]) as MediaItemScopeRow | null
  if (!item) throw new MediaCatalogValidationError('规范媒体条目不存在', 404, 'MEDIA_ITEM_NOT_FOUND')
  if (item.library_id !== root.library_id || item.root_folder_id !== root.id || item.has_root_mapping !== 1) {
    throw new MediaCatalogValidationError(
      '媒体条目不属于当前合集根目录',
      409,
      'MEDIA_ITEM_SCOPE_MISMATCH',
    )
  }

  let targetGroup: WorkGroupScopeRow | null = null
  if (groupId !== null) {
    targetGroup = db.prepare(`
      SELECT id, library_id, root_folder_id FROM media_work_groups WHERE id = ?
    `).get(groupId) as WorkGroupScopeRow | null
    if (!targetGroup) throw new MediaCatalogValidationError('作品组不存在', 404, 'MEDIA_WORK_GROUP_NOT_FOUND')
    if (targetGroup.library_id !== root.library_id || targetGroup.root_folder_id !== root.id) {
      throw new MediaCatalogValidationError(
        '作品组不属于当前合集根目录',
        409,
        'MEDIA_WORK_GROUP_SCOPE_MISMATCH',
      )
    }
  }

  const currentMember = db.prepare(`
    SELECT m.work_group_id
    FROM media_work_group_members m
    JOIN media_work_groups g ON g.id = m.work_group_id
    WHERE m.media_item_id = ? AND g.library_id = ? AND g.root_folder_id = ?
  `).get([item.id, root.library_id, root.id]) as { work_group_id: number } | null
  const oldGroupId = currentMember?.work_group_id ?? null

  let inTransaction = false
  db.exec('BEGIN IMMEDIATE')
  inTransaction = true
  try {
    if (groupId === null) {
      db.prepare('DELETE FROM media_work_group_members WHERE media_item_id = ?').run(item.id)
      db.prepare(`
        INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id)
        VALUES (?, ?)
        ON CONFLICT(root_folder_id, media_item_id) DO NOTHING
      `).run([root.id, item.id])
    } else {
      db.prepare(`
        DELETE FROM media_work_group_exclusions
        WHERE root_folder_id = ? AND media_item_id = ?
      `).run([root.id, item.id])
      if (currentMember) {
        db.prepare(`
          UPDATE media_work_group_members
          SET work_group_id = ?, manual_locked = 1, updated_at = datetime('now')
          WHERE media_item_id = ?
        `).run([groupId, item.id])
      } else {
        db.prepare(`
          INSERT INTO media_work_group_members
            (work_group_id, media_item_id, relation_role, manual_locked)
          VALUES (?, ?, 'main', 1)
        `).run([groupId, item.id])
      }
    }

    if (oldGroupId !== null && oldGroupId !== groupId) {
      db.prepare(`
        DELETE FROM media_work_groups
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM media_work_group_members WHERE work_group_id = ?
          )
      `).run([oldGroupId, oldGroupId])
    }
    db.exec('COMMIT')
    inTransaction = false
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    }
    throw error
  }

  return getMediaCatalogForFolder(db, root.id)
}
