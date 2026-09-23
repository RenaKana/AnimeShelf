export interface RestoreResolution { folderId: number; path?: string; keepMissing?: boolean }
export interface RestoreEntry {
  folderId: number; parentId: number | null; name: string; fromPath: string; toPath: string
  status: 'direct' | 'coordinated' | 'unresolved' | 'missing'; reason?: string; candidates: string[]
}
export interface RestorePreview { previewId: string; entries: RestoreEntry[]; unresolved: number; expiresAt: number }
