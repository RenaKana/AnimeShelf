import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import express from 'express'
import { createServiceRouter } from '../../routes/service'
import { createApplication } from '../../application'
import { createDb } from '../../db/schema'
import { requestLocalHttp } from './http-test-client'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function start(restart?: () => Promise<void>) {
  const db = createDb(':memory:')
  const application = await createApplication({ database: db, manifests: [], loaders: {}, backgroundTasks: false, restart })
  const server: Server = await new Promise(resolve => { const listener = application.app.listen(0, '127.0.0.1', () => resolve(listener)) })
  cleanup.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await application.stop()
    db.close()
  })
  return server
}

describe('core service restart endpoint', () => {
  it('still restarts exactly once when the client disconnects before the acknowledgement finishes', async () => {
    const restart = vi.fn(() => new Promise<void>(() => {}))
    const app = express()
    let disconnect = true
    app.use((_req, res, next) => {
      if (disconnect) {
        disconnect = false
        res.json = () => { res.destroy(); return res }
      }
      next()
    })
    app.use('/api/service', createServiceRouter('disconnected', restart))
    const server: Server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const options = { method: 'POST', headers: { 'X-AnimeShelf-Owner': '1' } }
    await expect(requestLocalHttp(server, '/api/service/restart', options)).rejects.toThrow()
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce(), { timeout: 300 })
    expect((await requestLocalHttp(server, '/api/service/restart', options)).status).toBe(202)
    expect(restart).toHaveBeenCalledOnce()
  })

  it('returns an uncached instance identity and acknowledges exactly one restart after the response finishes', async () => {
    const restart = vi.fn(() => new Promise<void>(() => {}))
    const server = await start(restart)
    const health = await requestLocalHttp(server, '/api/health')
    const identity = await health.json()
    expect(identity).toMatchObject({ ok: true, instanceId: expect.any(String), restartSupported: true })
    expect(health.headers['cache-control']).toBe('no-store')
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await requestLocalHttp(server, '/api/service/restart', { method: 'POST', headers: { 'X-AnimeShelf-Owner': '1' } })
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ instanceId: identity.instanceId })
    }
    expect(restart).toHaveBeenCalledOnce()
  })

  it('rejects requests outside the local owner boundary without invoking restart', async () => {
    const restart = vi.fn(async () => {})
    const server = await start(restart)
    const invalid: Record<string, string>[] = [
      {}, { 'X-AnimeShelf-Owner': '0' },
      { 'X-AnimeShelf-Owner': '1', Authorization: 'Bearer external-token' },
      { 'X-AnimeShelf-Owner': '1', Origin: 'https://example.org' },
      { 'X-AnimeShelf-Owner': '1', Host: 'example.org' },
    ]
    for (const headers of invalid) expect((await requestLocalHttp(server, '/api/service/restart', { method: 'POST', headers })).status).toBe(403)
    expect((await requestLocalHttp(server, '/api/service/restart')).status).toBe(404)
    expect(restart).not.toHaveBeenCalled()
  })

  it('explicitly rejects a restart when the application has no managing host', async () => {
    const server = await start()
    expect(await (await requestLocalHttp(server, '/api/health')).json()).toMatchObject({ restartSupported: false })
    const response = await requestLocalHttp(server, '/api/service/restart', { method: 'POST', headers: { 'X-AnimeShelf-Owner': '1' } })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'RESTART_UNAVAILABLE' })
  })
})
