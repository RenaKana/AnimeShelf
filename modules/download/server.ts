import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'
import { DownloadService } from './server/service'
import { createDownloadRouter } from './server/routes'

export default function createModule(context: ModuleContext): ServerModule {
  const service = new DownloadService({ signal: context.signal })
  return {
    routes: [{ path: '/api/download', router: createDownloadRouter(service) }],
    quiesce: () => service.dispose(),
    stop: () => service.dispose(),
  }
}
