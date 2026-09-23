import type { Database } from 'node-sqlite3-wasm'
import type { FolderMoveJob } from '../../shared/folder-moves'

export function installFolderMoveSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS folder_move_jobs (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_body TEXT NOT NULL,
    data TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
}
export function hasMoveStore(db: Database): boolean {
  return Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='folder_move_jobs'"))
}
export function readMoveJobs<T extends FolderMoveJob = FolderMoveJob>(db: Database): T[] {
  if (!hasMoveStore(db)) return []
  return (db.all('SELECT data FROM folder_move_jobs ORDER BY updated_at DESC') as unknown as { data: string }[]).map(row => JSON.parse(row.data))
}
export function saveMoveJob(db: Database, job: FolderMoveJob) {
  job.updatedAt = new Date().toISOString()
  db.run('UPDATE folder_move_jobs SET data=?, updated_at=? WHERE id=?', [JSON.stringify(job), job.updatedAt, job.id])
}
export function assertMoveRecoverySettled(db: Database) {
  const blocked = readMoveJobs(db).some(job => job.items.some(item => ['copying', 'verified', 'source_staged', 'published', 'committed', 'cleanup_pending', 'needs_attention'].includes(item.phase)))
  if (blocked) throw Object.assign(new Error('存在未完成的媒体迁移，请在移动任务中核对并继续处理'), { status: 409, code: 'MOVE_RECOVERY_REQUIRED' })
}
