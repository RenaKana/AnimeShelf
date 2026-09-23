import { describe, expect, it } from 'vitest'
import { buildCollectionArtwork, collectionWorkPoster } from '../client/collectionArtwork'

describe('collection artwork selection', () => {
  it('includes deep catalog posters instead of relying only on immediate children', () => {
    const artwork = buildCollectionArtwork({ children: [{ id: 12, poster_version: null }], collection_artwork: [{ id: 807, poster_version: 'al-20593-version' }] })
    expect(artwork[807]).toBe('/api/folders/807/poster?v=al-20593-version')
  })
  it('uses a later version of the same work and never falls back to a multi-work group poster', () => {
    const artwork = { 1: null, 2: '/own.jpg', 12: '/group.jpg' }
    const work = { folders: [{ id: 1 }, { id: 2 }], group: { anchor_folder_id: 12, item_ids: [1, 2], members: [] } }
    expect(collectionWorkPoster(work, artwork)).toBe('/own.jpg')
    expect(collectionWorkPoster({ ...work, folders: [{ id: 1 }] }, artwork)).toBeNull()
    expect(collectionWorkPoster({ ...work, folders: [{ id: 1 }], group: { ...work.group, item_ids: [1] } }, artwork)).toBe('/group.jpg')
  })
})
