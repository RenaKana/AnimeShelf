import type { ExternalApiRouteContribution } from '../../server/core/external-api-contributions'
import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'
import type { CatalogHooks } from '../../server/core/extensions'
import * as catalog from './server/media-catalog'
import folders from './server/folders'
import { getCollectionArtwork } from './server/collection-artwork'
import { getCollectionResetStatus } from './server/collection-reset'
import { mediaCatalogExternalApiRoutes } from './server/external-api'
import { getOwnedSeasons } from './server/owned-seasons'
export default function createModule(context: ModuleContext): ServerModule {
  context.contribute<ExternalApiRouteContribution>('externalApi.routes', mediaCatalogExternalApiRoutes)
  context.provide<CatalogHooks>('catalog', {
    snapshot: (db, id) => { const value = catalog.getMediaCatalogForFolder(db, id); return { ...value, canonical: value.canonical ?? null, candidates: value.candidates ?? [] } },
    rebuildLibrary: (db, id, transaction) => transaction ? catalog.rebuildLibraryMediaCatalogInTransaction(db, id) : catalog.rebuildLibraryMediaCatalog(db, id),
    rebuildFolder: catalog.rebuildMediaCatalogForFolder,
    collectionExtras: (db, id, dir) => ({ collection_artwork: getCollectionArtwork(db, id, dir), collection_reset: getCollectionResetStatus(db, id) }),
    ownedSeasons: getOwnedSeasons,
  })
  context.provide('catalogOperations', catalog)
  return { routes: [{ path: '/api/folders', router: folders }], start: () => { catalog.ensureMediaCatalogsCurrent(context.db) }, afterRestore: () => { catalog.rebuildAllMediaCatalogs(context.db) } }
}
