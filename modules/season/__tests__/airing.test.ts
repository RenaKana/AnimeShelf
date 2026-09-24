import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { providerRateLimitGate } from '../../../server/services/provider-rate-limit'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: () => null } }))
vi.mock('../../../server/db/instance', () => mockedInstance)
vi.mock('../../../server/services/network', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/network')>(),
  networkFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}))

import { anilistIdsOf, bangumiIdsOf, favoriteAirStatusFallback, refreshAiringProgress, resetAiringProgressCache, tmdbIdsOf } from '../server/airing'

describe('favorite airing fallback', () => {
  it('uses begin rather than air_day to classify future and past entries', () => {
    const now = new Date('2026-08-29T00:00:00.000Z')
    expect(favoriteAirStatusFallback('2026-09-01T14:00:00.000Z', now)).toBe('upcoming')
    expect(favoriteAirStatusFallback('2026-08-01T14:00:00.000Z', now)).toBe('airing')
    expect(favoriteAirStatusFallback(null, now)).toBe('upcoming')
  })

  it('extracts every source id while keeping an explicit favorite identity first', () => {
    const links = JSON.stringify([
      { name: '番组计划', url: 'https://bgm.tv/subject/43558' },
      { name: '番组计划', url: 'https://bgm.tv/subject/551918' },
      { name: 'AniList', url: 'https://anilist.co/anime/16049' },
      { name: 'AniList', url: 'https://anilist.co/anime/6213' },
      { name: 'TMDB', url: 'https://www.themoviedb.org/tv/1001' },
      { name: 'TMDB', url: 'https://www.themoviedb.org/movie/1002' },
    ])

    expect(bangumiIdsOf('manual-bangumi-551918', '551918', links)).toEqual([551918, 43558])
    expect(anilistIdsOf('calendar-md5-item', links)).toEqual([16049, 6213])
    expect(tmdbIdsOf('calendar-md5-item', links)).toEqual([1001, 1002])
  })
})

describe('favorite airing provider rate limits', () => {
  let db: any

  beforeEach(() => {
    db = createDb(':memory:')
    mockedInstance.db = db
    providerRateLimitGate.reset()
    resetAiringProgressCache()
  })

  afterEach(() => {
    providerRateLimitGate.reset()
    resetAiringProgressCache()
    if (db?.isOpen) db.close()
    mockedInstance.db = undefined
    vi.restoreAllMocks()
  })

  function insertAniListFavorite() {
    db.prepare('INSERT INTO season_favorites (item_id, title, links) VALUES (?, ?, ?)').run([
      'manual-anilist-123',
      'Example Anime',
      JSON.stringify([{ name: 'AniList', url: 'https://anilist.co/anime/123' }]),
    ])
  }

  it('propagates HTTP 429 and shares the AniList cooldown without a second request', async () => {
    insertAniListFavorite()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {
      status: 429,
      headers: { 'Retry-After': '9' },
    }))

    await expect(refreshAiringProgress(true)).rejects.toMatchObject({
      provider: 'anilist',
      code: 'SOURCE_RATE_LIMITED',
      retryAfterSeconds: 9,
    })
    await expect(refreshAiringProgress(true)).rejects.toMatchObject({
      provider: 'anilist',
      code: 'SOURCE_RATE_LIMITED',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('treats AniList GraphQL status 429 in an HTTP 200 response as a rate limit', async () => {
    insertAniListFavorite()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: null,
      errors: [{ status: 429 }],
    }), {
      status: 200,
      headers: { 'Retry-After': '7' },
    }))

    await expect(refreshAiringProgress(true)).rejects.toMatchObject({
      provider: 'anilist',
      code: 'SOURCE_RATE_LIMITED',
      retryAfterSeconds: 7,
    })
  })
})
