import type { Database } from 'node-sqlite3-wasm'

export function installFilesystemHistorySchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS filesystem_operation_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    folder_id INTEGER NOT NULL,
    library_root TEXT NOT NULL,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    identity TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    status TEXT NOT NULL,
    undo_of TEXT,
    created_at TEXT NOT NULL,
    error TEXT
  )`)
}
