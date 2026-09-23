import type { Database } from 'node-sqlite3-wasm'
import { makeSettingsDb } from './settings'

// The host initializes the process database before loading feature entrypoints.
export let db: Database
export let settingsDb: ReturnType<typeof makeSettingsDb>
export function initializeDatabase(database: Database): void {
  db = database
  settingsDb = makeSettingsDb(database)
}
