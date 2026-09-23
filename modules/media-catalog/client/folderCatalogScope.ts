import type { MediaCatalogSnapshot } from '../../../src/types'

const EMPTY_CATALOG: MediaCatalogSnapshot = {
  media_catalog: [], media_catalog_summary: null, media_catalog_v2: null, media_catalog_candidates: [],
}

/** API actions resolve the owning catalog; a nested folder must not render its siblings. */
export function scopeFolderCatalog(folderId: number, snapshot: MediaCatalogSnapshot | null | undefined): MediaCatalogSnapshot {
  const owner = snapshot?.media_catalog_v2?.root_folder_id ?? snapshot?.media_catalog_summary?.root_folder_id
  return owner === folderId && snapshot ? snapshot : EMPTY_CATALOG
}
