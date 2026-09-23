import express from 'express'
import http, { type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeExternalApiStore } from '../server/external-api-tokens'
import { createExternalApiApp, createExternalApiService } from '../server/external-api-server'
import { createExternalAccessRouter } from '../server/access'
import { createExternalDataRouter } from '../server/data'
import { seasonExternalApiRoutes } from '../../season/server/external-api'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'

vi.mock('../../../server/db/instance', () => { throw new Error('External API tests must not import the real application database') })

const dbs: ReturnType<typeof createDb>[] = []
const servers: Server[] = []
const managers: ReturnType<typeof createExternalApiService>[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const db of dbs.splice(0)) db.close()
})
function database() { const db = createDb(':memory:'); dbs.push(db); return db }
async function listen(app: ReturnType<typeof express>) {
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  return server
}
function dataRouter() {
  const router = express.Router()
  router.get('/me', (_req, res) => res.json(res.locals.externalApiToken))
  router.get('/folders', (_req, res) => res.json({ role: res.locals.externalApiToken.role }))
  return router
}
const ownerHeaders = { 'content-type': 'application/json', 'X-AnimeShelf-Owner': '1' }

describe('external API trust boundaries', () => {
  it('requires bearer credentials, rejects query tokens and expires/revokes immediately', async () => {
    const store = makeExternalApiStore(database())
    store.setConfig({ enabled: true, port: 3003 })
    const issued = store.createToken({ name: 'reader' })
    const server = await listen(createExternalApiApp(store, dataRouter()))
    expect((await requestLocalHttp(server, '/api/v1/folders')).status).toBe(401)
    expect((await requestLocalHttp(server, `/api/v1/folders?token=${issued.token}`)).status).toBe(401)
    const headers = { Authorization: `Bearer ${issued.token}` }
    const success = await requestLocalHttp(server, '/api/v1/folders', { headers })
    expect(success.status).toBe(200)
    expect(success.headers['cache-control']).toBe('no-store')
    expect(await success.json()).toEqual({ role: 'read' })
    store.updateToken(issued.token_info.id, { role: 'edit' })
    expect(await (await requestLocalHttp(server, '/api/v1/folders', { headers })).json()).toEqual({ role: 'edit' })
    store.revokeToken(issued.token_info.id)
    expect((await requestLocalHttp(server, '/api/v1/folders', { headers })).status).toBe(401)
  })
  it('never exposes owner/legacy/static routes on the external app', async () => {
    const store = makeExternalApiStore(database())
    store.setConfig({ enabled: true, port: 3003 })
    const issued = store.createToken({ name: 'manager', role: 'files' })
    const server = await listen(createExternalApiApp(store, dataRouter()))
    for (const path of ['/api/settings', '/api/external-access/tokens', '/api/folders', '/posters/file.jpg', '/api/v1/settings', '/api/v1/../settings']) {
      expect((await requestLocalHttp(server, path, { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(404)
    }
    expect((await requestLocalHttp(server, '/api/v1/folders', { headers: { Authorization: `Bearer ${issued.token}`, Origin: 'https://hostile.example' } })).status).toBe(403)
    store.setConfig({ enabled: false, port: 3003 })
    expect((await requestLocalHttp(server, '/api/v1/folders', { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(503)
  })
  it('rate limits repeated failed authentication without leaking credentials', async () => {
    const store = makeExternalApiStore(database())
    store.setConfig({ enabled: true, port: 3003 })
    const server = await listen(createExternalApiApp(store, dataRouter(), { failedAuthLimit: 2 }))
    await requestLocalHttp(server, '/api/v1/me')
    await requestLocalHttp(server, '/api/v1/me')
    const limited = await requestLocalHttp(server, '/api/v1/me')
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    const issued = store.createToken({ name: 'valid caller' })
    expect((await requestLocalHttp(server, '/api/v1/me', { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(200)
  })
  it('uses the real router for role checks, strict queries, payload limits and sanitized audit', async () => {
    const db = database()
    const store = makeExternalApiStore(db)
    store.setConfig({ enabled: true, port: 3003 })
    const issued = store.createToken({ name: 'integration' })
    const app = createExternalApiApp(store, createExternalDataRouter(db, { contributions: [seasonExternalApiRoutes] }))
    expect(app.get('query parser')).toBe('simple')
    const server = await listen(app)
    const headers = { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' }
    const create = () => requestLocalHttp(server, '/api/v1/favorites', { method: 'POST', headers, body: JSON.stringify({ item_id: 'external-test', title: 'Private title' }) })
    expect((await create()).status).toBe(403)
    store.updateToken(issued.token_info.id, { role: 'edit' })
    expect((await create()).status).toBe(201)
    expect((await requestLocalHttp(server, '/api/v1/folders/1/rename', { method: 'PUT', headers, body: '{}' })).status).toBe(403)
    expect((await requestLocalHttp(server, '/api/v1/me?token=ignored', { headers })).status).toBe(400)
    expect((await requestLocalHttp(server, '/api/v1/favorites?q[isBuffer]=x', { headers })).status).toBe(400)
    expect((await requestLocalHttp(server, '/api/v1/favorites', { method: 'POST', headers, body: '{' })).status).toBe(400)
    expect((await requestLocalHttp(server, '/api/v1/favorites', { method: 'POST', headers, body: JSON.stringify({ title: 'x'.repeat(129 * 1024) }) })).status).toBe(413)
    const audits = db.prepare('SELECT * FROM external_api_audit').all()
    expect(audits.length).toBeGreaterThanOrEqual(4)
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'POST', route: '/favorites', status: 201 })]))
    expect(JSON.stringify(audits)).not.toContain(issued.token)
    expect(JSON.stringify(audits)).not.toContain('Private title')
    store.updateToken(issued.token_info.id, { role: 'disabled' })
    expect((await requestLocalHttp(server, '/api/v1/me', { headers })).status).toBe(401)
  })
  it('audits mutations even if the caller aborts before the response finishes', async () => {
    const db = database()
    const store = makeExternalApiStore(db)
    store.setConfig({ enabled: true, port: 3003 })
    const issued = store.createToken({ name: 'abort', role: 'edit' })
    let didMutate!: () => void
    const mutated = new Promise<void>(resolve => { didMutate = resolve })
    const router = express.Router()
    router.post('/mutate/:id', (_req, _res) => {
      db.prepare('INSERT INTO tags (name, color, kind) VALUES (?, ?, ?)').run(['aborted mutation', '#000000', 'custom'])
      didMutate()
      // Intentionally leave the response open so the client can abort after the write.
    })
    const server = await listen(createExternalApiApp(store, router))
    const request = http.request({ hostname: '127.0.0.1', port: (server.address() as any).port, path: '/api/v1/mutate/private-id', method: 'POST', headers: { Authorization: `Bearer ${issued.token}` } })
    request.on('error', () => {})
    request.end()
    await mutated
    request.destroy()
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) AS n FROM external_api_audit').get()).toEqual({ n: 1 }))
    expect(db.prepare('SELECT route, status FROM external_api_audit').get()).toEqual({ route: '/mutate/:id', status: 499 })
    expect(db.prepare('SELECT name FROM tags WHERE name = ?').get('aborted mutation')).toBeDefined()
  })
  it('disables a listener within its drain limit even when a response never ends', async () => {
    const reserve = await listen(express())
    const port = (reserve.address() as any).port
    await new Promise<void>(resolve => reserve.close(() => resolve()))
    let received!: () => void
    const started = new Promise<void>(resolve => { received = resolve })
    const manager = createExternalApiService(database(), () => {
      const router = express.Router()
      router.get('/hang', (_req, _res) => { received() })
      return router
    }, { drainTimeoutMs: 40 })
    managers.push(manager)
    await manager.configure({ enabled: true, port })
    const issued = manager.store.createToken({ name: 'hang test' })
    const request = http.get(`http://127.0.0.1:${port}/api/v1/hang`, { headers: { Authorization: `Bearer ${issued.token}` } })
    request.on('error', () => {})
    await started
    const before = Date.now()
    try {
      expect((await manager.configure({ enabled: false, port })).status).toBe('stopped')
      expect(Date.now() - before).toBeLessThan(1500)
    } finally { request.destroy() }
  })
  it('rechecks permission after receiving a delayed request body', async () => {
    const db = database()
    const store = makeExternalApiStore(db)
    store.setConfig({ enabled: true, port: 3003 })
    const issued = store.createToken({ name: 'delayed body', role: 'edit' })
    const authenticate = vi.spyOn(store, 'authenticate')
    const server = await listen(createExternalApiApp(store, createExternalDataRouter(db, { contributions: [seasonExternalApiRoutes] })))
    const body = JSON.stringify({ item_id: 'late', title: 'Must not write' })
    let request!: http.ClientRequest
    const status = new Promise<number>((resolve, reject) => {
      request = http.request({ hostname: '127.0.0.1', port: (server.address() as any).port, path: '/api/v1/favorites', method: 'POST', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!))
      })
      request.on('error', reject)
      request.write(body.slice(0, 5))
    })
    try {
      await vi.waitFor(() => expect(authenticate).toHaveBeenCalled())
      store.updateToken(issued.token_info.id, { role: 'read' })
      request.end(body.slice(5))
      expect(await status).toBe(403)
      expect(db.prepare("SELECT item_id FROM season_favorites WHERE item_id = 'late'").get()).toBeNull()
    } finally { request.destroy(); authenticate.mockRestore() }
  })
  it('waits for tracked database work after closing sockets and refuses restart during shutdown', async () => {
    const db = database()
    const reserve = await listen(express())
    const port = (reserve.address() as any).port
    await new Promise<void>(resolve => reserve.close(() => resolve()))
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const manager = createExternalApiService(db, () => {
      const router = express.Router()
      router.post('/work', (_req, res) => {
        res.locals.externalApiTrackOperation(gate.then(() => { db.exec("INSERT INTO tags (name, color) VALUES ('finished work', '#ffffff')") }))
        entered()
      })
      return router
    }, { drainTimeoutMs: 20 })
    managers.push(manager)
    await manager.configure({ enabled: true, port })
    const issued = manager.store.createToken({ name: 'tracked work', role: 'edit' })
    const request = http.request(`http://127.0.0.1:${port}/api/v1/work`, { method: 'POST', headers: { Authorization: `Bearer ${issued.token}` } })
    request.on('error', () => {})
    request.end()
    await started
    let stopped = false
    const completion = manager.stop().then(() => { stopped = true })
    try {
      await vi.waitFor(() => expect(request.destroyed).toBe(true))
      expect(stopped).toBe(false)
      expect(() => manager.configure({ enabled: true, port })).toThrow()
    } finally { release(); await completion; request.destroy() }
    expect(db.prepare("SELECT name FROM tags WHERE name = 'finished work'").get()).toBeDefined()
  })
  it('protects token administration by peer, Host, Origin and explicit owner header', async () => {
    const manager = createExternalApiService(database(), dataRouter)
    managers.push(manager)
    const app = express()
    app.use(express.json())
    app.use('/api/external-access', createExternalAccessRouter(manager))
    const server = await listen(app)
    const body = JSON.stringify({ name: 'caller', role: 'read' })
    expect((await requestLocalHttp(server, '/api/external-access/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(403)
    const rejectedHeaders: Record<string, string>[] = [{ Origin: 'https://hostile.example' }, { Host: 'hostile.example' }, { Authorization: 'Bearer external-token' }, { Authorization: '' }]
    for (const extra of rejectedHeaders) {
      expect((await requestLocalHttp(server, '/api/external-access/tokens', { method: 'POST', headers: { ...ownerHeaders, ...extra }, body })).status).toBe(403)
    }
    const created = await requestLocalHttp(server, '/api/external-access/tokens', { method: 'POST', headers: ownerHeaders, body })
    expect(created.status).toBe(201)
    const token = (await created.json()).token
    const listed = await requestLocalHttp(server, '/api/external-access')
    expect(listed.status).toBe(200)
    expect(await listed.text()).not.toContain(token)
    expect(await listed.text()).not.toContain('token_hash')
  })
  it('starts and stops only the dedicated loopback listener and reports port conflicts', async () => {
    const blocker = await listen(express())
    const port = (blocker.address() as any).port
    const manager = createExternalApiService(database(), dataRouter)
    managers.push(manager)
    const failed = await manager.configure({ enabled: true, port })
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('端口')
    await new Promise<void>(resolve => blocker.close(() => resolve()))
    const started = await manager.configure({ enabled: true, port })
    expect(started.status).toBe('running')
    expect(started.base_url).toBe(`http://127.0.0.1:${port}/api/v1`)
    const issued = manager.store.createToken({ name: 'check' })
    const http = await import('node:http')
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`${started.base_url}/me`, { headers: { Authorization: `Bearer ${issued.token}` } }, res => {
        let text = ''; res.on('data', value => { text += value }); res.on('end', () => resolve(text))
      }).on('error', reject)
    })
    expect(JSON.parse(body).role).toBe('read')
    expect((await manager.configure({ enabled: false, port })).status).toBe('stopped')
  })
})
