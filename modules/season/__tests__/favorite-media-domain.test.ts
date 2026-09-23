import { describe, expect, it } from 'vitest'
import { bangumiDataFavoriteEvidence, classifyFavorite, mergeFavoriteEvidence } from '../../../shared/favorite-media-domain'
import { resolveMediaDomain, type MediaDomainEvidence } from '../../../shared/media-domain'

const anilistLink = { name: 'AniList', url: 'https://anilist.co/anime/123' }
const tmdbMovieLink = { name: 'TMDB', url: 'https://www.themoviedb.org/movie/42' }
const tmdbTvLink = { name: 'TMDB', url: 'https://www.themoviedb.org/tv/42' }

function evidence(entry: MediaDomainEvidence): string {
  return JSON.stringify([entry])
}

describe('favorite media-domain classification', () => {
  it('keeps TMDB movie and TV identities separate when the numeric id is reused', () => {
    const movieEvidence: MediaDomainEvidence = {
      source: 'tmdb', externalId: '42', authority: 'confirmed', mediaType: 'movie', genreIds: [18],
    }
    const tvEvidence: MediaDomainEvidence = {
      source: 'tmdb', externalId: '42', authority: 'confirmed', mediaType: 'tv', genreIds: [18],
    }

    expect(classifyFavorite({ item_id: 'manual-tmdb-42', links: [tmdbMovieLink], media_domain_evidence: evidence(movieEvidence) })).toMatchObject({
      media_domain: 'live_action',
      media_domain_source: 'metadata',
    })
    expect(classifyFavorite({ item_id: 'manual-tmdb-42', links: [tmdbMovieLink], media_domain_evidence: evidence(tvEvidence) })).toMatchObject({
      media_domain: 'unknown',
      media_domain_reason: 'insufficient',
    })
    expect(classifyFavorite({ item_id: 'manual-tmdb-42', links: [tmdbTvLink], media_domain_evidence: evidence(tvEvidence) })).toMatchObject({
      media_domain: 'live_action',
      media_domain_source: 'metadata',
    })
  })

  it('migrates AniList links into trusted anime evidence even without persisted evidence', () => {
    expect(classifyFavorite({ item_id: 'legacy-favorite', links: [anilistLink], media_domain_evidence: null })).toMatchObject({
      media_domain: 'anime',
      media_domain_source: 'metadata',
      media_domain_reason: null,
    })
  })

  it('keeps typed AniList evidence trusted when older persisted evidence is present', () => {
    const row = {
      item_id: 'legacy-favorite',
      links: [anilistLink],
      media_domain_evidence: evidence({ source: 'anilist', externalId: '123', authority: 'automatic', mediaType: 'ANIME' }),
    }
    expect(classifyFavorite(row)).toMatchObject({ media_domain: 'anime', media_domain_source: 'metadata' })
  })

  it('accepts canonical bangumi-data evidence for calendar identities', () => {
    const itemId = 'calendar-item-id'
    expect(classifyFavorite({ item_id: itemId, links: [], media_domain_evidence: null }, bangumiDataFavoriteEvidence(itemId))).toMatchObject({
      media_domain: 'anime',
      media_domain_source: 'metadata',
    })
  })

  it('gives confirmed evidence precedence over automatic evidence, but reports confirmed conflicts', () => {
    const confirmedAnime: MediaDomainEvidence = { source: 'anilist', externalId: '123', authority: 'confirmed', mediaType: 'ANIME' }
    const automaticLive: MediaDomainEvidence = { source: 'tmdb', externalId: '42', authority: 'automatic', mediaType: 'tv', genreIds: [18] }
    const confirmedLive: MediaDomainEvidence = { ...automaticLive, authority: 'confirmed' }
    const links = [anilistLink, tmdbTvLink]

    expect(classifyFavorite({ item_id: 'mixed', links, media_domain_evidence: null }, [confirmedAnime, automaticLive])).toMatchObject({
      media_domain: 'anime',
      media_domain_source: 'metadata',
    })
    expect(classifyFavorite({ item_id: 'mixed', links, media_domain_evidence: null }, [confirmedAnime, confirmedLive])).toMatchObject({
      media_domain: 'unknown',
      media_domain_reason: 'conflict',
    })
    expect(resolveMediaDomain({ evidence: [confirmedAnime, automaticLive] })).toMatchObject({ media_domain: 'anime' })
  })

  it('does not downgrade a confirmed source when an automatic refresh repeats its identity', () => {
    const confirmed: MediaDomainEvidence = { source: 'anilist', externalId: '123', authority: 'confirmed', mediaType: 'ANIME' }
    const automatic: MediaDomainEvidence = { ...confirmed, authority: 'automatic' }
    const merged = mergeFavoriteEvidence({ item_id: 'manual-anilist-123', links: [anilistLink], media_domain_evidence: evidence(confirmed) }, [automatic])
    expect(JSON.parse(merged ?? '[]')).toEqual([confirmed])
  })

  it('keeps conflicting confirmed subject types from one persisted snapshot', () => {
    const type2: MediaDomainEvidence = { source: 'bangumi', externalId: '456', authority: 'confirmed', subjectType: 2 }
    const type6: MediaDomainEvidence = { source: 'bangumi', externalId: '456', authority: 'confirmed', subjectType: 6 }
    const row = {
      item_id: 'manual-bangumi-456',
      links: [{ name: '番组计划', url: 'https://bgm.tv/subject/456' }],
      media_domain_evidence: JSON.stringify([type2, type6]),
    }

    expect(classifyFavorite(row)).toMatchObject({ media_domain: 'unknown', media_domain_reason: 'conflict' })
  })

  it('lets a confirmed refresh replace stale variants for the same source identity', () => {
    const type2: MediaDomainEvidence = { source: 'bangumi', externalId: '456', authority: 'confirmed', subjectType: 2 }
    const type6: MediaDomainEvidence = { source: 'bangumi', externalId: '456', authority: 'confirmed', subjectType: 6 }
    const row = {
      item_id: 'manual-bangumi-456',
      links: [{ name: '番组计划', url: 'https://bgm.tv/subject/456' }],
      media_domain_evidence: JSON.stringify([type2, type6]),
    }

    expect(JSON.parse(mergeFavoriteEvidence(row, [type2]) ?? '[]')).toEqual([type2])
  })
})
