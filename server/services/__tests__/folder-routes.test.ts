import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFileDb } from '../../db/files'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { rebuildLibraryMediaCatalog } from '../../../modules/media-catalog/server/media-catalog'
import { requestLocalHttp, type TestHttpResponse } from './http-test-client'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({
  db: undefined as any,
  settingsDb: { get: () => null },
}))

vi.mock('../../db/instance', () => mockedInstance)

describe('folder name maintenance routes', () => {
  let db: any
  let router: any
  let server: any
  let showId: number

  beforeAll(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    bindTestModuleCapabilities(db)

    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [
      'D:\\Anime',
      'D:\\Anime\\Show',
      'D:\\Anime\\Show\\Season 1',
    ])
    const rows = folderDb.getByLibrary(library.id)
    const show = rows.find(folder => folder.path === 'D:\\Anime\\Show')!
    const season = rows.find(folder => folder.path === 'D:\\Anime\\Show\\Season 1')!
    showId = show.id
    makeFileDb(db).upsertMany(library.id, [{
      path: 'D:\\Anime\\Show\\Season 1\\episode-01.mkv',
      folder_id: season.id,
      name: 'episode-01.mkv',
      size: 1,
      date_modified: 1,
      ext: 'mkv',
    }])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(show.id)
    rebuildLibraryMediaCatalog(db, library.id)
    db.exec(`
      CREATE TRIGGER fail_folder_route_catalog_rebuild
      BEFORE INSERT ON folder_media_entries
      WHEN NEW.manual_locked = 0
      BEGIN
        SELECT RAISE(ABORT, 'injected folder route catalog failure');
      END;
    `)

    const catalogRouter = (await import('../../../modules/media-catalog/server/folders')).default
    router = (await import('../../routes/folders')).default
    const app = express()
    app.use(express.json())
    app.use('/api/folders', router)
    app.use('/api/folders', catalogRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  async function post(path: string, body: Record<string, unknown>): Promise<TestHttpResponse> {
    return requestLocalHttp(server, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function put(path: string, body: Record<string, unknown>): Promise<TestHttpResponse> {
    return requestLocalHttp(server, path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rolls back rename-regex names when catalog rebuild fails', async () => {
    const response = await post('/api/folders/rename-regex', {
      pattern: '^Show$',
      replacement: 'Renamed',
      apply: true,
    })

    expect(response.status).toBe(500)
    expect(db.prepare('SELECT name, renamed FROM folders WHERE id = ?').get(showId)).toEqual({
      name: 'Show',
      renamed: 0,
    })
  })

  it('rolls back restore-names updates when catalog rebuild fails', async () => {
    db.prepare('UPDATE folders SET name = ?, renamed = 1 WHERE id = ?').run(['Pretty Show', showId])

    const response = await post('/api/folders/restore-names', {})

    expect(response.status).toBe(500)
    expect(db.prepare('SELECT name, renamed FROM folders WHERE id = ?').get(showId)).toEqual({
      name: 'Pretty Show',
      renamed: 1,
    })
  })

  it('rolls back a collection toggle when rebuilding the catalog fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await put(`/api/folders/${showId}/pin`, { pinned: true })
      .finally(() => errorLog.mockRestore())

    expect(response.status).toBe(500)
    expect(db.prepare('SELECT pinned FROM folders WHERE id = ?').get(showId)).toEqual({ pinned: 0 })
  })

  it('edits the display alias without changing disk paths and preserves it on scan upsert', async () => {
    const denied = await put(`/api/folders/${showId}/display-name`, { name: 'Alias' })
    expect(denied.status).toBe(403)
    db.exec('DROP TRIGGER fail_folder_route_catalog_rebuild')
    const before = db.prepare('SELECT path FROM folders WHERE id=?').get(showId)
    const response = await requestLocalHttp(server, `/api/folders/${showId}/display-name`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-AnimeShelf-Owner': '1' }, body: JSON.stringify({ name: 'Alias' }) })
    expect(response.status).toBe(200)
    makeFolderDb(db).upsertTree(1, [before.path])
    expect(db.prepare('SELECT name, renamed, path FROM folders WHERE id=?').get(showId)).toEqual({ name: 'Alias', renamed: 1, path: before.path })
  })

  it('lists retained missing empty roots so users can reopen and relink them', async () => {
    const root = makeLibraryDb(db).create('Missing', 'D:\\Missing', 'anime')
    makeFolderDb(db).upsertTree(root.id, ['D:\\Missing'])
    db.prepare('UPDATE folders SET path_missing=1, is_series=1 WHERE library_id=?').run(root.id)
    const response = await requestLocalHttp(server, `/api/folders?type=series&libraryId=${root.id}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'D:\\Missing', path_missing: 1 })]))
  })
})
