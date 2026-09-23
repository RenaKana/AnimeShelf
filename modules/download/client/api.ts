import { read } from '../../../src/api'
import type { DownloadSource, ResourcePage, ResourceQuery } from '../shared/types'

export async function fetchDownloadSources(signal?: AbortSignal): Promise<DownloadSource[]> {
  const response = await read<{ sources: DownloadSource[] }>('/api/download/sources', signal)
  return response.sources
}

export function fetchDownloadPage(query: ResourceQuery, signal: AbortSignal): Promise<ResourcePage> {
  const params = new URLSearchParams({ source: query.source, keyword: query.keyword })
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.refresh) params.set('refresh', '1')
  return read<ResourcePage>(`/api/download/resources?${params.toString()}`, signal)
}
