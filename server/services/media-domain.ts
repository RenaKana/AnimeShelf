import type { Folder } from '../types'
import { parseMediaDomainEvidence, resolveMediaDomain, type MediaDomainEvidence, type MediaDomainResolution } from '../../shared/media-domain'

/** Old AniList bindings were made through Media(type: ANIME). An empty
 * source default without an ID proves nothing. Other legacy bindings need
 * the structured subject type / genre IDs that old versions did not save. */
export function folderDomainEvidence(folder: Folder): MediaDomainEvidence[] | null {
  if (folder.media_domain_evidence != null) {
    return parseMediaDomainEvidence(folder.media_domain_evidence).filter(entry =>
      entry.source === folder.source && entry.externalId === String(folder.anilist_id)
      && (entry.source !== 'tmdb' || entry.mediaType === folder.tmdb_media_type))
  }
  if (folder.source === 'anilist' && Number(folder.anilist_id) > 0) {
    return [{ source: 'anilist', externalId: String(folder.anilist_id), mediaType: 'ANIME', authority: 'confirmed' }]
  }
  return null
}

export function classifyFolder(folder: Folder, libraryType: unknown, metadataFolder: Folder = folder): MediaDomainResolution {
  const source = folder.media_domain_override != null ? folder : metadataFolder
  const result = resolveMediaDomain({
    override: source.media_domain_override,
    evidence: folderDomainEvidence(source),
    hasMetadata: Boolean(source.anilist_id || source.has_poster || source.synopsis?.trim() || source.genres || source.year != null || source.rating != null || source.episodes != null),
    libraryType,
  })
  if (source.id !== folder.id && result.media_domain_source !== 'library_default' && result.media_domain_source !== 'unknown') {
    return { ...result, media_domain_source: result.media_domain_source === 'manual' ? 'metadata' : result.media_domain_source, media_domain_reason: 'display_metadata' }
  }
  return result
}
