import { afterEach, describe, expect, it, vi } from 'vitest'
import { Database } from 'node-sqlite3-wasm'
import { Router } from 'express'
import { ModuleRuntime } from '../../core/module-runtime'
import type { ModuleManifest } from '../../../shared/modules'

const manifest = (id: string, requires: string[] = []): ModuleManifest => ({ id, name: id, version: '1', defaultEnabled: true, requires, optional: [] })
const databases: Database[] = []
const database = () => { const db = new Database(':memory:'); databases.push(db); return db }
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('startup module runtime', () => {
  it('aborts and drains background work before removing its dependencies', async () => {
    const db = database(), cleanup = vi.fn()
    let finish!: () => void, stopped = false, signal!: AbortSignal
    const runtime = new ModuleRuntime(db, [manifest('feature')], {
      feature: async () => ({ default: context => {
        signal = context.signal
        context.provide('retained-until-drained', 1)
        context.contribute('test-contributions', 'registered')
        context.onDispose(cleanup)
        context.track(new Promise<void>(resolve => { finish = resolve }))
        return {}
      } }),
    })
    await runtime.start()
    const shutdown = runtime.stop().then(() => { stopped = true })
    await Promise.resolve(); await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(stopped).toBe(false)
    expect(runtime.capability('retained-until-drained')).toBe(1)
    expect(cleanup).not.toHaveBeenCalled()
    finish(); await shutdown
    expect(cleanup).toHaveBeenCalledOnce()
    expect(runtime.capability('retained-until-drained')).toBeUndefined()
    expect(runtime.contributions('test-contributions')).toEqual([])
  })
  it('quiesces producers before draining work and disposes resources afterward', async () => {
    const events: string[] = []
    let finish!: () => void
    const runtime = new ModuleRuntime(database(), [manifest('feature')], {
      feature: async () => ({ default: context => {
        context.onQuiesce(() => { events.push('quiesce') })
        context.onDispose(() => { events.push('dispose') })
        context.track(new Promise<void>(resolve => { finish = () => { events.push('task'); resolve() } }))
        return {}
      } }),
    })
    await runtime.start()
    const shutdown = runtime.stop()
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(['quiesce'])
    finish(); await shutdown
    expect(events).toEqual(['quiesce', 'task', 'dispose'])
  })
  it('retains failed module resources until its tracked work drains', async () => {
    const cleanup = vi.fn()
    let finish!: () => void
    const runtime = new ModuleRuntime(database(), [manifest('feature')], {
      feature: async () => ({ default: context => {
        context.provide('failed-capability', 1)
        context.onDispose(cleanup)
        context.track(new Promise<void>(resolve => { finish = resolve }))
        throw new Error('startup failed')
      } }),
    })
    await runtime.start()
    expect(runtime.capability('failed-capability')).toBeUndefined()
    expect(cleanup).not.toHaveBeenCalled()
    finish()
    await runtime.whenSettled()
    expect(cleanup).toHaveBeenCalledOnce()
  })
  it('aborts an in-progress module start before waiting for startup', async () => {
    let entered!: () => void
    const starting = new Promise<void>(resolve => { entered = resolve })
    const runtime = new ModuleRuntime(database(), [manifest('feature')], {
      feature: async () => ({ default: context => ({ start: () => new Promise<void>(resolve => {
        entered()
        if (context.signal.aborted) resolve()
        else context.signal.addEventListener('abort', () => resolve(), { once: true })
      }) }) }),
    })
    const boot = runtime.start()
    await starting
    const shutdown = runtime.stop()
    const outcome = await Promise.race([shutdown.then(() => 'stopped'), new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 75))])
    if (outcome === 'timed-out') runtime.abort()
    await Promise.all([boot, shutdown])
    expect(outcome).toBe('stopped')
  })
  it('times out startup and disposes a factory that resolves after isolation', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const earlyCleanup = vi.fn(), lateStop = vi.fn()
    const runtime = new ModuleRuntime(database(), [manifest('feature')], {
      feature: async () => ({ default: async context => {
        context.onDispose(earlyCleanup)
        await pending
        return { stop: lateStop }
      } }),
    }, { startupTimeoutMs: 20 })
    const boot = runtime.start()
    const outcome = await Promise.race([boot.then(() => 'finished'), new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100))])
    release()
    await boot
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime.stop()
    expect(outcome).toBe('finished')
    expect(runtime.snapshot().modules[0]).toMatchObject({ active: false, reason: '模块启动超时' })
    expect(earlyCleanup).toHaveBeenCalledOnce()
    expect(lateStop).toHaveBeenCalledOnce()
  })
  it('scopes middleware to declared routes and accepts nested routers', async () => {
    const child = Router()
    child.get('/', (_req, res) => res.json({ ok: true }))
    const parent = Router()
    parent.use('/child', child)
    parent.use((_req, res) => res.status(404).end())
    const routeManifest: ModuleManifest = { ...manifest('feature'), routes: [{ method: 'GET', path: '/api/parent/child' }] }
    const runtime = new ModuleRuntime(database(), [routeManifest], {
      feature: async () => ({ default: () => ({ routes: [{ path: '/api/parent', router: parent }] }) }),
    })
    await runtime.start()
    expect(runtime.isActive('feature')).toBe(true)
    const route = runtime.routes()[0]
    expect(route.accepts('GET', '/api/parent/child')).toBe(true)
    expect(route.accepts('GET', '/api/parent/undeclared')).toBe(false)
    await runtime.stop()
  })
  it('applies registered migrations once and rolls back a failing migration batch', async () => {
    const db = database(), up = vi.fn((db: Database) => db.exec('CREATE TABLE retained(value TEXT)'))
    const loader = async () => ({ default: () => ({ migrations: [{ id: '001', up }] }) })
    const first = new ModuleRuntime(db, [manifest('feature')], { feature: loader })
    await first.start(); await first.stop()
    const next = new ModuleRuntime(db, [manifest('feature')], { feature: loader })
    await next.start(); await next.stop()
    expect(up).toHaveBeenCalledTimes(1)
    const failing = new ModuleRuntime(db, [manifest('broken')], { broken: async () => ({ default: () => ({ migrations: [
      { id: '001', up: db => { db.exec('CREATE TABLE should_rollback(id INTEGER)') } },
      { id: '002', up: () => { throw new Error('migration rejected') } },
    ] }) }) })
    await failing.start()
    expect(failing.isActive('broken')).toBe(false)
    const statement = db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'")
    try { expect(statement.get()).toBeNull() } finally { statement.finalize() }
  })
  it('reloads restored next-start configuration without changing the current graph', async () => {
    const db = database(), afterRestore = vi.fn()
    const runtime = new ModuleRuntime(db, [manifest('feature')], { feature: async () => ({ default: () => ({ afterRestore }) }) })
    await runtime.start()
    db.exec("INSERT INTO module_config VALUES('feature',0)")
    await runtime.afterRestore()
    expect(runtime.snapshot()).toMatchObject({ restartRequired: true, modules: [{ active: true, configuredEnabled: false }] })
    expect(afterRestore).toHaveBeenCalledOnce()
    await runtime.stop()
  })
  it('saves atomically for next restart without changing active modules', async () => {
    const db = database(), stop = vi.fn()
    const load = vi.fn(async () => ({ default: () => ({ stop }) }))
    const runtime = new ModuleRuntime(db, [manifest('feature')], { feature: load })
    await runtime.start()
    expect(runtime.configure({ enabled: { feature: false } })).toMatchObject({ restartRequired: true, modules: [{ active: true, configuredEnabled: false }] })
    expect(stop).not.toHaveBeenCalled()
    await runtime.stop()
    const next = new ModuleRuntime(db, [manifest('feature')], { feature: load })
    await next.start()
    expect(load).toHaveBeenCalledTimes(1)
    expect(next.snapshot().modules[0].active).toBe(false)
  })
  it('rejects inconsistent dependencies without persisting any part', async () => {
    const runtime = new ModuleRuntime(database(), [manifest('base'), manifest('child', ['base'])], {})
    expect(() => runtime.configure({ enabled: { base: false } })).toThrow(/child.*base/)
    expect(runtime.snapshot().modules.every(m => m.configuredEnabled)).toBe(true)
    expect(runtime.configure({ enabled: { base: false, child: false } }).modules.every(m => !m.configuredEnabled)).toBe(true)
  })
  it('isolates failures, skips dependents and disposes in reverse order', async () => {
    const stops: string[] = [], child = vi.fn(), db = database()
    const runtime = new ModuleRuntime(db, [manifest('first'), manifest('broken'), manifest('child', ['broken']), manifest('last')], {
      first: async () => ({ default: (context: any) => { context.provide('first', 1); return { stop: () => { stops.push('first') } } } }),
      broken: async () => ({ default: (context: any) => { context.provide('broken', 1); throw new Error('broken startup') } }),
      child,
      last: async () => ({ default: () => ({ stop: () => { stops.push('last') } }) }),
    })
    await runtime.start()
    expect(runtime.isActive('first')).toBe(true)
    expect(runtime.isActive('broken')).toBe(false)
    expect(runtime.capability('broken')).toBeUndefined()
    expect(child).not.toHaveBeenCalled()
    await runtime.stop(); await runtime.stop()
    expect(stops).toEqual(['last', 'first'])
  })
  it('preserves configuration for removed source modules', () => {
    const db = database()
    new ModuleRuntime(db, [manifest('feature')], {}).configure({ enabled: { feature: false } })
    new ModuleRuntime(db, [], {})
    expect(new ModuleRuntime(db, [manifest('feature')], {}).snapshot().modules[0].configuredEnabled).toBe(false)
  })
})
