import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Database } from 'node-sqlite3-wasm'
import { assertHistorySettled, historyDestination, pathKey, readDirectoryIdentity, readHistory, validateLocalDirectory, withinPath } from './filesystem-history'
import { assertDesktopEditionBackupFile } from '../db/desktop-edition'
import type { RestoreEntry, RestorePreview, RestoreResolution } from '../../shared/restore'

interface BackupFolder { id: number; parent_id: number | null; library_id: number; path: string; name: string; path_missing?: number }
interface BackupFile { id: number; folder_id: number; library_id: number; path: string; size: number | null; date_modified: number | null; path_missing?: number }
interface BackupLibrary { id: number; root_path: string }
interface BackupGraph { folders: BackupFolder[]; files: BackupFile[]; libraries: BackupLibrary[]; syntheticRootIds: number[] }
interface PreviewSession {
  database: Database; file: string; fileHash: string; databaseHash: string; graph: BackupGraph
  resolutions: RestoreResolution[]; preview: RestorePreview; identities: Map<number, string>; owned: boolean
}
const sessions = new Map<string, PreviewSession>()
const ttl = 30 * 60_000

export class RestorePreviewError extends Error {
  constructor(message: string, readonly code = 'RESTORE_PREVIEW_INVALID', readonly status = 409) { super(message) }
}

export function fileFingerprint(file: string): string {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 200 * 1024 * 1024) throw new RestorePreviewError('备份文件大小异常', 'INVALID_BACKUP', 400)
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function databaseFingerprint(db: Database): string {
  const graph = {
    libraries: db.all('SELECT * FROM libraries ORDER BY id'),
    folders: db.all('SELECT id, library_id, parent_id, path, path_missing FROM folders ORDER BY id'),
    files: db.all('SELECT id, folder_id, library_id, path, size, date_modified, path_missing FROM files ORDER BY id'),
    history: readHistory(db),
  }
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex')
}

function readBackupGraph(file: string): BackupGraph {
  const source = new Database(file, { readOnly: true, fileMustExist: true })
  try {
    const integrity = source.all('PRAGMA integrity_check') as unknown as { integrity_check: string }[]
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('备份完整性检查未通过')
    if (source.all('PRAGMA foreign_key_check').length) throw new Error('备份数据违反外键约束')
    const missingColumn = source.all('PRAGMA table_info(folders)').some(column => column.name === 'path_missing') ? 'path_missing' : '0 AS path_missing'
    const missingFileColumn = source.all('PRAGMA table_info(files)').some(column => column.name === 'path_missing') ? 'path_missing' : '0 AS path_missing'
    const graph = {
      folders: source.all(`SELECT id, library_id, parent_id, path, name, ${missingColumn} FROM folders ORDER BY length(path), id`),
      files: source.all(`SELECT id, folder_id, library_id, path, size, date_modified, ${missingFileColumn} FROM files`),
      libraries: source.all('SELECT id, root_path FROM libraries'),
    } as unknown as BackupGraph
    graph.syntheticRootIds = []
    let nextId = graph.folders.reduce((maximum, folder) => Math.max(maximum, folder.id), 0) + 1
    for (const library of graph.libraries) {
      if (graph.folders.some(folder => folder.library_id === library.id)) continue
      const id = nextId++
      graph.syntheticRootIds.push(id)
      graph.folders.push({ id, library_id: library.id, parent_id: null, path: library.root_path, name: path.basename(library.root_path) || library.root_path })
    }
    graph.folders.sort((a, b) => a.path.length - b.path.length || a.id - b.id)
    const libraries = new Map(graph.libraries.map(library => [library.id, library]))
    const folders = new Map(graph.folders.map(folder => [folder.id, folder]))
    for (const library of graph.libraries) if (!path.isAbsolute(library.root_path)) throw new Error('备份媒体库路径无效')
    for (const folder of graph.folders) {
      const library = libraries.get(folder.library_id)
      if (!library || !path.isAbsolute(folder.path) || !withinPath(library.root_path, folder.path)) throw new Error('备份文件夹超出媒体库范围')
      if (folder.parent_id != null) {
        const parent = folders.get(folder.parent_id)
        if (!parent || parent.library_id !== folder.library_id || !withinPath(parent.path, folder.path, false)) throw new Error('备份目录层级无效')
      }
    }
    for (const fileRow of graph.files) {
      const folder = folders.get(fileRow.folder_id)
      if (!folder || fileRow.library_id !== folder.library_id || !path.isAbsolute(fileRow.path) || pathKey(path.dirname(fileRow.path)) !== pathKey(folder.path)) throw new Error('备份文件路径无效')
    }
    return graph
  } finally { source.close() }
}

function removeSession(id: string): void {
  const session = sessions.get(id)
  sessions.delete(id)
  if (session?.owned) try { fs.rmSync(session.file) } catch { /* Retain on transient Windows lock. */ }
}

function pruneSessions(): void {
  for (const [id, session] of sessions) if (session.preview.expiresAt < Date.now()) removeSession(id)
  while (sessions.size >= 5) removeSession(sessions.keys().next().value!)
}

function currentRoots(db: Database): string[] {
  return (db.all('SELECT root_path FROM libraries') as unknown as { root_path: string }[]).map(row => row.root_path)
}

function acceptedRoot(db: Database, originalRoot: string, target: string, confirmedRoot?: string): string {
  if (confirmedRoot && withinPath(confirmedRoot, target)) return confirmedRoot
  // An empty installation may restore its original roots; an existing installation
  // only associates files inside one of its explicitly configured libraries.
  const roots = currentRoots(db)
  const root = roots.find(value => withinPath(value, target)) ?? (roots.length === 0 && withinPath(originalRoot, target) ? originalRoot : undefined)
  if (!root) throw new Error('目标位置不在当前已配置的媒体库中')
  return root
}

function filesMatch(files: BackupFile[], originalRoot: string, target: string): boolean {
  try {
    for (const fileRow of files) {
      const relative = path.relative(originalRoot, fileRow.path)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
      const file = path.join(target, relative)
      validateLocalDirectory(target, path.dirname(file))
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || (fileRow.size != null && stat.size !== fileRow.size)) return false
      if (fileRow.date_modified != null && Math.abs(Math.floor(stat.mtimeMs / 1000) - fileRow.date_modified) > 2) return false
    }
    return true
  } catch { return false }
}

function candidateDirectories(session: PreviewSession, folder: BackupFolder): string[] {
  const descendants = session.graph.files.filter(file => withinPath(folder.path, file.path))
  if (!descendants.length) return [] // Empty directories cannot establish content identity.
  const possible = new Set((session.database.all('SELECT path FROM folders WHERE path_missing=0') as unknown as { path: string }[]).map(row => row.path))
  try {
    for (const entry of fs.readdirSync(path.dirname(folder.path), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) possible.add(path.join(path.dirname(folder.path), entry.name))
    }
  } catch { /* No sibling directory available. */ }
  const originalRoot = session.graph.libraries.find(library => library.id === folder.library_id)!.root_path
  return [...possible].filter(target => {
    try {
      validateLocalDirectory(acceptedRoot(session.database, originalRoot, target), target)
      return filesMatch(descendants, folder.path, target)
    } catch { return false }
  }).slice(0, 8)
}

function calculatePreview(session: PreviewSession): RestorePreview {
  const { graph, database: db } = session
  const entries: RestoreEntry[] = []
  const identities = new Map<number, string>()
  const orderedResolutions = session.resolutions.map(resolution => {
    const folder = graph.folders.find(item => item.id === resolution.folderId)
    if (!folder || (resolution.keepMissing !== true && (!resolution.path || !path.isAbsolute(resolution.path)))) throw new RestorePreviewError('关联位置选择无效', 'INVALID_RESOLUTION', 400)
    return { ...resolution, folder }
  }).sort((a, b) => b.folder.path.length - a.folder.path.length)
  for (const folder of graph.folders) {
    const choice = orderedResolutions.find(resolution => withinPath(resolution.folder.path, folder.path))
    const originalRoot = graph.libraries.find(library => library.id === folder.library_id)!.root_path
    const confirmedRoot = orderedResolutions.find(resolution => resolution.folder.library_id === folder.library_id && pathKey(resolution.folder.path) === pathKey(originalRoot) && resolution.path)?.path
    const entry: RestoreEntry = { folderId: folder.id, parentId: folder.parent_id, name: folder.name, fromPath: folder.path, toPath: folder.path, status: 'direct', candidates: [] }
    if (choice?.keepMissing) { entry.status = 'missing'; entries.push(entry); continue }
    const historyPath = historyDestination(db, folder.path)
    if (choice?.path) entry.toPath = path.join(choice.path, path.relative(choice.folder.path, folder.path))
    else if (historyPath) entry.toPath = historyPath
    try {
      if (!choice && historyPath && pathKey(historyPath) !== pathKey(folder.path) && fs.existsSync(folder.path)) throw new Error('原路径已被重新占用，请确认使用原路径还是历史记录中的当前位置')
      if (folder.path_missing && !choice) throw new Error('备份中已标记缺失，请确认位置或保留为缺失')
      validateLocalDirectory(acceptedRoot(db, originalRoot, entry.toPath, confirmedRoot), entry.toPath)
      const ownFiles = graph.files.filter(file => file.folder_id === folder.id)
      if (!filesMatch(ownFiles, folder.path, entry.toPath)) throw new Error('文件清单、大小或修改时间与备份不一致')
      identities.set(folder.id, JSON.stringify(readDirectoryIdentity(entry.toPath)))
      if (entry.toPath !== entry.fromPath) entry.status = 'coordinated'
    } catch (error) {
      entry.status = 'unresolved'
      entry.reason = error instanceof Error ? error.message : '目录位置无法确认'
      const parent = entries.find(item => item.folderId === folder.parent_id)
      if (parent?.status !== 'unresolved') entry.candidates = candidateDirectories(session, folder)
    }
    entries.push(entry)
  }
  const targetPaths = new Map<string, RestoreEntry>()
  for (const entry of entries) {
    const key = pathKey(entry.toPath)
    const previous = targetPaths.get(key)
    if (previous) {
      for (const item of [entry, previous]) { item.status = 'unresolved'; item.reason = '多个条目映射到相同路径' }
    }
    targetPaths.set(key, entry)
  }
  // A library root cannot be moved independently of its children or silently mapped
  // into another library's subtree. Parent relationships must remain truthful.
  for (const entry of entries) {
    if (entry.parentId == null) continue
    const parent = entries.find(item => item.folderId === entry.parentId)
    if (parent && !withinPath(parent.toPath, entry.toPath, false)) { entry.status = 'unresolved'; entry.reason = '位置与父目录不一致，请先关联父目录' }
  }
  session.identities = identities
  return { ...session.preview, entries, unresolved: entries.filter(entry => entry.status === 'unresolved').length }
}

export function inspectRestore(db: Database, file: string, owned = false): RestorePreview {
  const fileHash = fileFingerprint(file)
  assertDesktopEditionBackupFile(file)
  assertHistorySettled(db)
  pruneSessions()
  const id = randomUUID()
  const session: PreviewSession = {
    database: db, file, fileHash, databaseHash: databaseFingerprint(db), graph: readBackupGraph(file),
    resolutions: [], preview: { previewId: id, entries: [], unresolved: 0, expiresAt: Date.now() + ttl }, identities: new Map(), owned,
  }
  session.preview = calculatePreview(session)
  sessions.set(id, session)
  return session.preview
}

function checkedSession(db: Database, id: string): PreviewSession {
  const session = sessions.get(id)
  if (!session || session.database !== db || session.preview.expiresAt < Date.now()) throw new RestorePreviewError('恢复预览已过期，请重新预检', 'RESTORE_PREVIEW_EXPIRED')
  assertHistorySettled(db)
  const fileHash = fileFingerprint(session.file)
  if (fileHash !== session.fileHash || databaseFingerprint(db) !== session.databaseHash) throw new RestorePreviewError('备份或当前媒体库已变化，请重新预检', 'RESTORE_PREVIEW_STALE')
  assertDesktopEditionBackupFile(session.file)
  return session
}

export function resolveRestorePreview(db: Database, id: string, resolutions: RestoreResolution[]): RestorePreview {
  const session = checkedSession(db, id)
  if (!Array.isArray(resolutions) || resolutions.length > session.graph.folders.length) throw new RestorePreviewError('关联清单无效', 'INVALID_RESOLUTION', 400)
  const merged = new Map(session.resolutions.map(resolution => [resolution.folderId, resolution]))
  for (const resolution of resolutions) merged.set(resolution.folderId, resolution)
  session.resolutions = [...merged.values()]
  session.preview = calculatePreview(session)
  return session.preview
}

export function validatedRestore(db: Database, id: string): { file: string; preview: RestorePreview; applyPaths: () => void; complete: () => void } {
  const session = checkedSession(db, id)
  if (session.preview.unresolved) throw new RestorePreviewError('请先处理全部无法确认的路径', 'RESTORE_RESOLUTION_REQUIRED')
  const expectedIdentities = session.identities
  const preview = calculatePreview(session)
  if (preview.unresolved || preview.entries.some(entry => entry.status !== 'missing' && expectedIdentities.get(entry.folderId) !== session.identities.get(entry.folderId))) throw new RestorePreviewError('磁盘位置或内容已变化，请重新预检', 'RESTORE_PREVIEW_STALE')
  return {
    file: session.file, preview,
    applyPaths: () => applyRestoredPaths(db, session.graph, preview.entries),
    complete: () => removeSession(id),
  }
}

function applyRestoredPaths(db: Database, graph: BackupGraph, entries: RestoreEntry[]): void {
  const map = new Map(entries.map(entry => [entry.folderId, entry]))
  // Temporary unique paths permit swaps without violating UNIQUE(path) midway.
  const prefix = `restore-staging:${randomUUID()}:`
  for (const id of graph.syntheticRootIds) {
    const folder = graph.folders.find(item => item.id === id)!
    db.run('INSERT INTO folders (id, library_id, parent_id, name, path) VALUES (?, ?, NULL, ?, ?)', [id, folder.library_id, folder.name, `${prefix}root:${id}`])
  }
  for (const folder of graph.folders) db.run('UPDATE folders SET path=? WHERE id=?', [`${prefix}folder:${folder.id}`, folder.id])
  for (const file of graph.files) db.run('UPDATE files SET path=? WHERE id=?', [`${prefix}file:${file.id}`, file.id])
  for (const folder of graph.folders) {
    const entry = map.get(folder.id)!
    let identity: string | null = null
    if (entry.status !== 'missing') {
      try { identity = JSON.stringify(readDirectoryIdentity(entry.toPath)) } catch { /* Leave unverified identities empty. */ }
    }
    db.run('UPDATE folders SET path=?, path_missing=?, missing_source=?, parent_id=?, filesystem_identity=? WHERE id=?', [entry.toPath, entry.status === 'missing' ? 1 : 0, entry.status === 'missing' ? 'restore' : null, folder.parent_id, identity, folder.id])
  }
  for (const file of graph.files) {
    const folder = graph.folders.find(item => item.id === file.folder_id)!
    const entry = map.get(folder.id)!
    const target = path.join(entry.toPath, path.basename(file.path))
    let identity: string | null = null
    let missing = entry.status === 'missing'
    if (!missing) {
      try {
        const stat = fs.lstatSync(target, { bigint: true })
        missing = !stat.isFile() || stat.isSymbolicLink()
        if (!missing && stat.ino !== 0n) identity = JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) })
      } catch { missing = true }
    }
    db.run('UPDATE files SET path=?, path_missing=?, filesystem_identity=? WHERE id=?', [target, missing ? 1 : 0, identity, file.id])
  }
  for (const library of graph.libraries) {
    const root = graph.folders.find(folder => folder.library_id === library.id && pathKey(folder.path) === pathKey(library.root_path))
    if (root) db.run('UPDATE libraries SET root_path=? WHERE id=?', [map.get(root.id)!.toPath, library.id])
  }
}
