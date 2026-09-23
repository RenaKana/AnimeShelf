import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createDb } from '../../../server/db/schema'
import { createApplication } from '../../../server/application'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'
import { loadClientModules } from '../../../src/modules/registry'
import manifest from '../manifest.json'
import createDownload from '../server'
import { DownloadService } from '../server/service'
import { createDownloadRouter } from '../server/routes'
import express from 'express'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('download module lifecycle and HTTP contract', () => {
  it('defaults on with four built-in sources and removes API and client contribution on next boot when disabled', async () => {
    const db = createDb(':memory:')
    cleanup.push(async () => db.close())
    const options = { database: db, manifests: [manifest], loaders: { download: async () => ({ default: createDownload }) }, backgroundTasks: false, distDir: 'nonexistent-download-test-build' }
    let host = await createApplication(options)
    let server: Server = await new Promise(resolve => { const server = host.app.listen(0, '127.0.0.1', () => resolve(server)) })
    const stop = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await host.stop() }
    cleanup.push(stop)
    expect(host.modules.snapshot().modules[0].active).toBe(true)
    const owner = { 'X-AnimeShelf-Owner': '1' }
    const response = await requestLocalHttp(server, '/api/download/sources', { headers: owner })
    expect(response.status).toBe(200)
    expect((await response.json()).sources).toEqual([
      { id: 'bangumi', name: 'Bangumi.moe', url: 'https://bangumi.moe/' },
      { id: 'acgrip', name: 'ACG.RIP', url: 'https://acg.rip/' },
      { id: 'dmhy', name: '动漫花园', url: 'https://share.dmhy.org/' },
      { id: 'nyaa', name: 'Nyaa', url: 'https://nyaa.si/', note: '遵守原站限流，按实际响应显示状态' },
    ])
    expect((await requestLocalHttp(server, '/api/download/resources?source=unknown', { headers: owner })).status).toBe(400)
    const loader = vi.fn(async () => ({ default: { routes: [{ path: '/download', element: null }], navItems: [{ to: '/download', label: '下载', icon: null }] } }))
    expect((await loadClientModules(host.modules.snapshot(), { download: loader })).modules).toHaveLength(1)
    const saved = await requestLocalHttp(server, '/api/modules', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }, body: '{"enabled":{"download":false}}' })
    expect(await saved.json()).toMatchObject({ restartRequired: true })
    expect((await requestLocalHttp(server, '/api/download/sources', { headers: owner })).status).toBe(200)
    await stop()
    host = await createApplication(options)
    server = await new Promise(resolve => { const server = host.app.listen(0, '127.0.0.1', () => resolve(server)) })
    expect((await requestLocalHttp(server, '/api/download/sources', { headers: owner })).status).toBe(404)
    expect((await requestLocalHttp(server, '/api/download/resources?source=bangumi', { headers: owner })).status).toBe(404)
    expect((await loadClientModules(host.modules.snapshot(), { download: loader })).modules).toEqual([])
    expect(loader).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid source, duplicate inputs and mismatched cursors before transport', async () => {
    const transport = vi.fn()
    const service = new DownloadService({ transport })
    const app = express().use('/api/download', createDownloadRouter(service))
    const server: Server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
    cleanup.push(async () => { service.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const owner = { 'X-AnimeShelf-Owner': '1' }
    for (const query of ['source=evil', 'source=bangumi&source=nyaa', 'source=bangumi&cursor=bad', 'source=bangumi&keyword%5Bx%5D=x']) expect((await requestLocalHttp(server, `/api/download/resources?${query}`, { headers: owner })).status).toBe(400)
    expect(transport).not.toHaveBeenCalled()
  })
})
