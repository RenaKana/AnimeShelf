import type { Database } from 'node-sqlite3-wasm'

export class FolderScopeError extends Error {
  constructor(message: string, readonly status: 400 | 404, readonly code: string) {
    super(message)
    this.name = 'FolderScopeError'
  }
}

export interface FrozenFolderScope {
  /** The validated roots supplied by the caller, deduplicated and sorted. */
  folderIds: number[]
  /** Every validated root plus its descendants, frozen before background work. */
  descendantIds: Set<number>
}

function invalidScope(message = 'folderIds 参数格式无效'): FolderScopeError {
  return new FolderScopeError(message, 400, 'INVALID_FOLDER_SCOPE')
}

/**
 * Parse the request-body form (number[]) or the status-query form ("1,2,3").
 * An omitted value is deliberately different from an explicit empty value:
 * omitted means the legacy whole-library scope, while empty is rejected.
 */
export function parseFolderIds(value: unknown, form: 'body' | 'query' = 'body'): number[] | undefined {
  if (value === undefined) return undefined

  let values: unknown[]
  if (form === 'body') {
    if (!Array.isArray(value)) throw invalidScope()
    values = value
  } else {
    if (typeof value !== 'string' || value.trim() === '') throw invalidScope()
    values = value.split(',').map(item => item.trim())
  }

  if (values.length === 0) throw invalidScope('folderIds 不能为空')
  const ids: number[] = []
  for (const value of values) {
    const id = form === 'query'
      ? (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN)
      : value
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw invalidScope()
    ids.push(id)
  }
  const unique = [...new Set(ids)].sort((left, right) => left - right)
  if (unique.length === 0) throw invalidScope('folderIds 不能为空')
  return unique
}

function rootRows(db: Database, folderIds: number[]): Array<{ id: number; library_id: number }> {
  const placeholders = folderIds.map(() => '?').join(', ')
  const statement = db.prepare(`SELECT id, library_id FROM folders WHERE id IN (${placeholders})`)
  try { return statement.all(folderIds) as Array<{ id: number; library_id: number }> }
  finally { statement.finalize() }
}

/** Validate roots and freeze their descendant set before a task is spawned. */
export function freezeFolderScope(db: Database, value: unknown, options: { libraryId?: number | null; form?: 'body' | 'query' } = {}): FrozenFolderScope | null {
  const folderIds = parseFolderIds(value, options.form ?? 'body')
  if (!folderIds) return null

  const rows = rootRows(db, folderIds)
  const byId = new Map(rows.map(row => [row.id, row]))
  const missing = folderIds.find(id => !byId.has(id))
  if (missing !== undefined) throw new FolderScopeError(`文件夹不存在: ${missing}`, 404, 'FOLDER_SCOPE_NOT_FOUND')

  const libraryId = options.libraryId ?? null
  if (libraryId != null) {
    const outside = folderIds.find(id => byId.get(id)!.library_id !== libraryId)
    if (outside !== undefined) throw new FolderScopeError('文件夹不属于当前媒体库', 400, 'FOLDER_SCOPE_LIBRARY_MISMATCH')
  }

  const placeholders = folderIds.map(() => '?').join(', ')
  const statement = db.prepare(`
    WITH RECURSIVE scope(id, library_id) AS (
      SELECT id, library_id FROM folders WHERE id IN (${placeholders})
      UNION ALL
      SELECT f.id, f.library_id
      FROM folders f JOIN scope s ON f.parent_id = s.id AND f.library_id = s.library_id
    )
    SELECT DISTINCT id FROM scope ORDER BY id
  `)
  try {
    const descendantIds = new Set((statement.all(folderIds) as Array<{ id: number }>).map(row => row.id))
    return { folderIds, descendantIds }
  } finally { statement.finalize() }
}

