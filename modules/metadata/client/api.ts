import type { FolderView, MetadataCandidate, Settings } from '../../../src/types'
import { queryString, request } from '../../../src/api'
import type { PosterRepairFailure } from '../../../shared/poster-repair'
export type { PosterRepairFailure } from '../../../shared/poster-repair'

// Task failures must surface with a reload action while retaining the exact ID.
// Do not hide them inside unbounded connection recovery or replay a mutation.
const taskRead = <T>(url: string) => request<T>(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })

export type PosterRepairMode = 'missing' | 'refresh'
export type MetadataSource = 'auto' | 'anilist' | 'bangumi' | 'tmdb'
export interface MetadataMatchProgress {
  jobId: string
  folderIds: number[] | null
  running: boolean
  total: number
  done: number
  matched: number
  failed: number
  current: string
  reasons?: Record<string, number>
  error?: string | null
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'idle'
}
export interface PosterRepairScope { libraryId?: number; includeFavorites?: boolean; folderIds?: number[] }
export interface PosterRepairJob {
  jobId: string
  retryOf: string | null
  mode: PosterRepairMode
  libraryId: number | null
  includeFavorites: boolean
  folderIds?: number[] | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  running: boolean
  done: boolean
  total: number
  processed: number
  repaired: number
  skipped: number
  failed: number
  current: string
  failures: PosterRepairFailure[]
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export const metadataApi = {
  search: (query: string, source = 'bangumi', folderId?: number) =>
    request<MetadataCandidate[]>(`/api/metadata/search${queryString({ q: query, source, folder_id: folderId })}`),
  bind: (folderId: number, source: string, candidate: MetadataCandidate) =>
    request<FolderView>('/api/metadata/bind', { method: 'POST', body: JSON.stringify({ folder_id: folderId, source, candidate }) }),
  refreshFolder: (folderId: number) =>
    request<FolderView>(`/api/folders/${folderId}/refresh-metadata`, { method: 'POST' }),
  clearFolder: (folderId: number) =>
    request<{ ok: boolean }>(`/api/folders/${folderId}/clear-metadata`, { method: 'POST' }),
  setDisplayFolder: (folderId: number, displayFolderId: number | null) =>
    request<FolderView>(`/api/folders/${folderId}/display-metadata`, { method: 'PUT', body: JSON.stringify({ folderId: displayFolderId }) }),
  matchLibrary: (libraryId: number, source: MetadataSource, folderIds?: number[]) =>
    request<{ running: boolean; jobId: string; folderIds: number[] | null }>(`/api/libraries/${libraryId}/match-metadata`, { method: 'POST', body: JSON.stringify({ source, folderIds }) }),
  libraryMatchStatus: (libraryId: number, jobId?: string) =>
    taskRead<MetadataMatchProgress>(`/api/libraries/${libraryId}/match-status${queryString({ jobId })}`),
  clearLibrary: (libraryId: number, folderIds?: number[]) =>
    request<{ ok: boolean; folderIds: number[] | null }>(`/api/libraries/${libraryId}/clear-metadata`, { method: 'POST', body: JSON.stringify({ folderIds }) }),
  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (settings: Settings) => request<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  repairPosters: (body?: PosterRepairScope & { mode?: PosterRepairMode }) =>
    request<{ ok: true; jobId: string; job: PosterRepairJob }>('/api/settings/repair-posters', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  posterRepairStatus: (jobId: string) =>
    taskRead<PosterRepairJob>(`/api/settings/backups/poster-repair-status${queryString({ jobId })}`),
  latestPosterRepair: async (libraryId?: number, includeFavorites = false, folderIds?: number[]) => {
    // queryString omits empty strings; never turn an explicit empty scope into
    // an unscoped task lookup that could restore an unrelated library job.
    if (folderIds !== undefined && (!folderIds.length || folderIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
      throw new Error('海报任务范围必须包含有效作品')
    }
    return taskRead<PosterRepairJob | null>(`/api/settings/backups/poster-repair-status${queryString({ libraryId: libraryId ?? 'all', includeFavorites: includeFavorites ? 1 : undefined, folderIds: folderIds?.join(',') })}`)
  },
  retryPosterRepair: (jobId: string) =>
    request<{ ok: true; jobId: string; job: PosterRepairJob }>(`/api/settings/repair-posters/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
}
