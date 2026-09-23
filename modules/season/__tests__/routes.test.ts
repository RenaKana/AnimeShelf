import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { requestLocalHttp, type TestHttpResponse } from '../../../server/services/__tests__/http-test-client'
import { ProviderRateLimitError } from '../../../server/services/provider-rate-limit'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: () => null } }))
const favoriteDetailMock = vi.hoisted(() => ({ fetchFavoriteDetail: vi.fn() }))

vi.mock('../../../server/db/instance', () => mockedInstance)
vi.mock('../server/favorite-detail', () => favoriteDetailMock)

const anilistLink = { name: 'AniList', url: 'https://anilist.co/anime/123' }
const confirmedAnimeEvidence = { source: 'anilist', externalId: '123', authority: 'confirmed', mediaType: 'ANIME' }

describe('season favorite media-domain routes', () => {
  let db: any
  let server: any
  let router: any

  beforeEach(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    favoriteDetailMock.fetchFavoriteDetail.mockReset()
    favoriteDetailMock.fetchFavoriteDetail.mockRejectedValue(new Error('detail unavailable'))
    router = (await import('../server/routes')).default
    const app = express()
    app.use(express.json())
    app.use('/api/season', router)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    if (db?.isOpen) db.close()
    mockedInstance.db = undefined
  })

  function insertFavorite(itemId: string, options: { links?: unknown[]; evidence?: unknown[]; override?: string | null } = {}) {
    db.prepare(`
      INSERT INTO season_favorites (item_id, title, links, media_domain_override, media_domain_evidence)
      VALUES (?, ?, ?, ?, ?)
    `).run([
      itemId,
      itemId,
      options.links ? JSON.stringify(options.links) : null,
      options.override ?? null,
      options.evidence ? JSON.stringify(options.evidence) : null,
    ])
  }

  function putDomain(itemId: string, override: unknown, owner = true): Promise<TestHttpResponse> {
    return requestLocalHttp(server, `/api/season/favorites/${encodeURIComponent(itemId)}/media-domain`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(owner ? { 'X-AnimeShelf-Owner': '1' } : {}) },
      body: JSON.stringify({ override }),
    })
  }

  it('requires owner access, validates the three-state override, and handles missing rows', async () => {
    insertFavorite('favorite-a')

    expect((await putDomain('favorite-a', 'anime', false)).status).toBe(403)
    expect((await putDomain('favorite-a', undefined)).status).toBe(400)
    expect((await putDomain('favorite-a', 'movie')).status).toBe(400)
    expect((await putDomain('missing', 'anime')).status).toBe(404)

    for (const override of ['anime', 'live_action', 'unknown', null]) {
      const response = await putDomain('favorite-a', override)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        ok: true,
        media_domain_override: override,
        media_domain: override ?? 'unknown',
      })
    }
  })

  it('updates only the addressed favorite row', async () => {
    insertFavorite('favorite-a')
    insertFavorite('favorite-b')

    expect((await putDomain('favorite-a', 'live_action')).status).toBe(200)
    expect(db.prepare('SELECT media_domain_override FROM season_favorites WHERE item_id = ?').get('favorite-a')).toEqual({ media_domain_override: 'live_action' })
    expect(db.prepare('SELECT media_domain_override FROM season_favorites WHERE item_id = ?').get('favorite-b')).toEqual({ media_domain_override: null })
  })

  it('persists candidate evidence even when detail refresh fails', async () => {
    const response = await requestLocalHttp(server, '/api/season/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item_id: 'manual-anilist-123',
        title: 'Example Anime',
        links: [anilistLink],
        media_domain_evidence: [confirmedAnimeEvidence],
      }),
    })

    expect(response.status).toBe(200)
    expect(favoriteDetailMock.fetchFavoriteDetail).toHaveBeenCalled()
    expect(db.prepare('SELECT media_domain_evidence FROM season_favorites WHERE item_id = ?').get('manual-anilist-123')).toEqual({
      media_domain_evidence: JSON.stringify([confirmedAnimeEvidence]),
    })
  })

  it('preserves confirmed evidence when a failed refresh supplies automatic evidence', async () => {
    insertFavorite('manual-anilist-123', {
      links: [anilistLink],
      evidence: [confirmedAnimeEvidence],
    })
    const automaticEvidence = { ...confirmedAnimeEvidence, authority: 'automatic' }

    const response = await requestLocalHttp(server, '/api/season/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item_id: 'manual-anilist-123',
        title: 'Example Anime',
        links: [anilistLink],
        media_domain_evidence: [automaticEvidence],
      }),
    })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT media_domain_evidence FROM season_favorites WHERE item_id = ?').get('manual-anilist-123')).toEqual({
      media_domain_evidence: JSON.stringify([confirmedAnimeEvidence]),
    })
  })

  it('passes the current favorite domain to poster refresh and persists returned evidence', async () => {
    insertFavorite('manual-anilist-123', {
      links: [anilistLink],
      evidence: [confirmedAnimeEvidence],
    })
    favoriteDetailMock.fetchFavoriteDetail.mockResolvedValue({
      posterPath: '/posters/refreshed.jpg',
      synopsis: '刷新简介',
      synopsisOriginal: null,
      airedEpisodes: null,
      totalEpisodes: null,
      airStatus: null,
      domainEvidence: [confirmedAnimeEvidence],
    })

    const response = await requestLocalHttp(server, '/api/season/favorites/manual-anilist-123/poster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'auto' }),
    })
    expect(response.status).toBe(200)
    expect(favoriteDetailMock.fetchFavoriteDetail).toHaveBeenCalledWith(
      'manual-anilist-123',
      [anilistLink],
      'auto',
      'anime',
    )
    expect(db.prepare('SELECT image, synopsis, media_domain_evidence FROM season_favorites WHERE item_id = ?').get('manual-anilist-123')).toEqual({
      image: '/posters/refreshed.jpg',
      synopsis: '刷新简介',
      media_domain_evidence: JSON.stringify([confirmedAnimeEvidence]),
    })
  })

  it('keeps existing confirmed evidence when poster refresh fails', async () => {
    insertFavorite('manual-anilist-123', {
      links: [anilistLink],
      evidence: [confirmedAnimeEvidence],
    })

    const response = await requestLocalHttp(server, '/api/season/favorites/manual-anilist-123/poster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'auto' }),
    })

    expect(response.status).toBe(502)
    expect(db.prepare('SELECT media_domain_evidence FROM season_favorites WHERE item_id = ?').get('manual-anilist-123')).toEqual({
      media_domain_evidence: JSON.stringify([confirmedAnimeEvidence]),
    })
  })

  it('maps poster provider limits to 429 and preserves existing metadata', async () => {
    insertFavorite('manual-anilist-123', {
      links: [anilistLink],
      evidence: [confirmedAnimeEvidence],
    })
    db.prepare('UPDATE season_favorites SET image = ?, synopsis = ?, synopsis_original = ?, aired_episodes = ?, total_episodes = ?, air_status = ? WHERE item_id = ?')
      .run(['/posters/existing.jpg', '已有简介', 'existing synopsis', 3, 12, 'airing', 'manual-anilist-123'])
    const now = Date.now()
    favoriteDetailMock.fetchFavoriteDetail.mockRejectedValue(new ProviderRateLimitError('anilist', now + 12_000, now))

    const response = await requestLocalHttp(server, '/api/season/favorites/manual-anilist-123/poster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'anilist' }),
    })

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('12')
    expect(await response.json()).toMatchObject({
      code: 'SOURCE_RATE_LIMITED',
      retryAfterSeconds: 12,
    })
    expect(db.prepare('SELECT image, synopsis, synopsis_original, aired_episodes, total_episodes, air_status, media_domain_evidence FROM season_favorites WHERE item_id = ?').get('manual-anilist-123')).toEqual({
      image: '/posters/existing.jpg',
      synopsis: '已有简介',
      synopsis_original: 'existing synopsis',
      aired_episodes: 3,
      total_episodes: 12,
      air_status: 'airing',
      media_domain_evidence: JSON.stringify([confirmedAnimeEvidence]),
    })
  })

  it('treats valid domain evidence as a successful poster refresh even without content fields', async () => {
    insertFavorite('manual-anilist-123', {
      links: [anilistLink],
    })
    favoriteDetailMock.fetchFavoriteDetail.mockResolvedValue({
      posterPath: null,
      synopsis: null,
      synopsisOriginal: null,
      airedEpisodes: null,
      totalEpisodes: null,
      airStatus: null,
      domainEvidence: [confirmedAnimeEvidence],
    })

    const response = await requestLocalHttp(server, '/api/season/favorites/manual-anilist-123/poster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'auto' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, image: null })
    expect(db.prepare('SELECT media_domain_evidence FROM season_favorites WHERE item_id = ?').get('manual-anilist-123')).toEqual({
      media_domain_evidence: JSON.stringify([confirmedAnimeEvidence]),
    })
  })
})
