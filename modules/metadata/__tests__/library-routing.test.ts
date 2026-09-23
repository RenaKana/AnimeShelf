import express from 'express'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { makeTagDb } from '../../../server/db/tags'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any }))
const metadataMocks = vi.hoisted(() => ({
  searchAniList: vi.fn(),
  searchBangumi: vi.fn(),
  getBangumiDetail: vi.fn(),
  searchTMDB: vi.fn(),
  getTMDBKey: vi.fn(),
  getBangumiToken: vi.fn(),
  bindAnilist: vi.fn(),
  bindBangumi: vi.fn(),
  bindTMDB: vi.fn(),
  mergeBangumiDetail: vi.fn(),
  pickBangumiCandidate: vi.fn(),
  preferBangumiSynopsis: vi.fn(),
  scoreBangumiCandidate: vi.fn(),
}))

vi.mock('../../../server/db/instance', () => mockedInstance)
vi.mock('../server/metadata', async importOriginal => ({
  ...await importOriginal<typeof import('../server/metadata')>(),
  ...metadataMocks,
}))

describe('library metadata routing', () => {
  let db: any
  let server: http.Server

  beforeEach(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    metadataMocks.searchAniList.mockReset().mockResolvedValue([])
    metadataMocks.searchBangumi.mockReset().mockResolvedValue([])
    metadataMocks.getBangumiDetail.mockReset().mockResolvedValue({})
    metadataMocks.searchTMDB.mockReset().mockResolvedValue([])
    metadataMocks.getTMDBKey.mockReset().mockReturnValue('test-key')
    metadataMocks.getBangumiToken.mockReset().mockReturnValue('test-token')
    metadataMocks.bindAnilist.mockReset()
    metadataMocks.bindBangumi.mockReset()
    metadataMocks.bindTMDB.mockReset()
    metadataMocks.mergeBangumiDetail.mockReset().mockImplementation((candidate: any, detail: any) => ({
      ...candidate,
      ...Object.fromEntries(Object.entries(detail ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '')),
    }))
    metadataMocks.pickBangumiCandidate.mockReset().mockImplementation((items: unknown[]) => items[0])
    metadataMocks.preferBangumiSynopsis.mockReset().mockImplementation((candidate: unknown) => candidate)
    metadataMocks.scoreBangumiCandidate.mockReset().mockReturnValue(250)

    const router = (await import('../server/libraries')).default
    const app = express()
    app.use(express.json())
    app.use('/api/libraries', router)
    server = await new Promise<http.Server>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  async function waitForIdle(libraryId: number, maxAttempts = 50, jobId?: string): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await requestLocalHttp(server, `/api/libraries/${libraryId}/match-status${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`)
      const status = await response.json()
      if (!status.running) return status
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('metadata match task did not finish')
  }

  async function start(libraryId: number, source = 'auto', waitAttempts = 300): Promise<void> {
    const body = JSON.stringify({ source })
    const response = await requestLocalHttp(server, `/api/libraries/${libraryId}/match-metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    })
    expect(response.status).toBe(200)
    await waitForIdle(libraryId, waitAttempts)
  }

  async function postMatch(libraryId: number, value: unknown): Promise<{ response: any; body: any }> {
    const body = JSON.stringify(value)
    const response = await requestLocalHttp(server, `/api/libraries/${libraryId}/match-metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    })
    return { response, body: await response.json() }
  }

  function seedLibrary(name: string, rootPath: string, type: string): { id: number; folderId: number; rootId: number } {
    const library = makeLibraryDb(db).create(name, rootPath, type)
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [rootPath, `${rootPath}\\Show`])
    const folder = folderDb.getByLibrary(library.id).find(row => row.path === `${rootPath}\\Show`)!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(folder.id)
    makeFileDb(db).upsertMany(library.id, [{
      folder_id: folder.id,
      path: `${rootPath}\\Show\\01.mkv`,
      name: '01.mkv',
      size: 1,
      date_modified: 1,
      ext: 'mkv',
    }])
    return { id: library.id, folderId: folder.id, rootId: folderDb.getByLibrary(library.id).find(row => row.path === rootPath)!.id }
  }

  function setItemDomain(folderId: number, domain: 'anime' | 'live_action'): void {
    db.prepare('UPDATE folders SET media_domain_override = ? WHERE id = ?').run([domain, folderId])
  }

  it('routes live-action auto matching directly to TMDB', async () => {
    const { id, folderId } = seedLibrary('Live', 'D:\\Live', 'live_action')
    setItemDomain(folderId, 'live_action')
    const candidate = {
      tmdbId: 777, mediaType: 'tv' as const, title: 'Show', originalTitle: null,
      year: 2024, rating: null, genres: [], synopsis: null, seasons: 1,
      posterUrl: null, posterPath: null, genreIds: [18], mediaDomain: 'live_action' as const,
    }
    metadataMocks.searchTMDB.mockResolvedValue([candidate])
    metadataMocks.bindTMDB.mockImplementation(async (targetId: number, value: typeof candidate, targetDb: any) => {
      targetDb.prepare("UPDATE folders SET anilist_id = ?, source = 'tmdb', tmdb_media_type = ? WHERE id = ?")
        .run([value.tmdbId, value.mediaType, targetId])
      return makeFolderDb(targetDb).getById(targetId)
    })

    await start(id)

    expect(metadataMocks.searchTMDB).toHaveBeenCalled()
    expect(metadataMocks.searchBangumi).not.toHaveBeenCalled()
    expect(metadataMocks.searchAniList).not.toHaveBeenCalled()
    expect(metadataMocks.bindTMDB).toHaveBeenCalledWith(folderId, candidate, db, { rebuildCatalog: false, automatic: true })
    expect(db.prepare('SELECT source, anilist_id, tmdb_media_type FROM folders WHERE id = ?').get(folderId)).toEqual({
      source: 'tmdb', anilist_id: 777, tmdb_media_type: 'tv',
    })
  })

  it('routes anime auto matching through Bangumi before AniList', async () => {
    const { id, folderId } = seedLibrary('Anime', 'D:\\Anime', 'anime')
    setItemDomain(folderId, 'anime')
    const candidate = {
      bgmId: 778, title: 'Show', titleZh: null, year: 2024, rating: null,
      synopsis: null, posterUrl: null, posterPath: null, type: 2, episodes: 12,
      airedEpisodes: 12, airDate: '2024-01-01', airStatus: 'finished' as const, mediaDomain: 'anime' as const,
    }
    metadataMocks.searchBangumi.mockResolvedValue([candidate])
    metadataMocks.bindBangumi.mockImplementation(async (targetId: number, value: typeof candidate, targetDb: any) => {
      targetDb.prepare("UPDATE folders SET anilist_id = ?, source = 'bangumi', tmdb_media_type = NULL WHERE id = ?")
        .run([value.bgmId, targetId])
      return makeFolderDb(targetDb).getById(targetId)
    })

    await start(id)

    expect(metadataMocks.searchBangumi).toHaveBeenCalled()
    expect(metadataMocks.bindBangumi).toHaveBeenCalledWith(folderId, candidate, db, { rebuildCatalog: false, automatic: true })
    expect(metadataMocks.searchAniList).not.toHaveBeenCalled()
    expect(metadataMocks.searchTMDB).not.toHaveBeenCalled()
  })

  it('does not bind an anime candidate when Bangumi detail identity or type validation fails', async () => {
    const { id, folderId } = seedLibrary('Anime invalid detail', 'D:\\AnimeInvalid', 'anime')
    setItemDomain(folderId, 'anime')
    const candidate = {
      bgmId: 779, title: 'Show', titleZh: null, year: 2024, rating: 8,
      synopsis: 'verified search synopsis', posterUrl: null, posterPath: null, type: 2, episodes: 12,
      airedEpisodes: 12, airDate: '2024-01-01', airStatus: 'finished' as const, mediaDomain: 'anime' as const,
    }
    metadataMocks.searchBangumi.mockResolvedValue([candidate])
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = NULL, rating = 7.2, synopsis = '原有简介', year = 2018, episodes = 10 WHERE id = ?").run(folderId)
    const original = db.prepare('SELECT source, anilist_id, rating, synopsis, year, episodes FROM folders WHERE id = ?').get(folderId)

    for (const code of ['BANGUMI_DETAIL_ID_MISMATCH', 'BANGUMI_DETAIL_TYPE_MISMATCH'] as const) {
      metadataMocks.getBangumiDetail.mockReset().mockRejectedValue(Object.assign(new Error(code), { code }))
      await start(id, 'auto', 220)

      expect(metadataMocks.getBangumiDetail).toHaveBeenCalledWith(779, { expectedBangumiType: 2 })
      expect(metadataMocks.bindBangumi).not.toHaveBeenCalled()
      expect(metadataMocks.searchAniList).not.toHaveBeenCalled()
      expect(db.prepare('SELECT source, anilist_id, rating, synopsis, year, episodes FROM folders WHERE id = ?').get(folderId)).toEqual(original)
    }
  })

  it('matches only a validated selected root subtree and reports a stable job identity', async () => {
    const { id, folderId } = seedLibrary('Scoped anime', 'D:\\ScopedAnime', 'anime')
    setItemDomain(folderId, 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(id, ['D:\\ScopedAnime\\Show\\Season 1', 'D:\\ScopedAnime\\Other'])
    const rows = folderDb.getByLibrary(id)
    const season = rows.find(row => row.path === 'D:\\ScopedAnime\\Show\\Season 1')!
    const other = rows.find(row => row.path === 'D:\\ScopedAnime\\Other')!
    setItemDomain(season.id, 'anime')
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(other.id)
    makeFileDb(db).upsertMany(id, [
      { folder_id: season.id, path: `${season.path}\\01.mkv`, name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { folder_id: other.id, path: `${other.path}\\01.mkv`, name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' },
    ])
    const candidate = {
      bgmId: 880, title: 'Show', titleZh: null, year: 2024, rating: null,
      synopsis: null, posterUrl: null, posterPath: null, type: 2, episodes: 12,
      airedEpisodes: 12, airDate: '2024-01-01', airStatus: 'finished' as const, mediaDomain: 'anime' as const,
    }
    metadataMocks.searchBangumi.mockResolvedValue([candidate])
    metadataMocks.bindBangumi.mockImplementation(async (targetId: number, value: typeof candidate, targetDb: any) => {
      targetDb.prepare("UPDATE folders SET anilist_id = ?, source = 'bangumi' WHERE id = ?").run([value.bgmId, targetId])
      return makeFolderDb(targetDb).getById(targetId)
    })

    const { response, body } = await postMatch(id, { source: 'bangumi', folderIds: [folderId, folderId] })
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ running: true, folderIds: [folderId] })
    const status = await waitForIdle(id, 80, body.jobId)

    expect(status).toMatchObject({ jobId: body.jobId, folderIds: [folderId], status: 'completed', error: null, total: 2, done: 2, matched: 2, running: false })
    expect(db.prepare('SELECT anilist_id FROM folders WHERE id IN (?, ?) ORDER BY id').all([folderId, season.id])).toEqual([{ anilist_id: 880 }, { anilist_id: 880 }])
    expect(db.prepare('SELECT anilist_id FROM folders WHERE id = ?').get(other.id)).toEqual({ anilist_id: null })
  })

  it('rejects empty, malformed, nonexistent, and cross-library scopes without widening', async () => {
    const first = seedLibrary('First scope', 'D:\\FirstScope', 'anime')
    const second = seedLibrary('Second scope', 'D:\\SecondScope', 'anime')
    for (const value of [{ folderIds: [] }, { folderIds: ['1'] }, { folderIds: [999999] }, { folderIds: [second.folderId] }]) {
      const { response } = await postMatch(first.id, { source: 'bangumi', ...value })
      expect([400, 404]).toContain(response.status)
    }
    expect(metadataMocks.searchBangumi).not.toHaveBeenCalled()
    expect(db.prepare('SELECT anilist_id FROM folders WHERE id = ?').get(first.folderId)).toEqual({ anilist_id: null })
  })

  it('clears only a selected subtree in a transaction while retaining files and tags', async () => {
    const { id, folderId } = seedLibrary('Clear scope', 'D:\\ClearScope', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(id, ['D:\\ClearScope\\Show\\Season 1', 'D:\\ClearScope\\Other'])
    const rows = folderDb.getByLibrary(id)
    const season = rows.find(row => row.path === 'D:\\ClearScope\\Show\\Season 1')!
    const other = rows.find(row => row.path === 'D:\\ClearScope\\Other')!
    db.prepare("UPDATE folders SET anilist_id = 881, source = 'bangumi', synopsis = 'clear me' WHERE id IN (?, ?)").run([folderId, season.id])
    db.prepare("UPDATE folders SET anilist_id = 882, source = 'bangumi', synopsis = 'keep me' WHERE id = ?").run(other.id)
    makeFileDb(db).upsertMany(id, [{ folder_id: season.id, path: `${season.path}\\01.mkv`, name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    const file = makeFileDb(db).getByFolder(season.id)[0]
    const tag = makeTagDb(db).create('keep-tag')
    makeTagDb(db).link(tag.id, 'folder', season.id)

    const body = JSON.stringify({ folderIds: [folderId] })
    const response = await requestLocalHttp(server, `/api/libraries/${id}/clear-metadata`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, folderIds: [folderId] })
    expect(db.prepare('SELECT anilist_id, source, synopsis FROM folders WHERE id IN (?, ?) ORDER BY id').all([folderId, season.id])).toEqual([
      { anilist_id: null, source: '', synopsis: null }, { anilist_id: null, source: '', synopsis: null },
    ])
    expect(db.prepare('SELECT anilist_id, source, synopsis FROM folders WHERE id = ?').get(other.id)).toEqual({ anilist_id: 882, source: 'bangumi', synopsis: 'keep me' })
    expect(db.prepare('SELECT id FROM files WHERE id = ?').get(file.id)).toEqual({ id: file.id })
    expect(db.prepare("SELECT tag_id, target_type, target_id FROM tag_links WHERE tag_id = ?").all(tag.id)).toEqual([{ tag_id: tag.id, target_type: 'folder', target_id: season.id }])
  })

  it('keeps match jobs distinct and rejects a conflicting same-library spawn', async () => {
    const { id } = seedLibrary('Job identity', 'D:\\JobIdentity', 'anime')
    const jobFolder = makeFolderDb(db).getByLibrary(id).find(row => row.name === 'Show')!
    setItemDomain(jobFolder.id, 'anime')
    const candidate = {
      bgmId: 883, title: 'Show', titleZh: null, year: 2024, rating: null,
      synopsis: null, posterUrl: null, posterPath: null, type: 2, episodes: 12,
      airedEpisodes: 12, airDate: '2024-01-01', airStatus: 'finished' as const, mediaDomain: 'anime' as const,
    }
    let release!: (rows: unknown[]) => void
    const pending = new Promise<unknown[]>(resolve => { release = resolve })
    metadataMocks.searchBangumi.mockReturnValue(pending)
    const first = await postMatch(id, { source: 'bangumi' })
    expect(first.response.status).toBe(200)
    expect(first.body.jobId).toEqual(expect.any(String))
    const running = await requestLocalHttp(server, `/api/libraries/${id}/match-status?jobId=${encodeURIComponent(first.body.jobId)}`)
    expect(running.status).toBe(200)
    expect((await running.json()).jobId).toBe(first.body.jobId)
    const conflict = await postMatch(id, { source: 'bangumi' })
    expect(conflict.response.status).toBe(409)
    release([candidate])
    await waitForIdle(id, 120, first.body.jobId)
  })

  it('completes unknown-library automatic matching conservatively', async () => {
    const { id } = seedLibrary('Unknown type', 'D:\\UnknownType', 'mystery')
    const started = await postMatch(id, { source: 'auto' })
    expect(started.response.status).toBe(200)
    const status = await waitForIdle(id, 300, started.body.jobId)
    expect(status).toMatchObject({ status: 'completed', running: false, error: null, failed: 1, finishedAt: expect.any(Number) })
  })
})
