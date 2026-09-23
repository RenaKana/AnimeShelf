import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Database } from 'node-sqlite3-wasm'
import { as } from '../db/schema'
import { makeFolderDb } from '../db/folders'
import type { Folder, Library } from '../types'
import { rebuildLibraryMediaCatalogInTransaction } from '../core/catalog-access'
import { withLibraryMaintenance } from './library-maintenance'
import { assertHistorySettled, beginRenameHistory, captureDirectory, historyUndoReason, identityMatches, pathKey, readHistory, setHistoryStatus, validateLocalDirectory } from './filesystem-history'

export interface RenameFolderInput {
  name: string
  expectedPath: string
}

export interface MoveFolderInput {
  targetLibraryId: number
  expectedPath: string
}

export interface DeleteFolderInput {
  expectedPath: string
}

export interface FolderOperationResult {
  id: number
  name: string
  path: string
  libraryId: number
  cleanupPending?: true
  cleanupPath?: string
}

export class FolderOperationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'FolderOperationError'
  }
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const activeFileOperations = new WeakSet<Database>()

async function withFileOperationLock<T>(db: Database, operation: () => Promise<T>): Promise<T> {
  if (activeFileOperations.has(db)) {
    throw new FolderOperationError('已有文件夹操作正在进行，请稍后重试', 409, 'FILE_OPERATION_IN_PROGRESS')
  }
  activeFileOperations.add(db)
  try {
    return await withLibraryMaintenance(db, '文件夹操作', () => { assertHistorySettled(db); return operation() })
  } finally {
    activeFileOperations.delete(db)
  }
}

function validateFolderName(rawName: string): string {
  const name = rawName.trim()
  if (!name) throw new FolderOperationError('名称不能为空', 400, 'INVALID_NAME')
  if (name.length > 255) throw new FolderOperationError('名称不能超过 255 个字符', 400, 'INVALID_NAME')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
    throw new FolderOperationError('名称包含 Windows 不允许的字符', 400, 'INVALID_NAME')
  }
  if (/[. ]$/.test(name) || WINDOWS_RESERVED_NAME.test(name)) {
    throw new FolderOperationError('该名称不能用于 Windows 文件夹', 400, 'INVALID_NAME')
  }
  return name
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right)
}

function isOutsideRelativePath(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function isInside(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (allowRoot && relative === '') || (relative !== '' && !isOutsideRelativePath(relative))
}

function pathComponents(value: string): string[] {
  const resolved = path.resolve(value)
  const parsed = path.parse(resolved)
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  const components: string[] = []
  let current = parsed.root
  for (const part of parts) {
    current = path.join(current, part)
    components.push(current)
  }
  return components
}

async function safeDirectory(
  value: string,
  missing: FolderOperationError,
  invalid: FolderOperationError,
): Promise<{ resolved: string; real: string }> {
  const resolved = path.resolve(value)
  try {
    for (const component of pathComponents(resolved)) {
      const stat = await fs.promises.lstat(component)
      if (stat.isSymbolicLink()) {
        throw new FolderOperationError('路径包含符号链接或联接目录，已拒绝操作', 403, 'UNSAFE_PATH_LINK')
      }
    }
    const stat = await fs.promises.lstat(resolved)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid
    return { resolved, real: await fs.promises.realpath(resolved) }
  } catch (error: any) {
    if (error instanceof FolderOperationError) throw error
    if (error?.code === 'ENOENT') throw missing
    throw error
  }
}

async function safeLibraryMember(libraryRoot: string, memberPath: string): Promise<{
  root: { resolved: string; real: string }
  member: { resolved: string; real: string }
}> {
  const root = await safeDirectory(
    libraryRoot,
    new FolderOperationError('媒体库根目录不存在', 404, 'LIBRARY_ROOT_NOT_FOUND'),
    new FolderOperationError('媒体库根路径不是普通文件夹', 400, 'INVALID_LIBRARY_ROOT'),
  )
  const member = await safeDirectory(
    memberPath,
    new FolderOperationError('磁盘文件夹不存在，请重新扫描媒体库', 404, 'SOURCE_NOT_FOUND'),
    new FolderOperationError('仅支持操作普通文件夹，不支持符号链接或联接目录', 400, 'UNSUPPORTED_FOLDER_TYPE'),
  )
  if (!isInside(root.real, member.real)) {
    throw new FolderOperationError('文件夹真实路径超出媒体库范围', 403, 'REALPATH_OUTSIDE_LIBRARY')
  }
  return { root, member }
}

async function assertSafeDestinationParent(rootRealPath: string, destination: string): Promise<void> {
  const parent = await safeDirectory(
    path.dirname(destination),
    new FolderOperationError('目标父目录不存在', 404, 'DESTINATION_PARENT_NOT_FOUND'),
    new FolderOperationError('目标父路径不是普通文件夹', 400, 'INVALID_DESTINATION_PARENT'),
  )
  if (!isInside(rootRealPath, parent.real, true)) {
    throw new FolderOperationError('目标真实路径超出媒体库范围', 403, 'REALPATH_OUTSIDE_LIBRARY')
  }
}

function operationContext(db: Database, folderId: number, expectedPath: string, allowRoot = false): { folder: Folder; library: Library } {
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new FolderOperationError('文件夹编号无效', 400, 'INVALID_FOLDER_ID')
  }
  const folder = as<Folder | undefined>(db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) ?? undefined)
  if (!folder) throw new FolderOperationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const library = as<Library | undefined>(db.prepare('SELECT * FROM libraries WHERE id = ?').get(folder.library_id) ?? undefined)
  if (!library) throw new FolderOperationError('所属媒体库不存在', 409, 'LIBRARY_NOT_FOUND')
  if (!expectedPath || !samePath(folder.path, expectedPath)) {
    throw new FolderOperationError('文件夹路径已变化，请刷新页面后重试', 409, 'STALE_FOLDER_PATH')
  }
  if (!isInside(library.root_path, folder.path, allowRoot)) {
    throw new FolderOperationError('不能修改媒体库根目录或库外路径', 403, 'ROOT_FOLDER_PROTECTED')
  }
  return { folder, library }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.promises.lstat(value)
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function renameStagingPath(source: string, operationId: string): string {
  return path.join(path.dirname(source), `.animeshelf-rename-${operationId}`)
}

function exactPathExists(value: string): boolean {
  try { return fs.readdirSync(path.dirname(value)).includes(path.basename(value)) } catch { return false }
}

async function renamePath(source: string, destination: string, operationId: string = randomUUID()): Promise<void> {
  const isCaseOnlyRename = source !== destination && samePath(source, destination)
  if (!isCaseOnlyRename) {
    await fs.promises.rename(source, destination)
    return
  }

  const temporary = renameStagingPath(source, operationId)
  if (await pathExists(temporary)) throw new FolderOperationError('重命名暂存位置已被占用', 409, 'DESTINATION_EXISTS')
  await fs.promises.rename(source, temporary)
  try {
    await fs.promises.rename(temporary, destination)
  } catch (error) {
    await fs.promises.rename(temporary, source).catch(() => {})
    throw error
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  try {
    await renamePath(source, destination)
  } catch (error: any) {
    if (error?.code === 'EXDEV') {
      throw new FolderOperationError('暂不支持跨磁盘分区移动文件夹', 409, 'CROSS_DEVICE_MOVE_UNSUPPORTED')
    }
    throw error
  }
}

function rebasePath(current: string, sourceRoot: string, destinationRoot: string): string {
  const relative = path.relative(sourceRoot, current)
  if (isOutsideRelativePath(relative)) {
    throw new FolderOperationError('数据库中存在超出目录范围的路径', 409, 'INVALID_SUBTREE_PATH')
  }
  return relative ? path.join(destinationRoot, relative) : destinationRoot
}

export function updateSubtreeLocation(
  db: Database,
  folder: Folder,
  destination: string,
  options: {
    rootName?: string
    resetRenamed?: boolean
    libraryId?: number
    parentId?: number | null
    recalculateLibraryIds?: number[]
    clearExternalDisplayMetadataReferences?: boolean
    manageTransaction?: boolean
  } = {},
): void {
  const folders = as<Folder[]>(db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM folders WHERE id = ?
      UNION ALL
      SELECT child.id FROM folders child JOIN subtree parent ON child.parent_id = parent.id
    )
    SELECT * FROM folders WHERE id IN (SELECT id FROM subtree)
  `).all(folder.id))
  const files = as<{ id: number; path: string }[]>(db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM folders WHERE id = ?
      UNION ALL
      SELECT child.id FROM folders child JOIN subtree parent ON child.parent_id = parent.id
    )
    SELECT id, path FROM files WHERE folder_id IN (SELECT id FROM subtree)
  `).all(folder.id))

  const manageTransaction = options.manageTransaction !== false
  if (manageTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const nextLibraryId = options.libraryId ?? folder.library_id
    if (options.clearExternalDisplayMetadataReferences && folders.length > 0) {
      const placeholders = folders.map(() => '?').join(',')
      const folderIds = folders.map(row => row.id)
      db.prepare(`
        UPDATE folders
        SET display_metadata_folder_id = NULL, updated_at = datetime('now')
        WHERE id NOT IN (${placeholders})
          AND display_metadata_folder_id IN (${placeholders})
      `).run([...folderIds, ...folderIds])
    }
    const updateFolderPath = db.prepare("UPDATE folders SET path = ?, library_id = ?, updated_at = datetime('now') WHERE id = ?")
    const updateRoot = db.prepare("UPDATE folders SET name = ?, path = ?, renamed = ?, library_id = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?")
    const updateFilePath = db.prepare("UPDATE files SET path = ?, library_id = ?, updated_at = datetime('now') WHERE id = ?")
    for (const row of folders) {
      const nextPath = rebasePath(row.path, folder.path, destination)
      if (row.id === folder.id) {
        updateRoot.run([
          options.rootName ?? row.name,
          nextPath,
          options.resetRenamed ? 0 : (row.renamed ?? 0),
          nextLibraryId,
          options.parentId === undefined ? row.parent_id : options.parentId,
          row.id,
        ])
      } else updateFolderPath.run([nextPath, nextLibraryId, row.id])
    }
    for (const file of files) updateFilePath.run([rebasePath(file.path, folder.path, destination), nextLibraryId, file.id])
    for (const libraryId of new Set(options.recalculateLibraryIds ?? [])) makeFolderDb(db).markSeries(libraryId)
    if (manageTransaction) db.exec('COMMIT')
  } catch (error) {
    if (manageTransaction) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ }
    }
    throw error
  }
}

export async function renameFolderOnDisk(
  db: Database,
  folderId: number,
  input: RenameFolderInput,
): Promise<FolderOperationResult> {
  return withFileOperationLock(db, () => renameFolderOnDiskLocked(db, folderId, input))
}

async function renameFolderOnDiskLocked(
  db: Database,
  folderId: number,
  input: RenameFolderInput,
  undoOf?: string,
): Promise<FolderOperationResult> {
  const name = validateFolderName(input.name)
  const { folder, library } = operationContext(db, folderId, input.expectedPath)
  const source = path.resolve(folder.path)
  const destination = path.join(path.dirname(source), name)
  if (!isInside(library.root_path, destination)) {
    throw new FolderOperationError('目标路径超出媒体库范围', 403, 'DESTINATION_OUTSIDE_LIBRARY')
  }
  if (source === destination) return { id: folder.id, name: folder.name, path: folder.path, libraryId: folder.library_id }

  const safeSource = await safeLibraryMember(library.root_path, source)
  await assertSafeDestinationParent(safeSource.root.real, destination)
  if (!samePath(source, destination) && await pathExists(destination)) {
    throw new FolderOperationError('同级目录中已存在同名文件夹', 409, 'DESTINATION_EXISTS')
  }

  const history = beginRenameHistory(db, folder.id, library.root_path, source, destination, undoOf)
  try { await renamePath(source, destination, history.operation_id) }
  catch (error) {
    setHistoryStatus(db, history.operation_id, exactPathExists(source) && identityMatches(source, history.identity) ? 'rolled_back' : 'needs_attention', String(error))
    throw error
  }
  try {
    const safeDestination = await safeLibraryMember(library.root_path, destination)
    if (!samePath(source, destination) && await pathExists(source)) throw new FolderOperationError('源路径在操作期间重新出现', 409, 'SOURCE_PATH_REAPPEARED')
    const current = operationContext(db, folderId, input.expectedPath)
    if (current.folder.library_id !== folder.library_id || !samePath(current.library.root_path, library.root_path)) {
      throw new FolderOperationError('文件夹所属媒体库已变化，请刷新后重试', 409, 'STALE_FOLDER_CONTEXT')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      updateSubtreeLocation(db, current.folder, safeDestination.member.resolved, {
        rootName: current.folder.renamed ? current.folder.name : name,
        manageTransaction: false,
      })
      makeFolderDb(db).markSeries(folder.library_id)
      rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
      setHistoryStatus(db, history.operation_id, 'applied')
      if (undoOf) setHistoryStatus(db, undoOf, 'undone')
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  } catch (error) {
    try {
      await renamePath(destination, source, history.operation_id)
      setHistoryStatus(db, history.operation_id, 'rolled_back')
    } catch {
      setHistoryStatus(db, history.operation_id, 'needs_attention', '数据库更新失败且磁盘回滚未完成')
      throw new FolderOperationError('数据库更新失败且无法恢复原文件夹，请手动检查磁盘', 500, 'FILESYSTEM_ROLLBACK_FAILED')
    }
    throw error
  }

  return { id: folder.id, name: folder.renamed ? folder.name : name, path: destination, libraryId: folder.library_id }
}

export function getFolderRenameHistory(db: Database, folderId: number) {
  const folder = makeFolderDb(db).getById(folderId)
  if (!folder) throw new FolderOperationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
  const rows = readHistory(db)
  const blocked = rows.find(row => row.status === 'pending' || row.status === 'needs_attention')
  return {
    blocked: blocked ? '存在未完成的磁盘操作，请核对前后路径并重启服务重新检查' : undefined,
    items: rows.filter(row => row.folder_id === folderId).map(row => {
      const reason = blocked ? '请先处理未完成的操作' : historyUndoReason(db, row, folder.path)
      return { operationId: row.operation_id, fromPath: row.from_path, toPath: row.to_path, createdAt: row.created_at, status: row.status, canUndo: !reason, reason }
    }),
  }
}

export async function undoFolderRename(db: Database, folderId: number, input: { operationId: string; expectedPath: string }) {
  return withFileOperationLock(db, async () => {
    const { folder, library } = operationContext(db, folderId, input.expectedPath)
    const row = readHistory(db).find(entry => entry.operation_id === input.operationId && entry.folder_id === folderId)
    if (!row || pathKey(row.library_root) !== pathKey(library.root_path)) throw new FolderOperationError('未找到当前目录的重命名记录', 409, 'HISTORY_MISMATCH')
    const reason = historyUndoReason(db, row, folder.path)
    if (reason) throw new FolderOperationError(reason, 409, 'UNDO_UNAVAILABLE')
    return renameFolderOnDiskLocked(db, folderId, { name: path.basename(row.from_path), expectedPath: folder.path }, row.operation_id)
  })
}

/** Resolve only provable outcomes. Never move a directory merely because a path exists. */
export async function recoverPendingFolderRenames(db: Database): Promise<void> {
  if (!readHistory(db).some(entry => ['pending', 'needs_attention'].includes(entry.status))) return
  await withLibraryMaintenance(db, '磁盘操作恢复', async () => {
    for (const row of readHistory(db).reverse().filter(entry => ['pending', 'needs_attention'].includes(entry.status))) {
      try {
        const folder = makeFolderDb(db).getById(row.folder_id)
        const library = folder && db.prepare('SELECT root_path FROM libraries WHERE id = ?').get(folder.library_id) as { root_path: string } | undefined
        if (!folder || !library || pathKey(library.root_path) !== pathKey(row.library_root) || pathKey(folder.path) !== pathKey(row.from_path)) throw new Error('数据库路径与操作记录不一致')
        const caseOnly = row.from_path !== row.to_path && samePath(row.from_path, row.to_path)
        const sourceExists = caseOnly ? exactPathExists(row.from_path) : fs.existsSync(row.from_path)
        const destinationExists = caseOnly ? exactPathExists(row.to_path) : fs.existsSync(row.to_path)
        const staging = renameStagingPath(row.from_path, row.operation_id)
        if (caseOnly && !sourceExists && !destinationExists && identityMatches(staging, row.identity)) {
          validateLocalDirectory(row.library_root, staging)
          if (JSON.stringify(captureDirectory(staging)) !== row.snapshot) throw new Error('暂存目录内容与操作记录不一致')
          // The durable operation ID identifies this intermediate directory. Undo
          // the interrupted first hop so the unchanged database is authoritative.
          await fs.promises.rename(staging, row.from_path)
          setHistoryStatus(db, row.operation_id, 'rolled_back'); continue
        }
        const sourceMatches = sourceExists && identityMatches(row.from_path, row.identity)
        const destinationMatches = destinationExists && identityMatches(row.to_path, row.identity)
        if (sourceMatches && !destinationExists) {
          setHistoryStatus(db, row.operation_id, 'rolled_back'); continue
        }
        if (sourceMatches || !destinationMatches || sourceExists || fs.existsSync(staging)) throw new Error('无法唯一确认磁盘操作结果')
        validateLocalDirectory(row.library_root, row.to_path)
        if (JSON.stringify(captureDirectory(row.to_path)) !== row.snapshot) throw new Error('目录内容与操作记录不一致')
        db.exec('BEGIN IMMEDIATE')
        try {
          updateSubtreeLocation(db, folder, row.to_path, { rootName: folder.renamed ? folder.name : path.basename(row.to_path), manageTransaction: false })
          makeFolderDb(db).markSeries(folder.library_id)
          rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
          setHistoryStatus(db, row.operation_id, 'applied')
          if (row.undo_of) setHistoryStatus(db, row.undo_of, 'undone')
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      } catch (error) { setHistoryStatus(db, row.operation_id, 'needs_attention', error instanceof Error ? error.message : String(error)) }
    }
  })
}

export async function relinkFolder(db: Database, folderId: number, input: { expectedPath: string; path: string }) {
  return withFileOperationLock(db, async () => {
    const { folder, library } = operationContext(db, folderId, input.expectedPath, true)
    if (!folder.path_missing) throw new FolderOperationError('仅缺失条目可以重新关联位置', 409, 'FOLDER_NOT_MISSING')
    if (!path.isAbsolute(input.path)) throw new FolderOperationError('请输入目录绝对路径', 400, 'INVALID_PATH')
    const isRoot = samePath(folder.path, library.root_path)
    const destination = validateLocalDirectory(isRoot ? input.path : library.root_path, input.path)
    const parent = folder.parent_id == null ? undefined : makeFolderDb(db).getById(folder.parent_id)
    if (!isRoot && (!parent || parent.path_missing || !samePath(path.dirname(destination), parent.path))) {
      throw new FolderOperationError('请先关联父目录；新位置必须位于当前父目录下', 409, 'PARENT_PATH_MISMATCH')
    }
    if (isRoot) {
      const otherRoots = db.prepare('SELECT root_path FROM libraries WHERE id != ?').all(library.id) as unknown as { root_path: string }[]
      if (otherRoots.some(other => isInside(other.root_path, destination, true) || isInside(destination, other.root_path, true))) throw new FolderOperationError('新根目录与其他媒体库重叠', 409, 'DESTINATION_EXISTS')
    }
    const conflict = db.prepare('SELECT id FROM folders WHERE path = ? AND id != ?').get([destination, folder.id])
    if (conflict) throw new FolderOperationError('目标位置已经被其他条目使用', 409, 'DESTINATION_EXISTS')
    // Explicit association still requires every recorded media file to be present.
    const files = db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub s ON f.parent_id=s.id)
      SELECT path, size FROM files WHERE folder_id IN (SELECT id FROM sub)`).all(folderId) as unknown as { path: string; size: number | null }[]
    for (const file of files) {
      const target = rebasePath(file.path, folder.path, destination)
      validateLocalDirectory(isRoot ? destination : library.root_path, path.dirname(target))
      const stat = fs.lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || (file.size != null && stat.size !== file.size)) throw new FolderOperationError('目标目录的文件清单或大小不匹配', 409, 'CONTENT_MISMATCH')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      updateSubtreeLocation(db, folder, destination, { manageTransaction: false })
      if (isRoot) db.prepare('UPDATE libraries SET root_path=? WHERE id=?').run([destination, library.id])
      db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub s ON f.parent_id=s.id)
        UPDATE folders SET path_missing=0 WHERE id IN (SELECT id FROM sub)`).run(folderId)
      rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
      db.exec('COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve the operation error. */ } throw error }
    return { id: folder.id, name: folder.name, path: destination, libraryId: folder.library_id }
  })
}

export async function moveFolderToLibraryRoot(
  db: Database,
  folderId: number,
  input: MoveFolderInput,
): Promise<FolderOperationResult> {
  return withFileOperationLock(db, () => moveFolderToLibraryRootLocked(db, folderId, input))
}

async function moveFolderToLibraryRootLocked(
  db: Database,
  folderId: number,
  input: MoveFolderInput,
): Promise<FolderOperationResult> {
  const { folder, library: sourceLibrary } = operationContext(db, folderId, input.expectedPath)
  if (!Number.isInteger(input.targetLibraryId) || input.targetLibraryId <= 0) {
    throw new FolderOperationError('目标媒体库编号无效', 400, 'INVALID_LIBRARY_ID')
  }
  const targetLibrary = as<Library | undefined>(db.prepare('SELECT * FROM libraries WHERE id = ?').get(input.targetLibraryId) ?? undefined)
  if (!targetLibrary) throw new FolderOperationError('目标媒体库不存在', 404, 'TARGET_LIBRARY_NOT_FOUND')

  const source = path.resolve(folder.path)
  const targetRoot = path.resolve(targetLibrary.root_path)
  const safeSource = await safeLibraryMember(sourceLibrary.root_path, source)
  const safeTargetRoot = await safeDirectory(
    targetRoot,
    new FolderOperationError('目标媒体库根目录不存在', 404, 'TARGET_ROOT_NOT_FOUND'),
    new FolderOperationError('目标媒体库路径不是普通文件夹', 400, 'INVALID_TARGET_ROOT'),
  )
  if (isInside(source, targetRoot, true) || isInside(safeSource.member.real, safeTargetRoot.real, true)) {
    throw new FolderOperationError('不能把文件夹移动到其自身内部', 409, 'DESTINATION_INSIDE_SOURCE')
  }
  if (normalizedPath(path.parse(source).root) !== normalizedPath(path.parse(targetRoot).root)) {
    throw new FolderOperationError('暂不支持跨磁盘分区移动文件夹', 409, 'CROSS_DEVICE_MOVE_UNSUPPORTED')
  }

  const destination = path.join(targetRoot, path.basename(source))
  if (source === destination) {
    return { id: folder.id, name: folder.name, path: folder.path, libraryId: folder.library_id }
  }
  await assertSafeDestinationParent(safeTargetRoot.real, destination)
  if (await pathExists(destination)) {
    throw new FolderOperationError('目标媒体库中已存在同名文件夹', 409, 'DESTINATION_EXISTS')
  }

  let filesystemMoved = false
  try {
    await movePath(source, destination)
    filesystemMoved = true
    const current = operationContext(db, folderId, input.expectedPath)
    const currentTargetLibrary = as<Library | undefined>(db.prepare('SELECT * FROM libraries WHERE id = ?').get(input.targetLibraryId) ?? undefined)
    if (!currentTargetLibrary || current.folder.library_id !== sourceLibrary.id
      || !samePath(current.library.root_path, sourceLibrary.root_path)
      || !samePath(currentTargetLibrary.root_path, targetLibrary.root_path)) {
      throw new FolderOperationError('文件夹或媒体库在移动期间发生变化，请刷新后重试', 409, 'STALE_FOLDER_CONTEXT')
    }
    const checkedTargetRoot = await safeDirectory(
      currentTargetLibrary.root_path,
      new FolderOperationError('目标媒体库根目录不存在', 404, 'TARGET_ROOT_NOT_FOUND'),
      new FolderOperationError('目标媒体库路径不是普通文件夹', 400, 'INVALID_TARGET_ROOT'),
    )
    const checkedDestination = await safeLibraryMember(currentTargetLibrary.root_path, destination)
    if (!samePath(checkedTargetRoot.real, checkedDestination.root.real) || await pathExists(source)) {
      throw new FolderOperationError('磁盘路径在移动期间发生变化，请刷新后重试', 409, 'STALE_FILESYSTEM_CONTEXT')
    }
    const finalCurrent = operationContext(db, folderId, input.expectedPath)
    const finalTargetLibrary = as<Library | undefined>(db.prepare('SELECT * FROM libraries WHERE id = ?').get(input.targetLibraryId) ?? undefined)
    if (!finalTargetLibrary || finalCurrent.folder.library_id !== sourceLibrary.id
      || !samePath(finalCurrent.library.root_path, sourceLibrary.root_path)
      || !samePath(finalTargetLibrary.root_path, checkedTargetRoot.resolved)) {
      throw new FolderOperationError('文件夹或媒体库在移动期间发生变化，请刷新后重试', 409, 'STALE_FOLDER_CONTEXT')
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      makeFolderDb(db).upsertTree(finalTargetLibrary.id, [checkedTargetRoot.resolved])
      const targetRootFolder = as<Folder | undefined>(db.prepare('SELECT * FROM folders WHERE library_id = ? AND path = ?').get([finalTargetLibrary.id, checkedTargetRoot.resolved]) ?? undefined)
      if (!targetRootFolder) throw new FolderOperationError('无法建立目标媒体库根目录记录', 500, 'TARGET_ROOT_RECORD_MISSING')
      updateSubtreeLocation(db, finalCurrent.folder, checkedDestination.member.resolved, {
        libraryId: finalTargetLibrary.id,
        parentId: targetRootFolder.id,
        recalculateLibraryIds: [sourceLibrary.id, finalTargetLibrary.id],
        clearExternalDisplayMetadataReferences: true,
        manageTransaction: false,
      })
      // Rehome the moved subtree into the target catalog before rebuilding the
      // source. The source pass can then remove any canonical item left with no
      // mappings instead of retaining a cross-library reference.
      const rebuildLibraryIds = sourceLibrary.id === finalTargetLibrary.id
        ? [finalTargetLibrary.id]
        : [finalTargetLibrary.id, sourceLibrary.id]
      for (const libraryId of rebuildLibraryIds) rebuildLibraryMediaCatalogInTransaction(db, libraryId)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  } catch (error) {
    if (filesystemMoved) {
      try {
        await movePath(destination, source)
      } catch {
        throw new FolderOperationError('数据库更新失败且无法恢复原文件夹，请手动检查磁盘', 500, 'FILESYSTEM_ROLLBACK_FAILED')
      }
    }
    throw error
  }

  return { id: folder.id, name: folder.name, path: destination, libraryId: targetLibrary.id }
}

export async function deleteFolderOnDisk(
  db: Database,
  folderId: number,
  input: DeleteFolderInput,
): Promise<FolderOperationResult> {
  return withFileOperationLock(db, () => deleteFolderOnDiskLocked(db, folderId, input))
}

async function deleteFolderOnDiskLocked(
  db: Database,
  folderId: number,
  input: DeleteFolderInput,
): Promise<FolderOperationResult> {
  const { folder, library } = operationContext(db, folderId, input.expectedPath)
  const source = path.resolve(folder.path)
  const safeSource = await safeLibraryMember(library.root_path, source)

  const stagedPath = path.join(path.dirname(source), `.animeshelf-delete-${randomUUID()}`)
  await assertSafeDestinationParent(safeSource.root.real, stagedPath)
  await renamePath(source, stagedPath)
  try {
    await safeLibraryMember(library.root_path, stagedPath)
    if (await pathExists(source)) throw new FolderOperationError('源路径在操作期间重新出现', 409, 'SOURCE_PATH_REAPPEARED')
    const current = operationContext(db, folderId, input.expectedPath)
    if (current.folder.library_id !== library.id || !samePath(current.library.root_path, library.root_path)) {
      throw new FolderOperationError('文件夹所属媒体库已变化，请刷新后重试', 409, 'STALE_FOLDER_CONTEXT')
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const folderIds = as<{ id: number }[]>(db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM folders WHERE id = ?
          UNION ALL
          SELECT child.id FROM folders child JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT id FROM subtree
      `).all(current.folder.id)).map(row => row.id)
      const fileIds = as<{ id: number }[]>(db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM folders WHERE id = ?
          UNION ALL
          SELECT child.id FROM folders child JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT id FROM files WHERE folder_id IN (SELECT id FROM subtree)
      `).all(current.folder.id)).map(row => row.id)
      const deleteTagLink = db.prepare('DELETE FROM tag_links WHERE target_type = ? AND target_id = ?')
      for (const id of folderIds) deleteTagLink.run(['folder', id])
      for (const id of fileIds) deleteTagLink.run(['file', id])
      db.prepare('DELETE FROM folders WHERE id = ?').run(current.folder.id)
      makeFolderDb(db).markSeries(current.library.id)
      rebuildLibraryMediaCatalogInTransaction(db, current.library.id)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  } catch (error) {
    try {
      await renamePath(stagedPath, source)
    } catch {
      throw new FolderOperationError('数据库删除失败且无法恢复原文件夹，请手动检查磁盘', 500, 'FILESYSTEM_ROLLBACK_FAILED')
    }
    throw error
  }

  try {
    await fs.promises.rm(stagedPath, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 })
  } catch (error) {
    // The database commit is authoritative. Preserve whatever remains in the
    // uniquely named tombstone; cleanup may already have removed some contents.
    console.warn(`Folder delete committed but tombstone cleanup failed: ${stagedPath}`, error)
    return { id: folder.id, name: folder.name, path: folder.path, libraryId: folder.library_id, cleanupPending: true, cleanupPath: stagedPath }
  }

  return { id: folder.id, name: folder.name, path: folder.path, libraryId: folder.library_id }
}
