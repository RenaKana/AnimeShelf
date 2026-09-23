import type {
  DatabaseSystemInfo,
  FileItem,
  FolderDetail,
  FolderOperationResult,
  FolderView,
  Library,
  ScanResult,
  Settings,
  Tag,
} from './types'
import { recoverRead } from './lib/readRecovery'
import type { RestorePreview, RestoreResolution } from '../shared/restore'

const ownerHeaders = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options })
  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    const body = parsed && typeof parsed === 'object' ? parsed : {}
    const err: any = new Error((body as any).error ?? `HTTP ${res.status}`)
    err.status = res.status
    err.code = (body as any).code
    err.diagnostics = (body as any).diagnostics
    err.connection = (body as any).connection
    // Vite emits an empty 500 when its API target is restarting. Keep actual
    // application 500s (with an error body) visible instead of retrying forever.
    err.retryable = [502, 503, 504].includes(res.status)
      || (res.status === 500 && !(body as any).error && !(body as any).code)
    throw err
  }
  return res.json() as Promise<T>
}

export const read = <T>(url: string, signal?: AbortSignal): Promise<T> => recoverRead(
  attemptSignal => request<T>(url, { cache: 'no-store', signal: attemptSignal }), signal,
)

export type QueryParams = Record<string, string | number | readonly (string | number)[] | undefined>
export const queryString = (params: QueryParams) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== '') search.append(key, String(item))
    }
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

export const api = {
  libraries: {
    list: (signal?: AbortSignal) => request<Library[]>('/api/libraries', { signal }),
    create: (body: { name: string; path: string; type: string; everything_url?: string }) =>
      request<Library>('/api/libraries', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, patch: { name?: string; type?: string }) =>
      request<Library>(`/api/libraries/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    rename: (id: number, name: string) =>
      request<Library>(`/api/libraries/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    remove: (id: number) => request<{ ok: boolean }>(`/api/libraries/${id}`, { method: 'DELETE' }),
    scan: (id: number) => request<ScanResult>(`/api/libraries/${id}/scan`, { method: 'POST' }),
    scanStatus: (signal?: AbortSignal) => request<import('../shared/library-scan').LibraryScanSnapshot>('/api/libraries/scan-status', { signal, cache: 'no-store' }),
  },
  folders: {
    setBatchMediaDomain: (ids: number[], override: import('../shared/media-domain').MediaDomain | null) =>
      request<import('../shared/folder-moves').BatchDomainResult>('/api/folders/batch/media-domain', { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ ids, override }) }),
    setMediaDomain: (id: number, override: import('../shared/media-domain').MediaDomain | null) =>
      request<FolderView>(`/api/folders/${id}/media-domain`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ override }) }),
    list: (params: QueryParams = {}, signal?: AbortSignal) =>
      request<FolderView[]>(`/api/folders${queryString(params)}`, { signal }),
    get: (id: number) => request<FolderDetail>(`/api/folders/${id}`),
    rename: (id: number, name: string, expectedPath: string) =>
      request<FolderOperationResult>(`/api/folders/${id}/rename`, { method: 'PUT', body: JSON.stringify({ name, expectedPath }) }),
    move: (id: number, targetLibraryId: number, expectedPath: string) =>
      request<FolderOperationResult>(`/api/folders/${id}/move`, { method: 'PUT', body: JSON.stringify({ targetLibraryId, expectedPath }) }),
    remove: (id: number, expectedPath: string) =>
      request<FolderOperationResult>(`/api/folders/${id}`, { method: 'DELETE', body: JSON.stringify({ expectedPath }) }),
    renameRegex: (body: { pattern: string; replacement?: string; ignoreCase?: boolean; scope?: 'top' | 'all'; apply?: boolean }) =>
      request<{ count?: number; applied?: number; scope?: string; changes: { id: number; from: string; to: string }[] }>('/api/folders/rename-regex', { method: 'POST', body: JSON.stringify(body) }),
    restoreNames: (body: { scope?: 'top' | 'all'; dryRun?: boolean }) =>
      request<{ count?: number; restored?: number; scope?: string; items: { id: number; from: string; to: string }[] }>('/api/folders/restore-names', { method: 'POST', body: JSON.stringify(body) }),
  },
  files: {
    get: (id: number) => request<FileItem>(`/api/files/${id}`),
  },
  play: (fileId: number) =>
    request<{ ok: boolean; path: string }>('/api/play', { method: 'POST', body: JSON.stringify({ file_id: fileId }) }),
  tags: {
    list: (signal?: AbortSignal) => request<Tag[]>('/api/tags', { signal }),
    create: (name: string, color?: string) =>
      request<Tag>('/api/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
    update: (id: number, patch: { name?: string; color?: string }) =>
      request<Tag>(`/api/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: number) => request<{ ok: boolean }>(`/api/tags/${id}`, { method: 'DELETE' }),
    link: (tagId: number, targetType: 'folder' | 'file', targetId: number) =>
      request<{ ok: boolean }>('/api/tags/link', { method: 'POST', body: JSON.stringify({ tag_id: tagId, target_type: targetType, target_id: targetId }) }),
    unlinkByTarget: (tagId: number, targetType: 'folder' | 'file', targetId: number) =>
      request<{ ok: boolean }>(`/api/tags/target/${tagId}${queryString({ target_type: targetType, target_id: targetId })}`, { method: 'DELETE' }),
    effective: (targetType: 'folder' | 'file', targetId: number) =>
      request<Tag[]>(`/api/tags/effective${queryString({ target_type: targetType, target_id: targetId })}`),
  },
  settings: {
    get: (signal?: AbortSignal) => request<Settings>('/api/settings', { signal }),
    systemInfo: () => request<DatabaseSystemInfo>('/api/settings/system-info'),
    update: (data: Settings) => request<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),
    backup: () => request<{ ok: boolean; path: string }>('/api/settings/backup', { method: 'POST' }),
    listBackups: () => request<{ backups: { name: string; dir: 'auto' | 'manual'; path: string; mtime: number; size: number }[] }>('/api/settings/backups'),
    inspectBackup: (source: { file: string; dir?: 'auto' | 'manual' } | { name: string; data: string }) =>
      request<RestorePreview>('/api/settings/backups/inspect', { method: 'POST', headers: ownerHeaders, body: JSON.stringify(source) }),
    resolveBackup: (previewId: string, resolutions: RestoreResolution[]) =>
      request<RestorePreview>('/api/settings/backups/inspect', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ previewId, resolutions }) }),
    restoreBackup: (previewId: string) =>
      request<{ ok: boolean; tables: number; rows: number; warning?: string }>('/api/settings/backups/restore', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ previewId }) }),
    uploadBackup: (name: string, dataBase64: string) =>
      request<RestorePreview>('/api/settings/backups/inspect', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name, data: dataBase64 }) }),
  },
}
