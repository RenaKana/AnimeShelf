import type { ExternalApiRouteContribution } from '../../server/core/external-api-contributions'
import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'
import routes from './server/routes'
import { refreshAiringProgress, resetAiringProgressCache } from './server/airing'
import { invalidateLibHitCache } from './server/libhit'
import { fetchFavoriteDetail } from './server/favorite-detail'
import { seasonExternalApiRoutes } from './server/external-api'
export default function createModule(context: ModuleContext): ServerModule {
  context.provide('invalidateLibraryMatches', invalidateLibHitCache)
  context.provide('fetchFavoriteDetail', fetchFavoriteDetail)
  context.contribute<ExternalApiRouteContribution>('externalApi.routes', seasonExternalApiRoutes)
  const refresh = () => { if (!context.signal.aborted) void context.track(refreshAiringProgress()).catch(() => {}) }
  return { routes: [{ path: '/api/season', router: routes }], start: () => {
    invalidateLibHitCache()
    resetAiringProgressCache()
    const first = setTimeout(refresh, 10_000), interval = setInterval(refresh, 60 * 60_000)
    context.onQuiesce(() => { clearTimeout(first); clearInterval(interval) })
  }, afterRestore: () => { invalidateLibHitCache(); resetAiringProgressCache() } }
}
