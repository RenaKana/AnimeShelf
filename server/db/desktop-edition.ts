import { Database } from 'node-sqlite3-wasm'
import type { Database as DatabaseHandle } from 'node-sqlite3-wasm'
import { sqlGet } from './sql'

export class DesktopEditionError extends Error {
  readonly code = 'PHONE_EDITION_UNSUPPORTED'

  constructor() {
    super('数据库或备份包含手机端同步数据，当前桌面版无法安全打开或恢复。')
    this.name = 'DesktopEditionError'
  }
}

export function assertDesktopEdition(database: DatabaseHandle): void {
  const phoneObject = sqlGet<{ name: string }>(database, `
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'trigger') AND name GLOB 'mobile_*'
    LIMIT 1
  `)
  if (phoneObject) throw new DesktopEditionError()
}

export function assertDesktopEditionBackupFile(file: string): void {
  const backup = new Database(file, { readOnly: true, fileMustExist: true })
  let failure: unknown
  try { assertDesktopEdition(backup) }
  catch (error) { failure = error }
  try { backup.close() }
  catch (error) { if (failure === undefined) failure = error }
  if (failure !== undefined) throw failure
}
