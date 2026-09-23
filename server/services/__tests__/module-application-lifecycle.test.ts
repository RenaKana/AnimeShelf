import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { Router } from 'express'
import { createDb } from '../../db/schema'
import { createApplication } from '../../application'
import { requestLocalHttp } from './http-test-client'
import type { ModuleManifest } from '../../../shared/modules'

const manifest = (routes: ModuleManifest['routes'] = []): ModuleManifest => ({
  id: 'feature', name: 'feature', version: '1', defaultEnabled: true, requires: [], optional: [], routes,
})
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

describe('module application lifecycle', () => {
  it('rejects an already-cancelled startup with AbortError', async () => {
    const db = createDb(':memory:')
    cleanup.push(() => db.close())
    const controller = new AbortController()
    controller.abort()
    await expect(createApplication({ database: db, manifests: [], loaders: {}, backgroundTasks: false, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels in-progress module startup and does not return a listenable application', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createDb(':memory:')
    cleanup.push(() => db.close())
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const startup = createApplication({
      database: db,
      manifests: [manifest()],
      loaders: { feature: async () => ({ default: context => ({ start: () => new Promise<void>(resolve => {
        entered()
        context.signal.addEventListener('abort', () => resolve(), { once: true })
      }) }) }) },
      backgroundTasks: false,
      signal: controller.signal,
    })
    await started
    controller.abort()
    await expect(startup).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('skips mounted module middleware for undeclared paths', async () => {
    const db = createDb(':memory:')
    const router = Router()
    let intercepted = 0
    router.get('/declared', (_req, res) => res.json({ ok: true }))
    router.use((_req, res) => { intercepted++; res.status(418).end() })
    const application = await createApplication({
      database: db,
      manifests: [manifest([{ method: 'GET', path: '/api/guard/declared' }])],
      loaders: { feature: async () => ({ default: () => ({ routes: [{ path: '/api/guard', router }] }) }) },
      backgroundTasks: false,
      distDir: 'nonexistent-test-build',
    })
    const server: Server = await new Promise(resolve => { const listener = application.app.listen(0, '127.0.0.1', () => resolve(listener)) })
    cleanup.push(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await application.stop()
      db.close()
    })
    expect((await requestLocalHttp(server, '/api/guard/declared')).status).toBe(200)
    expect((await requestLocalHttp(server, '/api/guard/undeclared')).status).toBe(404)
    expect(intercepted).toBe(0)
  })

  it('returns from stop while retaining a database for a timed-out factory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createDb(':memory:')
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const application = await createApplication({
      database: db,
      manifests: [manifest()],
      loaders: { feature: async () => ({ default: async () => { await pending; return {} } }) },
      backgroundTasks: false,
      moduleStartupTimeoutMs: 20,
    })
    const outcome = await Promise.race([
      application.stop().then(() => 'stopped'),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ])
    expect(outcome).toBe('stopped')
    expect(() => db.exec('SELECT 1')).not.toThrow()
    release()
    await application.modules.whenSettled()
    await Promise.resolve()
    db.close()
  })

  it('keeps a cancelled startup pending until its uncooperative factory settles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createDb(':memory:')
    const controller = new AbortController()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    let finished = false
    const startup = createApplication({
      database: db, manifests: [manifest()],
      loaders: { feature: async () => ({ default: async () => { entered(); await pending; return {} } }) },
      backgroundTasks: false, signal: controller.signal,
    }).catch(error => { finished = true; return error })
    await started
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(finished).toBe(false)
    expect(() => db.exec('SELECT 1')).not.toThrow()
    release()
    expect(await startup).toMatchObject({ name: 'AbortError' })
    db.close()
  })

  it('waits for timed-out factories before disposal releases the process application slot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const firstDb = createDb(':memory:')
    const secondDb = createDb(':memory:')
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const application = await createApplication({
      database: firstDb,
      manifests: [manifest()],
      loaders: { feature: async () => ({ default: async () => { await pending; return {} } }) },
      backgroundTasks: false,
      moduleStartupTimeoutMs: 20,
    })
    await application.stop()
    await expect(createApplication({ database: secondDb, manifests: [], loaders: {}, backgroundTasks: false })).rejects.toThrow('Only one AnimeShelf application may run in a process')
    let disposed = false
    const disposal = application.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    release()
    await disposal
    const replacement = await createApplication({ database: secondDb, manifests: [], loaders: {}, backgroundTasks: false })
    await replacement.stop()
    firstDb.close()
    secondDb.close()
  })
})
