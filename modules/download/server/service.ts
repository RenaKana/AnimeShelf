import type { DownloadResource, ResourcePage, ResourceQuery, SourceId, SourceStatus } from '../shared/types'
import { ProxyError } from '../../../server/services/proxy'
import { acgPages, decodeCursor, encodeAcgCursor, encodeCursor } from './security'
import { createTransport, type ListRequest, type Transport } from './transport'
import { buildRequest, parsePage, isVerificationPage, ParseError } from './adapters'
import { classifyCollection } from '../shared/collections'
import { DOWNLOAD_SOURCES, sourceInfo } from '../shared/sources'
import { DownloadNetworkError } from './network'

interface ParsedPage { resources: DownloadResource[]; nextPage: number | null }
interface ServiceOptions {
  transport?: Transport
  parse?: (source: SourceId, body: string, page: number, baseUrl: string) => ParsedPage
  signal?: AbortSignal
  timeoutMs?: number
  queueWaitMs?: number
  maxConcurrent?: number
  cacheMs?: number
  now?: () => number
}
interface Waiter { source: SourceId; signal: AbortSignal; run: () => void; cancel: () => void }
const cancelled = () => new DOMException('Request cancelled', 'AbortError')
class SourceFailure extends Error { constructor(readonly status: SourceStatus) { super(status.message) } }

export class DownloadService {
  private readonly controller = new AbortController()
  private readonly cache = new Map<string, { expires: number; value: ResourcePage }>()
  private readonly cooling = new Map<SourceId, number>()
  private readonly activeSources = new Set<SourceId>()
  private readonly waiting: Waiter[] = []
  private readonly transport: Transport
  private readonly parse: NonNullable<ServiceOptions['parse']>
  private readonly now: () => number
  private unlink = () => {}
  constructor(private options: ServiceOptions = {}) {
    this.transport = options.transport ?? createTransport()
    this.parse = options.parse ?? parsePage
    this.now = options.now ?? Date.now
    const stop = () => this.dispose()
    if (options.signal?.aborted) this.dispose()
    else if (options.signal) {
      options.signal.addEventListener('abort', stop, { once: true })
      this.unlink = () => options.signal!.removeEventListener('abort', stop)
    }
  }
  dispose() {
    this.controller.abort(cancelled())
    this.cache.clear()
    this.cooling.clear()
    this.unlink()
  }
  sources() {
    return DOWNLOAD_SOURCES.map(info => ({ ...info }))
  }
  private drain() {
    for (const waiter of [...this.waiting]) {
      if (this.activeSources.size >= (this.options.maxConcurrent ?? 3)) break
      if (this.activeSources.has(waiter.source)) continue
      this.waiting.splice(this.waiting.indexOf(waiter), 1)
      waiter.signal.removeEventListener('abort', waiter.cancel)
      if (waiter.signal.aborted) { waiter.cancel(); continue }
      this.activeSources.add(waiter.source)
      waiter.run()
    }
  }
  private acquire(source: SourceId, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.waiting.length >= 24) return Promise.reject(new Error('busy'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        source, signal,
        run: () => resolve(() => { this.activeSources.delete(source); this.drain() }),
        cancel: () => {
          const index = this.waiting.indexOf(waiter)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(signal.reason ?? cancelled())
        },
      }
      signal.addEventListener('abort', waiter.cancel, { once: true })
      this.waiting.push(waiter)
      this.drain()
    })
  }
  private limited(source: SourceId): ResourcePage | null {
    const until = this.cooling.get(source)
    if (!until || until <= this.now()) { this.cooling.delete(source); return null }
    return this.result(source, { kind: 'rate_limited', message: '原站限流，请在冷却结束后重试', retryAt: new Date(until).toISOString() })
  }
  private result(source: SourceId, status: SourceStatus): ResourcePage {
    return { source, resources: [], nextCursor: null, status }
  }
  private async read(request: ListRequest, signal: AbortSignal) {
    const response = await this.transport(request, signal)
    signal.throwIfAborted()
    if (response.status === 429) {
      const raw = response.retryAfter?.trim()
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : NaN
      const date = raw ? Date.parse(raw) : NaN
      const until = Number.isFinite(seconds) ? this.now() + seconds : Number.isFinite(date) ? date : this.now() + 60_000
      this.cooling.set(request.source, Math.min(8.64e15, Math.max(this.now() + 1000, until)))
      throw new SourceFailure(this.limited(request.source)!.status)
    }
    if (isVerificationPage(response.body) || response.status === 403 || response.status === 401) throw new SourceFailure({ kind: 'restricted', message: '原站需要验证或限制访问，请打开原站后重试' })
    if (response.status < 200 || response.status >= 300) throw new SourceFailure({ kind: 'error', code: 'http', message: `原站响应异常（HTTP ${response.status}）` })
    return response.body
  }
  async resources(query: ResourceQuery, caller?: AbortSignal): Promise<ResourcePage> {
    this.controller.signal.throwIfAborted()
    caller?.throwIfAborted()
    const source = sourceInfo(query.source)
    // Bind cached pages and cursors to the built-in origin. Legacy saved addresses are never read.
    const revision = source.url
    const page = decodeCursor(query, revision)
    const key = JSON.stringify([revision, query.source, query.keyword, query.cursor ?? 'first'])
    const limited = this.limited(query.source)
    if (limited) return limited
    const cached = this.cache.get(key)
    if (!query.refresh && cached && cached.expires > this.now()) return { ...structuredClone(cached.value), cached: true }
    const controller = new AbortController()
    const abort = () => controller.abort(cancelled())
    caller?.addEventListener('abort', abort, { once: true })
    this.controller.signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    let timer = setTimeout(() => { controller.abort(cancelled()) }, this.options.queueWaitMs ?? 30_000)
    let release: (() => void) | undefined
    try {
      release = await this.acquire(query.source, controller.signal)
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort(cancelled()) }, this.options.timeoutMs ?? 18_000)
      // A request already ahead of us may have established a cooldown or cache entry.
      const cooldown = this.limited(query.source)
      if (cooldown) return cooldown
      const ready = this.cache.get(key)
      if (!query.refresh && ready && ready.expires > this.now()) return { ...structuredClone(ready.value), cached: true }
      let parsed: ParsedPage
      let nextCursor: string | null
      if (query.source === 'acgrip') {
        const pages = acgPages(query, revision), next: [number | null, number | null] = [null, null]
        parsed = { resources: [], nextPage: null }
        for (const [index, category] of (['1', '5'] as const).entries()) {
          const categoryPage = pages[index]
          if (categoryPage === null) continue
          const body = await this.read(buildRequest('acgrip', query.keyword, categoryPage, source.url, false, category), controller.signal)
          const result = this.parse('acgrip', body, categoryPage, source.url)
          parsed.resources.push(...result.resources.map(resource => category === '5'
            ? { ...resource, isCollection: classifyCollection(resource.title, true) }
            : resource))
          next[index] = result.nextPage
        }
        nextCursor = encodeAcgCursor(query.keyword, next, revision)
      } else {
        const body = await this.read(buildRequest(query.source, query.keyword, page, source.url), controller.signal)
        try { parsed = this.parse(query.source, body, page, source.url) }
        catch (error) {
          // Never use RSS to bypass a challenge or a rate limit.
          if (query.source !== 'nyaa' || page !== 1 || !(error instanceof ParseError)) throw error
          const rss = await this.read(buildRequest('nyaa', query.keyword, 1, source.url, true), controller.signal)
          parsed = this.parse('nyaa', rss, 1, source.url)
        }
        nextCursor = parsed.nextPage ? encodeCursor(query.source, query.keyword, parsed.nextPage, revision) : null
      }
      controller.signal.throwIfAborted()
      const resources = [...new Map(parsed.resources.map(resource => [resource.id, resource])).values()]
      const result: ResourcePage = {
        source: query.source, resources,
        nextCursor,
        status: { kind: 'success', message: resources.length ? `已加载 ${resources.length} 条` : '本页无动画资源' },
      }
      for (const [cachedKey, entry] of this.cache) if (entry.expires <= this.now()) this.cache.delete(cachedKey)
      if (this.cache.size >= 120) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { expires: this.now() + (this.options.cacheMs ?? 30_000), value: structuredClone(result) })
      return result
    } catch (error) {
      if (caller?.aborted || this.controller.signal.aborted) throw cancelled()
      if (timedOut) return this.result(query.source, { kind: 'error', code: 'timeout', message: '请求超时，可单独重试' })
      if (error instanceof DownloadNetworkError) return this.result(query.source, { kind: 'error', code: error.code, message: error.message })
      if (error instanceof SourceFailure) return this.result(query.source, error.status)
      if (error instanceof ProxyError) return this.result(query.source, { kind: 'error', code: 'network_policy', message: error.message })
      if (error instanceof ParseError) return this.result(query.source, { kind: 'error', code: 'parse', message: '原站列表格式未识别，不能确认搜索结果' })
      return this.result(query.source, { kind: 'error', code: error instanceof Error && error.message === 'busy' ? 'busy' : 'connection', message: '连接失败或请求繁忙，可单独重试' })
    } finally {
      clearTimeout(timer)
      release?.()
      caller?.removeEventListener('abort', abort)
      this.controller.signal.removeEventListener('abort', abort)
    }
  }
}
