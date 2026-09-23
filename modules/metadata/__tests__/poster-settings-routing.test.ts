import express from 'express'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'
import { PosterRepairService, setPosterRepairService } from '../server/poster-repair'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any }))
vi.mock('../../../server/db/instance', () => mockedInstance)

describe('poster repair scoped settings routes', () => {
  let db: any
  let server: http.Server
  let controller: AbortController

  beforeEach(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    controller = new AbortController()
    const service = new PosterRepairService({
      db,
      signal: controller.signal,
      track: <T,>(operation: Promise<T>) => operation,
      delayMs: 0,
      cachedPath: () => null,
      fetchAnilistPoster: async () => 'https://example.com/poster.jpg',
      cache: async () => '/posters/al_900.jpg',
    })
    setPosterRepairService(service)
    const router = (await import('../server/settings')).default
    const app = express()
    app.use(express.json())
    app.use('/api/settings', router)
    server = await new Promise<http.Server>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    setPosterRepairService(null)
    db.close()
  })

  function folders(libraryId: number, paths: string[]) {
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(libraryId, paths)
    return folderDb.getByLibrary(libraryId)
  }

  it('repairs across libraries, reports the scoped latest job, and rejects widening inputs', async () => {
    const first = makeLibraryDb(db).create('A', 'D:\\SettingsScopeA', 'anime')
    const second = makeLibraryDb(db).create('B', 'D:\\SettingsScopeB', 'anime')
    const firstRows = folders(first.id, ['D:\\SettingsScopeA', 'D:\\SettingsScopeA\\Selected', 'D:\\SettingsScopeA\\Other'])
    const secondRows = folders(second.id, ['D:\\SettingsScopeB', 'D:\\SettingsScopeB\\Selected'])
    const selected = firstRows.find(row => row.name === 'Selected')!
    const outside = firstRows.find(row => row.name === 'Other')!
    const crossLibrary = secondRows.find(row => row.name === 'Selected')!
    for (const row of [selected, outside, crossLibrary]) {
      db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 900 WHERE id = ?").run(row.id)
    }

    const scopeBody = JSON.stringify({ folderIds: [crossLibrary.id, selected.id] })
    const started = await requestLocalHttp(server, '/api/settings/repair-posters', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(scopeBody)) },
      body: scopeBody,
    })
    expect(started.status).toBe(202)
    const startedBody = await started.json()
    expect(startedBody.job).toMatchObject({ folderIds: [selected.id, crossLibrary.id], includeFavorites: false })

    const status = await requestLocalHttp(server, `/api/settings/backups/poster-repair-status?folderIds=${selected.id},${crossLibrary.id}`)
    expect(status.status).toBe(200)
    expect((await status.json()).jobId).toBe(startedBody.jobId)
    expect(db.prepare('SELECT has_poster FROM folders WHERE id IN (?, ?) ORDER BY id').all([selected.id, crossLibrary.id])).toEqual([{ has_poster: 1 }, { has_poster: 1 }])
    expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(outside.id)).toEqual({ has_poster: 0 })

    const unrelated = await requestLocalHttp(server, `/api/settings/backups/poster-repair-status?folderIds=${outside.id}`)
    expect(unrelated.status).toBe(200)
    expect(await unrelated.json()).toBeNull()

    const conflictBody = JSON.stringify({ folderIds: [selected.id], includeFavorites: true })
    const conflict = await requestLocalHttp(server, '/api/settings/repair-posters', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(conflictBody)) },
      body: conflictBody,
    })
    expect(conflict.status).toBe(400)

    const emptyBody = JSON.stringify({ folderIds: [] })
    const empty = await requestLocalHttp(server, '/api/settings/repair-posters', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(emptyBody)) },
      body: emptyBody,
    })
    expect(empty.status).toBe(400)

    const missing = await requestLocalHttp(server, '/api/settings/backups/poster-repair-status?folderIds=999999')
    expect(missing.status).toBe(404)
  })
})

