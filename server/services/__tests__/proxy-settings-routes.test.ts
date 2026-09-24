import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestLocalHttp } from './http-test-client'

const routeMocks = vi.hoisted(() => ({
  db: {},
  settingsDb: {
    getAll: vi.fn(() => ({ proxy_url: 'http://127.0.0.1:7897' })),
    get: vi.fn(),
    set: vi.fn(),
  },
  getProxyStatus: vi.fn(() => ({ mode: 'system', source: 'system', message: '使用 Windows 系统代理' })),
  validateProxySettings: vi.fn(),
  invalidateProxySettings: vi.fn(),
}))

vi.mock('../../db/instance', () => ({ db: routeMocks.db, settingsDb: routeMocks.settingsDb }))
vi.mock('../../db/schema', () => ({ DATA_DIR: 'C:/temp/animeshelf-proxy-route-test' }))
vi.mock('../../db/maintenance', () => ({ databaseIntegrity: vi.fn(() => ['ok']) }))
vi.mock('../../services/backup', () => ({
  manualBackup: vi.fn(),
  listBackups: vi.fn(() => []),
  applyRestorePreview: vi.fn(),
}))
vi.mock('../../services/restore-preview', () => ({
  inspectRestore: vi.fn(),
  resolveRestorePreview: vi.fn(),
  RestorePreviewError: class RestorePreviewError extends Error {},
}))
vi.mock('../../services/library-maintenance', () => ({ withLibraryMaintenance: vi.fn() }))
vi.mock('../../core/owner-request', () => ({ isOwnerRequest: vi.fn(() => true) }))
vi.mock('../../core/extensions', () => ({ afterDataRestore: vi.fn(), invalidateLibraryMatches: vi.fn() }))
vi.mock('../../services/library-scan-coordinator', () => ({ refreshLibraryScanning: vi.fn() }))
vi.mock('../../services/proxy', () => ({
  getProxyStatus: routeMocks.getProxyStatus,
  validateProxySettings: routeMocks.validateProxySettings,
  invalidateProxySettings: routeMocks.invalidateProxySettings,
}))

describe('proxy settings routes', () => {
  let server: any

  beforeAll(async () => {
    const { default: settingsRouter } = await import('../../routes/settings')
    const app = express()
    app.use(express.json())
    app.use('/api/settings', settingsRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  beforeEach(() => {
    routeMocks.settingsDb.getAll.mockReturnValue({ proxy_url: 'http://127.0.0.1:7897' })
    routeMocks.settingsDb.set.mockClear()
    routeMocks.validateProxySettings.mockReset()
    routeMocks.validateProxySettings.mockImplementation(() => undefined)
    routeMocks.getProxyStatus.mockClear()
    routeMocks.invalidateProxySettings.mockClear()
  })

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(resolve))
  })

  it('serves a fresh, uncached proxy status', async () => {
    const response = await requestLocalHttp(server, '/api/settings/proxy-status')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(await response.json()).toMatchObject({ mode: 'system', source: 'system' })
    expect(routeMocks.invalidateProxySettings.mock.invocationCallOrder[0]).toBeLessThan(routeMocks.getProxyStatus.mock.invocationCallOrder[0])
  })

  it('omits legacy proxy credentials from the general settings response', async () => {
    routeMocks.settingsDb.getAll.mockReturnValue({ proxy_url: 'http://old-user:old-secret@127.0.0.1:7897' })
    const response = await requestLocalHttp(server, '/api/settings')
    const settings = await response.json<Record<string, string>>()

    expect(response.status).toBe(200)
    expect(settings.proxy_url).toBeUndefined()
    expect(settings.proxy_url_configured).toBe('1')
    expect(settings.proxy_mode).toBe('manual')
    expect(await response.text()).not.toContain('old-secret')
  })

  it('validates combined saved and submitted proxy fields before writing secrets', async () => {
    const error = Object.assign(new Error('Proxy credentials are not supported'), { code: 'PROXY_AUTH_UNSUPPORTED' })
    routeMocks.validateProxySettings.mockImplementation((settings: Record<string, unknown>) => {
      expect(settings.proxy_mode).toBe('manual')
      expect(settings.proxy_url).toBe('http://old-user:old-secret@127.0.0.1:7897')
      throw error
    })
    const response = await requestLocalHttp(server, '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxy_mode: 'manual', proxy_url: 'http://old-user:old-secret@127.0.0.1:7897', tmdb_key: 'must-not-be-written' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'PROXY_AUTH_UNSUPPORTED' })
    expect(routeMocks.settingsDb.set).not.toHaveBeenCalled()
  })

  it('rejects non-string network values before calling validation or writing', async () => {
    const response = await requestLocalHttp(server, '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxy_mode: true, tmdb_key: 'must-not-be-written' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'PROXY_CONFIG_INVALID' })
    expect(routeMocks.validateProxySettings).not.toHaveBeenCalled()
    expect(routeMocks.settingsDb.set).not.toHaveBeenCalled()
  })

  it('saves only network fields and invalidates after validation', async () => {
    const response = await requestLocalHttp(server, '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxy_mode: 'manual', proxy_url: 'https://proxy.example:8443' }),
    })
    expect(response.status).toBe(200)
    expect(routeMocks.validateProxySettings).toHaveBeenCalledWith({
      proxy_url: 'https://proxy.example:8443',
      proxy_mode: 'manual',
    })
    expect(routeMocks.settingsDb.set).toHaveBeenNthCalledWith(1, 'proxy_mode', 'manual')
    expect(routeMocks.settingsDb.set).toHaveBeenNthCalledWith(2, 'proxy_url', 'https://proxy.example:8443')
    expect(routeMocks.invalidateProxySettings).toHaveBeenCalledOnce()
  })
})
