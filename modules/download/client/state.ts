import { SOURCE_IDS, type DownloadResource, type ResourcePage, type ResourceQuery, type SourceId, type SourceStatus } from '../shared/types'
import { DEFAULT_DOWNLOAD_VIEW, DOWNLOAD_SORT_COLUMNS, type DownloadSortKey, type DownloadViewPreferences } from './presentation'

export type ClientSourcePhase = 'idle' | 'loading' | SourceStatus['kind']

export interface ClientSourceState {
  phase: ClientSourcePhase
  message: string
  nextCursor: string | null
  failedCursor: string | null
  retryAt?: string
  cached?: boolean
}

export interface DownloadClientState extends DownloadViewPreferences {
  draftKeyword: string
  draftSources: SourceId[]
  submittedKeyword: string
  submittedSources: SourceId[]
  resources: DownloadResource[]
  sourceStates: Record<SourceId, ClientSourceState>
}

export interface DownloadPreferences extends Partial<DownloadViewPreferences> {
  version: 1
  draftKeyword: string
  draftSources: SourceId[]
  submittedKeyword: string
  submittedSources: SourceId[]
}

export type DownloadPageFetcher = (query: ResourceQuery, signal: AbortSignal) => Promise<ResourcePage>

export const DOWNLOAD_SESSION_KEY = 'animeshelf.download.filters.v1'

const idleSourceState = (): ClientSourceState => ({
  phase: 'idle',
  message: '',
  nextCursor: null,
  failedCursor: null,
})

const sourceStateRecord = (): Record<SourceId, ClientSourceState> => Object.fromEntries(
  SOURCE_IDS.map(source => [source, idleSourceState()]),
) as Record<SourceId, ClientSourceState>

function validSourceList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 32
    && value.every(source => typeof source === 'string')
    && new Set(value).size === value.length
}
const supportedSources = (value: readonly string[]): SourceId[] => value.filter((source): source is SourceId => SOURCE_IDS.includes(source as SourceId))

export function parseDownloadPreferences(raw: string | null | undefined): DownloadPreferences | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<DownloadPreferences>
    if (
      value.version !== 1
      || typeof value.draftKeyword !== 'string'
      || typeof value.submittedKeyword !== 'string'
      || value.draftKeyword.length > 200
      || value.submittedKeyword.length > 200
      || !validSourceList(value.draftSources)
      || !validSourceList(value.submittedSources)
    ) return null
    return {
      version: 1,
      draftKeyword: value.draftKeyword,
      draftSources: supportedSources(value.draftSources),
      submittedKeyword: value.submittedKeyword,
      submittedSources: supportedSources(value.submittedSources),
      sortKey: DOWNLOAD_SORT_COLUMNS.some(([key]) => key === value.sortKey) ? value.sortKey : DEFAULT_DOWNLOAD_VIEW.sortKey,
      sortDirection: value.sortDirection === 'asc' || value.sortDirection === 'desc' ? value.sortDirection : DEFAULT_DOWNLOAD_VIEW.sortDirection,
      collectionsOnly: value.collectionsOnly === true,
    }
  } catch {
    return null
  }
}

export function serializeDownloadPreferences(state: Pick<DownloadClientState,
  'draftKeyword' | 'draftSources' | 'submittedKeyword' | 'submittedSources'> & Partial<DownloadViewPreferences>): string {
  return JSON.stringify({
    version: 1,
    draftKeyword: state.draftKeyword,
    draftSources: state.draftSources,
    submittedKeyword: state.submittedKeyword,
    submittedSources: state.submittedSources,
    sortKey: state.sortKey ?? DEFAULT_DOWNLOAD_VIEW.sortKey,
    sortDirection: state.sortDirection ?? DEFAULT_DOWNLOAD_VIEW.sortDirection,
    collectionsOnly: state.collectionsOnly ?? false,
  } satisfies DownloadPreferences)
}

export function createInitialDownloadState(preferences?: DownloadPreferences | null): DownloadClientState {
  const draft = supportedSources(preferences?.draftSources ?? SOURCE_IDS)
  const submitted = supportedSources(preferences?.submittedSources ?? SOURCE_IDS)
  return {
    draftKeyword: preferences?.draftKeyword ?? '',
    draftSources: draft.length || submitted.length ? draft : [...SOURCE_IDS],
    submittedKeyword: preferences?.submittedKeyword ?? '',
    submittedSources: submitted.length ? submitted : draft.length ? [...draft] : [...SOURCE_IDS],
    resources: [],
    sourceStates: sourceStateRecord(),
    sortKey: preferences?.sortKey ?? DEFAULT_DOWNLOAD_VIEW.sortKey,
    sortDirection: preferences?.sortDirection ?? DEFAULT_DOWNLOAD_VIEW.sortDirection,
    collectionsOnly: preferences?.collectionsOnly ?? false,
  }
}

const resourceKey = (resource: Pick<DownloadResource, 'source' | 'id'>) => `${resource.source}\u0000${resource.id}`

function publishedTime(resource: DownloadResource): number | null {
  if (!resource.publishedAt) return null
  const parsed = Date.parse(resource.publishedAt)
  return Number.isFinite(parsed) ? parsed : null
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '请求失败，请稍后重试'
}

export class DownloadController {
  private state: DownloadClientState
  private generation = 0
  private disposed = false
  private readonly requestIds = new Map<SourceId, number>()
  private readonly controllers = new Map<SourceId, AbortController>()
  private readonly order = new Map<string, number>()
  private nextOrder = 0
  private readonly fetchPage: DownloadPageFetcher
  private readonly onChange?: (state: DownloadClientState) => void
  private readonly now: () => number

  constructor(options: {
    fetchPage: DownloadPageFetcher
    initialState?: DownloadClientState
    onChange?: (state: DownloadClientState) => void
    now?: () => number
  }) {
    this.fetchPage = options.fetchPage
    this.state = options.initialState ?? createInitialDownloadState()
    this.onChange = options.onChange
    this.now = options.now ?? Date.now
  }

  getState(): DownloadClientState {
    return this.state
  }

  setDraftKeyword(keyword: string): void {
    this.update({ ...this.state, draftKeyword: keyword.slice(0, 200) })
  }

  setDraftSources(sources: SourceId[]): void {
    const unique = supportedSources([...new Set(sources)])
    this.update({ ...this.state, draftSources: unique })
  }

  toggleSort(sortKey: DownloadSortKey): void {
    const sortDirection = this.state.sortKey === sortKey
      ? this.state.sortDirection === 'asc' ? 'desc' : 'asc'
      : ['title', 'source', 'group'].includes(sortKey) ? 'asc' : 'desc'
    this.update({ ...this.state, sortKey, sortDirection })
  }

  setCollectionsOnly(collectionsOnly: boolean): void {
    this.update({ ...this.state, collectionsOnly })
  }

  getRetryRemainingMs(source: SourceId): number {
    const retryAt = this.state.sourceStates[source].retryAt
    if (!retryAt) return 0
    const target = Date.parse(retryAt)
    return Number.isFinite(target) ? Math.max(0, target - this.now()) : 0
  }

  async submit(refresh = false): Promise<boolean> {
    const submittedSources = supportedSources(this.state.draftSources)
    if (!submittedSources.length || this.disposed) return false

    this.update({
      ...this.state,
      submittedKeyword: this.state.draftKeyword.trim(),
      submittedSources,
    })
    return this.loadSubmitted(refresh)
  }

  async loadSubmitted(refresh = false): Promise<boolean> {
    const submittedSources = supportedSources(this.state.submittedSources)
    if (!submittedSources.length || this.disposed) return false

    this.cancelRequests()
    const generation = ++this.generation
    this.order.clear()
    this.nextOrder = 0
    const sourceStates = sourceStateRecord()
    const runnableSources: SourceId[] = []
    for (const source of submittedSources) {
      const previous = this.state.sourceStates[source]
      if (previous.phase === 'rate_limited' && this.getRetryRemainingMs(source) > 0) {
        sourceStates[source] = { ...previous, nextCursor: null, failedCursor: null, cached: undefined }
      } else {
        sourceStates[source] = { ...sourceStates[source], phase: 'loading', message: refresh ? '正在刷新' : '正在请求' }
        runnableSources.push(source)
      }
    }
    this.update({
      ...this.state,
      resources: [],
      sourceStates,
    })
    await Promise.allSettled(runnableSources.map(source => this.runSource(source, null, refresh, generation)))
    return generation === this.generation && !this.disposed
  }

  refresh(): Promise<boolean> {
    return this.submit(true)
  }

  async loadMore(source: SourceId): Promise<boolean> {
    const sourceState = this.state.sourceStates[source]
    if (
      this.disposed
      || !this.state.submittedSources.includes(source)
      || !SOURCE_IDS.includes(source)
      || sourceState.phase !== 'success'
      || !sourceState.nextCursor
    ) return false
    return this.runSource(source, sourceState.nextCursor, false, this.generation)
  }

  async retry(source: SourceId): Promise<boolean> {
    const sourceState = this.state.sourceStates[source]
    if (
      this.disposed
      || !this.state.submittedSources.includes(source)
      || !SOURCE_IDS.includes(source)
      || sourceState.phase === 'idle'
      || sourceState.phase === 'loading'
      || sourceState.phase === 'success'
      || this.getRetryRemainingMs(source) > 0
    ) return false
    return this.runSource(source, sourceState.failedCursor, false, this.generation)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.cancelRequests()
  }

  private cancelRequests(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  private update(next: DownloadClientState): void {
    this.state = next
    this.onChange?.(next)
  }

  private updateSource(source: SourceId, next: ClientSourceState): void {
    this.update({
      ...this.state,
      sourceStates: { ...this.state.sourceStates, [source]: next },
    })
  }

  private mergeResources(incoming: DownloadResource[]): void {
    const byKey = new Map(this.state.resources.map(item => [resourceKey(item), item]))
    for (const resource of incoming) {
      const key = resourceKey(resource)
      if (!this.order.has(key)) this.order.set(key, this.nextOrder++)
      byKey.set(key, resource)
    }
    const resources = [...byKey.values()].sort((left, right) => {
      const leftTime = publishedTime(left)
      const rightTime = publishedTime(right)
      if (leftTime === null && rightTime !== null) return 1
      if (leftTime !== null && rightTime === null) return -1
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime
      return (this.order.get(resourceKey(left)) ?? 0) - (this.order.get(resourceKey(right)) ?? 0)
    })
    this.update({ ...this.state, resources })
  }

  private async runSource(source: SourceId, cursor: string | null, refresh: boolean, generation: number): Promise<boolean> {
    this.controllers.get(source)?.abort()
    const controller = new AbortController()
    this.controllers.set(source, controller)
    const requestId = (this.requestIds.get(source) ?? 0) + 1
    this.requestIds.set(source, requestId)
    const previous = this.state.sourceStates[source]
    this.updateSource(source, {
      ...previous,
      phase: 'loading',
      message: cursor ? '正在加载下一页' : refresh ? '正在刷新' : '正在请求',
    })

    const query: ResourceQuery = {
      source,
      keyword: this.state.submittedKeyword,
      ...(cursor ? { cursor } : {}),
      ...(refresh ? { refresh: true } : {}),
    }
    try {
      const result = await this.fetchPage(query, controller.signal)
      if (!this.isCurrent(source, requestId, generation)) return false
      if (result.source !== source) throw new Error('返回的来源与请求不匹配')
      this.mergeResources(result.resources)
      const successful = result.status.kind === 'success'
      this.updateSource(source, {
        phase: result.status.kind,
        message: result.status.message,
        nextCursor: successful ? result.nextCursor : previous.nextCursor,
        failedCursor: successful ? null : cursor,
        retryAt: result.status.retryAt,
        cached: result.cached,
      })
      return successful
    } catch (error) {
      if (!this.isCurrent(source, requestId, generation) || isAbortError(error)) return false
      this.updateSource(source, {
        ...previous,
        phase: 'error',
        message: errorMessage(error),
        failedCursor: cursor,
        retryAt: undefined,
      })
      return false
    } finally {
      if (this.requestIds.get(source) === requestId) this.controllers.delete(source)
    }
  }

  private isCurrent(source: SourceId, requestId: number, generation: number): boolean {
    return !this.disposed && generation === this.generation && this.requestIds.get(source) === requestId
  }
}
