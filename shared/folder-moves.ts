export interface MoveSelection { id: number; expectedPath: string }
export interface FolderMoveInput {
  items: MoveSelection[]
  targetLibraryId: number
  targetRelativePath: string
}
export type MovePhase = 'pending' | 'copying' | 'verified' | 'source_staged' | 'published' | 'committed' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'cleanup_pending' | 'needs_attention'
export interface FolderMoveItem {
  id: number
  name: string
  sourcePath: string
  targetPath: string
  sourceLibraryId: number
  bytes: number
  copiedBytes: number
  phase: MovePhase
  crossVolume: boolean
  error?: string
  code?: string
  coveredBy?: number
  recoveryPaths?: string[]
  log?: Array<{ at: string; phase: MovePhase; bytes: number; error?: string }>
}
export interface FolderMovePreview { input: FolderMoveInput; items: FolderMoveItem[]; bytes: number }
export interface FolderMoveJob {
  id: string
  status: 'running' | 'paused' | 'completed' | 'cancelled'
  createdAt: string
  updatedAt: string
  input: FolderMoveInput
  items: FolderMoveItem[]
  cancelRequested: boolean
  error?: string
}
export interface BatchDomainResult { results: Array<{ id: number; ok: boolean; error?: string }> }
