export { DOWNLOAD_SOURCE_IDS as SOURCE_IDS } from '../../../shared/download-sources'
import { DOWNLOAD_SOURCE_IDS as SOURCE_IDS } from '../../../shared/download-sources'
export type SourceId = typeof SOURCE_IDS[number]
export interface DownloadSource {
  id: SourceId
  name: string
  url: string
  note?: string
}
export interface DownloadResource {
  source: SourceId
  id: string
  title: string
  detailUrl: string
  group: string | null
  size: string | null
  publishedAt: string | null
  seeders: number | null
  isCollection?: boolean
}
export type SourceStatusKind = 'success' | 'restricted' | 'rate_limited' | 'error'
export interface SourceStatus {
  kind: SourceStatusKind
  message: string
  code?: 'network_policy' | 'timeout' | 'connection' | 'parse' | 'http' | 'busy' | 'unsafe_target' | 'proxy_unsupported'
  retryAt?: string
}
export interface ResourcePage {
  source: SourceId
  resources: DownloadResource[]
  nextCursor: string | null
  status: SourceStatus
  cached?: boolean
}
export interface ResourceQuery {
  source: SourceId
  keyword: string
  cursor?: string
  refresh?: boolean
}
