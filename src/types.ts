import type { MediaDomain, MediaDomainFields, MediaDomainEvidence } from '../shared/media-domain'

export interface Library {
  id: number; name: string; root_path: string; type: string
  everything_url: string | null; created_at: string
}
export interface Tag { id: number; name: string; color: string; kind: 'custom' | 'system' }
export type DisplayMetadataKind = 'self' | 'season' | 'movie' | 'special' | 'extras' | 'unknown'
export interface DisplayMetadataCandidate {
  id: number; name: string; path: string; kind: DisplayMetadataKind; depth: number; hasMetadata: boolean
}
export interface FolderView extends MediaDomainFields {
  id: number; library_id: number; parent_id: number | null; name: string; path: string
  is_series: number; anilist_id: number | null; has_poster: number
  path_missing?: number
  media_domain?: MediaDomain
  tmdb_media_type?: 'movie' | 'tv' | null
  owned_season_numbers?: number[] | null
  size: number; file_count: number; tags: Tag[]
  pinned?: number // 虚拟拎出：合集标记（1 = 侧边栏单独入口）
  library_name?: string // 「全部媒体」视图展示所属媒体库
  rating?: number | null; genres?: string | null; synopsis?: string | null; year?: number | null; episodes?: number | null
  source?: string // 元数据来源 'bangumi' | 'anilist' | 'tmdb'
  display_metadata_folder_id?: number | null
  effective_metadata_folder_id?: number
  effective_metadata_folder_name?: string
  poster_version?: string | null
  display_metadata_candidates?: DisplayMetadataCandidate[]
  created_at: string; updated_at: string
}
export interface FileItem {
  id: number; folder_id: number; library_id: number; name: string; path: string
  size: number | null; date_modified: number | null; ext: string
  path_missing?: number
  tags: Tag[]; created_at: string; updated_at: string
}
export type MediaCatalogKind = 'season' | 'movie' | 'ova' | 'special' | 'custom' | 'extras' | 'unknown'
export interface MediaCatalogEntry extends MediaDomainFields {
  id: number; folder_id: number; series_id: number
  kind: MediaCatalogKind; season_number: number | null; part_number: number | null
  folder_name: string; folder_path: string; series_title: string; series_key: string
  manual_locked: 0 | 1; confidence: number; conflict_reason: string | null
  detected_by: string; source: string | null; external_id: string | null
  custom_label?: string | null
}
export interface MediaCatalogSummary extends MediaDomainFields {
  root_folder_id: number; series_id: number; series_key: string; series_title: string
  entry_count: number; season_numbers: number[]; manual_count: number
  conflict_count: number; unknown_count: number
}
export interface MediaCatalogSourceId {
  source: string; external_id: string; is_primary: 0 | 1
}
export interface MediaCatalogItem extends MediaDomainFields {
  id: number; library_id: number; root_folder_id: number; item_key: string
  title: string; title_zh: string | null; kind: MediaCatalogKind
  season_number: number | null; part_number: number | null
  manual_locked: 0 | 1; confidence: number; conflict_reason: string | null
  source_ids: MediaCatalogSourceId[]
  custom_label?: string | null
}
export interface MediaCatalogMapping extends MediaDomainFields {
  id: number; folder_id: number; media_item_id: number; root_folder_id: number
  series_id: number | null; content_role: string; kind: MediaCatalogKind
  season_number: number | null; part_number: number | null
  folder_name: string; folder_path: string; manual_locked: 0 | 1
  confidence: number; conflict_reason: string | null; detected_by: string
  custom_label?: string | null
}
export interface MediaCatalogV2Summary {
  root_folder_id: number; item_count: number; mapping_count: number
  season_numbers: number[]; manual_count: number; conflict_count: number
  unknown_count: number
}

export interface MediaCatalogWorkGroupMember {
  id: number
  work_group_id?: number
  media_item_id: number
  relation_role: 'main' | 'side_story' | 'spin_off' | 'unknown' | string
  manual_locked: 0 | 1
}

export interface MediaCatalogWorkGroupSummary {
  item_count: number
  physical_folder_count: number
  season_numbers: number[]
  manual_count: number
  conflict_count: number
  unknown_count: number
}

export interface MediaCatalogWorkGroup extends MediaDomainFields {
  id: number
  key: string
  group_key: string
  title: string
  anchor: number | null
  anchor_folder_id: number | null
  manual_locked: 0 | 1
  item_ids: number[]
  members: MediaCatalogWorkGroupMember[]
  summary: MediaCatalogWorkGroupSummary
}

export interface MediaCatalogV2 {
  root_folder_id: number; items: MediaCatalogItem[]; mappings: MediaCatalogMapping[]
  summary: MediaCatalogV2Summary; work_groups: MediaCatalogWorkGroup[]
  ungrouped_item_ids: number[]
}
export interface CollectionPresentation {
  entries: Array<{ key: string; title: string | null; position: number | null }>
}
export interface CollectionPresentationUpdate {
  key: string; title?: string | null; position?: number | null
}
export type MediaCatalogCandidateReason = 'excluded' | 'extras' | 'insufficient_evidence'
export interface MediaCatalogCandidate extends MediaDomainFields {
  folder_id: number; folder_name: string; folder_path: string
  suggested_kind: MediaCatalogKind; suggested_season_numbers: number[]
  suggested_part_number: number | null; suggested_custom_label?: string | null; confidence: number
  reason: MediaCatalogCandidateReason; source: string | null; external_id: string | null
}
export interface MediaCatalogRebuildResult {
  rootCount: number; foldersProcessed: number; inserted: number
  removedAutomatic: number; preservedManual: number; seasonEntries: number
  unknownEntries: number; conflicts: number
  canonicalItems?: number; canonicalMappings?: number
  canonicalUnknownItems?: number; canonicalConflicts?: number
}
export interface MediaCatalogSnapshot {
  media_catalog: MediaCatalogEntry[]
  media_catalog_summary: MediaCatalogSummary | null
  media_catalog_v2?: MediaCatalogV2 | null
  media_catalog_candidates: MediaCatalogCandidate[]
}
export interface MediaCatalogManualPayload {
  kind: MediaCatalogKind
  customLabel?: string | null
  seasonNumbers?: number[]
  partNumber?: number | null
  clearManual?: boolean
}
export type MediaCatalogUpdatePayload = MediaCatalogManualPayload | { clearManual: true } | { excluded: true }
export interface FolderDetail extends FolderView {
  collection_artwork?: Array<{ id: number; poster_version: string | null }>
  collection_reset?: { snapshot_version: string }
  children: FolderView[]
  files: FileItem[]
  media_catalog: MediaCatalogEntry[]
  media_catalog_summary: MediaCatalogSummary | null
  media_catalog_v2?: MediaCatalogV2 | null
  media_catalog_candidates: MediaCatalogCandidate[]
}
export interface FolderOperationResult {
  id: number
  name: string
  path: string
  libraryId: number
}
export type ScanResult = import('../shared/library-scan').LibraryScanResult
export interface AniListCandidate {
  anilistId: number; title: string; originalTitle: string | null
  year: number | null; rating: number | null; genres: string[]
  synopsis: string | null; episodes: number | null
  posterUrl: string | null; posterPath: string | null
}
export interface BangumiCandidate {
  bgmId: number; title: string; titleZh: string | null
  year: number | null; rating: number | null
  synopsis: string | null; posterUrl: string | null; posterPath: string | null
  type?: number | null // bgm 类型：2=动画 6=真人 1=书籍 3=音乐 4=游戏
  episodes?: number | null
  airedEpisodes?: number | null
  airDate?: string | null
  airStatus?: 'airing' | 'finished' | 'upcoming' | null
}
export interface TMDBCandidate {
  tmdbId: number; mediaType: 'movie' | 'tv'
  title: string; originalTitle: string | null
  year: number | null; rating: number | null; genres: string[]
  synopsis: string | null; seasons: number | null
  posterUrl: string | null; posterPath: string | null
  genreIds?: number[] | null; mediaDomain?: MediaDomain
}
export type MetadataSource = 'anilist' | 'bangumi' | 'tmdb'
export type MetadataCandidate = AniListCandidate | BangumiCandidate | TMDBCandidate
export interface Wallpaper {
  id: string; name: string
  type: 'video' | 'web' | 'scene' | 'application' | 'unknown'
  dir: string; mediaFile: string | null; preview: string | null
  renderMode: 'video' | 'web' | 'preview' | 'unavailable'
}
export interface DatabaseSystemInfo {
  dataDir: string
  databasePath: string
  databaseSize: number
  schemaVersion: number
  healthy: boolean
  integrity: string[]
}
export interface SeasonAnime extends MediaDomainFields {
  id: string; title: string; titleZh: string | null
  begin: string; airDay: string; airTime: string | null
  links: { name: string; url: string }[]
  favorited: boolean
}
export interface SeasonCalendarData {
  season: string; year: number
  days: Record<string, SeasonAnime[]>
  favorites: string[]
}
export interface SeasonFavorite extends MediaDomainFields {
  item_id: string; title: string; title_zh: string | null
  air_day: string | null; air_time: string | null; begin: string | null; bangumi_id: string | null
  links: { name: string; url: string }[]
  image: string | null
  synopsis: string | null
  synopsis_original: string | null
  aired_episodes: number | null
  total_episodes: number | null
  air_status: 'airing' | 'finished' | 'upcoming' | null
  media_type: 'anime' | 'live'
  lib_match_override: 'present' | 'absent' | null
  lib_hit: { matched: boolean; method: 'id' | 'name' | 'manual'; folderName: string | null; folderId: number | null } | null
  /** Automatic media-library state; omitted only for legacy API snapshots. */
  lib_status?: 'present' | 'related' | 'absent' | 'unknown'
  added_at: string
}
export interface SeasonFavoritePayload {
  media_domain_evidence?: MediaDomainEvidence[]
  item_id: string
  title: string
  title_zh?: string | null
  air_day?: string | null
  air_time?: string | null
  begin?: string | null
  bangumi_id?: string | null
  links?: { name: string; url: string }[] | null
  image?: string | null
  media_type?: 'anime' | 'live' | null
  synopsis?: string | null
  synopsis_original?: string | null
  aired_episodes?: number | null
  total_episodes?: number | null
  air_status?: 'airing' | 'finished' | 'upcoming' | null
}
export type Settings = Record<string, string>
