import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import type { Database } from 'node-sqlite3-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalApiRole, ExternalApiTokenInfo } from '../../../shared/external-api'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { createExternalDataRouter } from '../server/data'
import * as mediaCatalog from '../../media-catalog/server/media-catalog'
import { mediaCatalogExternalApiRoutes } from '../../media-catalog/server/external-api'
import { seasonExternalApiRoutes } from '../../season/server/external-api'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'
import { requestLocalHttp, type TestHttpRequestInit } from '../../../server/services/__tests__/http-test-client'

vi.mock('../../../server/db/instance', () => { throw new Error('External data routes must not import the real application database') })

interface FixtureIds {
  libraryA: number
  libraryB: number
  show: number
  season: number
  file: number
  rename: number
  move: number
  remove: number
}

function token(role: ExternalApiRole, patch: Partial<ExternalApiTokenInfo> = {}): ExternalApiTokenInfo {
  return {
    id: `token-${role}`,
    name: `${role} token`,
    prefix: `prefix-${role}`,
    role,
    created_at: '2026-09-05T00:00:00.000Z',
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    ...patch,
  }
}

describe('external data API', () => {
  let tempDir: string
  let db: Database
  let server: Server
  let ids: FixtureIds
  let paths: Record<'rename' | 'move' | 'remove' | 'libraryB', string>

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-external-data-'))
    db = createDb(path.join(tempDir, 'external-data.db'))
    bindTestModuleCapabilities(db)

    const rootA = path.join(tempDir, 'library-a')
    const rootB = path.join(tempDir, 'library-b')
    const showPath = path.join(rootA, 'Show')
    const seasonPath = path.join(showPath, 'Season 1')
    const episodePath = path.join(seasonPath, 'episode-01.mkv')
    paths = {
      rename: path.join(rootA, 'Rename Me'),
      move: path.join(rootA, 'Move Me'),
      remove: path.join(rootA, 'Delete Me'),
      libraryB: rootB,
    }
    fs.mkdirSync(seasonPath, { recursive: true })
    fs.mkdirSync(paths.rename, { recursive: true })
    fs.mkdirSync(paths.move, { recursive: true })
    fs.mkdirSync(paths.remove, { recursive: true })
    fs.mkdirSync(rootB, { recursive: true })
    fs.writeFileSync(episodePath, 'video')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const libraryA = libraryDb.create('Anime A', rootA, 'anime', 'http://127.0.0.1:9999')
    const libraryB = libraryDb.create('Anime B', rootB, 'anime', 'http://127.0.0.1:9998')
    folderDb.upsertTree(libraryA.id, [rootA, showPath, seasonPath, paths.rename, paths.move, paths.remove])
    folderDb.upsertTree(libraryB.id, [rootB])
    const folders = folderDb.getByLibrary(libraryA.id)
    const show = folders.find(folder => folder.path === showPath)!
    const season = folders.find(folder => folder.path === seasonPath)!
    const rename = folders.find(folder => folder.path === paths.rename)!
    const move = folders.find(folder => folder.path === paths.move)!
    const remove = folders.find(folder => folder.path === paths.remove)!
    makeFileDb(db).upsertMany(libraryA.id, [{
      path: episodePath,
      folder_id: season.id,
      name: path.basename(episodePath),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    const file = db.prepare('SELECT id FROM files WHERE path = ?').get(episodePath) as { id: number }
    db.prepare("UPDATE folders SET is_series = 1, source = 'anilist', anilist_id = 12345 WHERE id = ?").run(show.id)
    mediaCatalog.rebuildLibraryMediaCatalog(db, libraryA.id)
    db.prepare(`
      INSERT INTO season_favorites
        (item_id, title, title_zh, media_type, links, synopsis)
      VALUES (?, ?, ?, 'anime', ?, ?)
    `).run(['favorite-seed', 'Seed Show', '种子番剧', JSON.stringify([{ name: 'Info', url: 'https://example.test/show' }]), '种子简介'])

    ids = {
      libraryA: libraryA.id,
      libraryB: libraryB.id,
      show: show.id,
      season: season.id,
      file: file.id,
      rename: rename.id,
      move: move.id,
      remove: remove.id,
    }

    const principals: Record<string, ExternalApiTokenInfo | Record<string, unknown>> = {
      read: token('read'),
      edit: token('edit'),
      files: token('files'),
      disabled: token('disabled'),
      revoked: token('read', { revoked_at: '2026-09-05T00:00:00.000Z' }),
      invalid: { id: 'invalid', role: 'owner' },
    }
    const app = express()
    app.use(express.json({ limit: '64kb' }))
    app.use((req, res, next) => {
      const principal = req.get('x-test-principal')
      if (principal && principals[principal]) res.locals.externalApiToken = principals[principal]
      next()
    })
    app.use('/api/v1', createExternalDataRouter(db, {
      contributions: [seasonExternalApiRoutes, mediaCatalogExternalApiRoutes],
    }))
    server = await new Promise<Server>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function request(requestPath: string, role?: string, init: TestHttpRequestInit = {}) {
    return requestLocalHttp(server, requestPath, {
      ...init,
      headers: {
        ...(role ? { 'x-test-principal': role } : {}),
        ...init.headers,
      },
    })
  }

  function json(method: string, body: unknown, role = 'edit'): TestHttpRequestInit {
    const encoded = JSON.stringify(body)
    return {
      method,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) },
      body: encoded,
    }
  }

  it('uses only the authenticated principal for role checks and fails closed', async () => {
    const missing = await request('/api/v1/libraries', undefined, {
      headers: { 'x-external-api-role': 'files', authorization: 'Bearer fake' },
    })
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' })

    for (const principal of ['disabled', 'revoked', 'invalid']) {
      const denied = await request('/api/v1/libraries', principal)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ code: 'TOKEN_DISABLED' })
    }

    for (const principal of ['read', 'edit', 'files']) {
      expect((await request('/api/v1/libraries', principal)).status).toBe(200)
    }
    const me = await request('/api/v1/me', 'read')
    expect(await me.json()).toEqual(expect.objectContaining({ id: 'token-read', role: 'read', prefix: 'prefix-read' }))
    expect(await me.text()).not.toContain('Bearer')

    expect((await request(`/api/v1/folders/${ids.show}`, 'read', json('PATCH', { synopsis: 'nope' }, 'read'))).status).toBe(403)
    expect((await request(`/api/v1/folders/${ids.rename}/rename`, 'edit', json('PUT', { name: 'Nope', expectedPath: paths.rename }))).status).toBe(403)

    const unknown = await request('/api/v1/settings', 'files')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'Route not found', code: 'ROUTE_NOT_FOUND' })

    const methodBypass = await request('/api/v1/libraries', 'files', { method: 'POST' })
    expect(methodBypass.status).toBe(404)
  })

  it('serves paginated local-only reads with explicit fields and no database writes', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('network must not be used') })
    vi.stubGlobal('fetch', fetchSpy)
    const before = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count

    const librariesResponse = await request('/api/v1/libraries', 'read')
    expect(librariesResponse.status).toBe(200)
    const libraries = await librariesResponse.json<any>()
    expect(libraries.pagination).toEqual({ page: 1, pageSize: 50, total: 2 })
    expect(libraries.data[0]).toEqual(expect.objectContaining({ id: expect.any(Number), name: expect.any(String), root_path: expect.any(String), type: 'anime' }))
    expect(libraries.data[0]).not.toHaveProperty('everything_url')

    const foldersResponse = await request(`/api/v1/folders?libraryId=${ids.libraryA}&q=Show&isSeries=true&pageSize=1`, 'read')
    expect(foldersResponse.status).toBe(200)
    const folders = await foldersResponse.json<any>()
    expect(folders.pagination).toEqual({ page: 1, pageSize: 1, total: 1 })
    expect(folders.data[0]).toMatchObject({ id: ids.show, name: 'Show', library_id: ids.libraryA })

    const detailResponse = await request(`/api/v1/folders/${ids.show}`, 'read')
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json<any>()
    expect(detail).toMatchObject({ id: ids.show, media_catalog_v2: { root_folder_id: ids.show } })
    expect(detail.media_catalog_v2.items.length).toBeGreaterThan(0)

    const fileResponse = await request(`/api/v1/files/${ids.file}`, 'read')
    expect(fileResponse.status).toBe(200)
    expect(await fileResponse.json()).toMatchObject({ id: ids.file, folder_id: ids.season, tags: [] })

    const tagsResponse = await request('/api/v1/tags?pageSize=2', 'read')
    expect(tagsResponse.status).toBe(200)
    expect((await tagsResponse.json<any>()).pagination.pageSize).toBe(2)

    const favoritesResponse = await request('/api/v1/favorites', 'read')
    expect(favoritesResponse.status).toBe(200)
    const favorites = await favoritesResponse.json<any>()
    expect(favorites.data[0]).toMatchObject({ item_id: 'favorite-seed', links: [{ name: 'Info', url: 'https://example.test/show' }] })
    expect((await request('/api/v1/favorites/favorite-seed', 'read')).status).toBe(200)

    const after = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
    expect(after).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()

    expect((await request('/api/v1/folders?pageSize=201', 'read')).status).toBe(400)
    expect((await request('/api/v1/folders?unknown=1', 'read')).status).toBe(400)
    const injection = await request(`/api/v1/folders?q=${encodeURIComponent("%' OR 1=1 --")}`, 'read')
    expect((await injection.json<any>()).pagination.total).toBe(0)
  })

  it('lets editors change safe metadata, favorites, tags, links, and manual catalog data', async () => {
    const metadata = await request(`/api/v1/folders/${ids.show}`, 'edit', json('PATCH', {
      name: 'Display Show',
      rating: 8.5,
      genres: ['Drama', 'Mystery'],
      synopsis: 'Local metadata only',
      year: 2026,
      episodes: 12,
    }))
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toMatchObject({ id: ids.show, name: 'Display Show', rating: 8.5, genres: ['Drama', 'Mystery'] })
    expect(db.prepare('SELECT name, renamed, synopsis FROM folders WHERE id = ?').get(ids.show)).toEqual({
      name: 'Display Show',
      renamed: 1,
      synopsis: 'Local metadata only',
    })
    const unknownMetadata = await request(`/api/v1/folders/${ids.show}`, 'edit', json('PATCH', { path: 'C:\\escape' }))
    expect(unknownMetadata.status).toBe(400)

    const createdFavorite = await request('/api/v1/favorites', 'edit', json('POST', {
      item_id: 'external-favorite',
      title: 'External Favorite',
      title_zh: '外部收藏',
      media_type: 'anime',
      links: [{ name: 'Source', url: 'https://example.test/external' }],
    }))
    expect(createdFavorite.status).toBe(201)
    expect((await request('/api/v1/favorites/external-favorite', 'read')).status).toBe(200)
    const updatedFavorite = await request('/api/v1/favorites/external-favorite', 'edit', json('PATCH', { synopsis: 'Edited without enrichment' }))
    expect(updatedFavorite.status).toBe(200)
    expect(await updatedFavorite.json()).toMatchObject({ synopsis: 'Edited without enrichment' })

    const createdTag = await request('/api/v1/tags', 'edit', json('POST', { name: 'External Tag', color: '#123456' }))
    expect(createdTag.status).toBe(201)
    const tag = await createdTag.json<any>()
    const updatedTag = await request(`/api/v1/tags/${tag.id}`, 'edit', json('PATCH', { name: 'Updated Tag' }))
    expect(updatedTag.status).toBe(200)
    const linked = await request(`/api/v1/tags/${tag.id}/links`, 'edit', json('POST', { target_type: 'folder', target_id: ids.show }))
    expect(linked.status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links WHERE tag_id = ? AND target_type = ? AND target_id = ?').get([tag.id, 'folder', ids.show])).toEqual({ count: 1 })
    expect((await request(`/api/v1/tags/${tag.id}/links`, 'edit', json('DELETE', { target_type: 'folder', target_id: ids.show }))).status).toBe(200)
    expect((await request(`/api/v1/tags/${tag.id}`, 'edit', { method: 'DELETE' })).status).toBe(200)

    const manual = await request(`/api/v1/folders/${ids.season}/media-catalog`, 'edit', json('PUT', {
      kind: 'season',
      seasonNumbers: [2],
    }))
    expect(manual.status).toBe(200)
    expect((await manual.json<any>()).media_catalog_v2.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: ids.season, kind: 'season', season_number: 2, manual_locked: 1 }),
    ]))

    expect((await request('/api/v1/favorites/external-favorite', 'edit', { method: 'DELETE' })).status).toBe(200)
    expect(db.prepare('SELECT item_id FROM season_favorites WHERE item_id = ?').get('external-favorite')).toBeNull()
  })

  it('returns the module-unavailable contract when an owning module did not contribute its routes', async () => {
    const app = express()
    app.use(express.json({ limit: '64kb' }))
    app.use((_req, res, next) => { res.locals.externalApiToken = token('files'); next() })
    app.use('/api/v1', createExternalDataRouter(db))
    const unavailableServer = await new Promise<Server>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
    try {
      const favorite = await requestLocalHttp(unavailableServer, '/api/v1/favorites')
      expect(favorite.status).toBe(404)
      expect(await favorite.json()).toEqual({ error: 'Module unavailable', code: 'MODULE_UNAVAILABLE' })

      const catalog = await requestLocalHttp(unavailableServer, `/api/v1/folders/${ids.season}/media-catalog`, json('PUT', {
        kind: 'season',
        seasonNumbers: [2],
      }))
      expect(catalog.status).toBe(404)
      expect(await catalog.json()).toEqual({ error: 'Module unavailable', code: 'MODULE_UNAVAILABLE' })
    } finally {
      await new Promise<void>(resolve => unavailableServer.close(() => resolve()))
    }
  })

  it('allows only file-tier principals to rename, move, and confirmed-delete genuine temporary folders', async () => {
    const stale = await request(`/api/v1/folders/${ids.rename}/rename`, 'files', json('PUT', {
      name: 'Renamed',
      expectedPath: `${paths.rename}-stale`,
    }, 'files'))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'STALE_FOLDER_PATH' })
    expect(fs.existsSync(paths.rename)).toBe(true)

    const renamedPath = path.join(path.dirname(paths.rename), 'Renamed')
    const renamed = await request(`/api/v1/folders/${ids.rename}/rename`, 'files', json('PUT', {
      name: 'Renamed',
      expectedPath: paths.rename,
    }, 'files'))
    expect(renamed.status).toBe(200)
    expect(fs.existsSync(renamedPath)).toBe(true)
    expect(fs.existsSync(paths.rename)).toBe(false)

    const moved = await request(`/api/v1/folders/${ids.move}/move`, 'files', json('PUT', {
      targetLibraryId: ids.libraryB,
      expectedPath: paths.move,
    }, 'files'))
    expect(moved.status).toBe(200)
    expect(fs.existsSync(path.join(paths.libraryB, 'Move Me'))).toBe(true)
    expect(fs.existsSync(paths.move)).toBe(false)

    const unconfirmed = await request(`/api/v1/folders/${ids.remove}`, 'files', json('DELETE', {
      expectedPath: paths.remove,
    }, 'files'))
    expect(unconfirmed.status).toBe(400)
    expect(await unconfirmed.json()).toMatchObject({ code: 'DELETE_CONFIRMATION_REQUIRED' })
    expect(fs.existsSync(paths.remove)).toBe(true)

    const removed = await request(`/api/v1/folders/${ids.remove}`, 'files', json('DELETE', {
      expectedPath: paths.remove,
      confirm: true,
    }, 'files'))
    expect(removed.status).toBe(200)
    expect(fs.existsSync(paths.remove)).toBe(false)
    expect(db.prepare('SELECT id FROM folders WHERE id = ?').get(ids.remove)).toBeNull()
  })
})
