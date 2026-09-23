import type { Database } from 'node-sqlite3-wasm'
import type { RequestHandler, Router } from 'express'
import type { ModuleConfigurationPatch, ModuleManifest, ModuleSnapshot } from '../../shared/modules'
import { sqlAll, sqlRun } from '../db/sql'
import { bindModuleRuntime } from './extensions'
import coreRoutes from '../../shared/core-routes.json'
import { makeSettingsDb } from '../db/settings'

export interface ModuleRoute { path: string; router: Router; beforeJson?: boolean }
export interface ActiveModuleRoute extends ModuleRoute { accepts: (method: string, path: string) => boolean }
export interface ServerModule {
  /** Append-only migrations run transactionally before start, once per module/id. */
  migrations?: Array<{ id: string; up: (db: Database) => void }>
  routes?: ModuleRoute[]
  start?: () => void | Promise<void>
  /** Stop producing work before tracked operations drain. */
  quiesce?: () => void | Promise<void>
  /** Release resources after tracked operations drain. */
  stop?: () => void | Promise<void>
  afterRestore?: () => void | Promise<void>
}
export interface ModuleContext {
  db: Database
  settings: ReturnType<typeof makeSettingsDb>
  /** Factories and start hooks must settle promptly after cancellation. */
  signal: AbortSignal
  isActive: (id: string) => boolean
  provide: <T>(name: string, value: T) => void
  capability: <T>(name: string) => T | undefined
  contribute: <T>(slot: string, value: T) => void
  contributions: <T>(slot: string) => T[]
  onQuiesce: (quiesce: () => void | Promise<void>) => void
  onDispose: (dispose: () => void | Promise<void>) => void
  track: <T>(operation: Promise<T>) => Promise<T>
}
export type ServerModuleLoader = () => Promise<{ default: (context: ModuleContext) => ServerModule | Promise<ServerModule> }>
export interface ModuleRuntimeOptions {
  /** Host cancellation aborts module startup and work; the host still calls stop() to drain. */
  signal?: AbortSignal
  startupTimeoutMs?: number
}

type LifecycleCallback = () => void | Promise<void>
type ExpressLayer = {
  handle: RequestHandler & { stack?: ExpressLayer[] }
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: ExpressLayer[] }
  regexp?: RegExp & { fast_slash?: boolean }
  keys?: Array<{ name: string | number }>
}

class ModuleContractError extends Error {}
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000

const normalizeMethod = (method: string) => method.toUpperCase().replace(/^_ALL$/, 'ALL')
const normalizePath = (value: string) => {
  const path = value.split('?', 1)[0].replace(/\/+$/, '')
  return path || '/'
}
const routeKey = (method: string, path: string) => `${normalizeMethod(method)} ${normalizePath(path).replace(/:[A-Za-z0-9_]+/g, ':param').toLowerCase()}`
const routeSegments = (path: string) => normalizePath(path).split('/').filter(Boolean)
const methodsOverlap = (left: string, right: string) => {
  const a = normalizeMethod(left), b = normalizeMethod(right)
  return a === b || a === 'ALL' || b === 'ALL' || (a === 'GET' && b === 'HEAD') || (a === 'HEAD' && b === 'GET')
}
const routePathsOverlap = (left: string, right: string) => {
  const a = routeSegments(left), b = routeSegments(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const leftSegment = a[index], rightSegment = b[index]
    if (leftSegment === '*' || rightSegment === '*') return true
    if (leftSegment === undefined || rightSegment === undefined) return false
    if (!leftSegment.startsWith(':') && !rightSegment.startsWith(':') && leftSegment.toLowerCase() !== rightSegment.toLowerCase()) return false
  }
  return true
}
const routeMatches = (declaredMethod: string, declaredPath: string, method: string, path: string) => {
  if (!methodsOverlap(declaredMethod, method) || (normalizeMethod(declaredMethod) !== 'ALL' && normalizeMethod(method) !== 'HEAD' && normalizeMethod(declaredMethod) !== normalizeMethod(method))) return false
  const pattern = routeSegments(declaredPath), actual = routeSegments(path)
  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index]
    if (segment === '*') return true
    if (actual[index] === undefined) return false
    if (!segment.startsWith(':') && segment.toLowerCase() !== actual[index].toLowerCase()) return false
  }
  return pattern.length === actual.length
}
const joinPaths = (...parts: string[]) => normalizePath('/' + parts.flatMap(part => part.split('/')).filter(Boolean).join('/'))

function nestedMountPath(layer: ExpressLayer): string {
  if (layer.regexp?.fast_slash) return ''
  const regexpSource = layer.regexp?.source
  const suffix = '\\/?(?=\\/|$)'
  if (!regexpSource || !regexpSource.startsWith('^') || !regexpSource.endsWith(suffix)) throw new ModuleContractError('Nested module router mounts require a simple string path')
  let source = regexpSource.slice(1, -suffix.length)
  for (const key of layer.keys ?? []) {
    if (typeof key.name === 'number') {
      const token = '(.*)'
      if (!source.includes(token)) throw new ModuleContractError('Nested module router wildcard could not be validated')
      source = source.replace(token, '*')
    } else {
      const token = '(?:\\/([^/]+?))'
      if (!source.includes(token)) throw new ModuleContractError('Nested module router parameter could not be validated')
      source = source.replace(token, `/:${key.name}`)
    }
  }
  source = source.replace(/\\\//g, '/').replace(/\\([.\-])/g, '$1')
  if (source.includes('\\') || /[()[\]|+?]/.test(source) || (source && !source.startsWith('/'))) throw new ModuleContractError('Nested module router mounts require a simple string path')
  return source
}

/** One instance per application; configuration changes never mutate a running graph. */
export class ModuleRuntime {
  private configured = new Map<string, boolean>()
  private started = new Map<string, ServerModule>()
  private reasons = new Map<string, string>()
  private capabilities = new Map<string, { owner: string; value: unknown }>()
  private contributionSlots = new Map<string, Array<{ owner: string; value: unknown }>>()
  private quiescers = new Map<string, LifecycleCallback[]>()
  private disposers = new Map<string, LifecycleCallback[]>()
  private quiesced = new Set<string>()
  private tasks = new Set<Promise<unknown>>()
  private moduleTasks = new Map<string, Set<Promise<unknown>>>()
  private pendingStartups = new Set<Promise<void>>()
  private lifecycleWork = new Set<Promise<void>>()
  private controller = new AbortController()
  private moduleControllers = new Map<string, AbortController>()
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private unlinkHostSignal?: () => void
  private startupTimeoutMs: number
  readonly bootEnabled = new Map<string, boolean>()

  constructor(readonly db: Database, readonly manifests: ModuleManifest[], private loaders: Record<string, ServerModuleLoader>, options: ModuleRuntimeOptions = {}) {
    db.exec('CREATE TABLE IF NOT EXISTS module_config (module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))')
    db.exec('CREATE TABLE IF NOT EXISTS module_migrations (module_id TEXT NOT NULL, migration_id TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(module_id,migration_id))')
    this.startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) && Number(options.startupTimeoutMs) > 0 ? Number(options.startupTimeoutMs) : DEFAULT_STARTUP_TIMEOUT_MS
    this.reloadConfiguration()
    for (const manifest of manifests) this.bootEnabled.set(manifest.id, this.configured.get(manifest.id) ?? manifest.defaultEnabled)
    if (options.signal) {
      const abort = () => this.abort(options.signal?.reason)
      if (options.signal.aborted) abort()
      else {
        options.signal.addEventListener('abort', abort, { once: true })
        this.unlinkHostSignal = () => options.signal?.removeEventListener('abort', abort)
      }
    }
    bindModuleRuntime(db, this)
  }

  private reloadConfiguration() {
    this.configured = new Map(sqlAll<{ module_id: string; enabled: number }>(this.db, 'SELECT module_id, enabled FROM module_config').map(row => [row.module_id, row.enabled === 1]))
  }

  private migrate(id: string, module: ServerModule) {
    const migrations = module.migrations ?? []
    if (migrations.some(m => !/^[a-zA-Z0-9_-]+$/.test(m.id)) || new Set(migrations.map(m => m.id)).size !== migrations.length) throw new ModuleContractError(`Invalid migrations: ${id}`)
    const applied = new Set(sqlAll<{ migration_id: string }>(this.db, 'SELECT migration_id FROM module_migrations WHERE module_id=?', [id]).map(row => row.migration_id))
    this.db.exec('SAVEPOINT module_migrate')
    try {
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue
        migration.up(this.db)
        sqlRun(this.db, 'INSERT INTO module_migrations(module_id,migration_id) VALUES (?,?)', [id, migration.id])
      }
      this.db.exec('RELEASE module_migrate')
    } catch (error) { this.db.exec('ROLLBACK TO module_migrate'); this.db.exec('RELEASE module_migrate'); throw error }
  }

  private validateRoutes(manifest: ModuleManifest, module: ServerModule) {
    const declarations = manifest.routes ?? []
    const declared = new Set(declarations.map(route => routeKey(route.method, route.path)))
    const occupied = [
      ...coreRoutes.map(route => ({ ...route, owner: 'core' })),
      ...this.manifests.filter(candidate => this.isActive(candidate.id)).flatMap(candidate => (candidate.routes ?? []).map(route => ({ ...route, owner: candidate.id }))),
    ]
    for (let index = 0; index < declarations.length; index++) {
      const route = declarations[index]
      const conflict = occupied.find(existing => methodsOverlap(route.method, existing.method) && routePathsOverlap(route.path, existing.path))
        ?? declarations.slice(0, index).find(existing => methodsOverlap(route.method, existing.method)
          && routePathsOverlap(route.path, existing.path)
          && normalizePath(route.path).toLowerCase() !== normalizePath(existing.path).toLowerCase())
      if (conflict) throw new ModuleContractError(`Undeclared or conflicting module route: ${routeKey(route.method, route.path)}`)
    }
    const actual = new Set<string>()
    const visit = (layers: ExpressLayer[], mountPath: string, nestedPath = '') => {
      for (const layer of layers) {
        if (layer.route) {
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
          for (const path of paths) for (const method of Object.keys(layer.route.methods)) {
            if (typeof path !== 'string') throw new ModuleContractError('Module routes must declare string paths')
            const key = routeKey(method, joinPaths(mountPath, nestedPath, path))
            if (!declared.has(key) || actual.has(key)) throw new ModuleContractError(`Undeclared or conflicting module route: ${key}`)
            actual.add(key)
          }
          continue
        }
        const nested = layer.handle?.stack
        if (nested) visit(nested, mountPath, joinPaths(nestedPath, nestedMountPath(layer)))
        // Plain middleware is safe because application.ts only invokes the router for a declared route.
      }
    }
    for (const mount of module.routes ?? []) {
      if (!/^\/api\/[^/]+/.test(mount.path) || /^\/api\/modules(?:\/|$)/.test(mount.path)) throw new ModuleContractError('Module routers require a non-reserved /api/<name> mount')
      visit((mount.router as unknown as { stack: ExpressLayer[] }).stack ?? [], mount.path)
    }
    if (actual.size !== declared.size) throw new ModuleContractError(`Module ${manifest.id} route declarations do not match its router`)
  }

  private trackOperation<T>(operation: Promise<T>, owner?: string): Promise<T> {
    this.tasks.add(operation)
    let owned: Set<Promise<unknown>> | undefined
    if (owner) {
      owned = this.moduleTasks.get(owner)
      if (!owned) { owned = new Set(); this.moduleTasks.set(owner, owned) }
      owned.add(operation)
    }
    const settled = () => { this.tasks.delete(operation); owned?.delete(operation) }
    operation.then(settled, settled)
    return operation
  }

  private runLifecycle(id: string, phase: string, callback: LifecycleCallback): Promise<void> {
    const operation = (async () => {
      try { await callback() }
      catch (error) { console.error(`Module ${id} ${phase} failed`, error instanceof ModuleContractError ? error.message : error instanceof Error ? error.name : 'Error') }
    })()
    this.lifecycleWork.add(operation)
    void operation.finally(() => this.lifecycleWork.delete(operation))
    return operation
  }

  private registerLifecycle(collection: Map<string, LifecycleCallback[]>, id: string, phase: string, callback: LifecycleCallback) {
    const callbacks = collection.get(id)
    if (callbacks) callbacks.push(callback)
    else void this.runLifecycle(id, phase, callback)
  }

  private throwIfAborted(signal: AbortSignal) {
    if (!signal.aborted) return
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Module startup aborted'), { name: 'AbortError' })
  }

  private async awaitStartup<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : Object.assign(new Error('Module startup aborted'), { name: 'AbortError' }))
      if (controller.signal.aborted) return onAbort()
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => controller.abort(new ModuleContractError('模块启动超时')), this.startupTimeoutMs)
    })
    try { return await Promise.race([operation, interrupted]) }
    finally {
      if (timer) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private async initializeModule(manifest: ModuleManifest, controller: AbortController): Promise<ServerModule> {
    const loaded = await this.loaders[manifest.id]?.()
    if (!loaded) throw new ModuleContractError('缺少模块入口')
    this.throwIfAborted(controller.signal)
    const module = await loaded.default({
      db: this.db,
      settings: makeSettingsDb(this.db),
      signal: controller.signal,
      isActive: this.isActive,
      capability: this.capability,
      track: operation => this.trackOperation(operation, manifest.id),
      contributions: this.contributions,
      contribute: (slot, value) => {
        if (!this.disposers.has(manifest.id)) throw new ModuleContractError(`模块 ${manifest.id} 已停止初始化`)
        const values = this.contributionSlots.get(slot) ?? []
        values.push({ owner: manifest.id, value })
        this.contributionSlots.set(slot, values)
      },
      provide: (name, value) => {
        if (!this.disposers.has(manifest.id)) throw new ModuleContractError(`模块 ${manifest.id} 已停止初始化`)
        if (this.capabilities.has(name)) throw new ModuleContractError(`重复能力: ${name}`)
        this.capabilities.set(name, { owner: manifest.id, value })
      },
      onQuiesce: quiesce => this.registerLifecycle(this.quiescers, manifest.id, 'quiesce', quiesce),
      onDispose: dispose => this.registerLifecycle(this.disposers, manifest.id, 'cleanup', dispose),
    })
    if (module.quiesce) this.registerLifecycle(this.quiescers, manifest.id, 'quiesce', module.quiesce)
    if (module.stop) this.registerLifecycle(this.disposers, manifest.id, 'cleanup', module.stop)
    this.throwIfAborted(controller.signal)
    this.validateRoutes(manifest, module)
    this.migrate(manifest.id, module)
    await module.start?.()
    this.throwIfAborted(controller.signal)
    return module
  }

  isActive = (id: string) => this.started.has(id)
  capability = <T,>(name: string): T | undefined => this.capabilities.get(name)?.value as T | undefined
  contributions = <T,>(slot: string): T[] => (this.contributionSlots.get(slot) ?? []).map(entry => entry.value as T)
  track = <T,>(operation: Promise<T>): Promise<T> => this.trackOperation(operation)

  snapshot(): ModuleSnapshot {
    return {
      modules: this.manifests.map(manifest => ({ ...manifest, configuredEnabled: this.configured.get(manifest.id) ?? manifest.defaultEnabled, active: this.isActive(manifest.id), reason: this.reasons.get(manifest.id) ?? null })),
      restartRequired: this.manifests.some(m => this.bootEnabled.get(m.id) !== (this.configured.get(m.id) ?? m.defaultEnabled)),
    }
  }

  configure(patch: ModuleConfigurationPatch): ModuleSnapshot {
    if (!patch || !patch.enabled || typeof patch.enabled !== 'object' || Array.isArray(patch.enabled)) throw new ModuleContractError('enabled 必须是模块开关对象')
    const next = new Map(this.configured), known = new Map(this.manifests.map(m => [m.id, m]))
    for (const [id, enabled] of Object.entries(patch.enabled)) {
      if (!known.has(id) || typeof enabled !== 'boolean') throw new ModuleContractError(`无效模块配置: ${id}`)
      next.set(id, enabled)
    }
    for (const manifest of this.manifests) {
      if (!(next.get(manifest.id) ?? manifest.defaultEnabled)) continue
      for (const required of manifest.requires) {
        const dependency = known.get(required)
        if (!dependency || !(next.get(required) ?? dependency.defaultEnabled)) throw new ModuleContractError(`${manifest.id} 需要启用 ${required}`)
      }
    }
    this.db.exec('SAVEPOINT configure_modules')
    try {
      for (const [id, enabled] of Object.entries(patch.enabled)) sqlRun(this.db, 'INSERT INTO module_config(module_id, enabled) VALUES (?, ?) ON CONFLICT(module_id) DO UPDATE SET enabled=excluded.enabled', [id, enabled ? 1 : 0])
      this.db.exec('RELEASE configure_modules')
      this.configured = next
    } catch (error) {
      this.db.exec('ROLLBACK TO configure_modules'); this.db.exec('RELEASE configure_modules'); throw error
    }
    return this.snapshot()
  }

  start(): Promise<void> {
    return this.starting ??= this.startModules()
  }

  private async startModules() {
    for (const manifest of this.manifests) {
      if (this.controller.signal.aborted) { this.reasons.set(manifest.id, '模块启动已取消'); continue }
      if (!this.bootEnabled.get(manifest.id)) { this.reasons.set(manifest.id, '已停用'); continue }
      const missing = manifest.requires.filter(id => !this.isActive(id))
      if (missing.length) { this.reasons.set(manifest.id, `依赖未启动: ${missing.join(', ')}`); continue }
      this.quiescers.set(manifest.id, [])
      this.disposers.set(manifest.id, [])
      this.moduleTasks.set(manifest.id, new Set())
      this.quiesced.delete(manifest.id)
      const controller = new AbortController()
      this.moduleControllers.set(manifest.id, controller)
      const abortModule = () => controller.abort(this.controller.signal.reason)
      if (this.controller.signal.aborted) controller.abort(this.controller.signal.reason)
      else this.controller.signal.addEventListener('abort', abortModule, { once: true })
      this.disposers.get(manifest.id)!.push(() => this.controller.signal.removeEventListener('abort', abortModule))
      const startup = this.initializeModule(manifest, controller)
      let observed!: Promise<void>
      observed = startup.then(() => {}, () => {}).finally(() => this.pendingStartups.delete(observed))
      this.pendingStartups.add(observed)
      try {
        const module = await this.awaitStartup(startup, controller)
        this.started.set(manifest.id, module)
      } catch (error) {
        const cancelled = this.controller.signal.aborted
        this.reasons.set(manifest.id, error instanceof ModuleContractError ? error.message : cancelled ? '模块启动已取消' : '模块启动失败，请检查本地日志')
        console.error(`Module ${manifest.id} startup failed`, error instanceof ModuleContractError ? error.message : error instanceof Error ? error.name : 'Error')
        this.withdrawModule(manifest.id)
        await this.quiesceModule(manifest.id)
        if (this.moduleTasks.get(manifest.id)?.size) this.deferModuleDisposal(manifest.id)
        else await this.disposeModule(manifest.id)
      }
    }
  }

  routes(): ActiveModuleRoute[] {
    return this.manifests.flatMap(manifest => {
      const module = this.started.get(manifest.id)
      if (!module) return []
      const declarations = manifest.routes ?? []
      return (module.routes ?? []).map(route => ({
        ...route,
        accepts: (method: string, path: string) => declarations.some(declared => routeMatches(declared.method, declared.path, method, path)),
      }))
    })
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }
  get aborted(): boolean { return this.controller.signal.aborted }
  get signal(): AbortSignal { return this.controller.signal }
  get hasPendingStartup(): boolean { return this.pendingStartups.size > 0 }

  async whenSettled(): Promise<void> {
    while (this.pendingStartups.size || this.lifecycleWork.size || this.tasks.size) {
      await Promise.allSettled([...this.pendingStartups, ...this.lifecycleWork, ...this.tasks])
    }
  }

  async afterRestore() {
    this.reloadConfiguration()
    for (const module of this.started.values()) await module.afterRestore?.()
  }

  private async quiesceModule(id: string) {
    this.moduleControllers.get(id)?.abort()
    if (this.quiesced.has(id)) return
    this.quiesced.add(id)
    const callbacks = (this.quiescers.get(id) ?? []).reverse()
    this.quiescers.delete(id)
    for (const quiesce of callbacks) await this.runLifecycle(id, 'quiesce', quiesce)
  }

  private withdrawModule(id: string) {
    for (const [name, value] of this.capabilities) if (value.owner === id) this.capabilities.delete(name)
    for (const [slot, values] of this.contributionSlots) this.contributionSlots.set(slot, values.filter(value => value.owner !== id))
    this.started.delete(id)
  }

  private async drainModuleTasks(id: string) {
    while (this.moduleTasks.get(id)?.size) await Promise.allSettled([...this.moduleTasks.get(id)!])
  }

  private deferModuleDisposal(id: string) {
    let operation!: Promise<void>
    operation = (async () => {
      await this.drainModuleTasks(id)
      await this.disposeModule(id)
    })().finally(() => this.lifecycleWork.delete(operation))
    this.lifecycleWork.add(operation)
  }

  private async disposeModule(id: string) {
    await this.quiesceModule(id)
    const callbacks = (this.disposers.get(id) ?? []).reverse()
    this.disposers.delete(id)
    for (const dispose of callbacks) await this.runLifecycle(id, 'cleanup', dispose)
    this.moduleControllers.delete(id)
    this.moduleTasks.delete(id)
    this.withdrawModule(id)
  }

  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      this.abort()
      await this.starting
      const ids = [...this.started.keys()].reverse()
      for (const id of ids) await this.quiesceModule(id)
      while (this.tasks.size) await Promise.allSettled([...this.tasks])
      for (const id of ids) await this.disposeModule(id)
      while (this.lifecycleWork.size) await Promise.allSettled([...this.lifecycleWork])
      this.unlinkHostSignal?.()
      this.unlinkHostSignal = undefined
    })()
  }
}