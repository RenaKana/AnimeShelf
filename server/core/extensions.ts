import type { Database } from 'node-sqlite3-wasm'
import type { ModuleRuntime } from './module-runtime'

const runtimes = new WeakMap<Database, ModuleRuntime>()
export function bindModuleRuntime(db: Database, runtime: ModuleRuntime) { runtimes.set(db, runtime) }
export function moduleRuntime(db: Database): ModuleRuntime | undefined { return runtimes.get(db) }
export function moduleActive(db: Database, id: string): boolean { return runtimes.get(db)?.isActive(id) ?? false }
export function capability<T>(db: Database, name: string): T | undefined { return runtimes.get(db)?.capability<T>(name) }

export interface CatalogSnapshot {
  entries: unknown[]
  summary: unknown | null
  canonical: unknown | null
  candidates: unknown[]
}
export interface CatalogHooks {
  snapshot: (db: Database, folderId: number) => CatalogSnapshot
  rebuildLibrary: (db: Database, libraryId: number, inTransaction: boolean) => unknown
  rebuildFolder: (db: Database, folderId: number) => unknown
  collectionExtras: (db: Database, folderId: number, posterDir: string) => object
  ownedSeasons?: (db: Database, folderIds: number[]) => Map<number, number[]>
}
export function getMediaCatalogForFolder(db: Database, folderId: number): CatalogSnapshot {
  return capability<CatalogHooks>(db, 'catalog')?.snapshot(db, folderId) ?? { entries: [], summary: null, canonical: null, candidates: [] }
}
export function collectionExtras(db: Database, folderId: number, posterDir: string): object {
  return capability<CatalogHooks>(db, 'catalog')?.collectionExtras(db, folderId, posterDir) ?? {}
}
export function getOwnedSeasonNumbers(db: Database, folderIds: number[]): Map<number, number[]> | null {
  const hook = capability<CatalogHooks>(db, 'catalog')?.ownedSeasons
  return hook ? hook(db, folderIds) : null
}
export function invalidateLibraryMatches(db: Database): void { capability<() => void>(db, 'invalidateLibraryMatches')?.() }
export async function afterDataRestore(db: Database): Promise<void> { await runtimes.get(db)?.afterRestore() }
