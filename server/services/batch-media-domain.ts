import type { Database } from 'node-sqlite3-wasm'
import { isMediaDomainOverride } from '../../shared/media-domain'
import type { BatchDomainResult } from '../../shared/folder-moves'
import { withLibraryMaintenance } from './library-maintenance'
import { rebuildLibraryMediaCatalogInTransaction } from '../core/catalog-access'
import { invalidateLibraryMatches } from '../core/extensions'

export async function setBatchMediaDomain(db: Database, rawIds: unknown, override: unknown): Promise<BatchDomainResult> {
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 10000 || rawIds.some(id => !Number.isSafeInteger(id) || id <= 0) || !isMediaDomainOverride(override)) {
    throw Object.assign(new Error('请选择有效条目和媒体分类'), { status: 400, code: 'INVALID_MEDIA_DOMAIN' })
  }
  const ids = [...new Set<number>(rawIds)]
  return withLibraryMaintenance(db, '批量媒体分类', () => {
    const results: BatchDomainResult['results'] = []
    const groups = new Map<number, number[]>()
    for (const id of ids) {
      const row = db.get('SELECT library_id FROM folders WHERE id=?', id) as { library_id: number } | undefined
      if (!row) results.push({ id, ok: false, error: '条目已不存在' })
      else groups.set(row.library_id, [...(groups.get(row.library_id) ?? []), id])
    }
    for (const [libraryId, folderIds] of groups) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const id of folderIds) db.run("UPDATE folders SET media_domain_override=?, updated_at=datetime('now') WHERE id=?", [override, id])
        rebuildLibraryMediaCatalogInTransaction(db, libraryId)
        db.exec('COMMIT')
        results.push(...folderIds.map(id => ({ id, ok: true })))
      } catch {
        db.exec('ROLLBACK')
        results.push(...folderIds.map(id => ({ id, ok: false, error: '该媒体库分类更新失败，已回滚' })))
      }
    }
    invalidateLibraryMatches(db)
    return { results }
  })
}
