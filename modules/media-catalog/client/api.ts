import type { CollectionOrganization } from '../../../shared/collection-organization'
import type {
  CollectionPresentation,
  CollectionPresentationUpdate,
  FolderDetail,
  FolderOperationResult,
  FolderView,
  MediaCatalogRebuildResult,
  MediaCatalogSnapshot,
  MediaCatalogUpdatePayload,
} from '../../../src/types'
import { queryString, request } from '../../../src/api'

export const api = {
  folders: {
    list: (params: Record<string, string | number | undefined> = {}) =>
      request<FolderView[]>(`/api/folders${queryString(params)}`),
    get: (id: number) => request<FolderDetail>(`/api/folders/${id}`),
    resetCollection: (id: number, expectedSnapshotVersion: string) =>
      request<MediaCatalogSnapshot & { collection_reset: { root_folder_id: number; before_snapshot_version: string; after_snapshot_version: string } }>(`/api/folders/${id}/collection-reset`, { method: 'POST', body: JSON.stringify({ confirm: true, expected_snapshot_version: expectedSnapshotVersion }) }),
    getCollectionOrganization: (id: number) => request<{ organization: CollectionOrganization; revision: number }>(`/api/folders/${id}/collection-organization`),
    updateCollectionOrganization: (id: number, organization: CollectionOrganization, expectedRevision: number) =>
      request<{ organization: CollectionOrganization; revision: number }>(`/api/folders/${id}/collection-organization`, { method: 'PATCH', body: JSON.stringify({ organization, expectedRevision }) }),
    getCollectionPresentation: (id: number) => request<CollectionPresentation>(`/api/folders/${id}/collection-presentation`),
    updateCollectionPresentation: (id: number, updates: CollectionPresentationUpdate[]) =>
      request<CollectionPresentation>(`/api/folders/${id}/collection-presentation`, { method: 'PATCH', body: JSON.stringify({ updates }) }),
    moveCollectionMember: (id: number, itemId: number, groupId: number | null) =>
      request<MediaCatalogSnapshot>(`/api/folders/${id}/collection-members/${itemId}/group`, { method: 'PUT', body: JSON.stringify({ groupId }) }),
    rebuildMediaCatalog: (id: number) =>
      request<MediaCatalogSnapshot & { rebuild: MediaCatalogRebuildResult }>(`/api/folders/${id}/rebuild-media-catalog`, { method: 'POST' }),
    updateMediaCatalog: (id: number, body: MediaCatalogUpdatePayload) =>
      request<MediaCatalogSnapshot>(`/api/folders/${id}/media-catalog`, { method: 'PUT', body: JSON.stringify(body) }),
    renameMediaWorkGroup: (folderId: number, groupId: number, title: string) =>
      request<MediaCatalogSnapshot>(`/api/folders/${folderId}/media-work-groups/${groupId}/title`, { method: 'PUT', body: JSON.stringify({ title }) }),
    mergeMediaWorkGroups: (folderId: number, targetGroupId: number, sourceGroupId: number) =>
      request<MediaCatalogSnapshot>(`/api/folders/${folderId}/media-work-groups/${targetGroupId}/merge`, { method: 'POST', body: JSON.stringify({ sourceGroupId }) }),
    detachMediaWorkGroupItem: (folderId: number, groupId: number, mediaItemId: number, title?: string) =>
      request<MediaCatalogSnapshot>(`/api/folders/${folderId}/media-work-groups/${groupId}/detach`, { method: 'POST', body: JSON.stringify({ mediaItemId, ...(title === undefined ? {} : { title }) }) }),
    attachMediaWorkGroupItem: (folderId: number, groupId: number, mediaItemId: number) =>
      request<MediaCatalogSnapshot>(`/api/folders/${folderId}/media-work-groups/${groupId}/attach`, { method: 'POST', body: JSON.stringify({ mediaItemId }) }),
    splitMediaWorkGroup: (folderId: number, groupId: number, mediaItemIds: number[], title: string) =>
      request<MediaCatalogSnapshot>(`/api/folders/${folderId}/media-work-groups/${groupId}/split`, { method: 'POST', body: JSON.stringify({ mediaItemIds, title }) }),
    rename: (id: number, name: string, expectedPath: string) =>
      request<FolderOperationResult>(`/api/folders/${id}/rename`, { method: 'PUT', body: JSON.stringify({ name, expectedPath }) }),
    pin: (id: number, pinned: boolean) =>
      request<{ ok: boolean; pinned: boolean; name: string }>(`/api/folders/${id}/pin`, { method: 'PUT', body: JSON.stringify({ pinned }) }),
  },
}
