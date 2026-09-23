import { describe, expect, it } from 'vitest'
import { scopeFolderCatalog } from '../client/folderCatalogScope'
import type { MediaCatalogSnapshot } from '../../../src/types'

describe('folder detail catalog scope', () => {
  const catalog = {
    media_catalog: [{ folder_id: 642 }, { folder_id: 807 }],
    media_catalog_summary: { root_folder_id: 594 },
    media_catalog_v2: { root_folder_id: 594 },
    media_catalog_candidates: [{ folder_id: 816 }],
  } as MediaCatalogSnapshot
  it('keeps the owning collection catalog unchanged', () => {
    expect(scopeFolderCatalog(594, catalog)).toBe(catalog)
  })
  it('does not project sibling works or inherited candidates on a nested physical folder', () => {
    expect(scopeFolderCatalog(642, catalog)).toEqual({ media_catalog: [], media_catalog_summary: null, media_catalog_v2: null, media_catalog_candidates: [] })
  })
  it('also scopes legacy-only mutation responses and ignores unknown ownership', () => {
    const legacy = { ...catalog, media_catalog_v2: undefined }
    expect(scopeFolderCatalog(594, legacy)).toBe(legacy)
    expect(scopeFolderCatalog(642, legacy).media_catalog).toEqual([])
    expect(scopeFolderCatalog(642, null).media_catalog).toEqual([])
    expect(scopeFolderCatalog(642, { ...legacy, media_catalog_summary: null }).media_catalog).toEqual([])
  })
})
