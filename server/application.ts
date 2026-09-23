import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database } from 'node-sqlite3-wasm'
import type { ModuleManifest } from '../shared/modules'
import { manifests } from '../.generated/modules'
import { loaders } from '../.generated/server-modules'
import { closeAppDb, POSTER_DIR, openAppDb } from './db/schema'
import { assertDesktopEdition } from './db/desktop-edition'
import { initializeDatabase } from './db/instance'
import { ModuleRuntime, type ActiveModuleRoute, type ServerModuleLoader } from './core/module-runtime'
import { createModulesRouter } from './routes/modules'
import { createServiceRouter } from './routes/service'
import { createLocalFilesRouter } from './routes/local-files'
import { trackRouter } from './core/track-router'
import { recoverPendingFolderRenames } from './services/folder-operations'
import { assertLibraryAvailable } from './services/library-maintenance'
import { LibraryScanCoordinator } from './services/library-scan-coordinator'
import { isLocalOrigin } from './core/local-origin'
import { FolderMoveService } from './services/folder-moves'
import { createFolderMovesRouter } from './routes/folder-moves'

export interface ApplicationOptions {
  database?: Database
  manifests?: ModuleManifest[]
  loaders?: Record<string, ServerModuleLoader>
  distDir?: string
  backgroundTasks?: boolean
  signal?: AbortSignal
  moduleStartupTimeoutMs?: number
  restart?: () => Promise<void>
}

// Existing core repositories share one process database. Reject overlapping hosts
// rather than silently redirect an application's requests to another database.
let activeApplication: Database | undefined
let acquiringApplication = false

function startupAbortError(signal: AbortSignal): Error {
  const reason = signal.reason
  const error = new Error(reason instanceof Error && reason.message ? reason.message : 'Application startup aborted')
  error.name = 'AbortError'
  return error
}

function throwIfStartupAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw startupAbortError(signal)
}

export async function createApplication(options: ApplicationOptions = {}) {
  throwIfStartupAborted(options.signal)
  if (activeApplication || acquiringApplication) throw new Error('Only one AnimeShelf application may run in a process')
  acquiringApplication = true
  let database: Database
  try { database = options.database ?? await openAppDb() }
  finally { acquiringApplication = false }
  assertDesktopEdition(database)
  activeApplication = database
  let modules: ModuleRuntime | undefined
  let scans: LibraryScanCoordinator | undefined
  let moves: FolderMoveService | undefined
  let released = false
  const releaseApplication = async () => {
    if (released) return
    if (!options.database) await closeAppDb(database)
    released = true
    if (activeApplication === database) activeApplication = undefined
  }
  const releaseWhenSafe = async () => {
    if (!modules) { await releaseApplication(); return }
    if (modules.hasPendingStartup) {
      // A timed-out factory still owns its context until it settles. Keep the DB alive,
      // but do not make host shutdown wait forever for uncooperative module code.
      void modules.whenSettled().then(releaseApplication).catch(error => console.error('Module shutdown settlement failed', error))
      return
    }
    await modules.whenSettled()
    await releaseApplication()
  }
  try {
    initializeDatabase(database)
    const app = express()
    const instanceId = randomUUID()
    modules = new ModuleRuntime(database, options.manifests ?? manifests, options.loaders ?? loaders, {
      signal: options.signal,
      startupTimeoutMs: options.moduleStartupTimeoutMs,
    })
    const requests = new Set<Promise<void>>()
    let closing = false
    app.use((req, res, next) => {
      if (!isLocalOrigin(req.get('origin'))) return res.status(403).json({ error: '不允许跨站浏览器调用', code: 'ORIGIN_FORBIDDEN' })
      next()
    })
    app.use(cors({ origin: (origin, callback) => callback(null, isLocalOrigin(origin)) }))
    app.use((_req, res, next) => {
      if (closing) return res.status(503).json({ error: '应用正在关闭', code: 'SERVER_STOPPING' })
      let finish!: () => void
      const pending = new Promise<void>(resolve => { finish = resolve })
      requests.add(pending)
      const done = () => { requests.delete(pending); finish() }
      res.once('finish', done); res.once('close', done)
      next()
    })
    await modules.start()
    await recoverPendingFolderRenames(database)
    moves = new FolderMoveService(database)
    await moves.recover()
    scans = new LibraryScanCoordinator(database, instanceId, { backgroundTasks: options.backgroundTasks })
    throwIfStartupAborted(options.signal)
    const mountModuleRoute = (route: ActiveModuleRoute) => {
      const router = trackRouter(route.router, modules!)
      app.use(route.path, (req, res, next) => {
        if (!route.accepts(req.method, req.originalUrl)) { next(); return }
        router(req, res, next)
      })
    }
    for (const route of modules.routes().filter(route => route.beforeJson)) mountModuleRoute(route)
    app.use(express.json({ limit: '50mb' }))
    app.use('/api/modules', createModulesRouter(modules))
    app.use('/api/service', createServiceRouter(instanceId, options.restart, () => assertLibraryAvailable(database)))
    app.use('/api/local-files', trackRouter(createLocalFilesRouter(() => database), modules))
    app.use('/api/folder-moves', trackRouter(createFolderMovesRouter(database, moves), modules))
    for (const route of modules.routes().filter(route => !route.beforeJson)) mountModuleRoute(route)
    const [libraries, folders, files, tags, settings, play] = await Promise.all([
      import('./routes/libraries'), import('./routes/folders'), import('./routes/files'),
      import('./routes/tags'), import('./routes/settings'), import('./routes/play'),
    ])
    throwIfStartupAborted(options.signal)
    for (const [prefix, router] of [['libraries', libraries.default], ['folders', folders.default], ['files', files.default], ['tags', tags.default], ['settings', settings.default], ['play', play.default]] as const) app.use(`/api/${prefix}`, trackRouter(router, modules))
    app.use('/posters', express.static(POSTER_DIR))
    app.get('/api/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, instanceId, restartSupported: Boolean(options.restart) }))
    app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在或模块未启用', code: 'NOT_FOUND' }))
    const distDir = options.distDir ?? process.env.ANIMESHELF_DIST_DIR ?? path.join(__dirname, '..', 'dist')
    if (fs.existsSync(path.join(distDir, 'index.html'))) {
      app.use(express.static(distDir))
      app.get(/^(?!\/api\/|\/posters\/).*/, (_req, res) => res.sendFile(path.resolve(distDir, 'index.html')))
    }
    const backupTimer = options.backgroundTasks === false ? null : setTimeout(() => {
      void modules!.track(import('./services/backup').then(({ autoBackup }) => { autoBackup() }))
    }, 800)
    scans.start()
    let shutdown: Promise<void> | undefined
    let disposal: Promise<void> | undefined
    const stop = () => shutdown ??= (async () => {
      closing = true
      if (backupTimer) clearTimeout(backupTimer)
      await scans!.stop()
      await moves!.stop()
      modules!.abort()
      await modules!.stop()
      while (requests.size) await Promise.allSettled([...requests])
      await releaseWhenSafe()
    })()
    return {
      app, modules, database,
      stop,
      dispose: () => disposal ??= (async () => {
        await stop()
        await modules!.whenSettled()
        await releaseApplication()
      })(),
    }
  } catch (error) {
    await scans?.stop()
    await moves?.stop()
    await modules?.stop()
    // No application handle is returned on failure. Finish cleanup here so a
    // host awaiting the rejected startup cannot exit ahead of a module writer.
    await modules?.whenSettled()
    await releaseApplication()
    throw error
  }
}

