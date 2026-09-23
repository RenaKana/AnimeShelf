import type { Database } from 'node-sqlite3-wasm'
import { sqlGet } from '../db/sql'
import { capability, type CatalogHooks } from './extensions'
import { maintainCatalogIntegrity } from './catalog-integrity'

function rebuild(db: Database, libraryId: number, inTransaction: boolean): unknown {
  const catalog = capability<CatalogHooks>(db, 'catalog')
  if (catalog) return catalog.rebuildLibrary(db, libraryId, inTransaction)
  if (!inTransaction) db.exec('SAVEPOINT retain_catalog_integrity')
  try {
    maintainCatalogIntegrity(db, [libraryId])
    if (!inTransaction) db.exec('RELEASE retain_catalog_integrity')
  } catch (error) {
    if (!inTransaction) { db.exec('ROLLBACK TO retain_catalog_integrity'); db.exec('RELEASE retain_catalog_integrity') }
    throw error
  }
}
export function rebuildLibraryMediaCatalog(db: Database, libraryId: number) { return rebuild(db, libraryId, false) }
export function rebuildLibraryMediaCatalogInTransaction(db: Database, libraryId: number) { return rebuild(db, libraryId, true) }
export function rebuildMediaCatalogForFolder(db: Database, folderId: number) {
  const catalog = capability<CatalogHooks>(db, 'catalog')
  if (catalog) return catalog.rebuildFolder(db, folderId)
  const folder = sqlGet<{ library_id: number }>(db, 'SELECT library_id FROM folders WHERE id=?', folderId)
  if (folder) return rebuild(db, folder.library_id, false)
}
