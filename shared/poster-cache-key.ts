export type PosterSource = 'anilist' | 'bangumi' | 'tmdb'
export type TmdbMediaType = 'movie' | 'tv'

/**
 * Return the on-disk poster identity for a metadata binding.
 *
 * TMDB ids are only unique inside their movie or TV namespace.  An absent
 * media type therefore has no safe writable cache key. Never guess or promote
 * `tm_<id>` into a typed namespace. Existing untyped bindings have a separate
 * read-only legacy-image fallback in folder presentation and missing repair.
 */
export function posterCacheKey(
  source: PosterSource,
  sourceId: number | string | null | undefined,
  tmdbMediaType?: TmdbMediaType | null,
): string | null {
  if (sourceId == null || String(sourceId).trim() === '') return null
  if (source === 'tmdb') {
    if (tmdbMediaType !== 'movie' && tmdbMediaType !== 'tv') return null
    return `tm_${tmdbMediaType}_${sourceId}`
  }
  return `${source === 'bangumi' ? 'bg' : 'al'}_${sourceId}`
}
