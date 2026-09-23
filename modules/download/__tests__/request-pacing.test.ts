import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRequest, ParseError } from '../server/adapters'
import { DownloadRequestPacer } from '../server/request-pacing'
import { createTransport } from '../server/transport'
import { DownloadService } from '../server/service'
import type { PinnedSend } from '../server/network'

const request = buildRequest('nyaa', 'Synthetic', 1, 'https://nyaa.si/')
const query = { source: 'nyaa' as const, keyword: 'Synthetic' }
const parse = () => ({ resources: [], nextPage: 2 })
const signal = () => new AbortController().signal

function harness() {
  const attempts: Array<{ source: string; time: number; url: string }> = []
  const response = vi.fn<PinnedSend>().mockResolvedValue({ status: 200, body: 'list' })
  const send: PinnedSend = (url, request, address, signal) => {
    attempts.push({ source: request.source, time: Date.now(), url: url.href })
    return response(url, request, address, signal)
  }
  const options = {
    send,
    resolve: vi.fn().mockResolvedValue({ address: '8.8.8.8', family: 4 }),
    proxy: () => null,
  }
  const pacer = new DownloadRequestPacer(() => Date.now())
  return { attempts, response, options, transport: createTransport({ ...options, pacer }) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('Nyaa HTTP request spacing', () => {
  it('paces refresh, pagination and changed keywords while cached pages make no HTTP request', async () => {
    const { transport, attempts } = harness()
    const service = new DownloadService({ transport, parse })
    const first = await service.resources(query)
    expect((await service.resources(query)).cached).toBe(true)
    expect(attempts).toHaveLength(1)
    for (const [index, next] of [
      { ...query, refresh: true },
      { ...query, cursor: first.nextCursor! },
      { ...query, keyword: 'Changed' },
    ].entries()) {
      const pending = service.resources(next)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(attempts).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect((await pending).status.kind).toBe('success')
    }
    expect(attempts.map(item => item.time)).toEqual([0, 5_000, 10_000, 15_000])
    service.dispose()
  })

  it('waits before the HTML-to-RSS fallback instead of sending both immediately', async () => {
    const { transport, attempts, response } = harness()
    response.mockImplementation(async url => ({ status: 200, body: url.searchParams.has('page') ? 'rss' : 'html' }))
    const service = new DownloadService({ transport, parse: (_source, body) => {
      if (body === 'html') throw new ParseError()
      return { resources: [], nextPage: null }
    } })
    const pending = service.resources(query)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status.kind).toBe('success')
    expect(attempts.map(item => item.time)).toEqual([0, 5_000])
    expect(new URL(attempts[1].url).searchParams.get('page')).toBe('rss')
    service.dispose()
  })

  it('paces each allowed redirect hop at the actual sender', async () => {
    const { transport, attempts, response } = harness()
    response.mockResolvedValueOnce({ status: 302, body: '', location: request.url })
    const pending = transport(request, signal())
    await vi.advanceTimersByTimeAsync(4_999)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ status: 200 })
    expect(attempts.map(item => item.time)).toEqual([0, 5_000])
  })

  it('shares the production gate across replacement service and transport instances', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    const { options, attempts } = harness()
    const first = new DownloadService({ transport: createTransport(options), parse })
    await first.resources(query)
    first.dispose()
    const second = new DownloadService({ transport: createTransport(options), parse })
    const pending = second.resources(query)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status.kind).toBe('success')
    expect(attempts.map(item => item.time)).toEqual([0, 5_000])
    second.dispose()
  })

  it('cancels a queued attempt promptly without consuming the next slot or leaving timers', async () => {
    const { transport, attempts } = harness()
    await transport(request, signal())
    const controller = new AbortController()
    const cancelled = expect(transport(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const next = transport(request, signal())
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    await cancelled
    await vi.advanceTimersByTimeAsync(4_000)
    await next
    expect(attempts.map(item => item.time)).toEqual([0, 5_000])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'caller', 'dispose'] as const)('does not send queued work after %s', async reason => {
    const { transport, attempts } = harness()
    const service = new DownloadService({ transport, parse, timeoutMs: reason === 'timeout' ? 1_000 : 18_000 })
    await service.resources(query)
    const controller = new AbortController()
    const pending = service.resources({ ...query, refresh: true }, controller.signal)
    const checked = reason === 'timeout'
      ? expect(pending).resolves.toMatchObject({ status: { code: 'timeout' } })
      : expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(500)
    if (reason === 'caller') controller.abort()
    if (reason === 'dispose') service.dispose()
    await vi.advanceTimersByTimeAsync(500)
    await checked
    await vi.advanceTimersByTimeAsync(5_000)
    expect(attempts).toHaveLength(1)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not delay a different source while Nyaa is waiting', async () => {
    const { transport, attempts } = harness()
    await transport(request, signal())
    const pending = transport(request, signal())
    await transport(buildRequest('dmhy', '', 1, 'https://share.dmhy.org/'), signal())
    expect(attempts.map(item => [item.source, item.time])).toEqual([['nyaa', 0], ['dmhy', 0]])
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(attempts[2]).toMatchObject({ source: 'nyaa', time: 5_000 })
  })

  it('still honors a longer Retry-After without trying RSS or issuing another request', async () => {
    const { transport, attempts, response } = harness()
    response.mockResolvedValueOnce({ status: 429, body: '', retryAfter: '12' })
    const service = new DownloadService({ transport, parse })
    expect((await service.resources(query)).status.kind).toBe('rate_limited')
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await service.resources({ ...query, refresh: true })).status.kind).toBe('rate_limited')
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(7_000)
    expect((await service.resources(query)).status.kind).toBe('success')
    expect(attempts.map(item => item.time)).toEqual([0, 12_000])
    service.dispose()
  })

  it('keeps the interval after a failed HTTP attempt', async () => {
    const { transport, attempts, response } = harness()
    response.mockRejectedValueOnce(new Error('synthetic offline'))
    await expect(transport(request, signal())).rejects.toThrow('synthetic offline')
    const pending = transport(request, signal())
    await vi.advanceTimersByTimeAsync(4_999)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(attempts.map(item => item.time)).toEqual([0, 5_000])
  })
})
