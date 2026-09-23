import { createServer, type RequestListener, type Server } from 'node:http'

export interface HostedApplication {
  app: RequestListener
  stop: () => Promise<void>
  dispose: () => Promise<void>
}

export interface ServiceHostOptions {
  createApplication: (options: { signal: AbortSignal; restart: () => Promise<void> }) => Promise<HostedApplication>
  port: number
  host: string
  onListening?: (server: Server) => void
  onRestartFailure?: (error: unknown) => void
  createServer?: (handler: RequestListener) => Server
}

const unavailable: RequestListener = (_req, res) => {
  res.statusCode = 503
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: 'Service is restarting', code: 'SERVER_RESTARTING' }))
}

export function createServiceHost(options: ServiceHostOptions) {
  let handler: RequestListener = unavailable
  let application: HostedApplication | undefined
  let applicationController: AbortController | undefined
  let startup: Promise<void> | undefined
  let creating: Promise<HostedApplication | undefined> | undefined
  let binding: Promise<void> | undefined
  let restarting: Promise<void> | undefined
  let shutdown: Promise<void> | undefined
  let quitting = false
  const stops = new WeakMap<HostedApplication, Promise<void>>()

  const server = (options.createServer ?? createServer)((req, res) => handler(req, res))

  const stopApplication = (target: HostedApplication): Promise<void> => {
    const existing = stops.get(target)
    if (existing) return existing
    const stopping = target.stop()
    stops.set(target, stopping)
    return stopping
  }

  const createGeneration = (): Promise<HostedApplication | undefined> => {
    const controller = new AbortController()
    applicationController = controller
    return creating = (async () => {
      const next = await options.createApplication({ signal: controller.signal, restart })
      if (quitting || controller.signal.aborted) {
        await stopApplication(next)
        await next.dispose()
        return undefined
      }
      return next
    })()
  }

  const listen = () => binding = new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener('listening', ready); reject(error) }
    const ready = () => {
      server.removeListener('error', failed)
      if (!quitting) options.onListening?.(server)
      resolve()
    }
    server.once('error', failed)
    server.once('listening', ready)
    server.listen(options.port, options.host)
  })

  const start = () => startup ??= (async () => {
    if (quitting) return
    const initial = await createGeneration()
    if (!initial) return
    if (quitting) { await stopApplication(initial); return }
    application = initial
    handler = initial.app
    try { await listen() }
    catch (error) {
      await stopApplication(initial)
      await initial.dispose()
      throw error
    }
  })()

  function restart(): Promise<void> {
    if (quitting) return Promise.resolve()
    if (restarting) return restarting
    restarting = (async () => {
      const previous = application
      if (!previous || quitting) return
      handler = unavailable
      const closeIdleRequests = setTimeout(() => server.closeAllConnections(), 2_000)
      closeIdleRequests.unref()
      try {
        await stopApplication(previous)
        await previous.dispose()
      } finally { clearTimeout(closeIdleRequests) }
      if (application === previous) application = undefined
      if (quitting) return
      const replacement = await createGeneration()
      if (!replacement) return
      if (quitting) { await stopApplication(replacement); return }
      application = replacement
      handler = replacement.app
    })().catch(async error => {
      if (!quitting) {
        // A failed generation cannot serve a recovery action. Release the port
        // so the normal launcher can start a fresh host instead of leaving 503s.
        await stop().catch(cleanupError => console.error('Service shutdown failed', cleanupError))
        options.onRestartFailure?.(error)
      }
      throw error
    }).finally(() => { restarting = undefined })
    return restarting
  }

  const closeListener = async () => {
    // listen() may still be resolving its address when shutdown is requested.
    await binding?.catch(() => {})
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  const stop = () => shutdown ??= (async () => {
    quitting = true
    applicationController?.abort(new Error('Service host is shutting down'))
    handler = unavailable
    const closed = closeListener()
    const closeIdleRequests = setTimeout(() => server.closeAllConnections(), 2_000)
    closeIdleRequests.unref()
    try {
      if (application) {
        await stopApplication(application)
        await application.dispose()
      }
      // createApplication owns cancellation cleanup while startup is in progress.
      // A created generation can retain the database lease until deferred module
      // startup settles, so process shutdown must also await its disposal.
      const created = await creating?.catch(() => undefined)
      if (created && created !== application) {
        await stopApplication(created)
        await created.dispose()
      }
    } finally {
      await closed
      clearTimeout(closeIdleRequests)
    }
  })()

  return { server, start, restart, shutdown: stop }
}
