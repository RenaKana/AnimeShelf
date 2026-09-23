import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleRuntime } from '../../../server/core/module-runtime'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { rebuildLibraryMediaCatalog } from '../../media-catalog/server/media-catalog'

const mockedDatabase = vi.hoisted(() => {
  const state = { db: undefined as any }
  return {
    state,
    proxy: { prepare: (sql: string) => state.db.prepare(sql) },
  }
})
vi.mock('../../../server/db/instance', () => ({ db: mockedDatabase.proxy }))

describe('wishlist library-match availability', () => {
  let db: any
  let showId: number
  let fileId: number

  beforeEach(async () => {
    db = createDb(':memory:')
    mockedDatabase.state.db = db
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const folders = makeFolderDb(db)
    folders.upsertTree(library.id, ['D:\\Anime', 'D:\\Anime\\Show'])
    const show = folders.getByLibrary(library.id).find(folder => folder.path === 'D:\\Anime\\Show')!
    showId = show.id
    db.prepare("UPDATE folders SET is_series = 1, source = 'bangumi', anilist_id = 123 WHERE id = ?").run(showId)
    makeFileDb(db).upsertMany(library.id, [{
      folder_id: showId,
      path: 'D:\\Anime\\Show\\01.mkv',
      name: '01.mkv',
      size: 1,
      date_modified: 1,
      ext: 'mkv',
    }])
    fileId = (db.prepare('SELECT id FROM files WHERE folder_id = ?').get(showId) as { id: number }).id
    rebuildLibraryMediaCatalog(db, library.id)

    vi.resetModules()
    const { bindModuleRuntime } = await import('../../../server/core/extensions')
    bindModuleRuntime(mockedDatabase.proxy as any, {
      isActive: (id: string) => id === 'media-catalog',
      capability: () => undefined,
      afterRestore: async () => {},
    } as unknown as ModuleRuntime)
  })

  afterEach(() => db.close())

  it('does not report a mapped title present after its only video becomes missing', async () => {
    const { detectLibStatus, invalidateLibHitCache } = await import('../server/libhit')
    expect(detectLibStatus('manual-bangumi-123', 'Show', null, { bangumiId: 123 }, true).status).toBe('present')

    db.prepare('UPDATE files SET path_missing = 1 WHERE id = ?').run(fileId)
    invalidateLibHitCache()
    expect(detectLibStatus('manual-bangumi-123', 'Show', null, { bangumiId: 123 }, true).status).toBe('absent')
  })

  it('does not report a mapped title present when its physical folder is missing', async () => {
    const { detectLibStatus, invalidateLibHitCache } = await import('../server/libhit')
    db.prepare('UPDATE folders SET path_missing = 1 WHERE id = ?').run(showId)
    invalidateLibHitCache()

    expect(detectLibStatus('manual-bangumi-123', 'Show', null, { bangumiId: 123 }, true).status).toBe('absent')
  })
})
