import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'node-sqlite3-wasm'
import type { Folder, Library } from '../types'
import type { FolderMoveInput, FolderMoveItem, FolderMoveJob, FolderMovePreview } from '../../shared/folder-moves'
import { makeFolderDb } from '../db/folders'
import { makeTagDb } from '../db/tags'
import { updateSubtreeLocation } from './folder-operations'
import { assertHistorySettled, pathKey, serializeFilesystemIdentity, validateLocalDirectory, withinPath } from './filesystem-history'
import { assertLibraryAvailable, withLibraryMaintenance } from './library-maintenance'
import { installFolderMoveSchema, readMoveJobs, saveMoveJob } from './folder-move-store'
import { rebuildLibraryMediaCatalogInTransaction } from '../core/catalog-access'
import { invalidateLibraryMatches } from '../core/extensions'

type Entry = { path: string; directory: boolean; size: number; identity: string; modified: number; hash?: string }
type Owned = { identity: string; size: number; hash?: string }
type Item = FolderMoveItem & { sourceRoot: string; targetRoot: string; sourceIdentity: string; sourceStage: string; targetStage: string; targetIdentity?: string; stageIdentity?: string; manifest?: Entry[]; owned?: Record<string, Owned> }
type Job = Omit<FolderMoveJob, 'items'> & { items: Item[] }
const exists = (p: string) => {
  if (!p) return false
  try { fs.lstatSync(p); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function fail(message: string, code = 'MOVE_INVALID', status = 409): never { throw Object.assign(new Error(message), { code, status }) }
const errorText = (error: unknown) => error instanceof Error ? error.message : '媒体迁移失败'
const identity = (p: string) => serializeFilesystemIdentity(p, 'directory')
const matches = (p: string, expected?: string) => { try { return Boolean(expected) && identity(p) === expected } catch { return false } }
const success = (item: Item) => item.phase === 'completed' || item.phase === 'cleanup_pending'

function normalize(raw: FolderMoveInput): FolderMoveInput {
  if (!raw || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 10000 || raw.items.some(item => !item || !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.expectedPath !== 'string' || !path.isAbsolute(item.expectedPath))) fail('请选择有效的媒体目录', 'INVALID_SELECTION', 400)
  if (!Number.isSafeInteger(raw.targetLibraryId) || raw.targetLibraryId <= 0 || typeof raw.targetRelativePath !== 'string') fail('目标媒体库无效', 'INVALID_TARGET', 400)
  const relative = raw.targetRelativePath
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part.includes(':') || part.includes('\0'))) fail('目标目录必须位于媒体库内', 'INVALID_TARGET', 400)
  const byId = new Map<number, string>()
  for (const item of raw.items) {
    if (byId.has(item.id) && pathKey(byId.get(item.id)!) !== pathKey(item.expectedPath)) fail('重复条目的路径不一致', 'INVALID_SELECTION', 400)
    byId.set(item.id, item.expectedPath)
  }
  return { items: [...byId].map(([id, expectedPath]) => ({ id, expectedPath })), targetLibraryId: raw.targetLibraryId, targetRelativePath: path.normalize(relative || '.') }
}

async function inventory(root: string, hashes: boolean, check: () => void = () => {}, progress?: (bytes: number) => void): Promise<Entry[]> {
  const result: Entry[] = []
  async function walk(directory: string) {
    check()
    validateLocalDirectory(root, directory)
    const names = await fs.promises.readdir(directory)
    for (const name of names.sort()) {
      check()
      const full = path.join(directory, name)
      const stat = await fs.promises.lstat(full)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('目录内含链接或不支持的文件类型', 'UNSAFE_PATH')
      if (result.length >= 100000) fail('目录条目过多，无法安全记录迁移', 'TOO_MANY_FILES')
      const entry: Entry = { path: path.relative(root, full), directory: stat.isDirectory(), size: stat.isFile() ? stat.size : 0, modified: stat.mtimeMs, identity: serializeFilesystemIdentity(full, stat.isDirectory() ? 'directory' : 'file') }
      if (!entry.directory && hashes) {
        const hash = createHash('sha256')
        for await (const chunk of fs.createReadStream(full)) { check(); hash.update(chunk); progress?.(chunk.length) }
        entry.hash = hash.digest('hex')
        const after = await fs.promises.lstat(full)
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || serializeFilesystemIdentity(full, 'file') !== entry.identity) fail('文件在读取期间发生变化', 'CONTENT_CHANGED')
      }
      result.push(entry)
      if (entry.directory) await walk(full)
    }
  }
  await walk(root)
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

function equalTree(a: Entry[], b: Entry[], identities: boolean): boolean {
  return a.length === b.length && a.every((entry, i) => entry.path === b[i].path && entry.directory === b[i].directory && entry.size === b[i].size && entry.hash === b[i].hash && (!identities || entry.identity === b[i].identity && (!entry.directory ? entry.modified === b[i].modified : true)))
}
function publicJob(job: Job): FolderMoveJob {
  return { ...job, items: job.items.map(({ id, name, sourcePath, targetPath, sourceLibraryId, bytes, copiedBytes, phase, crossVolume, error, code, coveredBy, log, sourceStage, targetStage }) => ({ id, name, sourcePath, targetPath, sourceLibraryId, bytes, copiedBytes, phase, crossVolume, error, code, coveredBy, log, recoveryPaths: ['needs_attention', 'cleanup_pending'].includes(phase) ? [sourceStage, targetStage].filter(Boolean) : undefined })) }
}
function targetDirectory(db: Database, libraryId: number, relative: string) {
  const library = db.get('SELECT * FROM libraries WHERE id=?', libraryId) as unknown as Library | undefined
  if (!library) fail('目标媒体库已不存在', 'TARGET_INVALID')
  try { return { library: library!, directory: validateLocalDirectory(library!.root_path, path.resolve(library!.root_path, relative)) } }
  catch { return fail('目标目录不存在、包含链接或超出媒体库', 'TARGET_INVALID') }
}

export async function browseMoveDirectories(db: Database, libraryId: number, relative = '') {
  const input = normalize({ items: [{ id: 1, expectedPath: path.resolve('.') }], targetLibraryId: libraryId, targetRelativePath: relative })
  const { library, directory } = targetDirectory(db, input.targetLibraryId, input.targetRelativePath)
  const children: Array<{ name: string; relativePath: string }> = []
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.animeshelf-')) continue
    try { validateLocalDirectory(library.root_path, path.join(directory, entry.name)); children.push({ name: entry.name, relativePath: path.relative(library.root_path, path.join(directory, entry.name)) }) } catch { /* Unsafe entries cannot be destinations. */ }
  }
  return { path: directory, relativePath: path.relative(library.root_path, directory), children: children.sort((a, b) => a.name.localeCompare(b.name)) }
}

async function preview(db: Database, raw: FolderMoveInput): Promise<{ input: FolderMoveInput; items: Item[]; bytes: number }> {
  const input = normalize(raw)
  const { library: target, directory } = targetDirectory(db, input.targetLibraryId, input.targetRelativePath)
  const items: Item[] = []
  const destinations = new Set<string>()
  // Ancestors take precedence independently of selection order.
  const selected = [...input.items].sort((a, b) => a.expectedPath.length - b.expectedPath.length)
  for (const selection of selected) {
    const row = db.get('SELECT * FROM folders WHERE id=?', selection.id) as unknown as Folder | undefined
    const sourceLibrary = row && db.get('SELECT * FROM libraries WHERE id=?', row.library_id) as unknown as Library | undefined
    const item: Item = { id: selection.id, name: row?.name ?? path.basename(selection.expectedPath), sourcePath: selection.expectedPath, sourceLibraryId: row?.library_id ?? 0, sourceRoot: sourceLibrary?.root_path ?? '', targetRoot: target.root_path, targetPath: path.join(directory, path.basename(selection.expectedPath)), bytes: 0, copiedBytes: 0, phase: 'pending', crossVolume: false, sourceIdentity: '', sourceStage: '', targetStage: '' }
    try {
      if (!row || !sourceLibrary || pathKey(row.path) !== pathKey(selection.expectedPath)) fail('条目或路径已变化，请刷新后重试', 'STALE_SOURCE')
      if (row.path_missing || !withinPath(sourceLibrary.root_path, row.path, false)) fail('不能移动缺失条目、库根目录或库外路径', 'SOURCE_PROTECTED')
      validateLocalDirectory(sourceLibrary.root_path, row.path)
      const parent = items.find(parent => parent.phase === 'pending' && withinPath(parent.sourcePath, row.path))
      if (parent) { item.phase = 'skipped'; item.coveredBy = parent.id; item.error = '由所选父目录一并处理，请查看父目录结果'; items.push(item); continue }
      if (withinPath(row.path, directory)) fail('不能移动到自身内部', 'DESTINATION_INSIDE_SOURCE')
      if (pathKey(row.path) === pathKey(item.targetPath)) { item.phase = 'skipped'; item.error = '已经位于目标位置'; items.push(item); continue }
      if (exists(item.targetPath) || destinations.has(pathKey(item.targetPath)) || db.get('SELECT id FROM folders WHERE lower(path)=lower(?)', item.targetPath)) fail('目标存在同名目录或条目，不会覆盖', 'DESTINATION_EXISTS')
      const entries = await inventory(row.path, false)
      item.bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
      item.sourceIdentity = identity(row.path)
      if (row.filesystem_identity && row.filesystem_identity !== item.sourceIdentity) fail('磁盘目录已被替换，请先核对条目', 'STALE_SOURCE')
      item.crossVolume = fs.statSync(row.path).dev !== fs.statSync(directory).dev
      destinations.add(pathKey(item.targetPath))
    } catch (error) { item.phase = 'failed'; item.error = errorText(error); item.code = (error as any).code ?? 'SOURCE_INVALID' }
    items.push(item)
  }
  return { input, items, bytes: items.filter(item => item.phase === 'pending').reduce((n, item) => n + item.bytes, 0) }
}

export class FolderMoveService {
  private active?: Promise<void>
  private stopping = false
  private jobs = new Map<string, Job>()
  constructor(private db: Database) { installFolderMoveSchema(db); for (const job of readMoveJobs<Job>(db)) this.jobs.set(job.id, job) }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(publicJob) }
  get(id: string) { const job = this.jobs.get(id); if (!job) fail('移动任务不存在', 'NOT_FOUND', 404); return publicJob(job!) }
  async preview(raw: FolderMoveInput): Promise<FolderMovePreview> { assertLibraryAvailable(this.db); return withLibraryMaintenance(this.db, '移动预检查', async () => { const result = await preview(this.db, raw); return { ...result, items: publicJob({ items: result.items } as Job).items } }) }
  private save(job: Job) {
    for (const item of job.items) {
      item.log ??= []
      const last = item.log.at(-1)
      if (!last || last.phase !== item.phase || last.error !== item.error) item.log.push({ at: new Date().toISOString(), phase: item.phase, bytes: item.copiedBytes, error: item.error })
    }
    saveMoveJob(this.db, job)
  }
  private check(job: Job) { if (this.stopping || job.cancelRequested) fail('已请求停止，保留已完成项', 'CANCELLED') }
  async create(raw: FolderMoveInput, requestKey: string) {
    if (this.stopping) fail('服务正在停止，请稍后继续', 'SERVICE_STOPPING')
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey ?? '')) fail('缺少有效请求标识', 'INVALID_REQUEST_KEY', 400)
    const input = normalize(raw)
    const body = JSON.stringify(input)
    const previous = this.db.get('SELECT id, request_body FROM folder_move_jobs WHERE request_key=?', requestKey) as { id: string; request_body: string } | undefined
    if (previous) { if (previous.request_body !== body) fail('请求标识已经用于其他选择', 'REQUEST_KEY_CONFLICT'); return this.get(previous.id) }
    assertLibraryAvailable(this.db)
    if (this.active) fail('已有移动任务正在执行', 'MOVE_BUSY')
    const result = await withLibraryMaintenance(this.db, '移动预检查', () => preview(this.db, input))
    const now = new Date().toISOString()
    const job: Job = { id: randomUUID(), input, items: result.items, createdAt: now, updatedAt: now, status: 'paused', cancelRequested: false }
    this.db.run('INSERT INTO folder_move_jobs(id, request_key, request_body, data, updated_at) VALUES(?,?,?,?,?)', [job.id, requestKey, body, JSON.stringify(job), now])
    this.jobs.set(job.id, job)
    this.launch(job)
    return publicJob(job)
  }
  cancel(id: string) { const job = this.jobs.get(id); if (!job) fail('移动任务不存在', 'NOT_FOUND', 404); job!.cancelRequested = true; this.save(job!); return publicJob(job!) }
  async resume(id: string, retry = false) {
    const job = this.jobs.get(id); if (!job) fail('移动任务不存在', 'NOT_FOUND', 404)
    if (this.active) fail('已有移动任务正在执行', 'MOVE_BUSY')
    if (job!.items.some(item => item.phase === 'needs_attention')) fail('磁盘状态不能自动确认；请先核对源、目标和暂存路径，再重新检查任务', 'MOVE_RECOVERY_REQUIRED')
    if (this.stopping) fail('服务正在停止，请稍后继续', 'SERVICE_STOPPING')
    const candidates = job!.items.filter(item => item.phase === 'pending' || item.phase === 'cancelled' || retry && item.phase === 'failed')
    if (candidates.length) {
      const refreshed = await withLibraryMaintenance(this.db, '迁移重试预检查', () => preview(this.db, { ...job!.input, items: candidates.map(item => ({ id: item.id, expectedPath: item.sourcePath })) }), true)
      for (const fresh of refreshed.items) {
        const old = job!.items.find(item => item.id === fresh.id)!
        Object.assign(old, fresh, { manifest: undefined, owned: undefined, stageIdentity: undefined, targetIdentity: undefined })
      }
    }
    job!.cancelRequested = false; job!.error = undefined
    this.launch(job!)
    return publicJob(job!)
  }
  private launch(job: Job) {
    job.status = 'running'; this.save(job)
    this.active = this.run(job).catch(error => { job.status = 'paused'; job.error = errorText(error); this.save(job) }).finally(() => { this.active = undefined })
  }
  async wait() { await this.active }
  async stop() { this.stopping = true; await this.active }
  async recover() {
    // Startup never resumes a copy or deletes files. It only reconciles durable evidence.
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.status = 'paused'
      for (const item of job.items) {
        if (['completed', 'failed', 'skipped', 'cancelled', 'pending'].includes(item.phase)) continue
        const row = this.db.get('SELECT path, library_id FROM folders WHERE id=?', item.id) as { path: string; library_id: number } | undefined
        if (row && pathKey(row.path) === pathKey(item.targetPath) && row.library_id === job.input.targetLibraryId && matches(item.targetPath, item.targetIdentity)) {
          // A committed copy is always revalidated by an explicit continuation, even
          // if its source staging directory disappeared before the crash.
          item.phase = item.crossVolume ? 'cleanup_pending' : 'completed'
          if (item.phase === 'cleanup_pending') item.error = '目标已迁移，源副本待核对清理；点击继续'
        } else if (row && pathKey(row.path) === pathKey(item.sourcePath)) {
          item.phase = 'needs_attention'; item.error = '迁移中断，需重新检查并恢复原位置后继续'
        } else { item.phase = 'needs_attention'; item.error = '数据库与迁移记录不一致，请人工核对' }
      }
      this.save(job)
    }
  }
  async reconcile(id: string) {
    const job = this.jobs.get(id); if (!job) fail('移动任务不存在', 'NOT_FOUND', 404)
    if (this.active) fail('已有移动任务正在执行', 'MOVE_BUSY')
    await withLibraryMaintenance(this.db, '迁移恢复', async () => {
      for (const item of job!.items.filter(item => item.phase === 'needs_attention')) {
        try { await this.rollback(job!, item); item.phase = 'pending'; item.error = undefined; item.code = undefined }
        catch (error) { item.error = `保留现场：${errorText(error)}` }
        this.save(job!)
      }
    }, true)
    return publicJob(job!)
  }
  private async run(job: Job) {
    await withLibraryMaintenance(this.db, '媒体迁移', async () => {
      assertHistorySettled(this.db)
      const otherUnsettled = [...this.jobs.values()].some(other => other.id !== job.id && other.items.some(item => ['needs_attention', 'cleanup_pending', 'copying', 'verified', 'source_staged', 'published', 'committed'].includes(item.phase)))
      if (otherUnsettled) fail('请先处理其他未完成的移动任务', 'MOVE_RECOVERY_REQUIRED')
      for (const item of job.items) {
        if (!['pending', 'cleanup_pending'].includes(item.phase)) continue
        if (job.cancelRequested || this.stopping) break
        try {
          if (item.phase === 'cleanup_pending') await this.cleanupSource(job, item)
          else await this.move(job, item)
        } catch (error) {
          const code = (error as any).code ?? 'MOVE_FAILED'
          if (item.phase === 'committed' || item.phase === 'cleanup_pending') { item.phase = 'cleanup_pending'; item.error = `目标已迁移，源副本待清理：${errorText(error)}` }
          else {
            try { await this.rollback(job, item); item.phase = code === 'CANCELLED' ? 'cancelled' : 'failed' }
            catch (rollbackError) { item.phase = 'needs_attention'; item.error = `恢复未完成，保留现场：${errorText(rollbackError)}` }
            item.error ??= errorText(error)
          }
          item.code = code; this.save(job)
          if (['needs_attention', 'cleanup_pending'].includes(item.phase) || ['TARGET_INVALID', 'CONTENT_CHANGED', 'CANCELLED'].includes(code)) { job.status = 'paused'; job.error = item.error; break }
        }
      }
      if (job.cancelRequested) {
        for (const item of job.items) if (item.phase === 'pending') item.phase = 'cancelled'
        job.status = job.items.some(item => ['needs_attention', 'cleanup_pending'].includes(item.phase)) ? 'paused' : 'cancelled'
      } else if (job.status !== 'paused') job.status = job.items.some(item => ['pending', 'needs_attention', 'cleanup_pending'].includes(item.phase)) ? 'paused' : 'completed'
      this.save(job)
      invalidateLibraryMatches(this.db)
    }, true)
  }
  private context(job: Job, item: Item) {
    const row = this.db.get('SELECT * FROM folders WHERE id=?', item.id) as unknown as Folder | undefined
    const library = this.db.get('SELECT * FROM libraries WHERE id=?', item.sourceLibraryId) as unknown as Library | undefined
    if (!row || !library || row.library_id !== item.sourceLibraryId || pathKey(row.path) !== pathKey(item.sourcePath) || pathKey(library.root_path) !== pathKey(item.sourceRoot)) fail('源条目或媒体库已变化', 'STALE_SOURCE')
    const target = targetDirectory(this.db, job.input.targetLibraryId, job.input.targetRelativePath)
    if (pathKey(target.library.root_path) !== pathKey(item.targetRoot) || pathKey(path.join(target.directory, path.basename(item.sourcePath))) !== pathKey(item.targetPath)) fail('目标媒体库已变化', 'TARGET_INVALID')
    return { row: row!, ...target }
  }
  private async move(job: Job, item: Item) {
    const { directory } = this.context(job, item)
    validateLocalDirectory(item.sourceRoot, item.sourcePath)
    if (!matches(item.sourcePath, item.sourceIdentity)) fail('源文件夹身份已变化', 'STALE_SOURCE')
    item.crossVolume = fs.statSync(item.sourcePath).dev !== fs.statSync(directory).dev
    if (exists(item.targetPath) || this.db.get('SELECT id FROM folders WHERE lower(path)=lower(?)', item.targetPath)) fail('目标存在同名目录或条目', 'DESTINATION_EXISTS')
    const token = `${job.id}-${item.id}`
    item.sourceStage = path.join(path.dirname(item.sourcePath), `.animeshelf-move-source-${token}`)
    item.targetStage = path.join(directory, `.animeshelf-move-target-${token}`)
    if (exists(item.sourceStage) || exists(item.targetStage)) fail('迁移暂存目录已存在，需要核对', 'STAGING_EXISTS')
    item.error = undefined; item.code = undefined; item.copiedBytes = 0; item.owned = {}
    const check = () => this.check(job)
    item.manifest = await inventory(item.sourcePath, item.crossVolume, check)
    item.bytes = item.manifest.reduce((sum, entry) => sum + entry.size, 0)
    this.check(job)
    item.phase = 'copying'; this.save(job)
    if (item.crossVolume) {
      const disk = await fs.promises.statfs(directory)
      if (Number(disk.bavail) * Number(disk.bsize) < item.bytes) fail('目标磁盘空间不足', 'ENOSPC')
      await fs.promises.mkdir(item.targetStage)
      item.stageIdentity = identity(item.targetStage); this.save(job)
      let lastSave = 0
      for (const entry of item.manifest) {
        check()
        const from = path.join(item.sourcePath, entry.path), to = path.join(item.targetStage, entry.path)
        if (entry.directory) { await fs.promises.mkdir(to); item.owned![entry.path] = { identity: identity(to), size: 0 }; this.save(job); continue }
        const input = await fs.promises.open(from, 'r')
        try {
          const output = await fs.promises.open(to, 'wx')
          const writtenHash = createHash('sha256')
          let ownedBytes = 0
          try {
            item.owned![entry.path] = { identity: serializeFilesystemIdentity(to, 'file'), size: 0, hash: writtenHash.copy().digest('hex') }; this.save(job)
            const buffer = Buffer.alloc(1024 * 1024)
            for (;;) {
              check()
              const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
              if (!bytesRead) break
              let written = 0
              while (written < bytesRead) {
                const result = await output.write(buffer, written, bytesRead - written, null)
                if (!result.bytesWritten) fail('目标写入中断', 'EIO')
                writtenHash.update(buffer.subarray(written, written + result.bytesWritten)); ownedBytes += result.bytesWritten; written += result.bytesWritten
              }
              item.copiedBytes += bytesRead
              if (Date.now() - lastSave > 300) { this.save(job); lastSave = Date.now() }
            }
            await output.sync()
          } finally {
            item.owned![entry.path].size = ownedBytes; item.owned![entry.path].hash = writtenHash.digest('hex')
            this.save(job)
            await output.close()
          }
        } finally { await input.close() }
        await fs.promises.utimes(to, new Date(entry.modified), new Date(entry.modified))
      }
      if (!equalTree(item.manifest, await inventory(item.targetStage, true, check), false) || !equalTree(item.manifest, await inventory(item.sourcePath, true, check), true)) fail('复制校验失败或源内容发生变化', 'CONTENT_CHANGED')
      item.targetIdentity = identity(item.targetStage)
    } else item.targetIdentity = item.sourceIdentity
    item.phase = 'verified'; this.save(job)
    check(); this.context(job, item)
    validateLocalDirectory(item.sourceRoot, item.sourcePath)
    if (!matches(item.sourcePath, item.sourceIdentity) || exists(item.targetPath)) fail('源或目标在移动期间发生变化', 'CONTENT_CHANGED')
    await fs.promises.rename(item.sourcePath, item.sourceStage)
    item.phase = 'source_staged'; this.save(job)
    if (!equalTree(item.manifest, await inventory(item.sourceStage, item.crossVolume, check), true)) fail('源目录在暂存期间发生变化', 'CONTENT_CHANGED')
    this.context(job, item)
    if (exists(item.targetPath)) fail('目标目录已被占用', 'DESTINATION_EXISTS')
    await fs.promises.rename(item.crossVolume ? item.targetStage : item.sourceStage, item.targetPath)
    item.phase = 'published'; this.save(job)
    const { row, library: target } = this.context(job, item)
    validateLocalDirectory(target.root_path, item.targetPath)
    if (!matches(item.targetPath, item.targetIdentity) || exists(item.sourcePath)) fail('无法确认发布后的目录身份', 'CONTENT_CHANGED')
    const tags = makeTagDb(this.db).effectiveTags('folder', item.id)
    const logBeforeCommit = item.log?.length ?? 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const ancestors: string[] = [target.root_path]
      let parent = target.root_path
      for (const part of path.relative(target.root_path, directory).split(path.sep).filter(Boolean)) { parent = path.join(parent, part); ancestors.push(parent) }
      makeFolderDb(this.db).upsertTree(target.id, ancestors)
      const targetParent = this.db.get('SELECT id FROM folders WHERE path=? AND library_id=?', [directory, target.id]) as { id: number }
      updateSubtreeLocation(this.db, row, item.targetPath, { libraryId: target.id, parentId: targetParent.id, recalculateLibraryIds: [item.sourceLibraryId, target.id], clearExternalDisplayMetadataReferences: true, manageTransaction: false })
      for (const tag of tags) makeTagDb(this.db).link(tag.id, 'folder', item.id)
      const subtree = this.db.all('SELECT id,path FROM folders WHERE library_id=?', target.id) as unknown as { id: number; path: string }[]
      for (const folder of subtree.filter(folder => withinPath(item.targetPath, folder.path))) this.db.run('UPDATE folders SET filesystem_identity=?,path_missing=0 WHERE id=?', [serializeFilesystemIdentity(folder.path, 'directory'), folder.id])
      const files = this.db.all('SELECT id,path FROM files WHERE library_id=?', target.id) as unknown as { id: number; path: string }[]
      for (const file of files.filter(file => withinPath(item.targetPath, file.path))) this.db.run('UPDATE files SET filesystem_identity=?,path_missing=0 WHERE id=?', [serializeFilesystemIdentity(file.path, 'file'), file.id])
      for (const id of new Set([target.id, item.sourceLibraryId])) rebuildLibraryMediaCatalogInTransaction(this.db, id)
      item.phase = 'committed'; this.save(job)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); item.log?.splice(logBeforeCommit); item.phase = 'published'; throw error }
    if (item.crossVolume) await this.cleanupSource(job, item)
    else { item.phase = 'completed'; item.copiedBytes = item.bytes; this.save(job) }
  }
  private async removeOwnedStage(item: Item) {
    if (!exists(item.targetStage)) return
    if (!matches(item.targetStage, item.stageIdentity)) fail('目标暂存目录身份不一致', 'RECOVERY_UNSAFE')
    validateLocalDirectory(item.targetRoot, item.targetStage)
    const entries = await inventory(item.targetStage, true)
    for (const entry of entries) {
      const owned = item.owned?.[entry.path]
      if (!owned || owned.identity !== entry.identity || owned.size !== entry.size || (!entry.directory && owned.hash !== entry.hash)) fail('暂存目录包含无法确认或已修改的内容', 'RECOVERY_UNSAFE')
    }
    for (const entry of entries.sort((a, b) => b.path.length - a.path.length)) {
      const full = path.join(item.targetStage, entry.path)
      if (serializeFilesystemIdentity(full, entry.directory ? 'directory' : 'file') !== entry.identity) fail('暂存内容已变化', 'RECOVERY_UNSAFE')
      if (entry.directory) await fs.promises.rmdir(full); else await fs.promises.unlink(full)
    }
    await fs.promises.rmdir(item.targetStage)
  }
  private async rollback(job: Job, item: Item) {
    const row = this.db.get('SELECT path FROM folders WHERE id=?', item.id) as { path: string } | undefined
    if (!row || pathKey(row.path) !== pathKey(item.sourcePath)) fail('数据库已经改变，不能回滚磁盘', 'RECOVERY_UNSAFE')
    validateLocalDirectory(item.sourceRoot, path.dirname(item.sourcePath))
    if (!matches(item.sourcePath, item.sourceIdentity)) {
      if (exists(item.sourcePath)) fail('原位置已被其他目录占用', 'RECOVERY_UNSAFE')
      const candidate = matches(item.sourceStage, item.sourceIdentity) ? item.sourceStage : !item.crossVolume && matches(item.targetPath, item.sourceIdentity) ? item.targetPath : undefined
      if (!candidate) fail('无法定位原目录', 'RECOVERY_UNSAFE')
      validateLocalDirectory(candidate === item.sourceStage ? item.sourceRoot : item.targetRoot, candidate)
      await fs.promises.rename(candidate, item.sourcePath)
    }
    if (item.crossVolume && matches(item.targetPath, item.targetIdentity)) {
      validateLocalDirectory(item.targetRoot, item.targetPath)
      if (!item.manifest || !equalTree(item.manifest, await inventory(item.sourcePath, true), true) || !equalTree(item.manifest, await inventory(item.targetPath, true), false)) fail('源或目标内容变化，保留两份', 'RECOVERY_UNSAFE')
      if (exists(item.targetStage)) fail('目标暂存位置已占用', 'RECOVERY_UNSAFE')
      await fs.promises.rename(item.targetPath, item.targetStage)
    }
    await this.removeOwnedStage(item)
    item.phase = 'pending'; this.save(job)
  }
  private async cleanupSource(job: Job, item: Item) {
    item.phase = 'cleanup_pending'; this.save(job)
    const row = this.db.get('SELECT path,library_id FROM folders WHERE id=?', item.id) as { path: string; library_id: number } | undefined
    if (!row || row.library_id !== job.input.targetLibraryId || pathKey(row.path) !== pathKey(item.targetPath) || !matches(item.targetPath, item.targetIdentity)) fail('目标记录或文件夹已变化，保留源副本', 'RECOVERY_UNSAFE')
    validateLocalDirectory(item.targetRoot, item.targetPath)
    if (exists(item.sourcePath)) fail('原位置重新出现目录，保留源副本并等待核对', 'RECOVERY_UNSAFE')
    const check = () => this.check(job)
    if (!item.manifest || !equalTree(item.manifest, await inventory(item.targetPath, true, check), false)) fail('目标校验未通过，保留源副本', 'CONTENT_CHANGED')
    if (!exists(item.sourceStage)) { item.phase = 'completed'; item.error = undefined; this.save(job); return }
    validateLocalDirectory(item.sourceRoot, item.sourceStage)
    if (!matches(item.sourceStage, item.sourceIdentity)) fail('源暂存目录身份变化，拒绝清理', 'RECOVERY_UNSAFE')
    const remaining = await inventory(item.sourceStage, true, check)
    const recorded = new Map(item.manifest.map(entry => [entry.path, entry]))
    for (const entry of remaining) { const old = recorded.get(entry.path); if (!old || !equalTree([old], [entry], true)) fail('源副本内容发生变化，拒绝清理', 'CONTENT_CHANGED') }
    // Never recursively delete a source tree: rmdir also refuses unexpected new content.
    for (const entry of remaining.sort((a, b) => b.path.length - a.path.length)) {
      check()
      const full = path.join(item.sourceStage, entry.path)
      validateLocalDirectory(item.sourceRoot, path.dirname(full))
      if (serializeFilesystemIdentity(full, entry.directory ? 'directory' : 'file') !== entry.identity) fail('清理期间源文件身份变化', 'CONTENT_CHANGED')
      if (entry.directory) await fs.promises.rmdir(full); else {
        // Recheck the corresponding published file just before removing its source
        // copy; the initial tree verification may have taken a long time.
        const target = path.join(item.targetPath, entry.path)
        validateLocalDirectory(item.targetRoot, path.dirname(target))
        const targetIdentity = serializeFilesystemIdentity(target, 'file')
        const targetHash = createHash('sha256')
        for await (const chunk of fs.createReadStream(target)) { check(); targetHash.update(chunk) }
        if (targetHash.digest('hex') !== entry.hash || serializeFilesystemIdentity(target, 'file') !== targetIdentity) fail('清理前目标文件发生变化，保留源副本', 'CONTENT_CHANGED')
        const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(full)) { check(); hash.update(chunk) }
        if (hash.digest('hex') !== entry.hash) fail('清理期间源文件变化', 'CONTENT_CHANGED')
        const after = await fs.promises.lstat(full)
        if (after.size !== entry.size || after.mtimeMs !== entry.modified || serializeFilesystemIdentity(full, 'file') !== entry.identity) fail('清理期间源文件身份或内容变化', 'CONTENT_CHANGED')
        await fs.promises.unlink(full)
      }
    }
    await fs.promises.rmdir(item.sourceStage)
    item.phase = 'completed'; item.error = undefined; item.code = undefined; item.copiedBytes = item.bytes; this.save(job)
  }
}

/** Trusted move roots bridge the Everything indexing delay without recreating records. */
export function completedMoveLocations(db: Database) {
  return readMoveJobs<Job>(db).flatMap(job => job.items.filter(success).filter(item => matches(item.targetPath, item.targetIdentity)).map(item => ({ from: item.sourcePath, to: item.targetPath })))
}
