import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'
import routes from './server/routes'
import folders from './server/folders'
import libraries from './server/libraries'
import settings from './server/settings'
import * as metadata from './server/metadata'
import { PosterRepairService, setPosterRepairService } from './server/poster-repair'
export default function createModule(context: ModuleContext): ServerModule {
  context.provide('metadata', metadata)
  const posterRepair = new PosterRepairService({
    db: context.db,
    signal: context.signal,
    track: context.track,
    favoriteDetail: () => context.capability('fetchFavoriteDetail'),
  })
  setPosterRepairService(posterRepair)
  context.onDispose(() => setPosterRepairService(null))
  return { routes: [{ path: '/api/metadata', router: routes }, { path: '/api/folders', router: folders }, { path: '/api/libraries', router: libraries }, { path: '/api/settings', router: settings }],
    afterRestore: () => { posterRepair.start({ mode: 'missing', includeFavorites: true }) } }
}
