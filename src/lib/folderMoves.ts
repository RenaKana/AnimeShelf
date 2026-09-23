import { request, queryString } from '../api'
import type { FolderMoveInput, FolderMoveJob, FolderMovePreview } from '../../shared/folder-moves'
const headers = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }
export const folderMoves = {
  directories: (libraryId: number, relativePath = '') => request<{ path: string; relativePath: string; children: Array<{ name: string; relativePath: string }> }>(`/api/folder-moves/directories${queryString({ libraryId, relativePath })}`, { headers, cache: 'no-store' }),
  preview: (input: FolderMoveInput) => request<FolderMovePreview>('/api/folder-moves/preview', { method: 'POST', headers, body: JSON.stringify(input) }),
  create: (input: FolderMoveInput, key: string) => request<FolderMoveJob>('/api/folder-moves', { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(input) }),
  list: () => request<FolderMoveJob[]>('/api/folder-moves', { headers, cache: 'no-store' }),
  get: (id: string) => request<FolderMoveJob>(`/api/folder-moves/${id}`, { headers, cache: 'no-store' }),
  action: (id: string, action: 'cancel' | 'resume' | 'retry' | 'reconcile') => request<FolderMoveJob>(`/api/folder-moves/${id}/${action}`, { method: 'POST', headers }),
}
