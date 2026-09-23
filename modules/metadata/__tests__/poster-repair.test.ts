import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDb } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { ModuleRuntime } from '../../../server/core/module-runtime'
import type { ModuleManifest } from '../../../shared/modules'
import metadataManifest from '../manifest.json'
import type { MetadataRequestOptions } from '../server/metadata'
import { PosterRepairService, posterFailure } from '../server/poster-repair'

describe('poster repair jobs', () => {
  let db: ReturnType<typeof createDb>
  let controller: AbortController
  let track: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = createDb(':memory:')
    controller = new AbortController()
    track = vi.fn(<T,>(operation: Promise<T>) => operation)
  })

  function folders(libraryId: number, paths: string[]) {
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(libraryId, paths)
    return folderDb.getByLibrary(libraryId)
  }

  it('uses the database library scope, includes descendants, and deduplicates source plus id', async () => {
    const first = makeLibraryDb(db).create('A', 'D:\\A', 'anime')
    const second = makeLibraryDb(db).create('B', 'D:\\B', 'anime')
    const firstRows = folders(first.id, ['D:\\A', 'D:\\A\\Series', 'D:\\A\\Series\\Season 1'])
    const secondRows = folders(second.id, ['D:\\B', 'D:\\B\\Other'])
    for (const row of firstRows.filter(row => row.path !== 'D:\\A')) db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 42 WHERE id = ?").run(row.id)
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 99 WHERE id = ?").run(secondRows.at(-1)!.id)
    const fetchPoster = vi.fn(async () => 'https://example.com/42.jpg')
    const cache = vi.fn(async () => '/posters/al_42.jpg')
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null, fetchAnilistPoster: fetchPoster, cache })

    const started = service.start({ libraryId: first.id })
    const job = await service.wait(started.jobId)

    expect(job).toMatchObject({ status: 'completed', total: 1, processed: 1, repaired: 1, failed: 0 })
    expect(fetchPoster).toHaveBeenCalledTimes(1)
    expect(cache).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT has_poster FROM folders WHERE anilist_id = 42 ORDER BY id').all()).toEqual([{ has_poster: 1 }, { has_poster: 1 }])
    expect(db.prepare('SELECT has_poster FROM folders WHERE anilist_id = 99').get()).toEqual({ has_poster: 0 })
  })

  it('freezes selected roots for retries, rejects empty scopes, and never writes outside them', async () => {
    const first = makeLibraryDb(db).create('A', 'D:\\PosterScopeA', 'anime')
    const second = makeLibraryDb(db).create('B', 'D:\\PosterScopeB', 'anime')
    const firstRows = folders(first.id, ['D:\\PosterScopeA', 'D:\\PosterScopeA\\Selected', 'D:\\PosterScopeA\\Other'])
    const secondRows = folders(second.id, ['D:\\PosterScopeB', 'D:\\PosterScopeB\\Other'])
    const selected = firstRows.find(row => row.name === 'Selected')!
    const outside = firstRows.find(row => row.name === 'Other')!
    const crossLibrary = secondRows.find(row => row.name === 'Other')!
    for (const row of [selected, outside, crossLibrary]) {
      db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 42, has_poster = 0 WHERE id = ?").run(row.id)
    }
    const cache = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('/posters/al_42.jpg')
    const service = new PosterRepairService({
      db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null,
      fetchAnilistPoster: async () => 'https://example.com/42.jpg', cache,
    })

    expect(() => service.start({ folderIds: [] })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => service.start({ folderIds: [999999] })).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => service.start({ folderIds: [selected.id], includeFavorites: true })).toThrow(expect.objectContaining({ status: 400 }))

    const firstJob = service.start({ folderIds: [selected.id] })
    expect(firstJob).toMatchObject({ folderIds: [selected.id] })
    const failed = await service.wait(firstJob.jobId)
    expect(failed).toMatchObject({ total: 1, failed: 1, folderIds: [selected.id] })
    expect(db.prepare('SELECT has_poster FROM folders WHERE id IN (?, ?) ORDER BY id').all([outside.id, crossLibrary.id])).toEqual([{ has_poster: 0 }, { has_poster: 0 }])

    const added = folders(first.id, ['D:\\PosterScopeA\\Selected\\NewSeason']).at(-1)!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 42, has_poster = 0 WHERE id = ?").run(added.id)
    const retry = service.retry(failed.jobId)
    const completed = await service.wait(retry.jobId)

    expect(completed).toMatchObject({ retryOf: failed.jobId, folderIds: [selected.id], total: 1, failed: 0, repaired: 1 })
    expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(selected.id)).toEqual({ has_poster: 1 })
    expect(db.prepare('SELECT has_poster FROM folders WHERE id IN (?, ?) ORDER BY id').all([added.id, outside.id])).toEqual([{ has_poster: 0 }, { has_poster: 0 }])
    expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(crossLibrary.id)).toEqual({ has_poster: 0 })
  })

  it('repairs has_poster from a valid cached file without downloading', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'anime')
    const row = folders(library.id, ['D:\\A', 'D:\\A\\Series']).at(-1)!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 7, has_poster = 0 WHERE id = ?").run(row.id)
    const fetchPoster = vi.fn()
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => '/posters/bg_7.jpg', fetchBangumiDetail: fetchPoster })

    const started = service.start({ libraryId: library.id })
    const job = await service.wait(started.jobId)

    expect(job).toMatchObject({ total: 1, repaired: 0, skipped: 1, failed: 0 })
    expect(fetchPoster).not.toHaveBeenCalled()
    expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(row.id)).toEqual({ has_poster: 1 })
  })

  it('counts a forced refresh failure while preserving prior poster state', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'anime')
    const row = folders(library.id, ['D:\\A', 'D:\\A\\Series']).at(-1)!
    db.prepare("UPDATE folders SET source = 'tmdb', anilist_id = 8, tmdb_media_type = 'movie', has_poster = 1 WHERE id = ?").run(row.id)
    const cache = vi.fn(async () => null)
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => '/posters/tm_movie_8.jpg', fetchTMDBPoster: async () => 'https://example.com/8.jpg', cache })

    const started = service.start({ libraryId: library.id, mode: 'refresh' })
    const job = await service.wait(started.jobId)

    expect(job).toMatchObject({ status: 'completed', repaired: 0, failed: 1 })
    expect(job.failures[0].reason).toContain('已保留原海报')
    expect(cache).toHaveBeenCalledWith('https://example.com/8.jpg', 'tm_movie_8', expect.objectContaining({ force: true }))
    expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(row.id)).toEqual({ has_poster: 1 })
  })

  it('does not merge TMDB movie and TV targets that share a numeric id', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'live_action')
    const rows = folders(library.id, ['D:\\A', 'D:\\A\\Movie', 'D:\\A\\TV'])
    db.prepare("UPDATE folders SET source = 'tmdb', anilist_id = 8, tmdb_media_type = 'movie' WHERE id = ?").run(rows[1].id)
    db.prepare("UPDATE folders SET source = 'tmdb', anilist_id = 8, tmdb_media_type = 'tv' WHERE id = ?").run(rows[2].id)
    const fetchPoster = vi.fn(async (_id: number, options?: MetadataRequestOptions) => `https://example.com/${options?.tmdbMediaType}.jpg`)
    const cache = vi.fn(async (_url: string, id: string) => `/posters/${id}.jpg`)
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null, fetchTMDBPoster: fetchPoster, cache })

    const started = service.start({ libraryId: library.id })
    const job = await service.wait(started.jobId)

    expect(job).toMatchObject({ status: 'completed', total: 2, repaired: 2, failed: 0 })
    expect(fetchPoster.mock.calls.map(call => call[1]?.tmdbMediaType).sort()).toEqual(['movie', 'tv'])
    expect(cache.mock.calls.map(call => call[1]).sort()).toEqual(['tm_movie_8', 'tm_tv_8'])
  })

  it('preserves an existing legacy poster when a TMDB row has no media type', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'live_action')
    const row = folders(library.id, ['D:\\A', 'D:\\A\\Movie']).at(-1)!
    db.prepare("UPDATE folders SET source = 'tmdb', anilist_id = 8, tmdb_media_type = NULL, has_poster = 1 WHERE id = ?").run(row.id)
    const posterDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-legacy-tmdb-'))
    const legacyFile = path.join(posterDirectory, 'tm_8.jpg')
    fs.writeFileSync(legacyFile, 'legacy')
    const fetchPoster = vi.fn()
    const cache = vi.fn()
    try {
      const service = new PosterRepairService({
        db, signal: controller.signal, track, delayMs: 0, posterDirectory,
        cachedPath: vi.fn(() => '/posters/tm_8.jpg'), fetchTMDBPoster: fetchPoster, cache,
      })

      const started = service.start({ libraryId: library.id, mode: 'refresh' })
      const job = await service.wait(started.jobId)

      expect(job).toMatchObject({ status: 'completed', total: 1, skipped: 0, repaired: 0, failed: 1 })
      expect(job.failures[0]).toMatchObject({ code: 'SOURCE_CONFIRMATION_REQUIRED', retryable: false, folderIds: [row.id] })
      expect(() => service.retry(job.jobId)).toThrow('没有可重试')
      const missing = await service.wait(service.start({ libraryId: library.id, mode: 'missing' }).jobId)
      expect(missing).toMatchObject({ total: 1, skipped: 1, repaired: 0, failed: 0 })
      expect(fetchPoster).not.toHaveBeenCalled()
      expect(cache).not.toHaveBeenCalled()
      expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(row.id)).toEqual({ has_poster: 1 })
      expect(fs.existsSync(legacyFile)).toBe(true)
    } finally {
      fs.rmSync(posterDirectory, { recursive: true, force: true })
    }
  })

  it('does not write a completed download onto a changed metadata binding and holds the maintenance lock', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'anime')
    const row = folders(library.id, ['D:\\A', 'D:\\A\\Series']).at(-1)!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 10 WHERE id = ?").run(row.id)
    let resolvePoster!: (url: string) => void
    const poster = new Promise<string>(resolve => { resolvePoster = resolve })
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null, fetchAnilistPoster: async () => poster, cache: async () => '/posters/al_10.jpg' })

    const started = service.start({ libraryId: library.id })
    expect(() => service.start({ libraryId: library.id })).toThrow(expect.objectContaining({ code: 'LIBRARY_BUSY' }))
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 11, has_poster = 0 WHERE id = ?").run(row.id)
    resolvePoster('https://example.com/10.jpg')
    await service.wait(started.jobId)

    expect(db.prepare('SELECT source, anilist_id, has_poster FROM folders WHERE id = ?').get(row.id)).toEqual({ source: 'bangumi', anilist_id: 11, has_poster: 0 })
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('retries only the prior failures in a new observable job', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'anime')
    const row = folders(library.id, ['D:\\A', 'D:\\A\\Series']).at(-1)!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 12 WHERE id = ?").run(row.id)
    const cache = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('/posters/al_12.jpg')
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null, fetchAnilistPoster: async () => 'https://example.com/12.jpg', cache })

    const first = service.start({ libraryId: library.id })
    const failed = await service.wait(first.jobId)
    const retry = service.retry(failed.jobId)
    const completed = await service.wait(retry.jobId)

    expect(failed).toMatchObject({ failed: 1, repaired: 0 })
    expect(completed).toMatchObject({ retryOf: failed.jobId, total: 1, failed: 0, repaired: 1 })
    expect(cache).toHaveBeenCalledTimes(2)
  })

  it('keeps source-confirmation failures out of retries and freezes legacy all-library roots', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\RetryFreeze', 'live_action')
    const rows = folders(library.id, ['D:\\RetryFreeze', 'D:\\RetryFreeze\\Old', 'D:\\RetryFreeze\\Network'])
    const old = rows.find(row => row.name === 'Old')!, network = rows.find(row => row.name === 'Network')!
    db.prepare("UPDATE folders SET source='tmdb', anilist_id=8, tmdb_media_type=NULL WHERE id=?").run(old.id)
    db.prepare("UPDATE folders SET source='bangumi', anilist_id=9 WHERE id=?").run(network.id)
    const cache = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private provider url with secret'), { code: 'ECONNRESET' })).mockResolvedValue('/posters/bg_9.jpg')
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null, cache, fetchBangumiDetail: async () => ({ posterUrl: 'https://lain.bgm.tv/9.jpg' }) })
    const failed = await service.wait(service.start().jobId)
    expect(failed).toMatchObject({ total: 2, failed: 2, skipped: 0 })
    expect(failed.failures.map(failure => [failure.code, failure.retryable])).toEqual([['SOURCE_CONFIRMATION_REQUIRED', false], ['NETWORK_ERROR', true]])
    expect(JSON.stringify(failed)).not.toContain('secret')
    const newRow = folders(library.id, ['D:\\RetryFreeze\\New']).find(row => row.name === 'New')!
    db.prepare("UPDATE folders SET source='bangumi', anilist_id=9 WHERE id=?").run(newRow.id)
    const completed = await service.wait(service.retry(failed.jobId).jobId)
    expect(completed).toMatchObject({ total: 1, repaired: 1, failed: 0 })
    expect(makeFolderDb(db).getById(newRow.id)?.has_poster).toBe(0)
    expect(makeFolderDb(db).getById(old.id)).toMatchObject({ anilist_id: 8, source: 'tmdb', tmdb_media_type: null })
  })

  it('classifies failures without exposing provider URLs or credentials', () => {
    expect(posterFailure({ code: 'BANGUMI_DETAIL_TYPE_MISMATCH', message: 'private' })).toMatchObject({ code: 'SOURCE_CONFIRMATION_REQUIRED', retryable: false })
    expect(posterFailure({ code: 'CERT_HAS_EXPIRED' })).toMatchObject({ code: 'TLS_ERROR', retryable: false })
    expect(posterFailure({ code: 'ERR_REMOTE_IMAGE_VALIDATION' })).toMatchObject({ code: 'IMAGE_REJECTED', retryable: false })
    expect(posterFailure({ code: 'SOURCE_NO_POSTER' })).toMatchObject({ code: 'SOURCE_NO_POSTER', retryable: false })
    expect(posterFailure({ code: 'IMAGE_PROXY_CONNECT' })).toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
  })

  it('does not guess AniList for an unsupported source or fetch an invalid binding', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\InvalidSource', 'anime')
    const rows = folders(library.id, ['D:\\InvalidSource\\Unknown', 'D:\\InvalidSource\\Invalid'])
    const unknown = rows.find(row => row.name === 'Unknown')!, invalid = rows.find(row => row.name === 'Invalid')!
    db.prepare("UPDATE folders SET source='unsupported', anilist_id=12, has_poster=1 WHERE id=?").run(unknown.id)
    db.prepare("UPDATE folders SET source='anilist', anilist_id=-1, has_poster=1 WHERE id=?").run(invalid.id)
    const fetchPoster = vi.fn()
    const cache = vi.fn()
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, fetchAnilistPoster: fetchPoster, cache })
    const job = await service.wait(service.start({ libraryId: library.id }).jobId)
    expect(job).toMatchObject({ total: 2, failed: 2, repaired: 0, skipped: 0 })
    expect(job.failures.every(failure => failure.code === 'SOURCE_CONFIRMATION_REQUIRED' && !failure.retryable)).toBe(true)
    expect(fetchPoster).not.toHaveBeenCalled()
    expect(cache).not.toHaveBeenCalled()
    expect(makeFolderDb(db).getById(unknown.id)).toMatchObject({ source: 'unsupported', anilist_id: 12, has_poster: 1 })
    expect(makeFolderDb(db).getById(invalid.id)).toMatchObject({ source: 'anilist', anilist_id: -1, has_poster: 1 })
  })

  it('cancels tracked work when the module signal aborts', async () => {
    const library = makeLibraryDb(db).create('A', 'D:\\A', 'anime')
    const row = folders(library.id, ['D:\\A', 'D:\\A\\Series']).at(-1)!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 13 WHERE id = ?").run(row.id)
    const fetchPoster = (_id: number, options?: MetadataRequestOptions) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
    })
    const service = new PosterRepairService({ db, signal: controller.signal, track, delayMs: 0, cachedPath: () => null, fetchAnilistPoster: fetchPoster })

    const started = service.start({ libraryId: library.id })
    controller.abort()
    const job = await service.wait(started.jobId)

    expect(job.status).toBe('cancelled')
    expect(db.prepare('SELECT has_poster FROM folders WHERE id = ?').get(row.id)).toEqual({ has_poster: 0 })
  })

  it('keeps the declared background job routes valid in the module runtime', async () => {
    const runtime = new ModuleRuntime(db, [metadataManifest as ModuleManifest], {
      metadata: () => import('../server'),
    })
    try {
      await runtime.start()
      expect(runtime.snapshot().modules[0]).toMatchObject({ id: 'metadata', active: true })
      expect(runtime.routes()).toHaveLength(4)
    } finally {
      await runtime.stop()
    }
  })
})
