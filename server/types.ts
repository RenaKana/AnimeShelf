import type { MediaDomain, MediaDomainFields } from '../shared/media-domain'

export interface Library {
  id: number; name: string; root_path: string; type: string
  everything_url: string | null; created_at: string
}
export interface Folder extends MediaDomainFields {
  id: number; library_id: number; parent_id: number | null; name: string; path: string
  is_series: number; anilist_id: number | null; has_poster: number; source: string
  tmdb_media_type?: 'movie' | 'tv' | null; media_domain?: MediaDomain
  display_metadata_folder_id?: number | null
  pinned?: number; renamed?: number; path_missing?: number; missing_source?: string | null; filesystem_identity?: string | null
  rating: number | null; genres: string | null; synopsis: string | null; year: number | null; episodes: number | null
  created_at: string; updated_at: string
}
export interface FileItem {
  id: number; folder_id: number; library_id: number; name: string; path: string
  size: number | null; date_modified: number | null; ext: string
  path_missing?: number; filesystem_identity?: string | null
  created_at: string; updated_at: string
}
export interface Tag {
  id: number; name: string; color: string; kind: 'custom' | 'system'
}
export interface TagLink {
  id: number; tag_id: number; target_type: 'folder' | 'file'; target_id: number; created_at: string
}
