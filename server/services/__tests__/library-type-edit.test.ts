import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFileDb } from '../../db/files'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { sqlAll, sqlGet, sqlRun } from '../../db/sql'
import { requestLocalHttp } from './http-test-client'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any }))
const scanMocks = vi.hoisted(() => ({
  scanLibrary: vi.fn(async (library: { id: number; type: string }) => ({
    added: 0, updated: 0, removed: 0, errors: [], changed: false, libraryType: library.type,
  })),
}))

vi.mock('../../db/instance', () => mockedInstance)
vi.mock('../scanner', () => ({ scanLibrary: scanMocks.scanLibrary }))

type Fixture = {
  libraryId: number
  showId: number
  fileId: number
  mediaItemId: number
}

function snapshot(db: any, libraryId: number) {
  const rows = <T>(sql: string, ...params: any[]) => sqlAll<T>(db, sql, params.length === 0 ? undefined : params)
  return {
    folders: rows('SELECT id, library_id, parent_id, path, anilist_id, source, has_poster, rating, synopsis, year, episodes FROM folders WHERE library_id = ? ORDER BY id', libraryId),
    files: rows('SELECT id, folder_id, library_id, path, size, date_modified, ext FROM files WHERE library_id = ? ORDER BY id', libraryId),
    series: rows('SELECT id, library_id, root_folder_id, series_key, title, manual_locked FROM media_series WHERE library_id = ? ORDER BY id', libraryId),
    entries: rows('SELECT id, folder_id, series_id, kind, season_number, part_number, source, external_id, manual_locked FROM folder_media_entries WHERE series_id IN (SELECT id FROM media_series WHERE library_id = ?) ORDER BY id', libraryId),
    items: rows('SELECT id, library_id, root_folder_id, item_key, title, kind, manual_locked FROM media_items WHERE library_id = ? ORDER BY id', libraryId),
    sources: rows('SELECT id, media_item_id, source, external_id, is_primary FROM media_item_sources WHERE media_item_id IN (SELECT id FROM media_items WHERE library_id = ?) ORDER BY id', libraryId),
    mappings: rows('SELECT id, folder_id, media_item_id, root_folder_id, content_role, kind, manual_locked FROM folder_media_mappings WHERE root_folder_id IN (SELECT id FROM folders WHERE library_id = ?) ORDER BY id', libraryId),
    groups: rows('SELECT id, library_id, root_folder_id, group_key, title, manual_locked FROM media_work_groups WHERE library_id = ? ORDER BY id', libraryId),
    members: rows('SELECT id, work_group_id, media_item_id, relation_role, manual_locked FROM media_work_group_members WHERE work_group_id IN (SELECT id FROM media_work_groups WHERE library_id = ?) ORDER BY id', libraryId),
    presentation: rows('SELECT root_folder_id, entry_key, display_title, position FROM media_collection_presentation WHERE root_folder_id IN (SELECT id FROM folders WHERE library_id = ?) ORDER BY root_folder_id, entry_key', libraryId),
    organization: rows('SELECT root_folder_id, organization_json, revision FROM media_collection_organization WHERE root_folder_id IN (SELECT id FROM folders WHERE library_id = ?) ORDER BY root_folder_id', libraryId),
    tags: rows('SELECT id, name, color, kind FROM tags ORDER BY id'),
    tagLinks: rows('SELECT id, tag_id, target_type, target_id FROM tag_links WHERE target_id IN (SELECT id FROM folders WHERE library_id = ?) OR target_id IN (SELECT id FROM files WHERE library_id = ?) ORDER BY id', libraryId, libraryId),
    favorites: rows('SELECT item_id, title, bangumi_id, synopsis, total_episodes, air_status, media_type, lib_match_override FROM season_favorites ORDER BY item_id'),
  }
}

function integrity(db: any): { integrity: unknown[]; foreignKeys: unknown[] } {
  return {
    integrity: sqlAll(db, 'PRAGMA integrity_check'),
    foreignKeys: sqlAll(db, 'PRAGMA foreign_key_check'),
  }
}

function seedFixture(db: any): Fixture {
  const library = makeLibraryDb(db).create('历史动漫库', 'D:\\AnimeShelf-type-fixture', 'anime')
  const folderDb = makeFolderDb(db)
  folderDb.upsertTree(library.id, [
    'D:\\AnimeShelf-type-fixture',
    'D:\\AnimeShelf-type-fixture\\Show',
  ])
  const show = sqlGet<{ id: number }>(db, 'SELECT id FROM folders WHERE path = ?', 'D:\\AnimeShelf-type-fixture\\Show')!
  sqlRun(db, `UPDATE folders SET is_series = 1, anilist_id = 12345, source = 'bangumi', has_poster = 1,
    rating = 8.8, synopsis = '保留的简介', year = 2024, episodes = 12 WHERE id = ?`, show.id)
  sqlRun(db, 'UPDATE folders SET media_domain_evidence=? WHERE id=?', [JSON.stringify([{ source: 'bangumi', externalId: '12345', authority: 'confirmed', subjectType: 2 }]), show.id])

  makeFileDb(db).upsertMany(library.id, [{
    folder_id: show.id, path: 'D:\\AnimeShelf-type-fixture\\Show\\01.mkv', name: '01.mkv',
    size: 42, date_modified: 1_700_000_000, ext: 'mkv',
  }])
  const file = sqlGet<{ id: number }>(db, 'SELECT id FROM files WHERE path = ?', 'D:\\AnimeShelf-type-fixture\\Show\\01.mkv')!

  const series = sqlRun(db, `INSERT INTO media_series (library_id, root_folder_id, series_key, title, manual_locked)
    VALUES (?, ?, ?, ?, 1)`, [library.id, show.id, 'series:show', '保留系列'])
  const mediaItem = sqlRun(db, `INSERT INTO media_items
    (library_id, root_folder_id, item_key, title, title_zh, kind, season_number, manual_locked)
    VALUES (?, ?, ?, ?, ?, 'season', 1, 1)`, [library.id, show.id, 'work:show', 'Preserved Show', '保留作品'])
  sqlRun(db, `INSERT INTO media_item_sources (media_item_id, source, external_id, is_primary)
    VALUES (?, 'bangumi', '12345', 1)`, mediaItem.lastInsertRowid)
  sqlRun(db, `INSERT INTO folder_media_entries
    (folder_id, series_id, kind, season_number, source, external_id, detected_by, manual_locked)
    VALUES (?, ?, 'season', 1, 'bangumi', '12345', 'manual', 1)`, [show.id, series.lastInsertRowid])
  sqlRun(db, `INSERT INTO folder_media_mappings
    (folder_id, media_item_id, root_folder_id, series_id, content_role, kind, season_number, detected_by, manual_locked)
    VALUES (?, ?, ?, ?, 'main', 'season', 1, 'manual', 1)`, [show.id, mediaItem.lastInsertRowid, show.id, series.lastInsertRowid])
  const group = sqlRun(db, `INSERT INTO media_work_groups
    (library_id, root_folder_id, group_key, title, manual_locked) VALUES (?, ?, ?, ?, 1)`, [library.id, show.id, 'group:show', '保留合集'])
  sqlRun(db, `INSERT INTO media_work_group_members (work_group_id, media_item_id, relation_role, manual_locked)
    VALUES (?, ?, 'main', 1)`, [group.lastInsertRowid, mediaItem.lastInsertRowid])
  sqlRun(db, `INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
    VALUES (?, 'work:show', '保留展示名', 0)`, show.id)
  sqlRun(db, `INSERT INTO media_collection_organization (root_folder_id, organization_json, revision)
    VALUES (?, ?, 3)`, [show.id, JSON.stringify({ contractVersion: 1, groups: [{ key: 'work:show', entryKeys: ['work:show'] }] })])

  const favoriteTag = sqlRun(db, `INSERT INTO tags (name, color, kind) VALUES ('收藏', '#f59e0b', 'custom')`)
  const watchedTag = sqlRun(db, `INSERT INTO tags (name, color, kind) VALUES ('状态:看完', '#3b82f6', 'system')`)
  sqlRun(db, `INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, 'folder', ?)`, [favoriteTag.lastInsertRowid, show.id])
  sqlRun(db, `INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, 'file', ?)`, [watchedTag.lastInsertRowid, file.id])
  sqlRun(db, `INSERT INTO season_favorites
    (item_id, title, title_zh, bangumi_id, synopsis, total_episodes, air_status, media_type, lib_match_override)
    VALUES ('manual-bangumi-12345', 'Preserved Show', '保留作品', '12345', '收藏简介', 12, 'finished', 'anime', NULL)`)

  return { libraryId: library.id, showId: show.id, fileId: file.id, mediaItemId: Number(mediaItem.lastInsertRowid) }
}

describe('library type editing', () => {
  let db: any
  let server: any
  let tempRoot: string
  let fixture: Fixture

  beforeAll(async () => {
    await import('../../routes/libraries')
    await import('../../routes/folders')
  })

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-library-type-'))
    db = createDb(path.join(tempRoot, 'animeshelf.db'))
    mockedInstance.db = db
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false })
    fixture = seedFixture(db)
    const librariesRouter = (await import('../../routes/libraries')).default
    const foldersRouter = (await import('../../routes/folders')).default
    const app = express()
    app.set('query parser', 'extended')
    app.use(express.json())
    app.use('/api/libraries', librariesRouter)
    app.use('/api/folders', foldersRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
    scanMocks.scanLibrary.mockClear()
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    if (db?.isOpen) db.close()
    mockedInstance.db = undefined
    const resolved = path.resolve(tempRoot)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('animeshelf-library-type-')) {
      throw new Error(`Refusing unsafe test cleanup: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  it('round-trips anime to live-action and back without changing media relations', async () => {
    const before = snapshot(db, fixture.libraryId)
    const first = await requestLocalHttp(server, `/api/libraries/${fixture.libraryId}`, {
      method: 'PUT', body: JSON.stringify({ type: 'live_action' }), headers: { 'content-type': 'application/json' },
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ id: fixture.libraryId, type: 'live_action' })

    const liveRows = await requestLocalHttp(server, `/api/folders?type=series&libraryId=${fixture.libraryId}&mediaDomain=live_action`)
    expect(liveRows.status).toBe(200)
    expect(await liveRows.json()).toEqual([])
    const animeRows = await requestLocalHttp(server, `/api/folders?type=series&libraryId=${fixture.libraryId}&mediaDomain=anime`)
    expect(animeRows.status).toBe(200)
    expect((await animeRows.json()).map((row: any) => row.id)).toEqual([fixture.showId])

    const second = await requestLocalHttp(server, `/api/libraries/${fixture.libraryId}`, {
      method: 'PUT', body: JSON.stringify({ type: 'anime' }), headers: { 'content-type': 'application/json' },
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ type: 'anime' })
    expect(snapshot(db, fixture.libraryId)).toEqual(before)
    expect(integrity(db)).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] })
  })

  it('persists the type across database reopen and passes it to the simulated scan', async () => {
    const response = await requestLocalHttp(server, `/api/libraries/${fixture.libraryId}`, {
      method: 'PUT', body: JSON.stringify({ type: 'live_action' }), headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    db.close()
    db = createDb(path.join(tempRoot, 'animeshelf.db'))
    mockedInstance.db = db

    const listed = await requestLocalHttp(server, '/api/libraries')
    expect(listed.status).toBe(200)
    expect((await listed.json()).find((library: any) => library.id === fixture.libraryId)).toMatchObject({ type: 'live_action' })

    const scan = await requestLocalHttp(server, `/api/libraries/${fixture.libraryId}/scan`, { method: 'POST' })
    expect(scan.status).toBe(200)
    expect(await scan.json()).toMatchObject({ libraryType: 'live_action' })
    expect(scanMocks.scanLibrary).toHaveBeenCalledWith(expect.objectContaining({ id: fixture.libraryId, type: 'live_action' }))
    expect(integrity(db)).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] })
  })

  it('keeps a legacy movie alias for name-only clients and rejects invalid type without writing', async () => {
    sqlRun(db, "UPDATE libraries SET type = 'movie' WHERE id = ?", fixture.libraryId)
    const before = snapshot(db, fixture.libraryId)
    const renamed = await requestLocalHttp(server, `/api/libraries/${fixture.libraryId}`, {
      method: 'PUT', body: JSON.stringify({ name: '旧客户端改名' }), headers: { 'content-type': 'application/json' },
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ name: '旧客户端改名', type: 'movie' })

    const invalid = await requestLocalHttp(server, `/api/libraries/${fixture.libraryId}`, {
      method: 'PUT', body: JSON.stringify({ type: 'novel' }), headers: { 'content-type': 'application/json' },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_LIBRARY_TYPE' })
    expect(sqlGet(db, 'SELECT name, type FROM libraries WHERE id = ?', fixture.libraryId)).toEqual({ name: '旧客户端改名', type: 'movie' })
    expect(snapshot(db, fixture.libraryId)).toEqual({ ...before, folders: before.folders, files: before.files })
  })
})
