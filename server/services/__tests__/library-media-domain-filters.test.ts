import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFileDb } from '../../db/files'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { requestLocalHttp } from './http-test-client'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any }))
vi.mock('../../db/instance', () => mockedInstance)

describe('folder media-domain filtering', () => {
  let db: any
  let server: any
  let animeShowId: number
  let liveShowId: number
  let unknownShowId: number

  beforeAll(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false })

    const libraries = makeLibraryDb(db)
    const anime = libraries.create('Anime', 'D:\\Anime', 'anime')
    const live = libraries.create('Live', 'D:\\Live', 'live_action')
    const unknown = libraries.create('Legacy', 'D:\\Legacy', 'legacy')
    const folders = makeFolderDb(db)
    folders.upsertTree(anime.id, ['D:\\Anime', 'D:\\Anime\\Show'])
    folders.upsertTree(live.id, ['D:\\Live', 'D:\\Live\\Show'])
    folders.upsertTree(unknown.id, ['D:\\Legacy', 'D:\\Legacy\\Show'])
    const rows = db.prepare('SELECT id, path FROM folders ORDER BY id').all() as Array<{ id: number; path: string }>
    animeShowId = rows.find(row => row.path === 'D:\\Anime\\Show')!.id
    liveShowId = rows.find(row => row.path === 'D:\\Live\\Show')!.id
    unknownShowId = rows.find(row => row.path === 'D:\\Legacy\\Show')!.id
    db.prepare('UPDATE folders SET is_series = 1 WHERE id IN (?, ?, ?)').run([animeShowId, liveShowId, unknownShowId])
    const files = makeFileDb(db)
    files.upsertMany(anime.id, [{ folder_id: animeShowId, path: 'D:\\Anime\\Show\\01.mkv', name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    files.upsertMany(live.id, [{ folder_id: liveShowId, path: 'D:\\Live\\Show\\01.mkv', name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    files.upsertMany(unknown.id, [{ folder_id: unknownShowId, path: 'D:\\Legacy\\Show\\01.mkv', name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])

    const router = (await import('../../routes/folders')).default
    const app = express()
    app.set('query parser', 'extended')
    app.use('/api/folders', router)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  async function list(query: string): Promise<any[]> {
    const response = await requestLocalHttp(server, `/api/folders?${query}`)
    expect(response.status).toBe(200)
    return response.json()
  }

  it('separates anime, live-action, and unknown series in the all-media route', async () => {
    const all = await list('type=series')
    expect(all.map(folder => folder.id)).toEqual(expect.arrayContaining([animeShowId, liveShowId, unknownShowId]))
    expect(all.map(folder => folder.media_domain)).toEqual(['anime', 'unknown', 'live_action'])

    expect((await list('type=series&mediaDomain=anime')).map(folder => folder.id)).toEqual([animeShowId])
    expect((await list('type=series&mediaDomain=live_action')).map(folder => folder.id)).toEqual([liveShowId])
    expect((await list('type=series&mediaDomain=unknown')).map(folder => folder.id)).toEqual([unknownShowId])
  })

  it('accepts mediaType as a compatibility alias and validates conflicting filters', async () => {
    expect((await list('type=series&mediaType=live')).map(folder => folder.id)).toEqual([liveShowId])
    expect((await list('type=series&mediaDomain=all')).map(folder => folder.id)).toHaveLength(3)

    for (const query of ['type=series&mediaDomain=cartoon', 'type=series&mediaDomain=anime&mediaType=live_action']) {
      const response = await requestLocalHttp(server, `/api/folders?${query}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_FOLDER_QUERY' })
    }
  })
})
