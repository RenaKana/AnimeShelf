import http from 'node:http'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb, ensureSystemTags } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'
import { providerRateLimitGate } from '../../../server/services/provider-rate-limit'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: vi.fn<() => string | null>(() => null) } }))
const mockDnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: '151.101.1.69', family: 4 }]))
const mockGet = vi.hoisted(() => vi.fn())
const mockResolveProxy = vi.hoisted(() => vi.fn(() => ({ mode: 'direct', source: 'direct', revision: 'test:direct' })))
vi.mock('../../../server/db/instance', () => mockedInstance)
vi.mock('../../../server/services/image-proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/image-proxy')>(),
  getImageProxy: () => null,
}))

vi.mock('../../../server/services/proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/proxy')>(),
  resolveProxy: mockResolveProxy,
}))

vi.mock('axios', () => {
  const post = vi.fn()
  return { default: { post, get: mockGet, create: vi.fn(() => ({ post, get: mockGet, defaults: {} })) } }
})
vi.mock('node:dns/promises', () => ({ lookup: mockDnsLookup }))

import metadataRoutes from '../server/routes'
import axios from 'axios'

const mockPost = (axios.create({}) as unknown as { post: ReturnType<typeof vi.fn> }).post

describe('metadata media-domain routes', () => {
  let db: any
  let server: http.Server

  beforeEach(async () => {
    providerRateLimitGate.reset()
    db = createDb(':memory:')
    mockedInstance.db = db
    ensureSystemTags(db)
    bindTestModuleCapabilities(db)
    mockedInstance.settingsDb.get.mockReset().mockReturnValue(null)
    mockPost.mockReset()
    mockGet.mockReset()
    mockResolveProxy.mockReset().mockReturnValue({ mode: 'direct', source: 'direct', revision: 'test:direct' })
    mockDnsLookup.mockReset().mockResolvedValue([{ address: '151.101.1.69', family: 4 }])
    const app = express()
    app.use(express.json())
    app.use('/api/metadata', metadataRoutes)
    server = await new Promise(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.restoreAllMocks()
    providerRateLimitGate.reset()
  })

  function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return requestLocalHttp(server, path, init)
  }

  function seedAnimeFolder() {
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    makeFolderDb(db).upsertTree(library.id, ['D:\\Anime', 'D:\\Anime\\Show'])
    return makeFolderDb(db).getByLibrary(library.id).find(row => row.name === 'Show')!
  }

  function bangumiCandidate(overrides: Record<string, unknown> = {}) {
    return {
      bgmId: 700, title: '候选动画标题', titleZh: '候选中文标题', year: 2024, rating: 8.1,
      genres: [], synopsis: '候选简介', posterUrl: null, posterPath: null, type: 2,
      episodes: 12, airedEpisodes: 12, airDate: '2024-01-01', airStatus: 'finished',
      ...overrides,
    }
  }

  it('returns Retry-After and does not cache a 429 as a successful empty search', async () => {
    mockedInstance.settingsDb.get.mockReturnValue('test-key')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    mockGet
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'Retry-After': '10' } } })
      .mockResolvedValueOnce({ data: { results: [{ id: 123, media_type: 'movie', title: 'Synthetic', genre_ids: [16] }] } })
    const query = '/api/metadata/search?q=rate-limit-route-fixture&source=tmdb'
    const first = await request(query)
    expect(first.status).toBe(429)
    expect(first.headers['retry-after']).toBe('10')
    expect(await first.json()).toMatchObject({ code: 'SOURCE_RATE_LIMITED', retryAfterSeconds: 10 })
    const blocked = await request(query)
    expect(blocked.status).toBe(429)
    expect(mockGet).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1_010_001)
    const recovered = await request(query)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject([{ tmdbId: 123 }])
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('keeps cross-domain candidates available for a manually selected target folder', async () => {
    const anime = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const live = makeLibraryDb(db).create('Live', 'D:\\Live', 'live_action')
    makeFolderDb(db).upsertTree(anime.id, ['D:\\Anime', 'D:\\Anime\\Same'])
    makeFolderDb(db).upsertTree(live.id, ['D:\\Live', 'D:\\Live\\Same'])
    mockPost.mockResolvedValue({ data: { data: [
      { id: 20, type: 2, name: '动画版本' },
      { id: 60, type: 6, name: '真人版本' },
    ] } })
    const animeFolder = makeFolderDb(db).getByLibrary(anime.id).find(row => row.name === 'Same')!
    const liveFolder = makeFolderDb(db).getByLibrary(live.id).find(row => row.name === 'Same')!

    const animeResponse = await request(`/api/metadata/search?q=Same&source=bangumi&folder_id=${animeFolder.id}`)
    const liveResponse = await request(`/api/metadata/search?q=Same&source=bangumi&folder_id=${liveFolder.id}`)

    expect(animeResponse.status).toBe(200)
    expect((await animeResponse.json()).map((item: any) => item.bgmId)).toEqual([20, 60])
    expect(liveResponse.status).toBe(200)
    expect((await liveResponse.json()).map((item: any) => item.bgmId)).toEqual([20, 60])
  })

  it('allows a manually selected cross-domain bind after validating the target folder', async () => {
    const live = makeLibraryDb(db).create('Live', 'D:\\Live', 'live_action')
    makeFolderDb(db).upsertTree(live.id, ['D:\\Live', 'D:\\Live\\Same'])
    const folder = makeFolderDb(db).getByLibrary(live.id).find(row => row.name === 'Same')!

    const response = await request('/api/metadata/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder_id: folder.id, source: 'anilist', candidate: {
        anilistId: 42, title: 'Anime', originalTitle: null, year: 2020, rating: null,
        genres: [], synopsis: null, episodes: 12, posterUrl: null, posterPath: null,
      } }),
    })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT anilist_id, source FROM folders WHERE id = ?').get(folder.id)).toEqual({ anilist_id: 42, source: 'anilist' })
  })

  it('rejects Bangumi detail identity/type conflicts without changing existing metadata', async () => {
    const folder = seedAnimeFolder()
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 701, has_poster = 1, rating = 7.5, synopsis = '保留简介', year = 2019, episodes = 10 WHERE id = ?").run(folder.id)
    const original = db.prepare('SELECT source, anilist_id, has_poster, rating, synopsis, year, episodes FROM folders WHERE id = ?').get(folder.id)

    for (const scenario of [
      { data: { id: 701, type: 2 }, code: 'BANGUMI_DETAIL_ID_MISMATCH' },
      { data: { id: 700 }, code: 'BANGUMI_DETAIL_TYPE_UNKNOWN' },
      { data: { id: 700, type: 6 }, code: 'BANGUMI_DETAIL_TYPE_MISMATCH' },
    ] as const) {
      mockGet.mockReset().mockResolvedValue({ data: scenario.data })
      const response = await request('/api/metadata/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder_id: folder.id, source: 'bangumi', candidate: bangumiCandidate() }),
      })

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ code: scenario.code })
      expect(db.prepare('SELECT source, anilist_id, has_poster, rating, synopsis, year, episodes FROM folders WHERE id = ?').get(folder.id)).toEqual(original)
    }
  })

  it('keeps verified candidate fields when a valid Bangumi detail is sparse', async () => {
    const folder = seedAnimeFolder()
    const candidate = bangumiCandidate()
    mockGet.mockResolvedValueOnce({ data: { id: candidate.bgmId, type: 2, eps: candidate.episodes } })

    const response = await request('/api/metadata/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder_id: folder.id, source: 'bangumi', candidate }),
    })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT source, anilist_id, has_poster, rating, synopsis, year, episodes FROM folders WHERE id = ?').get(folder.id)).toEqual({
      source: 'bangumi', anilist_id: candidate.bgmId, has_poster: 0, rating: candidate.rating,
      synopsis: candidate.synopsis, year: candidate.year, episodes: candidate.episodes,
    })
  })

  it('serves a valid allowlisted poster through the image proxy', async () => {
    const image = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//9k=', 'base64')
    mockGet.mockResolvedValueOnce({ status: 200, data: image, headers: { 'content-type': 'image/jpeg', 'content-length': String(image.length) } })

    const response = await request('/api/metadata/image?u=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fposter.jpg')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/^image\/jpeg/)
    expect(mockGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, maxContentLength: 32 * 1024 * 1024 })
  })

  it('does not fetch an allowlisted hostname that resolves to a private address', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }])

    const response = await request('/api/metadata/image?u=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fprivate.jpg')

    expect(response.status).toBe(404)
    expect(mockGet).not.toHaveBeenCalled()
  })
})
