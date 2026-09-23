import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestLocalHttp, type TestHttpRequestInit, type TestHttpResponse } from './http-test-client'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-route-cache-'))
const previousDataDir = process.env.ANIMESHELF_DATA_DIR
process.env.ANIMESHELF_DATA_DIR = tempDataDir

const routeMocks = vi.hoisted(() => ({
  db: {},
  settingsDb: { getAll: vi.fn(), get: vi.fn(), set: vi.fn() },
  libraryDb: {
    delete: vi.fn(),
    getById: vi.fn().mockReturnValue({ id: 1 }),
  },
  invalidateLibHitCache: vi.fn(),
  restoreBackup: vi.fn(),
  restoreFromPath: vi.fn(),
  applyRestorePreview: vi.fn(),
  manualBackup: vi.fn(),
  listBackups: vi.fn(),
}))

vi.mock('../../db/instance', () => ({ db: routeMocks.db, settingsDb: routeMocks.settingsDb }))
vi.mock('../../db/libraries', () => ({ makeLibraryDb: () => routeMocks.libraryDb }))
vi.mock('../scanner', () => ({ scanLibrary: vi.fn() }))
vi.mock('../backup', () => ({
  manualBackup: routeMocks.manualBackup,
  listBackups: routeMocks.listBackups,
  restoreBackup: routeMocks.restoreBackup,
  restoreFromPath: routeMocks.restoreFromPath,
  applyRestorePreview: routeMocks.applyRestorePreview,
}))
vi.mock('../../db/maintenance', () => ({ databaseIntegrity: vi.fn(() => ['ok']) }))

describe('library and settings cache invalidation routes', () => {
  let server: any

  beforeAll(async () => {
    bindTestModuleCapabilities(routeMocks.db as any, {
      activeModules: [],
      catalog: false,
      invalidateLibraryMatches: routeMocks.invalidateLibHitCache,
    })
    const [{ default: librariesRouter }, { default: settingsRouter }] = await Promise.all([
      import('../../routes/libraries'),
      import('../../routes/settings'),
    ])
    const app = express()
    app.use(express.json())
    app.use('/api/libraries', librariesRouter)
    app.use('/api/settings', settingsRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  beforeEach(() => {
    routeMocks.invalidateLibHitCache.mockClear()
    routeMocks.libraryDb.delete.mockClear()
    routeMocks.restoreBackup.mockReset()
    routeMocks.restoreFromPath.mockReset()
    routeMocks.applyRestorePreview.mockReset()
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previousDataDir === undefined) delete process.env.ANIMESHELF_DATA_DIR
    else process.env.ANIMESHELF_DATA_DIR = previousDataDir
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  })

  async function request(url: string, init: TestHttpRequestInit = {}): Promise<TestHttpResponse> {
    return requestLocalHttp(server, url, init)
  }

  it('invalidates library matching cache after deleting a library', async () => {
    const response = await request('/api/libraries/1', { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(routeMocks.libraryDb.delete).toHaveBeenCalledWith(1)
    expect(routeMocks.invalidateLibHitCache).toHaveBeenCalledTimes(1)
  })

  it('invalidates cache after restoring a listed backup', async () => {
    routeMocks.applyRestorePreview.mockResolvedValue({ tables: 1, rows: 1, postersRestored: null, missingPosters: null, warning: '数据库已恢复，但海报缓存补回失败' })

    const response = await request('/api/settings/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-AnimeShelf-Owner': '1' },
      body: JSON.stringify({ previewId: 'reviewed-backup' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, warning: '数据库已恢复，但海报缓存补回失败' })
    expect(routeMocks.applyRestorePreview).toHaveBeenCalledWith('reviewed-backup')
    expect(routeMocks.invalidateLibHitCache).toHaveBeenCalledTimes(1)
  })

  it('rejects legacy upload-and-restore without changing data or invalidating caches', async () => {
    routeMocks.restoreFromPath.mockResolvedValue({ tables: 1, rows: 1, postersRestored: 0, missingPosters: 0 })
    const data = Buffer.alloc(1024, 1).toString('base64')

    const response = await request('/api/settings/backups/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'uploaded.db', data }),
    })

    expect(response.status).toBe(409)
    expect(routeMocks.restoreFromPath).not.toHaveBeenCalled()
    expect(routeMocks.applyRestorePreview).not.toHaveBeenCalled()
    expect(routeMocks.invalidateLibHitCache).not.toHaveBeenCalled()
  })
})
