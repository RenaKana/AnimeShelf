import fs from 'fs'
import path from 'path'
import { Database } from 'node-sqlite3-wasm'

export function databaseIntegrity(database: Database): string[] {
  return database.all('PRAGMA integrity_check').map(row => String(Object.values(row)[0]))
}

export function assertDatabaseIntegrity(database: Database): void {
  try {
    const result = databaseIntegrity(database)
    if (result.length !== 1 || result[0] !== 'ok') throw new Error(result.join('; '))
  } catch (error) {
    const failure = new Error('数据库完整性检查失败，已停止操作；请关闭所有实例并离线修复。')
    Object.assign(failure, { code: 'DATABASE_INTEGRITY_FAILED', cause: error })
    throw failure
  }
}

export function verifyDatabaseFile(filePath: string): void {
  let snapshot: Database | null = null
  try {
    snapshot = new Database(filePath, { fileMustExist: true, readOnly: true })
    assertDatabaseIntegrity(snapshot)
  } finally {
    try { snapshot?.close() }
    catch (cause) {
      throw Object.assign(new Error('备份校验连接未能关闭，未发布备份文件。'), { code: 'DATABASE_CLOSE_FAILED', cause })
    }
  }
}

// 当前 wasm 驱动使用 DELETE journal 且同一文件只能维持一个连接。
// 在主连接上用 IMMEDIATE 事务短暂冻结写入，再同步复制并校验，避免活动数据库复制到一半发生变化。
export function createDatabaseSnapshot(database: Database, sourcePath: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination)) throw new Error(`备份文件已存在：${destination}`)
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  let transactionStarted = false
  let retainTemporary = false
  try {
    const journalRow = database.get('PRAGMA journal_mode') as Record<string, unknown> | null
    const journalMode = String(journalRow ? Object.values(journalRow)[0] : '').toLowerCase()
    if (journalMode !== 'delete') throw new Error(`不支持的 SQLite journal_mode：${journalMode || 'unknown'}`)
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    fs.copyFileSync(sourcePath, temporary)
    database.exec('COMMIT')
    transactionStarted = false
    verifyDatabaseFile(temporary)
    fs.renameSync(temporary, destination)
  } catch (error) {
    retainTemporary = (error as { code?: string }).code === 'DATABASE_CLOSE_FAILED'
    throw error
  } finally {
    if (transactionStarted) {
      try { database.exec('ROLLBACK') } catch { /* 保留主错误 */ }
    }
    // A driver lock still present means close was not proven successful.
    if (!retainTemporary && !fs.existsSync(`${temporary}.lock`)) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* 保留主错误 */ }
    }
  }
}
