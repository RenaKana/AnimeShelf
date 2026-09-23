import path from 'path'
import serviceRuntime, { type ServiceRuntime } from '../scripts/service-runtime.cjs'
import { createApplication } from './application'
import { createServiceHost } from './core/service-host'

const { createServiceRuntime } = serviceRuntime
const configuredPort = Number(process.env.PORT ?? 3001)
let registration: ServiceRuntime | undefined
let registrationStartup: Promise<void> | undefined
let lastListeningPort: number | null = null

const host = createServiceHost({
  createApplication,
  port: configuredPort,
  host: process.env.LISTEN_HOST ?? '127.0.0.1',
  onListening: server => {
    lastListeningPort = (server.address() as { port: number }).port
    console.log('AnimeShelf API running on port', lastListeningPort)
    process.send?.({ type: 'service-status', apiPort: lastListeningPort })
    registration?.update({
      state: 'running',
      apiPort: lastListeningPort,
      webUrl: registration.status().webUrl ?? `http://127.0.0.1:${lastListeningPort}`,
    })
  },
  onRestartFailure: () => { if (!process.versions.electron) process.exitCode = 1 },
})

let shutdown: Promise<void> | undefined
export function shutdownServer(): Promise<void> {
  return shutdown ??= (async () => {
    try {
      await host.shutdown()
      await registrationStartup
      await registration?.close()
    } catch (error) {
      registration?.fail(error)
      throw error
    }
  })()
}

export async function startServiceRegistration(options: {
  kind?: string
  projectDir?: string
  dataDir?: string
  webUrl?: string | null
  apiPort?: number | null
  logPath?: string | null
  onStop?: () => void | Promise<void>
} = {}): Promise<void> {
  if (registration || process.env.ANIMESHELF_SERVICE_CHILD === '1') return
  if (registrationStartup) return registrationStartup
  registrationStartup = (async () => {
    const created = await createServiceRuntime({
      kind: options.kind ?? 'standalone',
      projectDir: options.projectDir ?? process.env.ANIMESHELF_PROJECT_DIR ?? process.cwd(),
      dataDir: options.dataDir ?? process.env.ANIMESHELF_DATA_DIR ?? path.resolve('data'),
      webUrl: options.webUrl ?? null,
      apiPort: options.apiPort ?? lastListeningPort ?? configuredPort,
      logPath: options.logPath ?? process.env.ANIMESHELF_SERVICE_LOG ?? null,
      onStop: options.onStop ?? (() => shutdownServer()),
    })
    if (shutdown) {
      await created.close()
      return
    }
    registration = created
    if (lastListeningPort) registration.update({
      state: 'running',
      apiPort: lastListeningPort,
      webUrl: options.webUrl ?? `http://127.0.0.1:${lastListeningPort}`,
    })
  })()
  return registrationStartup
}

export function updateServiceRegistration(status: Parameters<ServiceRuntime['update']>[0]): void {
  registration?.update(status)
}

const ownsStandaloneRegistration = !process.versions.electron && process.env.ANIMESHELF_SERVICE_CHILD !== '1'
const startup = (async () => {
  if (ownsStandaloneRegistration) await startServiceRegistration()
  try { await host.start() }
  catch (error) {
    registration?.fail(error)
    await registration?.close({ remove: false })
    throw error
  }
})()

void startup.catch(error => {
  if (!shutdown) {
    console.error('Application startup failed', error)
    if (process.connected) process.send?.({
      type: 'startup-failed',
      error: error instanceof Error ? error.message : String(error),
      code: typeof error?.code === 'string' ? error.code : undefined,
    })
    process.exitCode = 1
  }
})

// Desktop uses shutdownServer directly. Direct web/service entrypoints use signals.
if (!process.versions.electron) {
  const onSignal = () => { void shutdownServer().catch(error => { console.error('Application shutdown failed', error); process.exitCode = 1 }) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}
