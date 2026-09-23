import { describe, expect, it } from 'vitest'
import { posterUrl, retainVisiblePosterErrors } from '../../../src/lib/poster'

describe('posterUrl', () => {
  it('uses the stable poster version returned by the server', () => {
    const item = { id: 7, poster_version: 'bg-42-100-1234' }

    expect(posterUrl(item)).toBe('/api/folders/7/poster?v=bg-42-100-1234')
    expect(posterUrl(item)).toBe('/api/folders/7/poster?v=bg-42-100-1234')
  })

  it('does not request a poster when the server reports no cached version', () => {
    expect(posterUrl({ id: 8, poster_version: null })).toBeNull()
  })

  it('drops a previous image error when the same folder receives a new poster version', () => {
    const oldUrl = posterUrl({ id: 7, poster_version: 'old' })
    if (!oldUrl) throw new Error('Fixture should have a poster URL')
    const newItem = { id: 7, poster_version: 'new' }

    expect([...retainVisiblePosterErrors(new Set([oldUrl]), [newItem])]).toEqual([])
  })
})
