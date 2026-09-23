import type { Database } from 'node-sqlite3-wasm'
import type { ModuleRuntime } from '../../core/module-runtime'
import { bindModuleRuntime, type CatalogHooks } from '../../core/extensions'
import * as catalogOperations from '../../../modules/media-catalog/server/media-catalog'
import { getCollectionArtwork } from '../../../modules/media-catalog/server/collection-artwork'
import { getCollectionResetStatus } from '../../../modules/media-catalog/server/collection-reset'

export interface TestModuleCapabilitiesOptions {
  activeModules?: Iterable<string>
  capabilities?: Record<string, unknown>
  catalog?: Partial<CatalogHooks> | false
  invalidateLibraryMatches?: () => void
  afterRestore?: () => void | Promise<void>
}

export interface TestModuleCapabilitiesBinding {
  activeModules: Set<string>
  catalog: CatalogHooks | undefined
  capabilities: Map<string, unknown>
  setCapability: (name: string, value: unknown) => void
}

function realCatalogHooks(overrides: Partial<CatalogHooks> = {}): CatalogHooks {
  return {
    snapshot: (db, folderId) => {
      const snapshot = catalogOperations.getMediaCatalogForFolder(db, folderId)
      return {
        entries: snapshot.entries,
        summary: snapshot.summary ?? null,
        canonical: snapshot.canonical ?? null,
        candidates: snapshot.candidates ?? [],
      }
    },
    rebuildLibrary: (db, libraryId, inTransaction) => inTransaction
      ? catalogOperations.rebuildLibraryMediaCatalogInTransaction(db, libraryId)
      : catalogOperations.rebuildLibraryMediaCatalog(db, libraryId),
    rebuildFolder: catalogOperations.rebuildMediaCatalogForFolder,
    collectionExtras: (db, folderId, posterDir) => ({
      collection_artwork: getCollectionArtwork(db, folderId, posterDir),
      collection_reset: getCollectionResetStatus(db, folderId),
    }),
    ...overrides,
  }
}

/** Binds the minimal module-runtime surface used by core code in isolated tests. */
export function bindTestModuleCapabilities(
  db: Database,
  options: TestModuleCapabilitiesOptions = {},
): TestModuleCapabilitiesBinding {
  const activeModules = new Set(options.activeModules ?? ['media-catalog'])
  const catalog = options.catalog === false ? undefined : realCatalogHooks(options.catalog)
  const capabilities = new Map<string, unknown>()
  if (catalog) {
    capabilities.set('catalog', catalog)
    capabilities.set('catalogOperations', catalogOperations)
  }
  if (options.invalidateLibraryMatches) {
    capabilities.set('invalidateLibraryMatches', options.invalidateLibraryMatches)
  }
  for (const [name, value] of Object.entries(options.capabilities ?? {})) {
    capabilities.set(name, value)
  }

  const runtime = {
    isActive: (id: string) => activeModules.has(id),
    capability: <T,>(name: string): T | undefined => capabilities.get(name) as T | undefined,
    afterRestore: async () => { await options.afterRestore?.() },
  } as unknown as ModuleRuntime
  bindModuleRuntime(db, runtime)

  return {
    activeModules,
    catalog,
    capabilities,
    setCapability: (name, value) => { capabilities.set(name, value) },
  }
}
