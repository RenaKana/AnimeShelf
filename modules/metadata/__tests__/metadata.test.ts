import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDb, ensureSystemTags, POSTER_DIR } from '../../../server/db/schema'
import { makeLibraryDb } from '../../../server/db/libraries'
import { makeFolderDb } from '../../../server/db/folders'
import {
  searchAniList, searchBangumi, searchTMDB, bindAnilist, getAniListDetail, getBangumiDetail, inferBangumiAirStatus,
  cachePoster, fetchRemoteImage, isValidPosterImage, pickBangumiCandidate, pickAutomaticMetadataCandidate, preferBangumiSynopsis,
  bindTMDB, assertCandidateMatchesFolder, mergeBangumiDetail, getAnilistPosterUrl, getTMDBDetail, getTMDBPoster,
} from '../server/metadata'
import { mediaDomainForBangumiType, mediaDomainForLibrary, mediaDomainForTMDB } from '../../../shared/media-domain'
import { anilistIdOf, bangumiIdOf, tmdbIdOf } from '../../season/server/airing'
import { metadataSourcesFor } from '../server/libraries'
import { providerRateLimitGate } from '../../../server/services/provider-rate-limit'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: vi.fn<() => string | null>(() => null) } }))
const mockDnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]))
const mockResolveProxy = vi.hoisted(() => vi.fn<(target: string) => import('../../../server/services/proxy').ProxyRoute>(() => ({ mode: 'direct' as const, source: 'direct' as const, revision: 'test:direct' })))
const mockNetworkFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../server/db/instance', () => mockedInstance)
vi.mock('../../../server/services/image-proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/image-proxy')>(),
  getImageProxy: () => null,
}))

vi.mock('../../../server/services/proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/proxy')>(),
  resolveProxy: mockResolveProxy,
}))
vi.mock('../../../server/services/network', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/network')>(),
  networkFetch: mockNetworkFetch,
}))

vi.mock('axios', () => {
  const post = vi.fn()
  const get = vi.fn().mockResolvedValue({ data: new Uint8Array() })
  // create 返回与顶层共享 post/get 的假实例（metadata.ts 用 axios.create 建 http 实例）
  return { default: { post, get, create: vi.fn(() => ({ post, get, defaults: {} })) } }
})

vi.mock('node:dns/promises', () => ({ lookup: mockDnsLookup }))

import axios from 'axios'
import { ProxyError } from '../../../server/services/proxy'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'
const mockHttp = axios.create({}) as unknown as { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }
const mockPost = mockHttp.post
const mockGet = mockHttp.get
const JPEG_IMAGE = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//9k=', 'base64')
const PNG_IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const WEBP_IMAGE = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

describe('metadata', () => {
  let db: any
  beforeEach(() => {
    providerRateLimitGate.reset()
    mockedInstance.settingsDb.get.mockReset().mockReturnValue(null)
    db = createDb(':memory:')
    mockedInstance.db = db
    ensureSystemTags(db)
    bindTestModuleCapabilities(db)
    mockPost.mockReset()
    mockGet.mockReset()
    mockResolveProxy.mockReset().mockReturnValue({ mode: 'direct', source: 'direct', revision: 'test:direct' })
    mockNetworkFetch.mockReset().mockImplementation(async (input: any, init: any) => globalThis.fetch(input, init))
  })
  afterEach(() => { vi.restoreAllMocks(); providerRateLimitGate.reset() })

  it('stops TMDB search at a direct 429 and shares cooldown without blocking AniList', async () => {
    mockGet.mockRejectedValueOnce({ response: { status: 429, headers: { 'Retry-After': '12' } } })
    await expect(searchTMDB('synthetic first', 'test-key')).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED', response: { status: 429 }, retryAfterSeconds: 12 })
    await expect(searchTMDB('synthetic second', 'test-key')).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED' })
    expect(mockGet).toHaveBeenCalledTimes(1)
    mockPost.mockResolvedValue({ data: { data: { Page: { media: [] } } } })
    await expect(searchAniList('synthetic')).resolves.toEqual([])
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('keeps routed TMDB 429 responses intact and shares the cooldown across endpoints', async () => {
    mockResolveProxy.mockReturnValue({ mode: 'manual', source: 'manual', revision: 'test:proxy', proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, url: 'http://127.0.0.1:7890' } })
    mockGet.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': '9' } }, config: { params: { api_key: 'fixture-private-key' } } })
    await expect(searchTMDB('synthetic', 'test-key')).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED', retryAfterSeconds: 9 })
    mockedInstance.settingsDb.get.mockReturnValue('test-key')
    await expect(getTMDBDetail(1, 'movie')).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED' })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it.each(['detail', 'poster'] as const)('does not hide or immediately retry a TMDB %s rate limit', async kind => {
    mockedInstance.settingsDb.get.mockReturnValue('test-key')
    mockGet.mockRejectedValueOnce({ response: { status: 429, headers: { 'Retry-After': '5' } } })
    const request = kind === 'detail' ? getTMDBDetail(1, 'movie') : getTMDBPoster(1, { tmdbMediaType: 'movie' })
    await expect(request).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED', response: { status: 429 } })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('propagates AniList detail limits and blocks later search calls during cooldown', async () => {
    mockPost.mockRejectedValue({ response: { status: 429, headers: { 'Retry-After': '5' } } })
    await expect(getAniListDetail(1)).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED' })
    await expect(searchAniList('synthetic')).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED' })
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('does not turn an AniList GraphQL rate limit into a missing poster', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: null, errors: [{ status: 429 }] }), { status: 200, headers: { 'Retry-After': '7' } }))
    await expect(getAnilistPosterUrl(1)).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED', retryAfterSeconds: 7 })
    await expect(getAniListDetail(1)).rejects.toMatchObject({ code: 'SOURCE_RATE_LIMITED' })
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('surfaces a TMDB connection failure without retrying another route', async () => {
    mockGet.mockRejectedValueOnce(Object.assign(new Error('connection failed'), { code: 'ECONNRESET' }))
    await expect(searchTMDB('synthetic', 'test-key')).rejects.toMatchObject({ code: 'NETWORK_CONNECTION_FAILED' })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('does not make a direct or proxy request after search cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(searchTMDB('synthetic', 'test-key', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('distinguishes an invalid AniList binding from a valid work with no poster and a temporary provider error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { Media: null }, errors: [{ status: 404 }] }) } as Response)
      await expect(getAnilistPosterUrl(123, { throwOnError: true })).rejects.toMatchObject({ code: 'SOURCE_CONFIRMATION_REQUIRED' })
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { Media: { coverImage: null } } }) } as Response)
      await expect(getAnilistPosterUrl(123, { throwOnError: true })).resolves.toBeNull()
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ data: null, errors: [{ status: 503 }] }) } as Response)
      await expect(getAnilistPosterUrl(123, { throwOnError: true })).rejects.toMatchObject({ response: { status: 503 } })
    } finally { fetchSpy.mockRestore() }
  })

  it('searchAniList maps GraphQL Page response to multiple candidates', async () => {
    mockPost.mockResolvedValue({ data: { data: { Page: { media: [
      { id: 1, title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
        coverImage: { extraLarge: 'https://img.anilist.co/x.jpg', large: null },
        startDate: { year: 2013 }, averageScore: 84, genres: ['Action'], description: '<p>hi</p>', episodes: 25 },
      { id: 2, title: { romaji: 'Y', english: null, native: 'ネイティブ' },
        coverImage: { extraLarge: null, large: 'https://img.anilist.co/l.jpg' },
        startDate: { year: null }, averageScore: 0, genres: [], description: null, episodes: null },
    ] } } } })
    const r = await searchAniList('进击的巨人')
    expect(r).toHaveLength(2)
    expect(r[0].anilistId).toBe(1)
    expect(r[0].title).toBe('Attack on Titan')
    expect(r[0].originalTitle).toBe('進撃の巨人')
    expect(r[0].year).toBe(2013)
    expect(r[0].rating).toBe(8.4)
    expect(r[0].synopsis).toBe('hi')
    expect(r[0].genres).toEqual(['Action'])
    expect(r[0].episodes).toBe(25)
    expect(r[0].posterUrl).toBe('https://img.anilist.co/x.jpg')
    // 第二候选：title 回退 romaji、评分 0 不被误判为 null、poster 回退 large
    expect(r[1].anilistId).toBe(2)
    expect(r[1].title).toBe('Y')
    expect(r[1].originalTitle).toBe('ネイティブ')
    expect(r[1].year).toBeNull()
    expect(r[1].rating).toBe(0)
    expect(r[1].synopsis).toBeNull()
    expect(r[1].episodes).toBeNull()
    expect(r[1].posterUrl).toBe('https://img.anilist.co/l.jpg')
  })

  it('searchAniList returns [] on failure', async () => {
    mockPost.mockRejectedValue(new Error('net'))
    await expect(searchAniList('x')).rejects.toMatchObject({ code: 'NETWORK_CONNECTION_FAILED' })
  })

  it('keeps an exact localized TMDB movie match beyond the mixed-result cutoff', async () => {
    const earlierResults = [
      { id: 97976, media_type: 'tv', name: '新世界', original_name: '新世界', first_air_date: '2020-01-13' },
      { id: 53052, media_type: 'tv', name: '来自新世界', original_name: '新世界より', first_air_date: '2012-09-29' },
      { id: 254363, media_type: 'tv', name: '魔方新世界', original_name: '魔方新世界', first_air_date: '2024-05-15' },
      { id: 103516, media_type: 'tv', name: '星际迷航：奇异新世界', original_name: 'Star Trek: Strange New Worlds', first_air_date: '2022-05-05' },
      { id: 108433, media_type: 'movie', title: '爱的新世界', original_title: '愛の新世界', release_date: '1994-12-17' },
      { id: 320983, media_type: 'movie', title: '三人新世界', original_title: '三人新世界', release_date: '1990-01-24' },
      { id: 225887, media_type: 'tv', name: '外婆的新世界', original_name: '外婆的新世界', first_air_date: '2023-05-07' },
      { id: 653346, media_type: 'movie', title: '猩球崛起：新世界', original_title: 'Kingdom of the Planet of the Apes', release_date: '2024-05-08' },
    ]
    mockGet.mockResolvedValue({ data: { results: [
        ...earlierResults,
        { id: 165213, media_type: 'movie', title: '新世界', original_title: '신세계', release_date: '2013-02-21' },
      ] } })
    const result = await searchTMDB('新世界', 'test-key')
    expect(result).toHaveLength(8)
    expect(result.map(candidate => candidate.tmdbId)).toContain(165213)
  })

  it('forwards cancellation to AniList search and detail without turning it into no results', async () => {
    const controller = new AbortController()
    const cancelled = Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })
    mockPost.mockRejectedValue(cancelled)
    await expect(searchAniList('test', { signal: controller.signal })).rejects.toBe(cancelled)
    expect(mockPost.mock.calls[0][2].signal).toBe(controller.signal)
    await expect(getAniListDetail(1, { signal: controller.signal })).rejects.toBe(cancelled)
    expect(mockPost.mock.calls[1][2].signal).toBe(controller.signal)
  })

  it('does not retry proxies or a legacy endpoint when Bangumi search is cancelled', async () => {
    const controller = new AbortController()
    const cancelled = Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })
    mockPost.mockRejectedValue(cancelled)
    await expect(searchBangumi('test', { signal: controller.signal })).rejects.toBe(cancelled)
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockPost.mock.calls[0][2].signal).toBe(controller.signal)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('carries the cancellation signal through the normal Bangumi legacy fallback', async () => {
    const controller = new AbortController()
    mockPost.mockRejectedValue(Object.assign(new Error('v0 not found'), { response: { status: 404 } }))
    mockGet.mockResolvedValue({ data: { list: [{ id: 1, type: 2, name: 'Anime' }] } })
    expect(await searchBangumi('test', { signal: controller.signal, maxResponseBytes: 1024 })).toHaveLength(1)
    expect(mockGet.mock.calls[0][1].signal).toBe(controller.signal)
    expect(mockPost.mock.calls[0][2].maxContentLength).toBe(1024)
    expect(mockGet.mock.calls[0][1].maxContentLength).toBe(1024)
  })

  it('searchBangumi only keeps anime and live-action subjects', async () => {
    mockPost.mockResolvedValue({ data: { data: [
      { id: 1, type: 1, name: '同名书籍' },
      { id: 2, type: 2, name: '动画' },
      { id: 3, type: 3, name: '音乐' },
      { id: 4, type: 4, name: '游戏' },
      { id: 6, type: 6, name: '真人影视' },
    ] } })

    const result = await searchBangumi('同名作品')

    expect(result.map(item => item.bgmId)).toEqual([2, 6])
    expect(result.map(item => item.type)).toEqual([2, 6])
  })

  it('filters Bangumi subjects to the target media domain', async () => {
    mockPost.mockResolvedValue({ data: { data: [
      { id: 20, type: 2, name: '动画版本' },
      { id: 60, type: 6, name: '真人版本' },
    ] } })

    expect((await searchBangumi('同名作品', { mediaDomain: 'anime' })).map(item => item.bgmId)).toEqual([20])
    expect((await searchBangumi('同名作品', { mediaDomain: 'live_action' })).map(item => item.bgmId)).toEqual([60])
  })

  it('does not call AniList for a live-action target library', async () => {
    expect(await searchAniList('真人作品', { mediaDomain: 'live_action' })).toEqual([])
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('classifies TMDB animation separately and refuses unknown genre evidence for domain filtering', async () => {
    mockGet.mockResolvedValue({ data: { results: [
        { id: 1, media_type: 'movie', title: '动画电影', genre_ids: [16], release_date: '2024-01-01' },
        { id: 2, media_type: 'tv', name: '真人剧集', genre_ids: [18], first_air_date: '2024-01-01' },
        { id: 3, media_type: 'movie', title: '类型未知', release_date: '2024-01-01' },
      ] } })
    const all = await searchTMDB('同名作品', 'test-key')
    expect(all.map(item => [item.tmdbId, item.mediaDomain])).toEqual([
      [1, 'anime'], [2, 'live_action'], [3, 'unknown'],
    ])
    expect((await searchTMDB('同名作品', 'test-key', { mediaDomain: 'anime' })).map(item => item.tmdbId)).toEqual([1])
    expect((await searchTMDB('同名作品', 'test-key', { mediaDomain: 'live_action' })).map(item => item.tmdbId)).toEqual([2])
  })

  it('allows manual cross-domain metadata but rejects automatic mismatch and insufficient TMDB evidence', async () => {
    const live = makeLibraryDb(db).create('真人影视', 'D:\\Live', 'live_action')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(live.id, ['D:\\Live', 'D:\\Live\\作品'])
    const folder = folderDb.getByLibrary(live.id).find((row: any) => row.name === '作品')!
    db.prepare("UPDATE folders SET media_domain_override = 'live_action' WHERE id = ?").run(folder.id)

    expect(mediaDomainForLibrary(live)).toBe('live_action')
    expect(mediaDomainForBangumiType(2)).toBe('anime')
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: [16] })).toBe('anime')
    expect(() => assertCandidateMatchesFolder(db, folder.id, 'bangumi', {
      bgmId: 2, type: 2,
    })).not.toThrow()
    expect(() => assertCandidateMatchesFolder(db, folder.id, 'bangumi', {
      bgmId: 2, type: 2,
    }, true)).toThrowError(/与条目当前真人影视分类不符/)
    await expect(bindTMDB(folder.id, {
      tmdbId: 3, mediaType: 'movie', title: '未知', originalTitle: null, year: null,
      rating: null, genres: [], synopsis: null, seasons: null, posterUrl: null, posterPath: null,
    }, db)).rejects.toThrowError(/候选缺少可确认/)
  })

  it('rechecks the current domain after a manual TMDB poster fetch', async () => {
    const live = makeLibraryDb(db).create('并发真人影视', 'D:\\ConcurrencyLive', 'live_action')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(live.id, ['D:\\ConcurrencyLive', 'D:\\ConcurrencyLive\\作品'])
    const folder = folderDb.getByLibrary(live.id).find((row: any) => row.name === '作品')!
    db.prepare("UPDATE folders SET media_domain_override = 'live_action' WHERE id = ?").run(folder.id)

    const tmdbId = 910_000_000 + process.pid * 2 + 1
    const posterUrl = `https://example.com/metadata-concurrency-manual-${tmdbId}.jpg`
    const posterFile = path.join(POSTER_DIR, `tm_movie_${tmdbId}.jpg`)
    const candidate = {
      tmdbId, mediaType: 'movie' as const, title: '并发真人作品', originalTitle: null, year: 2026,
      rating: 7.5, genres: [], synopsis: '并发测试', seasons: null,
      posterUrl, posterPath: null, genreIds: [18], mediaDomain: 'live_action' as const,
    }
    let posterFetchStarted!: () => void
    let resolvePosterFetch!: (value: unknown) => void
    const fetchStarted = new Promise<void>(resolve => { posterFetchStarted = resolve })
    const posterResponse = new Promise<unknown>(resolve => { resolvePosterFetch = resolve })
    mockGet.mockImplementationOnce(async () => {
      posterFetchStarted()
      return posterResponse
    })

    try {
      const binding = bindTMDB(folder.id, candidate, db)
      await fetchStarted
      db.prepare("UPDATE folders SET media_domain_override = 'anime' WHERE id = ?").run(folder.id)
      resolvePosterFetch({ status: 200, data: JPEG_IMAGE, headers: { 'content-type': 'image/jpeg' } })

      const updated = await binding

      expect(updated.source).toBe('tmdb')
      expect(updated.anilist_id).toBe(tmdbId)
      expect(updated.tmdb_media_type).toBe('movie')
      expect(updated.has_poster).toBe(1)
      expect(folderDb.getById(folder.id)?.media_domain_override).toBe('anime')
    } finally {
      fs.rmSync(posterFile, { force: true })
    }
  })

  it('rejects an automatic TMDB bind when the domain changes during poster fetch', async () => {
    const live = makeLibraryDb(db).create('自动并发真人影视', 'D:\\ConcurrencyAutoLive', 'live_action')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(live.id, ['D:\\ConcurrencyAutoLive', 'D:\\ConcurrencyAutoLive\\作品'])
    const folder = folderDb.getByLibrary(live.id).find((row: any) => row.name === '作品')!
    db.prepare("UPDATE folders SET media_domain_override = 'live_action' WHERE id = ?").run(folder.id)
    const originalMetadata = db.prepare('SELECT source, anilist_id, tmdb_media_type, has_poster FROM folders WHERE id = ?').get(folder.id)

    const tmdbId = 910_000_000 + process.pid * 2 + 2
    const posterUrl = `https://example.com/metadata-concurrency-auto-${tmdbId}.jpg`
    const posterFile = path.join(POSTER_DIR, `tm_movie_${tmdbId}.jpg`)
    const candidate = {
      tmdbId, mediaType: 'movie' as const, title: '自动并发真人作品', originalTitle: null, year: 2026,
      rating: 7.5, genres: [], synopsis: '并发测试', seasons: null,
      posterUrl, posterPath: null, genreIds: [18], mediaDomain: 'live_action' as const,
    }
    let posterFetchStarted!: () => void
    let resolvePosterFetch!: (value: unknown) => void
    const fetchStarted = new Promise<void>(resolve => { posterFetchStarted = resolve })
    const posterResponse = new Promise<unknown>(resolve => { resolvePosterFetch = resolve })
    mockGet.mockImplementationOnce(async () => {
      posterFetchStarted()
      return posterResponse
    })

    try {
      const binding = bindTMDB(folder.id, candidate, db, { automatic: true })
      await fetchStarted
      db.prepare("UPDATE folders SET media_domain_override = 'anime' WHERE id = ?").run(folder.id)
      resolvePosterFetch({ status: 200, data: JPEG_IMAGE, headers: { 'content-type': 'image/jpeg' } })

      await expect(binding).rejects.toMatchObject({ code: 'MEDIA_DOMAIN_MISMATCH' })
      expect(db.prepare('SELECT source, anilist_id, tmdb_media_type, has_poster FROM folders WHERE id = ?').get(folder.id)).toEqual(originalMetadata)
      expect(folderDb.getById(folder.id)?.media_domain_override).toBe('anime')
    } finally {
      fs.rmSync(posterFile, { force: true })
    }
  })

  it('uses domain-specific automatic sources and library hints for unknown items', () => {
    expect(metadataSourcesFor('anime', 'auto')).toEqual(['bangumi', 'anilist'])
    expect(metadataSourcesFor('live_action', 'auto')).toEqual(['tmdb'])
    expect(metadataSourcesFor('unknown', 'auto')).toEqual(['bangumi', 'anilist', 'tmdb'])
    expect(metadataSourcesFor('unknown', 'auto', 'live_action')).toEqual(['tmdb', 'bangumi', 'anilist'])
    expect(metadataSourcesFor('live_action', 'bangumi')).toEqual(['bangumi'])
  })

  it('does not select an ambiguous exact-title automatic candidate', () => {
    const candidates = [1, 2].map(tmdbId => ({
      tmdbId, mediaType: 'tv' as const, title: '同名作品', originalTitle: null, year: 2024,
      rating: null, genres: [], synopsis: null, seasons: 1, posterUrl: null, posterPath: null, genreIds: [18],
    }))

    expect(pickAutomaticMetadataCandidate('tmdb', candidates, ['同名作品'], 2024)).toBeUndefined()
  })

  it('prefers the matching TV anime over manga and an episode zero special', () => {
    const common = { titleZh: null, rating: null, synopsis: null, posterUrl: null, posterPath: null, airedEpisodes: null, airDate: null, airStatus: 'finished' as const }
    const picked = pickBangumiCandidate([
      { ...common, bgmId: 19198, title: 'Another', type: 1, year: 2010, episodes: 120 },
      { ...common, bgmId: 24540, title: 'Another 第0話', type: 2, year: 2012, episodes: 1 },
      { ...common, bgmId: 20851, title: 'Another', type: 2, year: 2012, episodes: 12 },
    ], 'Another', 2, 2012)

    expect(picked?.bgmId).toBe(20851)
  })

  it('allows an explicit first season for a series root title', () => {
    const common = { titleZh: null, rating: null, synopsis: null, posterUrl: null, posterPath: null, airedEpisodes: null, airDate: null, airStatus: 'finished' as const, type: 2 as const }
    const picked = pickBangumiCandidate([
      { ...common, bgmId: 146457, title: 'Rick and Morty Season 3', year: 2017, episodes: 10 },
      { ...common, bgmId: 93377, title: 'Rick and Morty Season 1', year: 2013, episodes: 11 },
    ], 'Rick and Morty', 2, 2013)

    expect(picked?.bgmId).toBe(93377)
  })

  it('uses a reliable Bangumi Chinese synopsis for an AniList candidate', async () => {
    mockPost.mockResolvedValueOnce({ data: { data: [{
        id: 20851, type: 2, name: 'Another', name_cn: 'Another', air_date: '2012-01-10', eps_count: 12,
        summary: '搜索简介', rating: { score: 6.9 },
      }] } })
    mockGet.mockResolvedValueOnce({ data: {
        id: 20851, type: 2, name: 'Another', name_cn: 'Another', date: '2012-01-10', eps: 12,
        summary: 'Bangumi 中文简介', rating: { score: 6.9 },
      } })

    const enriched = await preferBangumiSynopsis({
      anilistId: 11111,
      title: 'Another',
      originalTitle: 'Another',
      year: 2012,
      rating: 7,
      genres: ['Mystery'],
      synopsis: 'AniList English synopsis',
      episodes: 12,
      posterUrl: null,
      posterPath: null,
    })

    expect(enriched.synopsis).toBe('Bangumi 中文简介')
  })

  it('keeps the AniList fallback when Bangumi only has a Japanese synopsis', async () => {
    mockPost.mockResolvedValueOnce({ data: { data: [{
        id: 1, type: 2, name: '作品', name_cn: null, air_date: '2020-01-01', eps_count: 12,
        summary: 'これは日本語だけのあらすじです。',
      }] } })
    mockGet.mockResolvedValueOnce({ data: {
        id: 1, type: 2, name: '作品', date: '2020-01-01', eps: 12,
        summary: 'これは日本語だけのあらすじです。登場人物たちの物語です。',
      } })

    const enriched = await preferBangumiSynopsis({
      anilistId: 1, title: '作品', originalTitle: '作品', year: 2020, rating: null,
      genres: [], synopsis: 'AniList fallback', episodes: 12, posterUrl: null, posterPath: null,
    })

    expect(enriched.synopsis).toBe('AniList fallback')
  })

  it('bindAnilist writes folder fields and poster path', async () => {
    mockPost.mockResolvedValue({ data: { data: { Page: { media: [{ id: 42, title: { romaji: 'T', english: null, native: null }, coverImage: { extraLarge: 'https://img.anilist.co/42.jpg', large: null }, startDate: { year: 2020 }, averageScore: null, genres: [], description: null, episodes: 12 }] } } } })
    const lib = makeLibraryDb(db).create('动漫', 'D:\\Anime', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(lib.id, ['D:\\Anime', 'D:\\Anime\\作品A'])
    const folder = folderDb.getByLibrary(lib.id).find((f: any) => f.name === '作品A')!
    const [cand] = await searchAniList('作品A')
    expect(cand.rating).toBeNull() // 无评分（null）保持 null，不得变成 0
    // 海报缓存不依赖网络：mock cachePoster 前先手动置 has_poster
    await bindAnilist(folder.id, { ...cand, posterUrl: null, posterPath: null }, db)
    const updated = folderDb.getById(folder.id)!
    expect(updated.anilist_id).toBe(42)
    expect(updated.has_poster).toBe(0)
  })

  it('persists TMDB shape and keeps equal movie/TV IDs in separate catalog identities', async () => {
    const lib = makeLibraryDb(db).create('真人影视', 'D:\\Live', 'live_action')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(lib.id, [
      'D:\\Live', 'D:\\Live\\Collection',
      'D:\\Live\\Collection\\Movie', 'D:\\Live\\Collection\\TV',
    ])
    const rows = folderDb.getByLibrary(lib.id)
    const root = rows.find(row => row.path === 'D:\\Live\\Collection')!
    const movie = rows.find(row => row.path.endsWith('Collection\\Movie'))!
    const tv = rows.find(row => row.path.endsWith('Collection\\TV'))!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(root.id)
    db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, ext)
      VALUES (?, ?, ?, ?, 'mkv')
    `).run([movie.id, lib.id, 'movie.mkv', 'D:\\Live\\Collection\\Movie\\movie.mkv'])
    db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, ext)
      VALUES (?, ?, ?, ?, 'mkv')
    `).run([tv.id, lib.id, 'tv.mkv', 'D:\\Live\\Collection\\TV\\tv.mkv'])

    const common = {
      tmdbId: 777, title: '同号作品', originalTitle: null, year: 2024,
      rating: null, genres: [], synopsis: null, seasons: null,
      posterUrl: null, posterPath: null, genreIds: [18],
    }
    await bindTMDB(movie.id, { ...common, mediaType: 'movie' }, db)
    await bindTMDB(tv.id, { ...common, mediaType: 'tv' }, db)

    expect(folderDb.getById(movie.id)?.tmdb_media_type).toBe('movie')
    expect(folderDb.getById(tv.id)?.tmdb_media_type).toBe('tv')
    expect(db.prepare(`
      SELECT s.source, s.external_id
      FROM media_item_sources s
      JOIN media_items i ON i.id = s.media_item_id
      WHERE i.library_id = ?
      ORDER BY s.source
    `).all(lib.id)).toEqual([
      { source: 'tmdb:movie', external_id: '777' },
      { source: 'tmdb:tv', external_id: '777' },
    ])
  })

  it('rebuilds the persistent media catalog after binding metadata', async () => {
    const lib = makeLibraryDb(db).create('动漫', 'D:\\Anime', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(lib.id, [
      'D:\\Anime', 'D:\\Anime\\作品A', 'D:\\Anime\\作品A\\Season 1',
    ])
    const rows = folderDb.getByLibrary(lib.id)
    const root = rows.find((folder: any) => folder.path === 'D:\\Anime\\作品A')!
    const season = rows.find((folder: any) => folder.path === 'D:\\Anime\\作品A\\Season 1')!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(root.id)
    db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, ext)
      VALUES (?, ?, 'S01E01.mkv', 'D:\\Anime\\作品A\\Season 1\\S01E01.mkv', 'mkv')
    `).run([season.id, lib.id])

    await bindAnilist(season.id, {
      anilistId: 42,
      title: '作品A',
      originalTitle: '作品A',
      year: 2020,
      rating: null,
      genres: [],
      synopsis: null,
      episodes: 12,
      posterUrl: null,
      posterPath: null,
    }, db)

    expect(db.prepare(`
      SELECT e.source, e.external_id, e.kind, e.season_number
      FROM folder_media_entries e WHERE e.folder_id = ?
    `).all(season.id)).toEqual([
      { source: 'anilist', external_id: '42', kind: 'season', season_number: 1 },
    ])
  })

  it('can defer catalog rebuilding during a bulk metadata match', async () => {
    const lib = makeLibraryDb(db).create('动漫', 'D:\\Anime', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(lib.id, [
      'D:\\Anime', 'D:\\Anime\\作品A', 'D:\\Anime\\作品A\\Season 1',
    ])
    const rows = folderDb.getByLibrary(lib.id)
    const root = rows.find((folder: any) => folder.path === 'D:\\Anime\\作品A')!
    const season = rows.find((folder: any) => folder.path === 'D:\\Anime\\作品A\\Season 1')!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(root.id)
    db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, ext)
      VALUES (?, ?, 'S01E01.mkv', 'D:\\Anime\\作品A\\Season 1\\S01E01.mkv', 'mkv')
    `).run([season.id, lib.id])

    const { rebuildLibraryMediaCatalog } = await import('../../media-catalog/server/media-catalog')
    rebuildLibraryMediaCatalog(db, lib.id)
    await bindAnilist(season.id, {
      anilistId: 42,
      title: '作品A',
      originalTitle: '作品A',
      year: 2020,
      rating: null,
      genres: [],
      synopsis: null,
      episodes: 12,
      posterUrl: null,
      posterPath: null,
    }, db, { rebuildCatalog: false })

    expect(db.prepare('SELECT source, external_id FROM folder_media_entries WHERE folder_id = ?').get(season.id))
      .toEqual({ source: null, external_id: null })
    rebuildLibraryMediaCatalog(db, lib.id)
    expect(db.prepare('SELECT source, external_id FROM folder_media_entries WHERE folder_id = ?').get(season.id))
      .toEqual({ source: 'anilist', external_id: '42' })
  })

  it('infers Bangumi air status without putting unknown wishes into finished', () => {
    const now = new Date('2026-08-24T00:00:00Z')
    expect(inferBangumiAirStatus('2026-10-01', null, null, now)).toBe('upcoming')
    expect(inferBangumiAirStatus(null, null, null, now)).toBe('upcoming')
    expect(inferBangumiAirStatus('2026-07-01', null, 12, now)).toBe('airing')
    expect(inferBangumiAirStatus('2020-04-04', '2020-06-20', 12, now)).toBe('finished')
  })

  it('extracts a direct AniList id from links or a manual favorite id', () => {
    expect(anilistIdOf('x', JSON.stringify([{ name: 'AniList', url: 'https://anilist.co/anime/19/Monster/' }]))).toBe(19)
    expect(anilistIdOf('manual-anilist-42', null)).toBe(42)
    expect(anilistIdOf('x', null)).toBeNull()
  })

  it('falls back from an invalid stored Bangumi id to a merged canonical link', () => {
    const mergedLinks = JSON.stringify([{ name: '番组计划', url: 'https://bgm.tv/subject/583729/' }])

    expect(bangumiIdOf('calendar-md5-item', '0', mergedLinks)).toBe(583729)
  })

  it('extracts a TMDB id from links or a manual favorite id', () => {
    expect(tmdbIdOf('calendar-md5-item', JSON.stringify([{ name: 'TMDB', url: 'https://www.themoviedb.org/tv/300112' }]))).toBe(300112)
    expect(tmdbIdOf('manual-tmdb-77338', null)).toBe(77338)
    expect(tmdbIdOf('calendar-md5-item', null)).toBeNull()
  })

  it('getBangumiDetail reads planned regular episode count and finished status', async () => {
    mockGet.mockResolvedValue({ data: {
      id: 286650,
      type: 2,
      name: 'アルテ',
      name_cn: '阿尔蒂',
      date: '2020-04-04',
      eps: 12,
      total_episodes: 14,
      summary: '简介',
      images: { large: 'https://lain.bgm.tv/test.jpg' },
      rating: { score: 7.1 },
      infobox: [{ key: '放送结束', value: '2020-06-20' }],
    } })
    const detail = await getBangumiDetail(286650)
    expect(mockGet).toHaveBeenCalledWith('https://api.bgm.tv/v0/subjects/286650', expect.any(Object))
    expect(detail.episodes).toBe(12)
    expect(detail.airStatus).toBe('finished')
    expect(detail.airedEpisodes).toBe(12)
  })

  it('rejects Bangumi detail responses with a mismatched subject id', async () => {
    mockGet.mockResolvedValue({ data: { id: 286651, type: 2, name: '另一条目', eps: 12 } })

    await expect(getBangumiDetail(286650, { expectedBangumiType: 2 })).rejects.toMatchObject({
      code: 'BANGUMI_DETAIL_ID_MISMATCH',
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('rejects Bangumi detail responses without structured media type', async () => {
    mockGet.mockResolvedValue({ data: { id: 286650, name: '类型缺失', eps: 12 } })

    await expect(getBangumiDetail(286650, { expectedBangumiType: 2 })).rejects.toMatchObject({
      code: 'BANGUMI_DETAIL_TYPE_UNKNOWN',
    })
  })

  it('keeps verified candidate fields when a valid detail response is sparse', () => {
    const candidate = {
      bgmId: 286650, title: '候选标题', titleZh: '候选中文名', year: 2020, rating: 8.1,
      synopsis: '候选简介', posterUrl: 'https://example.test/poster.jpg', posterPath: null,
      type: 2 as const, episodes: 12, airedEpisodes: 12, airDate: '2020-01-01', airStatus: 'finished' as const,
    }
    const merged = mergeBangumiDetail(candidate, { bgmId: 286650, type: 2, synopsis: null, rating: null, titleZh: '' })

    expect(merged).toEqual(candidate)
  })

  it('accepts a typed animated movie or special as a Bangumi detail', async () => {
    mockGet.mockResolvedValue({ data: {
      id: 320, type: '2', name: '作品 剧场版', date: '2024-01-01', eps: 1,
      summary: '动画电影简介', images: { large: 'https://lain.bgm.tv/movie.jpg' },
    } })

    const detail = await getBangumiDetail(320, { expectedBangumiType: 2 })

    expect(detail).toMatchObject({ bgmId: 320, type: 2, episodes: 1, title: '作品 剧场版' })
  })

  it('surfaces a Bangumi route failure without retrying through another route', async () => {
    mockGet.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
    await expect(getBangumiDetail(265708)).rejects.toMatchObject({ code: 'NETWORK_CONNECTION_FAILED' })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0][1]).toMatchObject({ proxy: false })
  })

  it('keeps remote posters on the selected route with a pinned validated address', async () => {
    mockGet.mockResolvedValueOnce({ data: JPEG_IMAGE, headers: { 'content-type': 'image/jpeg' } })

    const image = await fetchRemoteImage('https://lain.bgm.tv/pic/cover/l/test.jpg')

    expect(image.data).toEqual(JPEG_IMAGE)
    expect(image.contentType).toBe('image/jpeg')
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0][1]).toMatchObject({
      responseType: 'arraybuffer',
      proxy: false,
    })

    const lookup = mockGet.mock.calls[0][1].httpsAgent.options.lookup as (hostname: string, options: object, callback: (...args: any[]) => void) => void
    const resolved = vi.fn()
    lookup('lain.bgm.tv', {}, resolved)
    expect(resolved).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('validates complete image containers and rejects truncated or header-only payloads', () => {
    for (const image of [JPEG_IMAGE, PNG_IMAGE, WEBP_IMAGE]) {
      expect(isValidPosterImage(image)).toBe(true)
      expect(isValidPosterImage(image.subarray(0, image.length - 2))).toBe(false)
    }
    expect(isValidPosterImage(Buffer.concat([PNG_IMAGE.subarray(0, 8), Buffer.alloc(64)]))).toBe(false)
    expect(isValidPosterImage(Buffer.concat([JPEG_IMAGE.subarray(0, 4), Buffer.alloc(64)]))).toBe(false)
    const fakeWebp = Buffer.alloc(32)
    fakeWebp.write('RIFF', 0, 'ascii'); fakeWebp.writeUInt32LE(24, 4); fakeWebp.write('WEBP', 8, 'ascii')
    expect(isValidPosterImage(fakeWebp)).toBe(false)
  })

  it('replaces a damaged local cache instead of treating its valid header as a poster', async () => {
    const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-cache-damaged-'))
    try {
      fs.writeFileSync(path.join(posterDir, 'al_77.jpg'), JPEG_IMAGE.subarray(0, 48))
      mockGet.mockResolvedValueOnce({ data: PNG_IMAGE, headers: { 'content-type': 'image/png' } })

      const result = await cachePoster('https://example.com/replacement.png', 'al_77', { directory: posterDir })

      expect(result).toBe('/posters/al_77.png')
      expect(fs.readFileSync(path.join(posterDir, 'al_77.png'))).toEqual(PNG_IMAGE)
      expect(fs.existsSync(path.join(posterDir, 'al_77.jpg'))).toBe(false)
      expect(mockGet).toHaveBeenCalledTimes(1)
    } finally {
      fs.rmSync(posterDir, { recursive: true, force: true })
    }
  })

  it('getBangumiDetail ignores an explicitly non-video subject', async () => {
    mockGet.mockResolvedValue({ data: {
      id: 999,
      type: 1,
      name: '同名漫画',
      date: '2020-01-01',
      eps: 120,
      total_episodes: 120,
    } })

    await expect(getBangumiDetail(999)).rejects.toMatchObject({ code: 'BANGUMI_DETAIL_TYPE_MISMATCH' })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('refreshes a cached poster and removes stale alternate extensions', async () => {
    const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-cache-refresh-'))
    try {
      fs.writeFileSync(path.join(posterDir, 'bg_42.jpg'), JPEG_IMAGE)
      fs.writeFileSync(path.join(posterDir, 'bg_42.webp'), WEBP_IMAGE)
      mockGet.mockResolvedValueOnce({ data: PNG_IMAGE, headers: { 'content-type': 'image/png' } })

      const result = await cachePoster('https://example.com/new.png', 'bg_42', {
        refresh: true,
        directory: posterDir,
      })

      expect(result).toBe('/posters/bg_42.png')
      expect(fs.readFileSync(path.join(posterDir, 'bg_42.png'))).toEqual(PNG_IMAGE)
      expect(fs.existsSync(path.join(posterDir, 'bg_42.jpg'))).toBe(false)
      expect(fs.existsSync(path.join(posterDir, 'bg_42.webp'))).toBe(false)
    } finally {
      fs.rmSync(posterDir, { recursive: true, force: true })
    }
  })

  it('overwrites a cached poster when a refresh keeps the same extension', async () => {
    const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-cache-overwrite-'))
    try {
      const poster = path.join(posterDir, 'bg_43.jpg')
      fs.writeFileSync(poster, JPEG_IMAGE)
      const refreshed = Buffer.from(JPEG_IMAGE)
      refreshed[15] ^= 1
      mockGet.mockResolvedValueOnce({ data: refreshed, headers: { 'content-type': 'image/jpeg' } })

      await cachePoster('https://example.com/new.jpg', 'bg_43', {
        refresh: true,
        directory: posterDir,
      })

      expect(fs.readFileSync(poster)).toEqual(refreshed)
    } finally {
      fs.rmSync(posterDir, { recursive: true, force: true })
    }
  })

  it('rejects an empty or invalid image response instead of caching it', async () => {
    const url = 'https://example.com/invalid-poster.jpg'
    mockGet.mockResolvedValueOnce({ data: new Uint8Array(), headers: { 'content-type': 'image/jpeg' } })
    await expect(fetchRemoteImage(url)).rejects.toThrow()
    mockGet.mockResolvedValueOnce({ data: JPEG_IMAGE, headers: { 'content-type': 'image/jpeg' } })
    await expect(fetchRemoteImage(url)).resolves.toMatchObject({ data: JPEG_IMAGE })
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('force refresh bypasses memory and file caches while retaining a usable old poster on failure', async () => {
    const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-cache-force-'))
    const url = 'https://example.com/force-poster.jpg'
    try {
      const poster = path.join(posterDir, 'al_88.jpg')
      fs.writeFileSync(poster, JPEG_IMAGE)
      const warmed = Buffer.from(JPEG_IMAGE)
      warmed[15] ^= 1
      mockGet.mockResolvedValueOnce({ data: warmed, headers: { 'content-type': 'image/jpeg' } })
      await fetchRemoteImage(url)
      mockGet.mockRejectedValueOnce(new Error('offline'))

      await expect(cachePoster(url, 'al_88', { force: true, directory: posterDir })).rejects.toMatchObject({ code: 'NETWORK_CONNECTION_FAILED' })
      expect(fs.readFileSync(poster)).toEqual(JPEG_IMAGE)
      expect(mockGet).toHaveBeenCalledTimes(2)
    } finally {
      fs.rmSync(posterDir, { recursive: true, force: true })
    }
  })

  it('getBangumiDetail falls back to legacy when v0 omits episode fields', async () => {
    mockGet
      .mockResolvedValueOnce({ data: {
        id: 123,
        type: 2,
        name: '旧条目',
        date: '2020-01-01',
        infobox: [],
        images: null,
      } })
      .mockResolvedValueOnce({ data: {
        id: 123,
        type: 2,
        name: '旧条目',
        air_date: '2020-01-01',
        eps_count: 24,
      } })
    const detail = await getBangumiDetail(123)
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(mockGet.mock.calls[1][0]).toBe('https://api.bgm.tv/subject/123')
    expect(detail.episodes).toBe(24)
    expect(detail.airStatus).toBe('finished')
  })

  it.each([
    [{ id: 124, type: 2, name: '错误 subject' }, 'BANGUMI_DETAIL_ID_MISMATCH'],
    [{ id: 123, name: '缺少类型' }, 'BANGUMI_DETAIL_TYPE_UNKNOWN'],
    [{ id: 123, type: 1, name: '同名漫画' }, 'BANGUMI_DETAIL_TYPE_MISMATCH'],
  ] as const)('rejects an invalid subject returned by the legacy Bangumi fallback: %s', async (legacyData, code) => {
    mockGet
      .mockRejectedValueOnce(Object.assign(new Error('v0 unavailable'), { response: { status: 404 } }))
      .mockResolvedValueOnce({ data: legacyData })

    await expect(getBangumiDetail(123, { expectedBangumiType: 2 })).rejects.toMatchObject({ code })
    expect(mockGet.mock.calls.map(call => call[0])).toEqual([
      'https://api.bgm.tv/v0/subjects/123',
      'https://api.bgm.tv/subject/123',
    ])
  })

  it('keeps candidate fields when the legacy fallback returns a valid sparse detail', async () => {
    mockGet
      .mockRejectedValueOnce(Object.assign(new Error('v0 unavailable'), { response: { status: 404 } }))
      .mockResolvedValueOnce({ data: { id: 123, type: 2, name: '', name_cn: '', summary: null, images: null } })
    const detail = await getBangumiDetail(123, { expectedBangumiType: 2 })
    const candidate = {
      bgmId: 123, title: '候选标题', titleZh: '候选中文名', year: 2020, rating: 8.1,
      synopsis: '候选简介', posterUrl: 'https://example.test/poster.jpg', posterPath: null,
      type: 2 as const, episodes: 12, airedEpisodes: 12, airDate: '2020-01-01', airStatus: 'finished' as const,
    }

    expect(mergeBangumiDetail(candidate, detail)).toEqual(candidate)
  })
})
