export interface LibraryScanResult {
  added: number; updated: number; removed: number; errors: string[]
  changed?: boolean; moved?: number; missing?: number; restored?: number
  retryable?: boolean; code?: string
  ambiguous?: number; warnings?: string[]
}

export interface LibraryScanStatus {
  libraryId: number
  reason: 'startup' | 'watch' | 'periodic' | 'manual' | 'retry'
  status: 'idle' | 'queued' | 'waiting' | 'scanning' | 'complete' | 'error'
  waitingReason?: 'filesystem_changed' | 'maintenance' | 'retry'
  /** Monotonic within an instance; optional for compatibility with older hosts. */
  sequence?: number
  revision: number
  result?: LibraryScanResult
  error?: string
  watchError?: string
}

export interface LibraryScanSnapshot {
  instanceId: string
  revision: number
  libraries: LibraryScanStatus[]
}
