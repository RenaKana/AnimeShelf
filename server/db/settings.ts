import type { Database } from 'node-sqlite3-wasm'
import { as } from './schema'
import { sqlAll, sqlGet, sqlRun } from './sql'

export function makeSettingsDb(db: Database) {
  return {
    get(key: string): string | undefined {
      return as<{ value: string } | undefined>(sqlGet(db, 'SELECT value FROM settings WHERE key = ?', key) ?? undefined)?.value
    },
    set(key: string, value: string): void {
      sqlRun(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
    },
    getAll(): Record<string, string> {
      const rows = as<{ key: string; value: string }[]>(sqlAll(db, 'SELECT key, value FROM settings'))
      return Object.fromEntries(rows.map(r => [r.key, r.value]))
    },
  }
}
