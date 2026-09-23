import type { ExternalApiRouteContribution } from '../../server/core/external-api-contributions'
import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'
import { createExternalApiService } from './server/external-api-server'
import { createExternalDataRouter } from './server/data'
import { createExternalAccessRouter } from './server/access'
import { invalidateLibraryMatches } from '../../server/core/extensions'
export default function createModule(context: ModuleContext): ServerModule {
  const service = createExternalApiService(context.db, () => createExternalDataRouter(context.db, {
    invalidateLibraryMatches: () => invalidateLibraryMatches(context.db),
    isModuleActive: context.isActive,
    contributions: context.contributions<ExternalApiRouteContribution>('externalApi.routes'),
  }))
  context.onQuiesce(() => service.stop())
  const apply = async () => { const status = await service.start(); if (status.error) console.error('External API listener unavailable') }
  return { routes: [{ path: '/api/external-access', router: createExternalAccessRouter(service) }], start: apply, afterRestore: apply }
}
