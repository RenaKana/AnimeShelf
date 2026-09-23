import { win32 as path } from 'node:path'
import fs from 'node:fs'
import { setImmediate as yieldToRequests } from 'node:timers/promises'
import type { Database } from 'node-sqlite3-wasm'
import type { FileItem, Folder, Library } from '../types'
import { makeFolderDb } from '../db/folders'
import { makeFileDb } from '../db/files'
import { EverythingClient, VIDEO_EXTS, type EverythingFile } from './everything'
import { openAppDb } from '../db/schema'
import { makeSettingsDb } from '../db/settings'
import { rebuildLibraryMediaCatalogInTransaction } from '../core/catalog-access'
import { invalidateLibraryMatches } from '../core/extensions'
import { withLibraryMaintenance } from './library-maintenance'
import { completedMoveLocations } from './folder-moves'
import {
  assertHistorySettled,
  historyDestination,
  identityMatches,
  pathKey,
  readHistory,
  serializeFilesystemIdentity,
  withinPath,
} from './filesystem-history'

export interface ScanOptions {
  signal?: AbortSignal
  isCurrent?: () => boolean
  /** Capture a path fingerprint before any directory read that may update atime. */
  captureFilesystemBaseline?: (target: string) => void
}
export interface ScanResult {
  added: number
  updated: number
  removed: number
  errors: string[]
  changed?: boolean
  moved?: number
  missing?: number
  restored?: number
  retryable?: boolean
  code?: string
  ambiguous?: number
  warnings?: string[]
}

interface IndexedFolder { path: string; filesystem_identity: string }
interface IndexedFile extends EverythingFile { filesystem_identity: string }
interface FolderMatch { current: IndexedFolder; previous: Folder; proof: 'exact' | 'identity' | 'manifest' | 'subtree' }
interface FileMatch { current: IndexedFile; previous: FileItem; proof: 'exact' | 'identity' | 'subtree' }
interface FolderReconciliation { matches: FolderMatch[]; ambiguous: number }

class ScanSnapshotError extends Error {
  readonly retryable = true
  constructor(message: string, readonly code: string) { super(message); this.name = 'ScanSnapshotError' }
}

class ScanCancelledError extends Error {
  readonly code = 'SCAN_CANCELLED'
  readonly retryable = true
  constructor() { super('扫描已取消') }
}

const emptyResult = (error?: unknown, fallbackCode = 'SCAN_FAILED'): ScanResult => {
  if (!error) return { added: 0, updated: 0, removed: 0, errors: [], changed: false, moved: 0, missing: 0, restored: 0 }
  const value = error as Error & { code?: string; retryable?: boolean }
  return {
    added: 0, updated: 0, removed: 0, changed: false, moved: 0, missing: 0, restored: 0,
    errors: [value.message], code: value.code ?? fallbackCode, retryable: value.retryable ?? true,
  }
}

const ensureCurrent = (options: ScanOptions): void => {
  if (options.signal?.aborted || options.isCurrent?.() === false) throw new ScanCancelledError()
}

// Only reads are raced against cancellation. A late OS result is discarded and
// never reaches reconciliation after the coordinator releases its database.
function readForScan<T>(read: () => Promise<T>, options: ScanOptions): Promise<T> {
  ensureCurrent(options)
  return new Promise((resolve, reject) => {
    const signal = options.signal
    const abort = () => { signal?.removeEventListener('abort', abort); reject(new ScanCancelledError()) }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(read).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}

async function inspectRoot(root: string, options: ScanOptions): Promise<string> {
  try {
    const [stat, , realRoot] = await readForScan(() => Promise.all([
      fs.promises.lstat(root), fs.promises.access(root, fs.constants.R_OK), fs.promises.realpath(root),
    ]), options)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不是可访问目录')
    ensureCurrent(options)
    return realRoot
  } catch (error) {
    if (error instanceof ScanCancelledError) throw error
    throw new ScanSnapshotError(`媒体库根目录不可访问：${root}（${(error as Error).message}）`, 'LIBRARY_ROOT_UNAVAILABLE')
  }
}

function statIdentity(stat: fs.BigIntStats): string {
  if (stat.ino === 0n) throw new Error('无法可靠确认文件系统身份')
  return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) })
}

async function inspectFolder(folderPath: string, root: string, realRoot: string, options: ScanOptions): Promise<IndexedFolder> {
  try {
    if (!withinPath(root, folderPath)) throw new Error('路径超出媒体库范围')
    const [stat, , realPath] = await readForScan(() => Promise.all([
      fs.promises.lstat(folderPath, { bigint: true }), fs.promises.access(folderPath, fs.constants.R_OK), fs.promises.realpath(folderPath),
    ]), options)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('索引项不是普通目录')
    if (!withinPath(realRoot, realPath)) throw new Error('实际路径超出媒体库范围')
    ensureCurrent(options)
    return { path: folderPath, filesystem_identity: statIdentity(stat) }
  } catch (error) {
    if (error instanceof ScanCancelledError) throw error
    throw new ScanSnapshotError(`Everything 目录索引已过期或不可访问：${folderPath}（${(error as Error).message}）`, 'EVERYTHING_STALE_INDEX')
  }
}

async function inspectFile(file: EverythingFile, root: string, realRoot: string, options: ScanOptions): Promise<IndexedFile> {
  try {
    if (!withinPath(root, file.path)) throw new Error('路径超出媒体库范围')
    const [stat, , realPath] = await readForScan(() => Promise.all([
      fs.promises.lstat(file.path, { bigint: true }), fs.promises.access(file.path, fs.constants.R_OK), fs.promises.realpath(file.path),
    ]), options)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('索引项不是普通文件')
    if (!withinPath(realRoot, realPath)) throw new Error('实际路径超出媒体库范围')
    ensureCurrent(options)
    return {
      path: file.path,
      size: Number(stat.size),
      dateModified: Math.floor(Number(stat.mtimeMs) / 1000),
      filesystem_identity: statIdentity(stat),
    }
  } catch (error) {
    if (error instanceof ScanCancelledError) throw error
    throw new ScanSnapshotError(`Everything 文件索引已过期或不可访问：${file.path}（${(error as Error).message}）`, 'EVERYTHING_STALE_INDEX')
  }
}

function uniqueByPath<T extends { path: string }>(values: T[]): T[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = pathKey(value.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function groupBy<T>(values: T[], keyFor: (value: T) => string | null | undefined): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const value of values) {
    const key = keyFor(value)
    if (!key) continue
    const group = grouped.get(key) ?? []
    group.push(value)
    grouped.set(key, group)
  }
  return grouped
}

function manifestForPersistedFolder(folder: Folder, files: FileItem[]): string | undefined {
  const rows = files.filter(file => withinPath(folder.path, file.path, false))
  if (!rows.length || rows.some(file => file.size === null || file.date_modified === null)) return undefined
  return rows.map(file => `${path.relative(folder.path, file.path).toLowerCase()}\0${file.size}\0${file.date_modified}`)
    .sort().join('\n')
}

function manifestForIndexedFolder(folder: IndexedFolder, files: IndexedFile[]): string | undefined {
  const rows = files.filter(file => withinPath(folder.path, file.path, false))
  if (!rows.length || rows.some(file => file.size === null || file.dateModified === null)) return undefined
  return rows.map(file => `${path.relative(folder.path, file.path).toLowerCase()}\0${file.size}\0${file.dateModified}`)
    .sort().join('\n')
}

function identityStillAtPath(entry: { path: string; filesystem_identity?: string | null }, expected: 'file' | 'directory'): boolean {
  if (!entry.filesystem_identity) return false
  try { return serializeFilesystemIdentity(entry.path, expected) === entry.filesystem_identity }
  catch { return false }
}

function reconcileFolders(current: IndexedFolder[], previous: Folder[], previousFiles: FileItem[], currentFiles: IndexedFile[], protectedRoots: string[]): FolderReconciliation {
  const matches: FolderMatch[] = []
  const matchedCurrent = new Set<string>()
  const matchedPrevious = new Set<number>()
  const eligiblePrevious = previous.filter(folder => !protectedRoots.some(root => withinPath(root, folder.path)))
  const assign = (entry: IndexedFolder, folder: Folder, proof: FolderMatch['proof']) => {
    const key = pathKey(entry.path)
    if (matchedCurrent.has(key) || matchedPrevious.has(folder.id)) return
    matches.push({ current: entry, previous: folder, proof })
    matchedCurrent.add(key); matchedPrevious.add(folder.id)
  }

  // Stable identities take priority so two externally swapped paths keep the
  // metadata belonging to the physical directories rather than to the names.
  const oldIdentity = groupBy(eligiblePrevious.filter(folder => !matchedPrevious.has(folder.id)), folder => folder.filesystem_identity)
  const newIdentity = groupBy(current.filter(folder => !matchedCurrent.has(pathKey(folder.path))), folder => folder.filesystem_identity)
  for (const [identity, entries] of newIdentity) {
    const folders = oldIdentity.get(identity) ?? []
    if (entries.length === 1 && folders.length === 1
      && (pathKey(entries[0].path) === pathKey(folders[0].path) || !identityStillAtPath(folders[0], 'directory'))) {
      assign(entries[0], folders[0], 'identity')
    }
  }

  const previousByPath = groupBy(eligiblePrevious.filter(folder => !matchedPrevious.has(folder.id)), folder => pathKey(folder.path))
  for (const entry of current.filter(folder => !matchedCurrent.has(pathKey(folder.path)))) {
    const candidates = previousByPath.get(pathKey(entry.path)) ?? []
    if (candidates.length === 1) assign(entry, candidates[0], 'exact')
  }

  // A legacy manifest can prove a move only after the old path disappeared.
  // Otherwise identical content in another registered library is unrelated.
  const legacy = eligiblePrevious.filter(folder => !matchedPrevious.has(folder.id) && !folder.filesystem_identity && !fs.existsSync(folder.path))
  const unmatched = current.filter(folder => !matchedCurrent.has(pathKey(folder.path)))
  const oldManifests = groupBy(legacy, folder => manifestForPersistedFolder(folder, previousFiles))
  const newManifests = groupBy(unmatched, folder => manifestForIndexedFolder(folder, currentFiles))
  for (const [manifest, entries] of newManifests) {
    const folders = oldManifests.get(manifest) ?? []
    if (entries.length === 1 && folders.length === 1) assign(entries[0], folders[0], 'manifest')
  }

  for (const parentMatch of [...matches].sort((a, b) => a.previous.path.length - b.previous.path.length)) {
    if (pathKey(parentMatch.previous.path) === pathKey(parentMatch.current.path)) continue
    for (const folder of eligiblePrevious) {
      if (matchedPrevious.has(folder.id) || !withinPath(parentMatch.previous.path, folder.path, false)) continue
      const target = path.join(parentMatch.current.path, path.relative(parentMatch.previous.path, folder.path))
      const entry = current.find(value => pathKey(value.path) === pathKey(target))
      if (entry) assign(entry, folder, 'subtree')
    }
  }
  const remainingOldManifests = groupBy(legacy.filter(folder => !matchedPrevious.has(folder.id)), folder => manifestForPersistedFolder(folder, previousFiles))
  const remainingNewManifests = groupBy(current.filter(folder => !matchedCurrent.has(pathKey(folder.path))), folder => manifestForIndexedFolder(folder, currentFiles))
  let ambiguous = 0
  for (const [manifest, entries] of remainingNewManifests) {
    const folders = remainingOldManifests.get(manifest) ?? []
    if (folders.length > 0 && (entries.length > 1 || folders.length > 1)) ambiguous += entries.length + folders.length
  }
  return { matches, ambiguous }
}

function reconcileFiles(current: IndexedFile[], previous: FileItem[], folderMatches: FolderMatch[], protectedRoots: string[]): FileMatch[] {
  const matches: FileMatch[] = []
  const matchedCurrent = new Set<string>()
  const matchedPrevious = new Set<number>()
  const eligiblePrevious = previous.filter(file => !protectedRoots.some(root => withinPath(root, file.path)))
  const assign = (entry: IndexedFile, file: FileItem, proof: FileMatch['proof']) => {
    const key = pathKey(entry.path)
    if (matchedCurrent.has(key) || matchedPrevious.has(file.id)) return
    matches.push({ current: entry, previous: file, proof })
    matchedCurrent.add(key); matchedPrevious.add(file.id)
  }

  // File identities also precede exact paths for directory/file swaps.
  const oldIdentity = groupBy(eligiblePrevious.filter(file => !matchedPrevious.has(file.id)), file => file.filesystem_identity)
  const newIdentity = groupBy(current.filter(file => !matchedCurrent.has(pathKey(file.path))), file => file.filesystem_identity)
  for (const [identity, entries] of newIdentity) {
    const files = oldIdentity.get(identity) ?? []
    if (entries.length === 1 && files.length === 1
      && (pathKey(entries[0].path) === pathKey(files[0].path) || !identityStillAtPath(files[0], 'file'))) {
      assign(entries[0], files[0], 'identity')
    }
  }

  const previousByPath = groupBy(eligiblePrevious.filter(file => !matchedPrevious.has(file.id)), file => pathKey(file.path))
  for (const entry of current.filter(file => !matchedCurrent.has(pathKey(file.path)))) {
    const candidates = previousByPath.get(pathKey(entry.path)) ?? []
    if (candidates.length === 1) assign(entry, candidates[0], 'exact')
  }

  for (const folderMatch of folderMatches) {
    if (pathKey(folderMatch.previous.path) === pathKey(folderMatch.current.path)) continue
    for (const file of eligiblePrevious) {
      if (matchedPrevious.has(file.id) || !withinPath(folderMatch.previous.path, file.path, false)) continue
      const target = path.join(folderMatch.current.path, path.relative(folderMatch.previous.path, file.path))
      const entry = current.find(value => pathKey(value.path) === pathKey(target))
      if (entry) assign(entry, file, 'subtree')
    }
  }
  return matches
}

async function readDiskInventory(root: string, protectedRoots: string[], isStagingPath: (value: string) => boolean, options: ScanOptions): Promise<{ folders: string[]; files: string[] }> {
  const folders: string[] = []
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    ensureCurrent(options)
    options.captureFilesystemBaseline?.(directory)
    ensureCurrent(options)
    folders.push(directory)
    let entries: fs.Dirent[]
    try { entries = await readForScan(() => fs.promises.readdir(directory, { withFileTypes: true }), options) }
    catch (error) {
      if (error instanceof ScanCancelledError) throw error
      throw new ScanSnapshotError(`无法读取媒体库目录：${directory}（${(error as Error).message}）`, 'FILESYSTEM_SNAPSHOT_UNAVAILABLE')
    }
    ensureCurrent(options)
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (isStagingPath(target) || protectedRoots.some(protectedRoot => withinPath(protectedRoot, target))) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && VIDEO_EXTS.includes(path.extname(entry.name).slice(1).toLowerCase())) files.push(target)
    }
  }
  await visit(root)
  return { folders, files }
}

// Yield only while collecting the snapshot. The shared-connection transaction
// below stays synchronous, so HTTP handlers cannot observe partial updates.
async function inspectInBatches<T, U>(values: T[], inspect: (value: T) => Promise<U>, options: ScanOptions): Promise<U[]> {
  const result: U[] = []
  let lastYield = performance.now()
  for (const value of values) {
    ensureCurrent(options)
    result.push(await inspect(value))
    if (performance.now() - lastYield >= 8) {
      await yieldToRequests()
      ensureCurrent(options)
      lastYield = performance.now()
    }
  }
  return result
}

export async function scanLibrary(lib: Library, database?: Database, options: ScanOptions = {}): Promise<ScanResult> {
  const db = database ?? await openAppDb()
  return withLibraryMaintenance(db, '扫描', () => {
    assertHistorySettled(db)
    return scanLibraryLocked(lib, db, options)
  })
}

async function scanLibraryLocked(lib: Library, db: Database, options: ScanOptions): Promise<ScanResult> {
  try { ensureCurrent(options) } catch (error) { return emptyResult(error) }
  const restoreProtectedRoots = (db.all("SELECT path FROM folders WHERE path_missing=1 AND missing_source='restore'") as unknown as Array<{ path: string }>).map(row => row.path)
  if (restoreProtectedRoots.some(root => withinPath(root, lib.root_path))) return emptyResult()
  let realRoot: string
  try { realRoot = await inspectRoot(lib.root_path, options) } catch (error) { return emptyResult(error) }

  const settings = makeSettingsDb(db)
  const folderDb = makeFolderDb(db)
  const fileDb = makeFileDb(db)
  const baseUrl = lib.everything_url ?? settings.get('everything_url') ?? 'http://localhost:1223'
  const client = new EverythingClient(baseUrl)
  let files: EverythingFile[]
  let folderPaths: string[]
  try {
    ;[files, folderPaths] = await Promise.all([
      client.searchFiles(lib.root_path, options.signal),
      client.searchFolders(lib.root_path, options.signal),
    ])
    ensureCurrent(options)
  } catch (error) {
    if (options.signal?.aborted || options.isCurrent?.() === false || (error as Error).name === 'AbortError') return emptyResult(new ScanCancelledError())
    const value = error as Error & { code?: string }
    return emptyResult(new ScanSnapshotError(`Everything 查询失败（${baseUrl}）：${value.message}`, value.code ?? 'EVERYTHING_UNAVAILABLE'))
  }

  const isStagingPath = (value: string) => /(?:^|[\\/])\.animeshelf-(?:delete|rename|move-source|move-target)-[^\\/]+(?:[\\/]|$)/i.test(value)
  folderPaths = folderPaths.filter(value => !isStagingPath(value))
  files = files.filter(file => !isStagingPath(file.path))

  const histories = readHistory(db).filter(row => ['applied', 'undone'].includes(row.status))
  const moves = completedMoveLocations(db)
  if (histories.length || moves.length) {
    const rebaseIndexed = (value: string) => {
      const moved = moves.find(move => withinPath(move.from, value) && !fs.existsSync(value))
      const destination = moved ? path.join(moved.to, path.relative(moved.from, value)) : historyDestination(db, value)
      return destination && (pathKey(destination) === pathKey(value) || !fs.existsSync(value)) ? destination : value
    }
    folderPaths = folderPaths.map(rebaseIndexed).filter(value => withinPath(lib.root_path, value))
    files = files.map(file => ({ ...file, path: rebaseIndexed(file.path) })).filter(file => withinPath(lib.root_path, file.path))
    const trustedRoots = [...moves.filter(move => withinPath(lib.root_path, move.to)).map(move => move.to), ...histories.flatMap(row => {
      const target = historyDestination(db, row.from_path) ?? row.to_path
      return identityMatches(target, row.identity) && withinPath(lib.root_path, target) ? [target] : []
    })]
    const indexedFolders = new Set(folderPaths.map(pathKey))
    const indexedFiles = new Set(files.map(file => pathKey(file.path)))
    for (const folder of folderDb.getByLibrary(lib.id)) {
      if (!trustedRoots.some(root => withinPath(root, folder.path) || withinPath(folder.path, root)) || folder.path_missing || !fs.existsSync(folder.path)) continue
      if (!indexedFolders.has(pathKey(folder.path))) { folderPaths.push(folder.path); indexedFolders.add(pathKey(folder.path)) }
      for (const file of fileDb.getByFolder(folder.id)) {
        if (file.path_missing || indexedFiles.has(pathKey(file.path))) continue
        try {
          const stat = fs.statSync(file.path)
          if (stat.isFile()) { files.push({ path: file.path, size: stat.size, dateModified: Math.floor(stat.mtimeMs / 1000) }); indexedFiles.add(pathKey(file.path)) }
        } catch { /* Validation below rejects any remaining stale indexed path. */ }
      }
    }
  }

  const protectedRoots = restoreProtectedRoots
  folderPaths = folderPaths.filter(value => !protectedRoots.some(root => withinPath(root, value)))
  files = files.filter(file => !protectedRoots.some(root => withinPath(root, file.path)))
  if (!folderPaths.some(value => pathKey(value) === pathKey(lib.root_path))) folderPaths.push(lib.root_path)

  let indexedFolders: IndexedFolder[]
  let indexedFiles: IndexedFile[]
  try {
    if (options.captureFilesystemBaseline) {
      const baselinePaths = uniqueByPath([
        { path: lib.root_path },
        ...folderPaths.map(folderPath => ({ path: folderPath })),
        ...files.map(file => ({ path: file.path })),
      ]).filter(entry => withinPath(lib.root_path, entry.path))
      for (const entry of baselinePaths) {
        ensureCurrent(options)
        options.captureFilesystemBaseline(entry.path)
      }
    }
    const disk = await readDiskInventory(lib.root_path, protectedRoots, isStagingPath, options)
    const reportedFolders = new Set(folderPaths.map(pathKey))
    const reportedFiles = new Set(files.map(file => pathKey(file.path)))
    const omittedFolder = disk.folders.find(folder => !reportedFolders.has(pathKey(folder)))
    const omittedFile = disk.files.find(file => !reportedFiles.has(pathKey(file)))
    if (omittedFolder || omittedFile) {
      throw new ScanSnapshotError(`Everything 索引遗漏了磁盘上的项目：${omittedFolder ?? omittedFile}`, 'EVERYTHING_STALE_INDEX')
    }
    indexedFolders = uniqueByPath(await inspectInBatches(folderPaths, value => inspectFolder(value, lib.root_path, realRoot, options), options))
    indexedFiles = uniqueByPath(await inspectInBatches(files, file => inspectFile(file, lib.root_path, realRoot, options), options))
    const indexedFolderKeys = new Set(indexedFolders.map(folder => pathKey(folder.path)))
    const orphan = indexedFiles.find(file => !indexedFolderKeys.has(pathKey(path.dirname(file.path))))
    if (orphan) throw new ScanSnapshotError(`Everything 文件缺少对应目录索引：${orphan.path}`, 'EVERYTHING_STALE_INDEX')
    ensureCurrent(options)
  } catch (error) { return emptyResult(error, 'EVERYTHING_STALE_INDEX') }

  // Capture mutable database fields after asynchronous collection, immediately
  // before reconciliation/commit, preserving edits made while disk I/O yielded.
  const allPreviousFolders = db.all('SELECT * FROM folders ORDER BY id') as unknown as Folder[]
  const allPreviousFiles = db.all('SELECT * FROM files ORDER BY id') as unknown as FileItem[]
  const folderReconciliation = reconcileFolders(indexedFolders, allPreviousFolders, allPreviousFiles, indexedFiles, protectedRoots)
  const folderMatches = folderReconciliation.matches
  const fileMatches = reconcileFiles(indexedFiles, allPreviousFiles, folderMatches, protectedRoots)
  const matchedFolderIds = new Set(folderMatches.map(match => match.previous.id))
  const matchedFileIds = new Set(fileMatches.map(match => match.previous.id))
  const currentFolderKeys = new Set(folderMatches.map(match => pathKey(match.current.path)))
  const currentFileKeys = new Set(fileMatches.map(match => pathKey(match.current.path)))
  const newFolderCount = indexedFolders.filter(folder => !currentFolderKeys.has(pathKey(folder.path))).length
  const movedFolderMatches = folderMatches.filter(match => match.current.path !== match.previous.path || match.previous.library_id !== lib.id)
  const movedFileMatches = fileMatches.filter(match => match.current.path !== match.previous.path || match.previous.library_id !== lib.id)
  const restoredFolderMatches = folderMatches.filter(match => match.previous.path_missing === 1)
  const restoredFileMatches = fileMatches.filter(match => match.previous.path_missing === 1)
  const replacedIdentities = folderMatches.filter(match => match.previous.filesystem_identity !== null && match.previous.filesystem_identity !== undefined
    && match.previous.filesystem_identity !== match.current.filesystem_identity).length
    + fileMatches.filter(match => match.previous.filesystem_identity !== null && match.previous.filesystem_identity !== undefined
      && match.previous.filesystem_identity !== match.current.filesystem_identity).length
  const newlyMissingFolders = allPreviousFolders.filter(folder => folder.library_id === lib.id && !matchedFolderIds.has(folder.id) && folder.path_missing !== 1)
  const newlyMissingFiles = allPreviousFiles.filter(file => file.library_id === lib.id && !matchedFileIds.has(file.id) && file.path_missing !== 1)
  const affectedLibraries = new Set<number>([lib.id])
  for (const match of movedFolderMatches) affectedLibraries.add(match.previous.library_id)
  for (const match of movedFileMatches) affectedLibraries.add(match.previous.library_id)

  let added = 0
  let updated = 0
  let seriesChanges = 0
  const moved = movedFolderMatches.length + movedFileMatches.length
  const missing = newlyMissingFolders.length + newlyMissingFiles.length
  const restored = restoredFolderMatches.length + restoredFileMatches.length
  const structuralChangeKnown = newFolderCount > 0 || moved > 0 || missing > 0 || restored > 0 || replacedIdentities > 0
  try {
    ensureCurrent(options)
    const previousByCurrentPath = new Map(folderMatches.map(match => [pathKey(match.current.path), match.previous]))
    const foldersUnchanged = folderMatches.every(({ current, previous }) =>
      current.filesystem_identity === previous.filesystem_identity && !previous.missing_source
      && (previous.renamed === 1 || previous.name === path.basename(current.path))
      && previous.parent_id === (previousByCurrentPath.get(pathKey(path.dirname(current.path)))?.id ?? null))
    const filesUnchanged = fileMatches.length === indexedFiles.length && fileMatches.every(({ current, previous }) =>
      current.filesystem_identity === previous.filesystem_identity
      && previous.folder_id === previousByCurrentPath.get(pathKey(path.dirname(current.path)))?.id
      && previous.name === path.basename(current.path) && previous.ext === path.extname(current.path).slice(1).toLowerCase()
      && previous.size === current.size && previous.date_modified === current.dateModified)
    if (!structuralChangeKnown && foldersUnchanged && filesUnchanged) return emptyResult()
    db.exec('BEGIN IMMEDIATE')
    try {
      const stageRoot = `${lib.root_path}\\.animeshelf-scan-db-stage-${process.pid}-${Date.now()}`
      for (const match of movedFolderMatches) {
        db.run('UPDATE folders SET path=? WHERE id=?', [`${stageRoot}\\folder-${match.previous.id}`, match.previous.id])
      }
      for (const match of movedFolderMatches) {
        const nextName = match.previous.renamed === 1 ? match.previous.name : path.basename(match.current.path)
        db.run(`UPDATE folders SET library_id=?, path=?, name=?, filesystem_identity=?, path_missing=0,
          missing_source=NULL, updated_at=datetime('now') WHERE id=?`, [
          lib.id, match.current.path, nextName, match.current.filesystem_identity, match.previous.id,
        ])
      }
      folderDb.upsertTree(lib.id, indexedFolders)
      const foldersByPath = new Map(folderDb.getByLibrary(lib.id).map(folder => [pathKey(folder.path), folder]))

      for (const match of movedFileMatches) {
        db.run('UPDATE files SET path=? WHERE id=?', [`${stageRoot}\\file-${match.previous.id}`, match.previous.id])
      }
      for (const match of movedFileMatches) {
        const folder = foldersByPath.get(pathKey(path.dirname(match.current.path)))
        if (!folder) throw new Error(`扫描文件缺少父目录：${match.current.path}`)
        db.run(`UPDATE files SET folder_id=?, library_id=?, name=?, path=?, size=?, date_modified=?, ext=?,
          filesystem_identity=?, path_missing=0, updated_at=datetime('now') WHERE id=?`, [
          folder.id, lib.id, path.basename(match.current.path), match.current.path, match.current.size, match.current.dateModified,
          path.extname(match.current.path).slice(1).toLowerCase(), match.current.filesystem_identity, match.previous.id,
        ])
      }
      const fileResult = fileDb.upsertMany(lib.id, indexedFiles.map(file => {
        const folder = foldersByPath.get(pathKey(path.dirname(file.path)))
        if (!folder) throw new Error(`扫描文件缺少父目录：${file.path}`)
        return {
          path: file.path, folder_id: folder.id, name: path.basename(file.path), size: file.size,
          date_modified: file.dateModified, ext: path.extname(file.path).slice(1).toLowerCase(),
          filesystem_identity: file.filesystem_identity,
        }
      }))
      added = fileResult.added
      updated = fileResult.updated

      for (const file of newlyMissingFiles) db.run(`UPDATE files SET path_missing=1, updated_at=datetime('now') WHERE id=?`, file.id)
      for (const folder of newlyMissingFolders) db.run(`UPDATE folders SET path_missing=1, missing_source='scan', updated_at=datetime('now') WHERE id=?`, folder.id)

      const meaningfulChange = structuralChangeKnown || added > 0 || updated > 0
      if (meaningfulChange) {
        for (const libraryId of affectedLibraries) seriesChanges += folderDb.markSeries(libraryId)
        for (const libraryId of affectedLibraries) rebuildLibraryMediaCatalogInTransaction(db, libraryId)
      }
      ensureCurrent(options)
      db.exec('COMMIT')
      if (meaningfulChange || seriesChanges > 0) invalidateLibraryMatches(db)
      const warnings = folderReconciliation.ambiguous > 0
        ? [`检测到 ${folderReconciliation.ambiguous} 个无法唯一确认的旧目录或候选目录；旧记录已保留为缺失，请手动重新关联。`]
        : []
      return {
        added, updated, removed: 0, errors: [], changed: meaningfulChange || seriesChanges > 0,
        moved, missing, restored, ambiguous: folderReconciliation.ambiguous, warnings,
      }
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
  } catch (error) {
    if (error instanceof ScanCancelledError) return emptyResult(error)
    throw error
  }
}
