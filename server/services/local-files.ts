import type { Database } from 'node-sqlite3-wasm'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export class LocalFileError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'LocalFileError'
  }
}

export type ExplorerSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface LocalFileDependencies {
  spawn?: ExplorerSpawn
}

interface LocalPathRow {
  target_path: string
  root_path: string
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function assertNoSymlinkBoundary(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target)
  const segments = relative ? relative.split(path.sep).filter(Boolean) : []
  let current = root
  const rootStats = await lstat(root)
  if (rootStats.isSymbolicLink()) {
    throw new LocalFileError(409, 'SYMLINK_BOUNDARY', '媒体库根目录是符号链接，无法从界面打开')
  }
  for (const segment of segments) {
    current = path.join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new LocalFileError(409, 'SYMLINK_BOUNDARY', '目标路径经过符号链接，无法从界面打开')
    }
  }
}

async function validateLocalPath(row: LocalPathRow | undefined, kind: 'folder' | 'file'): Promise<string> {
  if (!row) throw new LocalFileError(404, 'RECORD_NOT_FOUND', kind === 'folder' ? '未找到文件夹记录' : '未找到文件记录')
  const root = path.resolve(row.root_path)
  const target = path.resolve(row.target_path)
  if (!inside(root, target)) throw new LocalFileError(409, 'OUTSIDE_LIBRARY', '目标路径不在所属媒体库中')

  try {
    await assertNoSymlinkBoundary(root, target)
    const [resolvedRoot, resolvedTarget, targetStats] = await Promise.all([realpath(root), realpath(target), lstat(target)])
    if (!inside(resolvedRoot, resolvedTarget)) throw new LocalFileError(409, 'OUTSIDE_LIBRARY', '目标真实路径不在所属媒体库中')
    if (kind === 'folder' ? !targetStats.isDirectory() : !targetStats.isFile()) {
      throw new LocalFileError(409, 'PATH_TYPE_MISMATCH', kind === 'folder' ? '记录路径不是文件夹' : '记录路径不是文件')
    }
    return resolvedTarget
  } catch (error) {
    if (error instanceof LocalFileError) throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new LocalFileError(404, 'PATH_NOT_FOUND', kind === 'folder' ? '文件夹路径不存在' : '文件路径不存在')
    }
    throw new LocalFileError(409, 'PATH_UNAVAILABLE', '无法验证本机路径')
  }
}

function launchExplorer(args: string[], spawnExplorer: ExplorerSpawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      // This is a user-requested desktop window, not a hidden background helper.
      child = spawnExplorer('explorer.exe', args, { shell: false, windowsHide: false })
    } catch (error) {
      reject(new LocalFileError(500, 'EXPLORER_START_FAILED', error instanceof Error ? error.message : '无法启动文件资源管理器'))
      return
    }
    child.once('spawn', resolve)
    child.once('error', error => reject(new LocalFileError(500, 'EXPLORER_START_FAILED', `无法启动文件资源管理器：${error.message}`)))
  })
}

export async function openFolderInExplorer(database: Database, id: number, dependencies: LocalFileDependencies = {}) {
  const row = database.prepare(`
    SELECT f.path AS target_path, l.root_path
    FROM folders f JOIN libraries l ON l.id = f.library_id
    WHERE f.id = ?
  `).get(id) as unknown as LocalPathRow | undefined
  const target = await validateLocalPath(row, 'folder')
  await launchExplorer([target], dependencies.spawn ?? spawn)
  return { ok: true as const, path: target }
}

export async function revealFileInExplorer(database: Database, id: number, dependencies: LocalFileDependencies = {}) {
  const row = database.prepare(`
    SELECT fi.path AS target_path, l.root_path
    FROM files fi JOIN libraries l ON l.id = fi.library_id
    WHERE fi.id = ?
  `).get(id) as unknown as LocalPathRow | undefined
  const target = await validateLocalPath(row, 'file')
  await launchExplorer([`/select,${target}`], dependencies.spawn ?? spawn)
  return { ok: true as const, path: target }
}

export async function validatePlayableFile(database: Database, id: number): Promise<string> {
  const row = database.prepare(`
    SELECT fi.path AS target_path, l.root_path, fi.path_missing, f.path_missing AS folder_missing
    FROM files fi JOIN folders f ON f.id = fi.folder_id JOIN libraries l ON l.id = fi.library_id
    WHERE fi.id = ?
  `).get(id) as unknown as (LocalPathRow & { path_missing: number; folder_missing: number }) | undefined
  if (row?.path_missing || row?.folder_missing) throw new LocalFileError(404, 'PATH_NOT_FOUND', '文件已缺失，标签和记录仍然保留')
  return validateLocalPath(row, 'file')
}
