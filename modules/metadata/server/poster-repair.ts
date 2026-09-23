import path from 'path'
import { randomUUID } from 'crypto'
import type { Database } from 'node-sqlite3-wasm'
import { POSTER_DIR } from '../../../server/db/schema'
import { assertLibraryAvailable, withLibraryMaintenance } from '../../../server/services/library-maintenance'
import {
  cachePoster,
  cachedPosterPath,
  getAnilistPosterUrl,
  getBangumiDetail,
  getTMDBPoster,
  type CachePosterOptions,
} from './metadata'
import { freezeFolderScope } from './folder-scope'
import { posterCacheKey, type TmdbMediaType } from '../../../shared/poster-cache-key'
import type { PosterRepairFailure, PosterFailureCode } from '../../../shared/poster-repair'
export type { PosterRepairFailure } from '../../../shared/poster-repair'

export type PosterRepairMode = 'missing' | 'refresh'
export type PosterRepairStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface PosterRepairJob {
  jobId: string
  retryOf: string | null
  mode: PosterRepairMode
  libraryId: number | null
  /** Validated root scope; null retains the legacy whole-library/all-libraries scope. */
  folderIds: number[] | null
  includeFavorites: boolean
  status: PosterRepairStatus
  total: number
  processed: number
  repaired: number
  skipped: number
  failed: number
  current: string
  failures: PosterRepairFailure[]
  error: string | null
  startedAt: number
  finishedAt: number | null
}

type FolderRow = { id: number; name: string; anilist_id: number; source: string; tmdb_media_type: TmdbMediaType | null }
type FolderBinding = { id: number; originalSource: string }
type FolderTarget = {
  key: string
  source: 'anilist' | 'bangumi' | 'tmdb' | 'unknown'
  sourceId: number
  base: string | null
  tmdbMediaType: TmdbMediaType | null
  name: string
  bindings: FolderBinding[]
}
type FavoriteRow = { item_id: string; title: string; links: string | null; image: string | null }
type FavoriteDetailFetcher = (id: string, links: { name: string; url: string }[]) => Promise<{ posterPath: string | null }>

export interface PosterRepairServiceOptions {
  db: Database
  signal: AbortSignal
  track: <T>(operation: Promise<T>) => Promise<T>
  posterDirectory?: string
  favoriteDetail?: () => FavoriteDetailFetcher | undefined
  fetchAnilistPoster?: typeof getAnilistPosterUrl
  fetchBangumiDetail?: typeof getBangumiDetail
  fetchTMDBPoster?: typeof getTMDBPoster
  cache?: typeof cachePoster
  cachedPath?: typeof cachedPosterPath
  delayMs?: number
}

export interface StartPosterRepairOptions {
  mode?: PosterRepairMode
  libraryId?: number | null
  includeFavorites?: boolean
  retryOf?: string | null
  targetKeys?: Set<string>
  folderIds?: number[] | null
  /** Internal retry snapshot. When present, do not re-expand roots. */
  frozenScopeIds?: ReadonlySet<number> | null
}

const MAX_RETAINED_JOBS = 20

function normalizedSource(source: string): FolderTarget['source'] {
  return source === 'tmdb' || source === 'bangumi' || source === 'anilist' ? source : 'unknown'
}

function targetKey(source: FolderTarget['source'], sourceId: number, tmdbMediaType: TmdbMediaType | null): string {
  return source === 'tmdb'
    ? `tmdb:${tmdbMediaType ?? 'unknown'}:${sourceId}`
    : `${source}:${sourceId}`
}

function publicJob(job: PosterRepairJob): PosterRepairJob {
  return { ...job, folderIds: job.folderIds ? [...job.folderIds] : null, failures: job.failures.map(failure => ({ ...failure, folderIds: [...failure.folderIds] })) }
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return String(error || '未知错误')
}

/** Do not send raw Axios errors (which may contain provider credentials) to UI. */
export function posterFailure(error: unknown): Pick<PosterRepairFailure, 'code' | 'reason' | 'retryable'> {
  const value = error as { code?: string; name?: string; message?: string; response?: { status?: number } }
  const code = value?.code ?? ''
  if (code.startsWith('BANGUMI_DETAIL_') || code === 'SOURCE_CONFIRMATION_REQUIRED' || value?.response?.status === 404) {
    return { code: 'SOURCE_CONFIRMATION_REQUIRED', reason: '来源不存在或媒介类型不匹配，请确认来源', retryable: false }
  }
  if (code === 'SOURCE_CONFIGURATION' || [401, 403].includes(value?.response?.status ?? 0)) return { code: 'SOURCE_CONFIGURATION', reason: '数据源配置或授权不可用，请检查数据源设置', retryable: false }
  if (code === 'SOURCE_NO_POSTER') return { code: 'SOURCE_NO_POSTER', reason: '元数据源没有可用海报', retryable: false }
  if (code === 'IMAGE_PROXY_CONFIG') return { code: 'PROXY_CONFIGURATION', reason: '海报代理配置不受支持，请设置本机 HTTP/HTTPS 代理', retryable: false }
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return { code: 'TLS_ERROR', reason: '图片连接的证书校验失败，请检查代理或网络证书', retryable: false }
  if (code === 'ERR_REMOTE_IMAGE_VALIDATION' || /不允许|仅支持|URL 无效/.test(value?.message ?? '')) return { code: 'IMAGE_REJECTED', reason: '图片地址或内容未通过安全校验；请检查图床及本机代理配置', retryable: false }
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_NETWORK|TIMEOUT|IMAGE_PROXY_CONNECT/.test(code) || value?.name === 'TimeoutError' || value?.response || /无法解析/.test(value?.message ?? '')) return { code: 'NETWORK_ERROR', reason: '图片或数据源暂时无法连接，请检查网络／本机代理后重试', retryable: true }
  return { code: 'DOWNLOAD_FAILED', reason: '海报下载失败，请检查网络后重试', retryable: true }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return Object.assign(new Error('海报任务已取消'), { name: 'AbortError' })
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as { name?: string; code?: string })?.name === 'AbortError' || (error as { code?: string })?.code === 'ERR_CANCELED'
}

export class PosterRepairService {
  private readonly jobs = new Map<string, PosterRepairJob>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly latestByScope = new Map<string, string>()
  private readonly scopeIdsByJob = new Map<string, Set<number> | null>()
  private readonly posterDirectory: string
  private readonly delayMs: number

  constructor(private readonly options: PosterRepairServiceOptions) {
    this.posterDirectory = options.posterDirectory ?? POSTER_DIR
    this.delayMs = options.delayMs ?? 120
  }

  private scopeKey(libraryId: number | null, includeFavorites: boolean, folderIds: number[] | null = null): string {
    const folders = folderIds ? `folders:${folderIds.join(',')}` : 'folders:all'
    return `${libraryId == null ? 'all' : `library:${libraryId}`}:${includeFavorites ? 'favorites' : 'media'}:${folders}`
  }

  private remember(job: PosterRepairJob): void {
    this.jobs.set(job.jobId, job)
    this.latestByScope.set(this.scopeKey(job.libraryId, job.includeFavorites, job.folderIds), job.jobId)
    while (this.jobs.size > MAX_RETAINED_JOBS) {
      const oldest = [...this.jobs.values()].find(candidate => candidate.status !== 'running' && candidate.status !== 'queued')
      if (!oldest) break
      this.jobs.delete(oldest.jobId)
      this.operations.delete(oldest.jobId)
      this.scopeIdsByJob.delete(oldest.jobId)
    }
  }

  start(options: StartPosterRepairOptions = {}): PosterRepairJob {
    if (this.options.signal.aborted) throw abortError(this.options.signal)
    const mode = options.mode ?? 'missing'
    const libraryId = options.libraryId ?? null
    const hasFolderScope = Object.prototype.hasOwnProperty.call(options, 'folderIds')
    const hasFrozenScope = Object.prototype.hasOwnProperty.call(options, 'frozenScopeIds')
    const explicitFolderScope = options.folderIds !== undefined && options.folderIds !== null
    if (explicitFolderScope && options.includeFavorites === true) {
      throw Object.assign(new Error('指定文件夹范围不能同时包含心愿单'), { status: 400, code: 'FOLDER_SCOPE_FAVORITES_CONFLICT' })
    }
    const includeFavorites = libraryId == null && options.includeFavorites === true
    if (mode !== 'missing' && mode !== 'refresh') throw new Error('无效的海报任务模式')
    if (libraryId != null && (!Number.isInteger(libraryId) || libraryId <= 0)) throw new Error('无效的媒体库')
    assertLibraryAvailable(this.options.db)

    const frozen = hasFrozenScope
      ? null
      : freezeFolderScope(this.options.db, options.folderIds, { libraryId })
    const folderIds = hasFrozenScope
      ? (options.folderIds == null ? null : [...options.folderIds].sort((left, right) => left - right))
      : (frozen?.folderIds ?? null)
    const scopeIds = hasFrozenScope
      ? (options.frozenScopeIds == null ? null : new Set(options.frozenScopeIds))
      : (frozen ? new Set(frozen.descendantIds) : null)

    const job: PosterRepairJob = {
      jobId: randomUUID(), retryOf: options.retryOf ?? null, mode, libraryId, folderIds, includeFavorites,
      status: 'queued', total: 0, processed: 0, repaired: 0, skipped: 0, failed: 0,
      current: '', failures: [], error: null, startedAt: Date.now(), finishedAt: null,
    }
    this.remember(job)
    this.scopeIdsByJob.set(job.jobId, scopeIds)
    syncRepairState(job)
    const operation = withLibraryMaintenance(this.options.db, 'poster', () => this.run(job, options.targetKeys, scopeIds))
    const tracked = this.options.track(operation)
    this.operations.set(job.jobId, tracked)
    void tracked.finally(() => this.operations.delete(job.jobId)).catch(() => {})
    return publicJob(job)
  }

  retry(jobId: string): PosterRepairJob {
    const previous = this.jobs.get(jobId)
    if (!previous) throw Object.assign(new Error('海报任务不存在'), { status: 404 })
    if (previous.status === 'running' || previous.status === 'queued') throw Object.assign(new Error('海报任务仍在运行'), { status: 409, code: 'LIBRARY_BUSY' })
    const targetKeys = new Set(previous.failures.filter(failure => failure.retryable).map(failure => failure.key))
    if (targetKeys.size === 0) throw Object.assign(new Error('没有可重试的失败项'), { status: 409 })
    const frozenScopeIds = this.scopeIdsByJob.get(previous.jobId) ?? null
    return this.start({
      mode: previous.mode,
      libraryId: previous.libraryId,
      includeFavorites: previous.includeFavorites,
      retryOf: previous.jobId,
      targetKeys,
      folderIds: previous.folderIds,
      frozenScopeIds,
    })
  }

  get(jobId: string): PosterRepairJob | null {
    const job = this.jobs.get(jobId)
    return job ? publicJob(job) : null
  }

  latest(libraryId: number | null, includeFavorites = false, folderIds: number[] | null = null): PosterRepairJob | null {
    const id = this.latestByScope.get(this.scopeKey(libraryId, libraryId == null && includeFavorites, folderIds))
    return id ? this.get(id) : null
  }

  async wait(jobId: string): Promise<PosterRepairJob> {
    await this.operations.get(jobId)
    const job = this.get(jobId)
    if (!job) throw new Error('海报任务不存在')
    return job
  }

  private throwIfAborted(): void {
    if (this.options.signal.aborted) throw abortError(this.options.signal)
  }

  private async delay(): Promise<void> {
    if (this.delayMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const signal = this.options.signal
      const done = () => { signal.removeEventListener('abort', cancelled); resolve() }
      const timer = setTimeout(done, this.delayMs)
      const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(abortError(signal)) }
      if (signal.aborted) cancelled()
      else signal.addEventListener('abort', cancelled, { once: true })
    })
  }

  private folderTargets(libraryId: number | null, targetKeys?: Set<string>, scopeIds: Set<number> | null = null): FolderTarget[] {
    const statement = this.options.db.prepare(`
      SELECT id, name, anilist_id, source, tmdb_media_type
      FROM folders
      WHERE anilist_id IS NOT NULL ${libraryId == null ? '' : 'AND library_id = ?'}
      ORDER BY id
    `)
    let rows: FolderRow[]
    try { rows = statement.all(libraryId == null ? [] : [libraryId]) as FolderRow[] } finally { statement.finalize() }
    if (scopeIds) rows = rows.filter(row => scopeIds.has(row.id))
    const grouped = new Map<string, FolderTarget>()
    for (const row of rows) {
      const source = normalizedSource(row.source)
      const tmdbMediaType = source === 'tmdb' && (row.tmdb_media_type === 'movie' || row.tmdb_media_type === 'tv')
        ? row.tmdb_media_type
        : null
      const key = targetKey(source, row.anilist_id, tmdbMediaType)
      if (targetKeys && !targetKeys.has(key)) continue
      const current = grouped.get(key)
      if (current) current.bindings.push({ id: row.id, originalSource: row.source })
      else grouped.set(key, {
        key, source, sourceId: row.anilist_id,
        base: source === 'unknown' ? null : posterCacheKey(source, row.anilist_id, tmdbMediaType),
        tmdbMediaType, name: row.name,
        bindings: [{ id: row.id, originalSource: row.source }],
      })
    }
    return [...grouped.values()]
  }

  private favoriteRows(targetKeys?: Set<string>): FavoriteRow[] {
    const table = this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'season_favorites'").get()
    if (!table || !this.options.favoriteDetail?.()) return []
    const statement = this.options.db.prepare('SELECT item_id, title, links, image FROM season_favorites ORDER BY item_id')
    let rows: FavoriteRow[]
    try { rows = statement.all() as FavoriteRow[] } finally { statement.finalize() }
    return targetKeys ? rows.filter(row => targetKeys.has(`favorite:${row.item_id}`)) : rows
  }

  private favoritePosterValid(image: string | null): boolean {
    if (!image?.startsWith('/posters/')) return false
    const fileName = image.slice('/posters/'.length)
    if (path.basename(fileName) !== fileName) return false
    const match = fileName.match(/^(.+)\.(jpg|png|webp)$/i)
    return Boolean(match && (this.options.cachedPath ?? cachedPosterPath)(match[1], this.posterDirectory) === `/posters/${fileName}`)
  }

  private updateBindings(target: FolderTarget, hasPoster: boolean): void {
    const update = this.options.db.prepare("UPDATE folders SET has_poster = ?, updated_at = datetime('now') WHERE id = ? AND anilist_id = ? AND source = ? AND (source != 'tmdb' OR tmdb_media_type IS ?)")
    try {
      for (const binding of target.bindings) update.run([hasPoster ? 1 : 0, binding.id, target.sourceId, binding.originalSource, target.tmdbMediaType])
    } finally { update.finalize() }
  }

  private fail(job: PosterRepairJob, target: Pick<PosterRepairFailure, 'key' | 'source' | 'sourceId' | 'name'>, reason: string, code: PosterFailureCode = 'DOWNLOAD_FAILED', retryable = true, folderIds: number[] = []): void {
    job.failed++
    job.failures.push({ ...target, reason, code, retryable, folderIds })
  }

  private async resolvePosterUrl(target: FolderTarget): Promise<string | null> {
    if (target.source === 'tmdb') {
      if (!target.tmdbMediaType) return null
      return (this.options.fetchTMDBPoster ?? getTMDBPoster)(target.sourceId, { signal: this.options.signal, tmdbMediaType: target.tmdbMediaType, throwOnError: true })
    }
    if (target.source === 'bangumi') return (await (this.options.fetchBangumiDetail ?? getBangumiDetail)(target.sourceId, { signal: this.options.signal })).posterUrl ?? null
    return (this.options.fetchAnilistPoster ?? getAnilistPosterUrl)(target.sourceId, { signal: this.options.signal, throwOnError: true })
  }

  private async repairFolder(job: PosterRepairJob, target: FolderTarget): Promise<void> {
    job.current = target.name
    const identity = { key: target.key, source: target.source, sourceId: String(target.sourceId), name: target.name }
    const folderIds = target.bindings.map(binding => binding.id)
    if (target.source === 'unknown' || !Number.isSafeInteger(target.sourceId) || target.sourceId <= 0) {
      this.fail(job, identity, '现有来源绑定不受支持或 ID 无效，请手动确认来源；已有海报已保留', 'SOURCE_CONFIRMATION_REQUIRED', false, folderIds)
      return
    }
    if (!target.base) {
      if (job.mode === 'missing' && (this.options.cachedPath ?? cachedPosterPath)(`tm_${target.sourceId}`, this.posterDirectory)) {
        this.updateBindings(target, true)
        job.skipped++
      } else {
        this.fail(job, identity, '旧 TMDb 绑定缺少电影／剧集类型，请确认来源后刷新；已有海报已保留', 'SOURCE_CONFIRMATION_REQUIRED', false, folderIds)
      }
      return
    }
    const existing = (this.options.cachedPath ?? cachedPosterPath)(target.base, this.posterDirectory)
    if (job.mode === 'missing' && existing) {
      this.updateBindings(target, true)
      job.skipped++
      return
    }
    try {
      const url = await this.resolvePosterUrl(target)
      this.throwIfAborted()
      if (!url) throw Object.assign(new Error('元数据源没有可用海报'), { code: 'SOURCE_NO_POSTER' })
      const cacheOptions: CachePosterOptions = {
        directory: this.posterDirectory,
        signal: this.options.signal,
        throwOnError: true,
        ...(job.mode === 'refresh' ? { force: true } : {}),
      }
      const saved = await (this.options.cache ?? cachePoster)(url, target.base, cacheOptions)
      this.throwIfAborted()
      if (!saved) throw new Error(job.mode === 'refresh' ? '强制刷新下载失败，已保留原海报' : '海报下载失败')
      this.updateBindings(target, true)
      job.repaired++
    } catch (error) {
      if (isAbort(error, this.options.signal)) throw error
      if (job.mode === 'missing') this.updateBindings(target, false)
      const failure = posterFailure(error)
      this.fail(job, identity, `${failure.reason}${job.mode === 'refresh' && existing ? '；已保留原海报' : ''}`, failure.code, failure.retryable, folderIds)
    }
  }

  private async repairFavorite(job: PosterRepairJob, favorite: FavoriteRow): Promise<void> {
    const key = `favorite:${favorite.item_id}`
    job.current = favorite.title
    if (job.mode === 'missing' && this.favoritePosterValid(favorite.image)) { job.skipped++; return }
    let links: { name: string; url: string }[] = []
    try { links = favorite.links ? JSON.parse(favorite.links) : [] } catch { links = [] }
    if (links.length === 0) {
      this.fail(job, { key, source: 'favorite', sourceId: favorite.item_id, name: favorite.title }, '心愿单没有可用来源链接', 'SOURCE_CONFIRMATION_REQUIRED', false)
      return
    }
    try {
      const result = await this.options.favoriteDetail?.()?.(favorite.item_id, links)
      this.throwIfAborted()
      if (!result?.posterPath) throw new Error('心愿单海报下载失败')
      this.options.db.prepare("UPDATE season_favorites SET image = ? WHERE item_id = ? AND COALESCE(image, '') = COALESCE(?, '') AND COALESCE(links, '') = COALESCE(?, '')")
        .run([result.posterPath, favorite.item_id, favorite.image, favorite.links])
      job.repaired++
    } catch (error) {
      if (isAbort(error, this.options.signal)) throw error
      const failure = posterFailure(error)
      this.fail(job, { key, source: 'favorite', sourceId: favorite.item_id, name: favorite.title }, failure.reason, failure.code, failure.retryable)
    }
  }

  private async run(job: PosterRepairJob, targetKeys?: Set<string>, scopeIds: Set<number> | null = null): Promise<void> {
    job.status = 'running'
    syncRepairState(job)
    try {
      if (job.libraryId != null) {
        const library = this.options.db.prepare('SELECT id FROM libraries WHERE id = ?').get(job.libraryId)
        if (!library) throw Object.assign(new Error('媒体库不存在'), { status: 404 })
      }
      const folders = this.folderTargets(job.libraryId, targetKeys, scopeIds)
      if (!scopeIds) this.scopeIdsByJob.set(job.jobId, new Set(folders.flatMap(target => target.bindings.map(binding => binding.id))))
      const favorites = job.includeFavorites ? this.favoriteRows(targetKeys) : []
      job.total = folders.length + favorites.length
      for (const target of folders) {
        this.throwIfAborted()
        await this.repairFolder(job, target)
        job.processed++
        syncRepairState(job)
        if (job.processed < job.total) await this.delay()
      }
      for (const favorite of favorites) {
        this.throwIfAborted()
        await this.repairFavorite(job, favorite)
        job.processed++
        syncRepairState(job)
        if (job.processed < job.total) await this.delay()
      }
      job.status = 'completed'
      job.current = ''
    } catch (error) {
      job.status = isAbort(error, this.options.signal) ? 'cancelled' : 'failed'
      job.error = errorText(error)
      job.current = ''
    } finally {
      job.finishedAt = Date.now()
      syncRepairState(job)
    }
  }
}

export const repairState = {
  jobId: null as string | null,
  folderIds: null as number[] | null,
  running: false,
  total: 0,
  processed: 0,
  repaired: 0,
  skipped: 0,
  failed: 0,
  failures: [] as PosterRepairFailure[],
  done: false,
  lastRun: 0,
}

function syncRepairState(job: PosterRepairJob): void {
  repairState.jobId = job.jobId
  repairState.folderIds = job.folderIds ? [...job.folderIds] : null
  repairState.running = job.status === 'queued' || job.status === 'running'
  repairState.total = job.total
  repairState.processed = job.processed
  repairState.repaired = job.repaired
  repairState.skipped = job.skipped
  repairState.failed = job.failed
  repairState.failures = job.failures.map(failure => ({ ...failure }))
  repairState.done = ['completed', 'failed', 'cancelled'].includes(job.status)
  repairState.lastRun = job.finishedAt ?? 0
}

let activeService: PosterRepairService | null = null

export function setPosterRepairService(service: PosterRepairService | null): void {
  activeService = service
}

export function posterRepairService(): PosterRepairService {
  if (!activeService) throw Object.assign(new Error('海报任务服务尚未启动'), { status: 503 })
  return activeService
}

export async function repairMissingPosters(): Promise<{ repaired: number; failed: number }> {
  const service = posterRepairService()
  const started = service.start({ mode: 'missing', includeFavorites: true })
  const finished = await service.wait(started.jobId)
  return { repaired: finished.repaired, failed: finished.failed }
}
