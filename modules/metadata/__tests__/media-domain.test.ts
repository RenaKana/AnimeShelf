import { describe, expect, it } from 'vitest'
import { mediaDomainForTMDB } from '../../../shared/media-domain'

describe('TMDB media-domain evidence', () => {
  it.each([
    ['movie', [18]],
    ['movie', [28, 35]],
    ['tv', [18]],
    ['tv', [10759, 10765]],
  ] as const)('accepts known non-animation %s genre IDs', (mediaType, genreIds) => {
    expect(mediaDomainForTMDB({ mediaType, genreIds })).toBe('live_action')
  })

  it('accepts a recognized detail genre object without trusting its display name', () => {
    expect(mediaDomainForTMDB({ mediaType: 'movie', genres: [{ id: 18, name: 'Drama' }] })).toBe('live_action')
  })

  it('keeps unknown, forged, missing, or malformed genre evidence unknown', () => {
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: [9999] })).toBe('unknown')
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: [18, 9999] })).toBe('unknown')
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: [] })).toBe('unknown')
    expect(mediaDomainForTMDB({ mediaType: 'movie' })).toBe('unknown')
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: ['18'] })).toBe('unknown')
    expect(mediaDomainForTMDB({ mediaType: 'movie', genres: ['Drama'] })).toBe('unknown')
  })

  it('keeps movie and TV genre vocabularies separate', () => {
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: [10759] })).toBe('unknown')
    expect(mediaDomainForTMDB({ mediaType: 'tv', genreIds: [28] })).toBe('unknown')
  })

  it('lets explicit animation genre 16 win over mixed evidence', () => {
    expect(mediaDomainForTMDB({ mediaType: 'movie', genreIds: [18, 16, 9999] })).toBe('anime')
    expect(mediaDomainForTMDB({ mediaType: 'tv', genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 16, name: 'Animation' }] })).toBe('anime')
  })
})
