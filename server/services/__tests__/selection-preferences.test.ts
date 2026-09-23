import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readNumberPref, writePref, UI_PREF_KEYS } from '../../../src/lib/uiPreferences'
import { createDb } from '../../db/schema'
import { makeLibraryDb } from '../../db/libraries'
import { makeFolderDb } from '../../db/folders'
import { requestLocalHttp } from './http-test-client'
import { withLibraryMaintenance } from '../library-maintenance'

const instance = vi.hoisted(() => ({ db: undefined as any }))
vi.mock('../../db/instance', () => instance)
afterEach(() => vi.unstubAllGlobals())

it('retains poster size for this session when local storage refuses writes', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota denied') } })
  expect(writePref(UI_PREF_KEYS.posterCardWidth, 180)).toBe(false)
  expect(readNumberPref(UI_PREF_KEYS.posterCardWidth, 150, 100, 280)).toBe(180)
  writePref(UI_PREF_KEYS.favoriteCardWidth, 240)
  expect(readNumberPref(UI_PREF_KEYS.posterCardWidth, 150, 100, 280)).toBe(180)
})

describe('selected tag target revalidation', () => {
  let db: ReturnType<typeof createDb>, server: ReturnType<express.Express['listen']>, folderId: number
  beforeEach(async () => {
    db = createDb(':memory:'); instance.db = db
    const library = makeLibraryDb(db).create('Fixture', 'D:\\Fixture', 'anime')
    makeFolderDb(db).upsertTree(library.id, ['D:\\Fixture', 'D:\\Fixture\\Show'])
    folderId = makeFolderDb(db).getByLibrary(library.id).find(row => row.name === 'Show')!.id
    db.run("INSERT INTO tags(id,name) VALUES(123,'Fixture')")
    const app = express(); app.use(express.json()); app.use('/api/tags', (await import('../../routes/tags')).default)
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)) })
  })
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close() })
  const tag = (id: number) => requestLocalHttp(server, '/api/tags/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag_id: 123, target_type: 'folder', target_id: id }) })
  it('never creates an orphan for a missing selected item and reports success for the valid item', async () => {
    expect((await tag(999999)).status).toBe(404)
    expect((await tag(folderId)).status).toBe(200)
    expect(db.all('SELECT target_id FROM tag_links')).toEqual([{ target_id: folderId }])
  })
  it('refuses a tag write while a disk operation holds the maintenance lock', async () => {
    await withLibraryMaintenance(db, '测试迁移', async () => expect((await tag(folderId)).status).toBe(409))
    expect(db.all('SELECT target_id FROM tag_links')).toEqual([])
  })
})
