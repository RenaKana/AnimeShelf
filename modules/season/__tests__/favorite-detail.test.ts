import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRateLimitError, providerRateLimitGate } from '../../../server/services/provider-rate-limit'

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  getBangumiDetail: vi.fn(),
  getTMDBDetail: vi.fn(),
  cachePoster: vi.fn(),
}))

vi.mock('../../metadata/server/metadata', () => ({
  getBangumiDetail: mocks.getBangumiDetail,
  getTMDBDetail: mocks.getTMDBDetail,
  cachePoster: mocks.cachePoster,
}))
vi.mock('../../../server/services/network', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/network')>(),
  networkFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}))

const links = [
  { name: '番组计划', url: 'https://bgm.tv/subject/1' },
  { name: 'AniList', url: 'https://anilist.co/anime/2' },
  { name: 'TMDB', url: 'https://www.themoviedb.org/movie/3' },
]

describe('favorite detail provider order and domain guards', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    providerRateLimitGate.reset()
    mocks.order = []
    mocks.getBangumiDetail.mockReset().mockImplementation(async () => {
      mocks.order.push('bangumi')
      return { bgmId: 1, type: 2, synopsis: 'Bangumi anime synopsis', posterUrl: 'https://img.test/bangumi.jpg', episodes: 12, airedEpisodes: 3, airStatus: 'airing' }
    })
    mocks.getTMDBDetail.mockReset().mockImplementation(async () => {
      mocks.order.push('tmdb')
      return {
        posterUrl: 'https://img.test/tmdb.jpg',
        synopsis: 'TMDB synopsis',
        domainEvidence: [{ source: 'tmdb', externalId: '3', authority: 'confirmed', mediaType: 'movie', genreIds: [18] }],
      }
    })
    mocks.cachePoster.mockReset().mockResolvedValue('/posters/favorite.jpg')
    globalThis.fetch = vi.fn(async () => {
      mocks.order.push('anilist')
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: { Media: {
          id: 2,
          description: 'AniList synopsis',
          episodes: 12,
          status: 'RELEASING',
          coverImage: { extraLarge: 'https://img.test/anilist.jpg' },
        } } }),
      } as Response
    })
  })

  afterEach(() => {
    providerRateLimitGate.reset()
    globalThis.fetch = originalFetch
  })

  it('orders auto sources by domain while explicit source remains isolated', async () => {
    const { fetchFavoriteDetail } = await import('../server/favorite-detail')

    const anime = await fetchFavoriteDetail('anime', links, 'auto', 'anime')
    expect(mocks.order).toEqual(['bangumi', 'anilist', 'tmdb'])
    expect(anime.synopsis).toBe('Bangumi anime synopsis')
    expect(new Set(anime.domainEvidence?.map(entry => entry.source))).toEqual(new Set(['bangumi', 'anilist', 'tmdb']))

    mocks.order = []
    const live = await fetchFavoriteDetail('live', links, 'auto', 'live_action')
    expect(mocks.order).toEqual(['tmdb', 'bangumi', 'anilist'])
    expect(live.synopsis).toBe('TMDB synopsis')
    expect(new Set(live.domainEvidence?.map(entry => entry.source))).toEqual(new Set(['bangumi', 'anilist', 'tmdb']))

    mocks.order = []
    await fetchFavoriteDetail('explicit', links, 'bangumi', 'live_action')
    expect(mocks.order).toEqual(['bangumi'])
  })

  it('does not use a Bangumi manga or novel summary as favorite metadata', async () => {
    mocks.getBangumiDetail.mockReset().mockImplementation(async () => {
      mocks.order.push('bangumi')
      return { bgmId: 1, type: 1, synopsis: 'Novel summary', posterUrl: 'https://img.test/novel.jpg' }
    })
    mocks.getTMDBDetail.mockReset()
    globalThis.fetch = vi.fn()

    const { fetchFavoriteDetail } = await import('../server/favorite-detail')
    const detail = await fetchFavoriteDetail('novel', [links[0]], 'auto', 'anime')

    expect(detail.synopsis).toBeNull()
    expect(detail.posterPath).toBeNull()
    expect(detail.domainEvidence).toEqual([{ source: 'bangumi', externalId: '1', authority: 'confirmed', subjectType: 1 }])
  })

  it('only uses TMDB content when reliable domain evidence matches the favorite', async () => {
    mocks.getBangumiDetail.mockReset()
    globalThis.fetch = vi.fn()
    const { fetchFavoriteDetail } = await import('../server/favorite-detail')
    const tmdbLink = links[2]

    mocks.getTMDBDetail.mockReset().mockResolvedValue({
      posterUrl: 'https://img.test/live.jpg',
      synopsis: 'Live-action synopsis',
      domainEvidence: [{ source: 'tmdb', externalId: '3', authority: 'confirmed', mediaType: 'movie', genreIds: [18] }],
    })
    const anime = await fetchFavoriteDetail('anime-tmdb', [tmdbLink], 'tmdb', 'anime')
    expect(anime.posterPath).toBeNull()
    expect(anime.synopsis).toBeNull()
    expect(anime.domainEvidence).toHaveLength(1)

    mocks.getTMDBDetail.mockResolvedValue({
      posterUrl: 'https://img.test/anime.jpg',
      synopsis: 'Animated synopsis',
      domainEvidence: [{ source: 'tmdb', externalId: '3', authority: 'confirmed', mediaType: 'movie', genreIds: [16] }],
    })
    const live = await fetchFavoriteDetail('live-tmdb', [tmdbLink], 'tmdb', 'live_action')
    expect(live.posterPath).toBeNull()
    expect(live.synopsis).toBeNull()

    const unknown = await fetchFavoriteDetail('unknown-tmdb', [tmdbLink], 'tmdb', 'unknown')
    expect(unknown.posterPath).toBe('/posters/favorite.jpg')
    expect(unknown.synopsis).toBe('Animated synopsis')
  })

  it('continues auto fallback after an AniList 429 and keeps the cooldown across calls', async () => {
    const anilistAndTmdbLinks = [links[1], links[2]]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {
      status: 429,
      headers: { 'Retry-After': '11' },
    }))
    mocks.getTMDBDetail.mockResolvedValue({
      posterUrl: 'https://img.test/fallback.jpg',
      synopsis: 'TMDB fallback synopsis',
      domainEvidence: [{ source: 'tmdb', externalId: '3', authority: 'confirmed', mediaType: 'movie', genreIds: [16] }],
    })

    const { fetchFavoriteDetail } = await import('../server/favorite-detail')
    const detail = await fetchFavoriteDetail('auto-fallback', anilistAndTmdbLinks, 'auto', 'anime')
    expect(detail.synopsis).toBe('TMDB fallback synopsis')
    expect(detail.posterPath).toBe('/posters/favorite.jpg')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await expect(fetchFavoriteDetail('explicit-after-cooldown', [links[1]], 'anilist', 'anime')).rejects.toMatchObject({
      provider: 'anilist',
      code: 'SOURCE_RATE_LIMITED',
      retryAfterSeconds: 11,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('propagates AniList GraphQL status 429 from an HTTP 200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: null,
      errors: [{ status: 429 }],
    }), {
      status: 200,
      headers: { 'Retry-After': '7' },
    }))

    const { fetchFavoriteDetail } = await import('../server/favorite-detail')
    await expect(fetchFavoriteDetail('graphql-limit', [links[1]], 'anilist', 'anime')).rejects.toMatchObject({
      provider: 'anilist',
      code: 'SOURCE_RATE_LIMITED',
      retryAfterSeconds: 7,
    })
  })

  it('keeps reliable sparse evidence when AniList is rate limited during auto fallback', async () => {
    const anilistAndTmdbLinks = [links[1], links[2]]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {
      status: 429,
      headers: { 'Retry-After': '6' },
    }))
    mocks.getTMDBDetail.mockResolvedValue({
      posterUrl: null,
      synopsis: null,
      domainEvidence: [{ source: 'tmdb', externalId: '3', authority: 'confirmed', mediaType: 'movie', genreIds: [16] }],
    })

    const { fetchFavoriteDetail } = await import('../server/favorite-detail')
    const detail = await fetchFavoriteDetail('sparse-fallback', anilistAndTmdbLinks, 'auto', 'anime')
    expect(detail.posterPath).toBeNull()
    expect(detail.synopsis).toBeNull()
    expect(detail.domainEvidence).toHaveLength(1)
  })

  it('propagates an explicit TMDB rate limit without rewriting it as a generic failure', async () => {
    const limit = new ProviderRateLimitError('tmdb', Date.now() + 13_000, Date.now())
    mocks.getTMDBDetail.mockRejectedValue(limit)

    const { fetchFavoriteDetail } = await import('../server/favorite-detail')
    await expect(fetchFavoriteDetail('tmdb-limit', [links[2]], 'tmdb', 'unknown')).rejects.toBe(limit)
  })
})
