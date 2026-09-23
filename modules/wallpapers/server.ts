import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'
import wallpapers from './server/routes'
import background from './server/background'
export default function createModule(_context: ModuleContext): ServerModule {
  return { routes: [{ path: '/api/wallpapers', router: wallpapers }, { path: '/api/background', router: background }] }
}
