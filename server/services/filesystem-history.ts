import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database } from 'node-sqlite3-wasm'

export interface DiskIdentity { dev: string; ino: string; birth: string }
export interface DiskEntry { path: string; type: 'file' | 'directory'; size?: number; modified?: number }
export interface FilesystemHistory {
  sequence: number; operation_id: string; folder_id: number; library_root: string
  from_path: string; to_path: string; identity: string; snapshot: string
  status: 'pending' | 'applied' | 'undone' | 'rolled_back' | 'needs_attention'
  undo_of: string | null; created_at: string; error: string | null
}

export function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function withinPath(root: string, value: string, allowRoot = true): boolean {
  const relative = path.relative(pathKey(root), pathKey(value))
  return (allowRoot || relative !== '') && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

export function readFilesystemIdentity(target: string, expected?: 'file' | 'directory'): DiskIdentity {
  const stat = fs.lstatSync(target, { bigint: true })
  if (stat.isSymbolicLink() || (expected === 'directory' && !stat.isDirectory()) || (expected === 'file' && !stat.isFile()) || stat.ino === 0n) {
    throw new Error(expected === 'file' ? '无法可靠确认文件身份' : '无法可靠确认目录身份')
  }
  return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) }
}

export function readDirectoryIdentity(directory: string): DiskIdentity {
  return readFilesystemIdentity(directory, 'directory')
}

export function serializeFilesystemIdentity(target: string, expected?: 'file' | 'directory'): string {
  return JSON.stringify(readFilesystemIdentity(target, expected))
}

export function identityMatches(directory: string, serialized: string): boolean {
  try { return JSON.stringify(readDirectoryIdentity(directory)) === serialized } catch { return false }
}

/** Paths supplied for reconnection are restricted to an existing library, without link traversal. */
export function validateLocalDirectory(root: string, directory: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(directory)
  if (!withinPath(resolvedRoot, resolved)) throw new Error('目录必须位于所属媒体库范围内')
  const parsed = path.parse(resolved).root
  let current = parsed
  for (const component of path.relative(parsed, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不支持符号链接、连接点或非目录路径')
  }
  if (!withinPath(fs.realpathSync(resolvedRoot), fs.realpathSync(resolved))) throw new Error('实际目录超出媒体库范围')
  return resolved
}

export function captureDirectory(directory: string): DiskEntry[] {
  const entries: DiskEntry[] = []
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entries.length >= 100_000) throw new Error('目录条目过多，无法安全记录本次操作')
      const file = path.join(current, entry.name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('目录内含符号链接或连接点，无法安全记录操作')
      const relative = path.relative(directory, file)
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory' }); visit(file) }
      else if (stat.isFile()) entries.push({ path: relative, type: 'file', size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) })
      else throw new Error('目录内含不支持的文件类型')
    }
  }
  visit(directory)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function readHistory(db: Database): FilesystemHistory[] {
  return db.all('SELECT * FROM filesystem_operation_history ORDER BY sequence DESC') as unknown as FilesystemHistory[]
}

export function assertHistorySettled(db: Database): void {
  if (db.get("SELECT 1 FROM filesystem_operation_history WHERE status IN ('pending','needs_attention') LIMIT 1")) {
    const error = new Error('存在未完成的磁盘操作，请先核对文件夹操作历史并重启服务重新检查')
    Object.assign(error, { status: 409, code: 'FILESYSTEM_RECOVERY_REQUIRED' })
    throw error
  }
}

export function beginRenameHistory(db: Database, folderId: number, root: string, from: string, to: string, undoOf?: string): FilesystemHistory {
  const operationId = randomUUID()
  const identity = JSON.stringify(readDirectoryIdentity(from))
  const snapshot = JSON.stringify(captureDirectory(from))
  db.run(`INSERT INTO filesystem_operation_history
    (operation_id, folder_id, library_root, from_path, to_path, identity, snapshot, status, undo_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [operationId, folderId, root, from, to, identity, snapshot, undoOf ?? null, new Date().toISOString()])
  return db.get('SELECT * FROM filesystem_operation_history WHERE operation_id = ?', operationId) as unknown as FilesystemHistory
}

export function setHistoryStatus(db: Database, operationId: string, status: FilesystemHistory['status'], error?: string): void {
  db.run('UPDATE filesystem_operation_history SET status = ?, error = ? WHERE operation_id = ?', [status, error ?? null, operationId])
}

export function historyUndoReason(db: Database, entry: FilesystemHistory, currentPath: string): string | undefined {
  if (entry.undo_of || entry.status !== 'applied') return '此记录不是可撤销的重命名'
  if (pathKey(currentPath) !== pathKey(entry.to_path)) return '目录位置已变化，请先撤销后续相关操作或核对路径'
  const newer = readHistory(db).find(other => other.sequence > entry.sequence && !other.undo_of && other.status === 'applied'
    && [other.from_path, other.to_path].some(p => [entry.from_path, entry.to_path].some(q => withinPath(p, q) || withinPath(q, p))))
  if (newer) return '请先撤销后续父目录或子目录的重命名'
  if (!identityMatches(currentPath, entry.identity)) return '当前目录身份与操作记录不一致'
  if (pathKey(entry.from_path) !== pathKey(entry.to_path) && fs.existsSync(entry.from_path)) return '原名称已被其他目录占用'
  return undefined
}

export function historyDestination(db: Database, original: string): string | undefined {
  const history = readHistory(db).filter(row => ['applied', 'undone'].includes(row.status)).reverse()
  let target = original
  let evidence = false
  for (let index = 0; index < history.length; index++) {
    const row = history[index]
    if (!withinPath(row.from_path, target)) continue
    let finalRoot = row.to_path
    for (const later of history.slice(index + 1)) {
      if (withinPath(later.from_path, finalRoot)) finalRoot = path.join(later.to_path, path.relative(later.from_path, finalRoot))
    }
    if (!identityMatches(finalRoot, row.identity)) return undefined
    target = path.join(row.to_path, path.relative(row.from_path, target))
    evidence = true
  }
  return evidence && target !== original ? target : undefined
}
