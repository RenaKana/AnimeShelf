import type { Database } from 'node-sqlite3-wasm'
import { assertMoveRecoverySettled } from './folder-move-store'

export class LibraryMaintenanceError extends Error {
  readonly status = 409
  readonly code = 'LIBRARY_BUSY'
}

const active = new WeakMap<Database, string>()
const idleListeners = new WeakMap<Database, Set<() => void>>()

export const libraryMaintenanceOperation = (db: Database): string | undefined => active.get(db)

export function onLibraryMaintenanceIdle(db: Database, listener: () => void): () => void {
  let listeners = idleListeners.get(db)
  if (!listeners) { listeners = new Set(); idleListeners.set(db, listeners) }
  listeners.add(listener)
  return () => {
    listeners!.delete(listener)
    if (!listeners!.size && idleListeners.get(db) === listeners) idleListeners.delete(db)
  }
}

export function assertLibraryAvailable(db: Database): void {
  const operation = active.get(db)
  if (operation) throw new LibraryMaintenanceError(`媒体库正在执行${operation}，请完成后重试`)
  assertMoveRecoverySettled(db)
}

/** Hold from before collecting a snapshot through its final write, not just during SQL. */
export async function withLibraryMaintenance<T>(db: Database, label: string, operation: () => Promise<T> | T, moveRecovery = false): Promise<T> {
  if (moveRecovery) {
    if (active.has(db)) throw new LibraryMaintenanceError(`媒体库正在执行${active.get(db)}，请完成后重试`)
  } else assertLibraryAvailable(db)
  active.set(db, label)
  try { return await operation() } finally {
    active.delete(db)
    // Observers schedule their own work; never run another operation inside the
    // releasing operation's finally block or let observers change its result.
    for (const listener of idleListeners.get(db) ?? []) {
      try { listener() } catch { /* isolated lifecycle observer */ }
    }
  }
}
