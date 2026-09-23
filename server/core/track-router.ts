import type { Router, RequestHandler } from 'express'
import type { ModuleRuntime } from './module-runtime'
const originals = new WeakMap<RequestHandler, RequestHandler>()

/** Express 4 does not track returned promises; keep SQLite alive until handlers settle. */
export function trackRouter(router: Router, runtime: ModuleRuntime): Router {
  type Layer = { handle: RequestHandler; route?: { stack: Layer[] }; stack?: Layer[] }
  const visit = (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.route) { visit(layer.route.stack); continue }
      const nested = (layer.handle as unknown as { stack?: Layer[] }).stack
      if (nested) { visit(nested); continue }
      const original = originals.get(layer.handle) ?? layer.handle
      if (original.length > 3) continue
      layer.handle = (req, res, next) => {
        try {
          const result = (original as (...args: unknown[]) => unknown)(req, res, next)
          if (result && typeof (result as Promise<unknown>).then === 'function') void runtime.track(Promise.resolve(result)).catch(next)
        } catch (error) { next(error) }
      }
      originals.set(layer.handle, original)
    }
  }
  visit((router as unknown as { stack: Layer[] }).stack)
  return router
}
