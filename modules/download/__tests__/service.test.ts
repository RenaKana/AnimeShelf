import { describe, expect, it, vi } from 'vitest'
import { DownloadService } from '../server/service'
import { encodeCursor } from '../server/security'
import type { Transport } from '../server/transport'
import type { DownloadResource, ResourceQuery } from '../shared/types'

const BANGUMI_ROOT = 'https://bangumi.moe/'
const ACG_ROOT = 'https://acg.rip/'
const query: ResourceQuery = { source: 'bangumi', keyword: '古見さん VCB-Studio' }
const parsed = () => ({ resources: [], nextPage: 2 })
const ok: Transport = async () => ({ status: 200, body: '{}' })
const aborting: Transport = (_request, signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

const makeService = (options: ConstructorParameters<typeof DownloadService>[0] = {}) => new DownloadService({
  ...options,
  transport: options.transport ?? ok,
})

describe('download request isolation', () => {
  it('keeps another source successful when a source fails', async () => {
    const service = makeService({ parse: parsed, transport: async (request, signal) => {
      if (request.source === 'bangumi') throw new Error('synthetic transport failure')
      return ok(request, signal)
    } })
    const results = await Promise.all([service.resources(query), service.resources({ ...query, source: 'acgrip' })])
    expect(results.map(result => result.status.kind)).toEqual(['error', 'success'])
    expect(JSON.stringify(results)).not.toContain('synthetic transport failure')
    service.dispose()
  })

  it('caches briefly, isolates query keys and refreshes without sharing mutable objects', async () => {
    let now = 100000
    const transport = vi.fn(ok)
    const service = makeService({ parse: parsed, transport, now: () => now, cacheMs: 1000 })
    const first = await service.resources(query)
    first.resources.push({} as never)
    expect((await service.resources(query)).resources).toEqual([])
    expect(transport).toHaveBeenCalledTimes(1)
    await service.resources({ ...query, keyword: 'other' })
    await service.resources({ ...query, refresh: true })
    now += 1100
    await service.resources(query)
    expect(transport).toHaveBeenCalledTimes(4)
    service.dispose()
  })

  it('binds cursors and cache requests to each built-in source, keyword and origin', async () => {
    const transport = vi.fn(ok)
    const service = makeService({ parse: parsed, transport })
    const cursor = encodeCursor('bangumi', 'same', 2, BANGUMI_ROOT)
    const first = await service.resources({ source: 'bangumi', keyword: 'same', cursor })
    expect(first.status.kind).toBe('success')
    expect(transport.mock.calls[0][0]).toMatchObject({ source: 'bangumi', baseUrl: BANGUMI_ROOT })
    await expect(service.resources({ source: 'bangumi', keyword: 'other', cursor })).rejects.toThrow()
    await expect(service.resources({ source: 'acgrip', keyword: 'same', cursor })).rejects.toThrow()
    await service.resources({ source: 'acgrip', keyword: 'same' })
    expect(transport.mock.calls.some(([request]) => request.baseUrl === ACG_ROOT)).toBe(true)
    service.dispose()
  })

  it('honors Retry-After across keyword, refresh and cursor requests without blocking other sources', async () => {
    let now = 100000
    const transport = vi.fn<Transport>(async () => ({ status: 429, body: '', retryAfter: '120' }))
    const service = makeService({ parse: parsed, transport, now: () => now })
    const first = await service.resources(query)
    expect(first.status).toMatchObject({ kind: 'rate_limited', retryAt: new Date(220000).toISOString() })
    await service.resources({ ...query, keyword: 'new', refresh: true })
    expect(transport).toHaveBeenCalledTimes(1)
    now = 220001
    await service.resources(query)
    expect(transport).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('times out and releases the source slot', async () => {
    const transport = vi.fn(aborting).mockImplementationOnce(aborting).mockImplementation(ok)
    const service = makeService({ parse: parsed, transport, timeoutMs: 20 })
    expect((await service.resources(query)).status.code).toBe('timeout')
    expect((await service.resources(query)).status.kind).toBe('success')
    service.dispose()
  })

  it('cancels active and queued work and refuses work after disposal', async () => {
    const transport = vi.fn(aborting)
    const service = makeService({ parse: parsed, transport })
    const controller = new AbortController()
    const active = service.resources(query, controller.signal)
    const queued = service.resources({ ...query, keyword: 'next' })
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(active).rejects.toMatchObject({ name: 'AbortError' })
    service.dispose()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    await expect(service.resources(query)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('limits concurrent requests globally and to one per source', async () => {
    let active = 0, peak = 0
    const seen = new Set<string>()
    const service = makeService({ parse: parsed, maxConcurrent: 2, transport: async request => {
      expect(seen.has(request.source)).toBe(false)
      seen.add(request.source); active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--; seen.delete(request.source)
      return { status: 200, body: '{}' }
    } })
    await Promise.all(['bangumi', 'acgrip', 'dmhy', 'nyaa', 'bangumi'].map(source => service.resources({ ...query, source: source as ResourceQuery['source'], refresh: true })))
    expect(peak).toBe(2)
    service.dispose()
  })

  it('gives a queued source its own network timeout after admission', async () => {
    const service = makeService({ parse: parsed, maxConcurrent: 1, timeoutMs: 35, transport: async () => {
      await new Promise(resolve => setTimeout(resolve, 24))
      return { status: 200, body: '{}' }
    } })
    const results = await Promise.all([service.resources(query), service.resources({ ...query, source: 'dmhy' })])
    expect(results.map(result => result.status.kind)).toEqual(['success', 'success'])
    service.dispose()
  })

  it('does not cache late success after cancellation or module shutdown', async () => {
    let finish!: () => void
    const transport = vi.fn<Transport>().mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { status: 200, body: '{}' }
    }).mockImplementation(ok)
    const service = makeService({ parse: parsed, transport })
    const controller = new AbortController()
    const pending = service.resources(query, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort(); finish()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await service.resources(query)
    expect(transport).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('distinguishes verification and parse failures from true empty results', async () => {
    const service = makeService({ transport: async request => ({
      status: 200,
      body: request.source === 'bangumi' ? '<title>Just a moment...</title>' : '<h1>Unknown structure</h1>',
    }) })
    expect((await service.resources(query)).status.kind).toBe('restricted')
    expect((await service.resources({ ...query, source: 'acgrip' })).status.code).toBe('parse')
    expect((await service.resources({ ...query, source: 'dmhy' })).status.code).toBe('parse')
    service.dispose()
  })

  it('honors HTTP-date Retry-After and never falls back to RSS for a 429', async () => {
    const now = Date.UTC(2026, 8, 10, 4)
    const until = now + 120000
    const transport = vi.fn<Transport>(async () => ({ status: 429, body: '', retryAfter: new Date(until).toUTCString() }))
    const service = makeService({ transport, now: () => now })
    expect((await service.resources({ ...query, source: 'nyaa' })).status.retryAt).toBe(new Date(until).toISOString())
    expect(transport).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('preserves the ACG.RIP collection-page context while merging injected parser results', async () => {
    let calls = 0
    const resource = (id: string): DownloadResource => ({
      source: 'acgrip', id, title: '[Group] The Bad Batch - 03 [1080p]',
      detailUrl: `${ACG_ROOT}t/${id}`, group: null, size: null,
      publishedAt: null, seeders: null, isCollection: false,
    })
    const service = makeService({
      transport: ok,
      parse: () => ({ resources: ++calls === 1 ? [resource('shared'), resource('anime')] : [resource('shared')], nextPage: null }),
    })
    const page = await service.resources({ source: 'acgrip', keyword: 'Bad Batch' })
    expect(page.resources.find(item => item.id === 'shared')?.isCollection).toBe(true)
    expect(page.resources.find(item => item.id === 'anime')?.isCollection).toBe(false)
    service.dispose()
  })
})
