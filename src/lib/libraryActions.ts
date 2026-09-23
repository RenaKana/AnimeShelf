import { request } from '../api'
import type { FolderOperationResult } from '../types'

const ownerHeaders = {
  'Content-Type': 'application/json',
  'X-AnimeShelf-Owner': '1',
}

export interface FolderRenameHistoryItem {
  operationId: string
  fromPath: string
  toPath: string
  createdAt: string
  status: string
  canUndo: boolean
  reason?: string
}

export interface FolderRenameHistory {
  items: FolderRenameHistoryItem[]
  blocked?: string
}

export function updateFolderDisplayName(id: number, name: string) {
  return request<{ ok?: boolean; id?: number; name: string }>(`/api/folders/${id}/display-name`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ name }),
  })
}

export function getFolderRenameHistory(id: number) {
  return request<FolderRenameHistory>(`/api/folders/${id}/rename-history`, {
    headers: ownerHeaders,
    cache: 'no-store',
  })
}

export function undoFolderRename(id: number, operationId: string, expectedPath: string) {
  return request<FolderOperationResult>(`/api/folders/${id}/undo-rename`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ operationId, expectedPath }),
  })
}

export function relinkFolder(id: number, expectedPath: string, path: string) {
  return request<FolderOperationResult>(`/api/folders/${id}/relink`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedPath, path }),
  })
}

export function openFolderLocation(id: number) {
  return request<{ ok: boolean; path: string }>(`/api/local-files/folder/${id}/open`, {
    method: 'POST',
    headers: ownerHeaders,
  })
}

export function revealFileLocation(id: number) {
  return request<{ ok: boolean; path: string }>(`/api/local-files/file/${id}/reveal`, {
    method: 'POST',
    headers: ownerHeaders,
  })
}
