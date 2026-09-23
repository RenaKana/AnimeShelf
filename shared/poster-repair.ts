export type PosterFailureCode = 'SOURCE_CONFIRMATION_REQUIRED' | 'SOURCE_CONFIGURATION' | 'SOURCE_NO_POSTER'
  | 'NETWORK_ERROR' | 'TLS_ERROR' | 'IMAGE_REJECTED' | 'PROXY_CONFIGURATION' | 'DOWNLOAD_FAILED'

export interface PosterRepairFailure {
  key: string
  source: 'anilist' | 'bangumi' | 'tmdb' | 'favorite' | 'unknown'
  sourceId: string
  name: string
  reason: string
  code: PosterFailureCode
  retryable: boolean
  folderIds: number[]
}
