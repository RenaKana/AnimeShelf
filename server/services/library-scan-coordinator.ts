import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'node-sqlite3-wasm'
import type { Library } from '../types'
import { makeLibraryDb } from '../db/libraries'
import { makeSettingsDb } from '../db/settings'
import { scanLibrary, type ScanOptions } from './scanner'
import { libraryMaintenanceOperation, onLibraryMaintenanceIdle } from './library-maintenance'
import type { LibraryScanResult, LibraryScanSnapshot, LibraryScanStatus } from '../../shared/library-scan'

type Reason = LibraryScanStatus['reason']
interface WatchHandle { close(): void; on(event: 'error', listener: (error: Error) => void): unknown }
type WatchEventType = 'rename' | 'change'
type WatchFilename = string | Buffer | null
type WatchListener = (eventType: WatchEventType, filename: WatchFilename) => void
type WatchFingerprint = {
  identity: string
  dev: string
  ino: string
  birth: string
  type: 'file' | 'directory' | 'other'
  mtime: string
  ctime: string
  size: string
}
type WatchBaseline = WatchFingerprint | null
interface Options {
  backgroundTasks?: boolean
  debounceMs?: number
  intervalMs?: number
  scan?: (library: Library, database: Database, options: ScanOptions) => Promise<LibraryScanResult>
  watch?: (root: string, onChange: WatchListener) => WatchHandle
}

function watchPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function resolveWatchPath(root: string, filename: WatchFilename): string | undefined {
  if (filename == null) return undefined
  const value = Buffer.isBuffer(filename) ? filename.toString() : filename
  if (!value) return undefined
  const target = path.resolve(root, value)
  const relative = path.relative(watchPathKey(root), watchPathKey(target))
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) ? undefined : target
}

function readWatchFingerprint(target: string): WatchFingerprint | undefined {
  try {
    const stat = fs.lstatSync(target, { bigint: true })
    const dev = String(stat.dev)
    const ino = String(stat.ino)
    const birth = String(stat.birthtimeNs)
    return {
      identity: JSON.stringify({ dev, ino, birth }),
      dev, ino, birth,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs),
      size: String(stat.size),
    }
  } catch {
    return undefined
  }
}

function sameWatchFingerprint(left: WatchFingerprint, right: WatchFingerprint): boolean {
  return left.identity === right.identity && left.dev === right.dev && left.ino === right.ino
    && left.birth === right.birth && left.type === right.type && left.mtime === right.mtime
    && left.ctime === right.ctime && left.size === right.size
}

const coordinators = new WeakMap<Database, LibraryScanCoordinator>()
export const libraryScanCoordinator = (db: Database) => coordinators.get(db)
export function refreshLibraryScanning(db: Database, restored = false): void { coordinators.get(db)?.refresh(restored) }

/** One worker for the entire database, matching the existing maintenance lock. */
export class LibraryScanCoordinator {
  private readonly statuses = new Map<number, LibraryScanStatus>()
  private readonly pending = new Map<number, { reason: Reason; resolve: Array<(result: LibraryScanResult) => void> }>()
  private readonly watchers = new Map<number, { root: string; handle: WatchHandle }>()
  private readonly watchBaselines = new Map<number, Map<string, WatchBaseline>>()
  private readonly activeWatchBaselines = new Map<number, Map<string, WatchBaseline>>()
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly retries = new Map<number, number>()
  private readonly retryAfter = new Map<number, number>()
  private interval?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private active?: AbortController
  private stopped = false
  private started = false
  private automatic = false
  private generation = 0
  private configuration = ''
  private readonly libraryGenerations = new Map<number, number>()
  private revision = 0
  private sequence = 0
  private maintenanceBlocked = false
  private unsubscribeMaintenance?: () => void
  private readonly debounceMs: number
  private readonly scan: NonNullable<Options['scan']>
  private readonly watch: NonNullable<Options['watch']>

  constructor(private readonly db: Database, private readonly instanceId: string, private readonly options: Options = {}) {
    this.debounceMs = options.debounceMs ?? 2000
    this.scan = options.scan ?? scanLibrary
    this.watch = options.watch ?? ((root, onChange) => fs.watch(root, { recursive: true }, onChange))
    coordinators.set(db, this)
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.unsubscribeMaintenance = onLibraryMaintenanceIdle(this.db, () => {
      if (this.stopped || !this.maintenanceBlocked) return
      this.maintenanceBlocked = false
      if (!this.running && this.hasReadyWork()) this.startDrain()
    })
    this.refresh()
    if (this.options.backgroundTasks === false) return
    if (makeSettingsDb(this.db).get('scan_on_startup') === '1') {
      for (const library of makeLibraryDb(this.db).getAll()) void this.request(library.id, 'startup')
    }
    this.interval = setInterval(() => {
      this.refresh()
      if (this.automatic) for (const library of makeLibraryDb(this.db).getAll()) void this.request(library.id, 'periodic')
    }, this.options.intervalMs ?? 10 * 60_000)
    this.interval.unref?.()
  }

  refresh(restored = false): void {
    if (this.stopped) return
    const libraries = makeLibraryDb(this.db).getAll()
    const ids = new Set(libraries.map(library => library.id))
    const wasAutomatic = this.automatic
    this.automatic = this.options.backgroundTasks !== false && makeSettingsDb(this.db).get('auto_scan') !== '0'
    const configuration = JSON.stringify([this.automatic, makeSettingsDb(this.db).get('everything_url'), libraries.map(library => [library.id, library.root_path, library.everything_url])])
    const configurationChanged = restored || configuration !== this.configuration
    if (configurationChanged) this.generation++
    this.configuration = configuration
    if (restored) this.revision++
    for (const [id, watcher] of this.watchers) {
      if (restored || !this.automatic || libraries.find(library => library.id === id)?.root_path !== watcher.root) {
        watcher.handle.close(); this.watchers.delete(id)
        this.watchBaselines.delete(id); this.activeWatchBaselines.delete(id)
      }
    }
    for (const [id, timer] of this.timers) if (!ids.has(id) || !this.automatic) {
      clearTimeout(timer); this.timers.delete(id)
      const status = this.statuses.get(id)
      if (status?.status === 'waiting' && this.pending.get(id)?.reason !== 'manual') {
        this.transition(status, { status: status.error ? 'error' : 'idle', waitingReason: undefined })
      }
    }
    for (const [id, entry] of this.pending) {
      if (ids.has(id) && (this.automatic || entry.reason === 'manual')) continue
      this.pending.delete(id)
      for (const resolve of entry.resolve) resolve({ added: 0, updated: 0, removed: 0, errors: ['自动扫描已取消或媒体库已移除'], code: 'SCAN_CANCELLED' })
      const status = this.statuses.get(id)
      if (status && status.status !== 'scanning') this.transition(status, { status: 'idle', error: undefined, waitingReason: undefined })
    }
    for (const id of this.statuses.keys()) if (!ids.has(id)) {
      this.statuses.delete(id); this.retries.delete(id); this.retryAfter.delete(id); this.libraryGenerations.delete(id)
      this.watchBaselines.delete(id); this.activeWatchBaselines.delete(id)
    }
    for (const library of libraries) {
      if (!this.statuses.has(library.id)) {
        this.statuses.set(library.id, { libraryId: library.id, reason: 'startup', status: 'idle', revision: this.revision, sequence: ++this.sequence })
        if (this.interval && this.automatic) void this.request(library.id, 'watch')
      }
      if (!this.automatic || this.watchers.has(library.id)) continue
      try {
        const handle = this.watch(library.root_path, (eventType, filename) => {
          if (this.stopped || !this.automatic || this.watchers.get(library.id)?.handle !== handle) return
          if (!this.isMeaningfulWatchEvent(library.id, library.root_path, eventType, filename)) return
          this.libraryGenerations.set(library.id, (this.libraryGenerations.get(library.id) ?? 0) + 1)
          this.schedule(library.id, 'watch')
          const current = this.statuses.get(library.id)
          if (current && current.status !== 'scanning' && current.status !== 'error') this.transition(current, { status: 'waiting', waitingReason: current.error ? 'retry' : 'filesystem_changed' })
        })
        this.watchers.set(library.id, { root: library.root_path, handle })
        delete this.statuses.get(library.id)!.watchError
        handle.on('error', error => {
          if (this.stopped || this.watchers.get(library.id)?.handle !== handle) return
          handle.close(); this.watchers.delete(library.id)
          const current = this.statuses.get(library.id)
          if (current) this.transition(current, { watchError: `目录监听不可用，将定期重试：${error.message}` })
          this.libraryGenerations.set(library.id, (this.libraryGenerations.get(library.id) ?? 0) + 1)
          this.schedule(library.id, 'retry')
        })
      } catch (error) {
        this.statuses.get(library.id)!.watchError = `目录监听不可用，将定期重试：${error instanceof Error ? error.message : String(error)}`
      }
    }
    // Applying configuration/restore invalidates an in-flight snapshot. On initial
    // startup the saved startup option alone decides whether to scan immediately.
    if (this.started && this.interval && this.automatic && (configurationChanged || !wasAutomatic)) {
      for (const library of libraries) void this.request(library.id, 'watch')
    }
  }

  private transition(status: LibraryScanStatus, changes: Partial<LibraryScanStatus>): void {
    Object.assign(status, changes, { sequence: ++this.sequence })
  }

  private isMeaningfulWatchEvent(id: number, root: string, eventType: WatchEventType, filename: WatchFilename): boolean {
    if (eventType !== 'change') return true
    const target = resolveWatchPath(root, filename)
    if (!target) return true
    const current = readWatchFingerprint(target)
    if (!current) return true
    const key = watchPathKey(target)
    const activeBaselines = this.activeWatchBaselines.get(id)
    // The current scan captured this before reading it. Comparing against the
    // previous scan here would repeatedly cancel after a real change; comparing
    // against that older value as a fallback could also hide a new mutation.
    if (activeBaselines?.has(key)) {
      const active = activeBaselines.get(key)
      return !(active && sameWatchFingerprint(active, current))
    }
    const stable = this.watchBaselines.get(id)?.get(key)
    if (stable && sameWatchFingerprint(stable, current)) return false
    return true
  }

  private hasReadyWork(): boolean {
    return [...this.pending.keys()].some(id => !this.timers.has(id))
  }

  private schedule(id: number, reason: Reason, delay = this.debounceMs): void {
    if (this.stopped || (!this.automatic && reason !== 'retry')) return
    // Filesystem events still invalidate snapshots, but cannot silently start a
    // new failure cycle after its bounded retries have been exhausted.
    if (this.statuses.get(id)?.status === 'error') return
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.request(id, reason)
    }, Math.max(delay, (this.retryAfter.get(id) ?? 0) - Date.now()))
    timer.unref?.()
    this.timers.set(id, timer)
  }

  request(id: number, reason: Reason = 'manual'): Promise<LibraryScanResult> {
    if (this.stopped) return Promise.resolve({ added: 0, updated: 0, removed: 0, errors: ['服务正在关闭'], code: 'SERVER_STOPPING' })
    const previous = this.statuses.get(id)
    if ((reason === 'watch' || reason === 'retry') && previous?.status === 'error' && previous.result) return Promise.resolve(previous.result)
    return new Promise(resolve => {
      if (reason === 'manual' || reason === 'periodic') { this.retries.delete(id); this.retryAfter.delete(id) }
      if (reason === 'manual') {
        const timer = this.timers.get(id)
        if (timer) clearTimeout(timer)
        this.timers.delete(id)
      }
      const entry = this.pending.get(id)
      if (entry) { entry.resolve.push(resolve); if (reason === 'manual') entry.reason = reason }
      else this.pending.set(id, { reason, resolve: [resolve] })
      const status = this.statuses.get(id)
      if (status && status.status !== 'scanning') this.transition(status, { status: 'queued', reason })
      if (this.maintenanceBlocked && libraryMaintenanceOperation(this.db)) {
        if (status) this.transition(status, { status: 'waiting', waitingReason: 'maintenance' })
        for (const waiting of this.pending.get(id)!.resolve.splice(0)) waiting({ added: 0, updated: 0, removed: 0, errors: ['等待当前维护任务完成'], code: 'LIBRARY_BUSY' })
      } else if (this.maintenanceBlocked) this.maintenanceBlocked = false
      if (!this.running && !this.maintenanceBlocked && this.hasReadyWork()) {
        // A microtask lets simultaneous triggers coalesce before starting work.
        this.startDrain()
      }
    })
  }

  private startDrain(): void {
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = undefined
      if (!this.stopped && !this.maintenanceBlocked && this.hasReadyWork()) this.startDrain()
    })
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.pending.size) {
      if (libraryMaintenanceOperation(this.db)) {
        this.maintenanceBlocked = true
        for (const [id, entry] of this.pending) {
          const status = this.statuses.get(id)
          if (status) this.transition(status, { status: 'waiting', waitingReason: 'maintenance' })
          // Do not keep an HTTP scan request waiting for a long poster job.
          for (const resolve of entry.resolve.splice(0)) resolve({ added: 0, updated: 0, removed: 0, errors: ['等待当前维护任务完成'], code: 'LIBRARY_BUSY' })
        }
        return
      }
      const next = [...this.pending.entries()].find(([id]) => !this.timers.has(id))
      if (!next) return
      const [id, entry] = next
      this.pending.delete(id)
      let library: Library | undefined
      try { library = makeLibraryDb(this.db).getById(id) }
      catch (error) {
        const result = { added: 0, updated: 0, removed: 0, errors: [error instanceof Error ? error.message : String(error)], code: 'SCAN_DATABASE_UNAVAILABLE' }
        const status = this.statuses.get(id)
        if (status) this.transition(status, { status: 'error', result, error: result.errors[0], waitingReason: undefined })
        for (const resolve of entry.resolve) resolve(result)
        continue
      }
      if (!library) {
        for (const resolve of entry.resolve) resolve({ added: 0, updated: 0, removed: 0, errors: ['媒体库已移除'], code: 'LIBRARY_NOT_FOUND' })
        continue
      }
      const status: LibraryScanStatus = this.statuses.get(id) ?? { libraryId: id, reason: entry.reason, status: 'idle', revision: this.revision }
      this.transition(status, { status: 'scanning', reason: entry.reason })
      this.statuses.set(id, status)
      const generation = this.generation
      const libraryGeneration = this.libraryGenerations.get(id) ?? 0
      const controller = new AbortController()
      this.active = controller
      const activeBaseline = new Map<string, WatchBaseline>()
      this.activeWatchBaselines.set(id, activeBaseline)
      let result: LibraryScanResult
      try {
        result = await this.scan(library, this.db, {
          signal: controller.signal,
          isCurrent: () => !this.stopped && generation === this.generation && libraryGeneration === (this.libraryGenerations.get(id) ?? 0),
          captureFilesystemBaseline: target => {
            const key = watchPathKey(target)
            if (activeBaseline.has(key)) return
            activeBaseline.set(key, readWatchFingerprint(target) ?? null)
          },
        })
      } catch (error: any) {
        result = { added: 0, updated: 0, removed: 0, errors: [error?.message ?? String(error)], code: error?.code, retryable: error?.code === 'LIBRARY_BUSY' }
      }
      this.active = undefined
      const scanWasCurrent = !this.stopped && generation === this.generation && libraryGeneration === (this.libraryGenerations.get(id) ?? 0)
      this.activeWatchBaselines.delete(id)
      if (scanWasCurrent && activeBaseline.size && !result.errors.length && result.code !== 'SCAN_CANCELLED') {
        this.watchBaselines.set(id, activeBaseline)
      }
      if (!this.stopped && this.statuses.has(id)) {
        if (result.changed) status.revision = ++this.revision
        if (result.code === 'LIBRARY_BUSY') {
          if (!this.pending.has(id)) this.pending.set(id, { reason: entry.reason, resolve: [] })
          this.transition(status, { status: 'waiting', waitingReason: 'maintenance', result })
          // Recheck after subscribing: the lock may already have been released.
          this.maintenanceBlocked = Boolean(libraryMaintenanceOperation(this.db))
          if (!this.maintenanceBlocked) this.schedule(id, 'retry')
        } else if (result.code === 'SCAN_CANCELLED') {
          if (this.automatic) {
            if (!this.timers.has(id) && !this.pending.has(id)) this.schedule(id, 'watch')
            this.transition(status, { status: 'waiting', waitingReason: 'filesystem_changed', error: status.error, result })
          } else this.transition(status, { status: 'idle', waitingReason: undefined, error: undefined, result })
        } else if (result.errors.length) {
          const attempts = this.retries.get(id) ?? 0
          const retry = this.automatic && result.retryable && attempts < 3
          this.transition(status, { status: retry ? 'waiting' : 'error', waitingReason: retry ? 'retry' : undefined, error: result.errors.join('；'), result })
          if (retry) {
            this.retries.set(id, attempts + 1)
            this.retryAfter.set(id, Date.now() + 2000 * 2 ** attempts)
            this.schedule(id, 'retry', 2000 * 2 ** attempts)
          } else {
            const timer = this.timers.get(id)
            if (timer) clearTimeout(timer)
            this.timers.delete(id); this.retryAfter.delete(id)
            for (const resolve of this.pending.get(id)?.resolve ?? []) resolve(result)
            this.pending.delete(id)
          }
        } else {
          this.retries.delete(id); this.retryAfter.delete(id)
          this.transition(status, { status: 'complete', waitingReason: undefined, error: undefined, result })
        }
      }
      for (const resolve of entry.resolve) resolve(result)
    }
  }

  snapshot(): LibraryScanSnapshot {
    return { instanceId: this.instanceId, revision: this.revision, libraries: [...this.statuses.values()].map(status => ({ ...status })) }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribeMaintenance?.()
    if (this.interval) clearInterval(this.interval)
    for (const watcher of this.watchers.values()) watcher.handle.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.watchers.clear(); this.timers.clear()
    this.watchBaselines.clear(); this.activeWatchBaselines.clear()
    this.active?.abort()
    for (const entry of this.pending.values()) for (const resolve of entry.resolve) resolve({ added: 0, updated: 0, removed: 0, errors: ['服务正在关闭'], code: 'SERVER_STOPPING' })
    this.pending.clear()
    await this.running
    if (coordinators.get(this.db) === this) coordinators.delete(this.db)
  }
}
