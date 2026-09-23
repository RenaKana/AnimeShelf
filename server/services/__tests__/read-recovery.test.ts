import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, request } from '../../../src/api'
import { getRecoveringReadCount, recoverRead, subscribeToReadRecovery } from '../../../src/lib/readRecovery'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('local API read recovery', () => {
  it('recovers libraries, appearance settings, and media after transient proxy and connection failures', async () => {
    const counts = new Map<string, number>()
    const fetch = vi.fn(async (url: string) => {
      const count = (counts.get(url) ?? 0) + 1
      counts.set(url, count)
      if (count === 1) return new Response('', { status: 500 }) // Vite ECONNREFUSED
      if (count === 2) throw new TypeError('Failed to fetch')
      if (count === 3) return json({ error: 'starting' }, 503)
      return json(url === '/api/settings' ? { background_type: 'image' } : [{ id: 1 }])
    })
    vi.stubGlobal('fetch', fetch)
    const result = Promise.all([
      recoverRead(signal => api.libraries.list(signal)),
      recoverRead(signal => api.settings.get(signal)),
      recoverRead(signal => api.folders.list({}, signal)),
    ])
    const expectation = expect(result).resolves.toEqual([[{ id: 1 }], { background_type: 'image' }, [{ id: 1 }]])
    void expectation.catch(() => {})
    await vi.advanceTimersByTimeAsync(7000)
    await expectation
    expect([...counts.values()]).toEqual([4, 4, 4])
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never replays a failed %s mutation', async method => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetch)
    await expect(request('/api/libraries/1', { method })).rejects.toThrow('Failed to fetch')
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([400, 401, 403, 404, 409, 500])('reports application errors (%s) without a retry loop', async status => {
    const fetch = vi.fn().mockResolvedValue(json({ error: 'read rejected', code: 'READ_REJECTED' }, status))
    vi.stubGlobal('fetch', fetch)
    await expect(recoverRead(signal => api.libraries.list(signal))).rejects.toMatchObject({ status, code: 'READ_REJECTED' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([null, 'denied', 0])('does not mistake a non-object error body (%s) for a transport failure', async body => {
    const fetch = vi.fn().mockResolvedValue(json(body, 403))
    vi.stubGlobal('fetch', fetch)
    await expect(recoverRead(signal => api.libraries.list(signal))).rejects.toMatchObject({ status: 403 })
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retains a pending read through a long outage with capped backoff and clears the connection notice', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetch)
    const changed = vi.fn()
    const unsubscribe = subscribeToReadRecovery(changed)
    const operation = recoverRead(signal => api.libraries.list(signal))
    await vi.advanceTimersByTimeAsync(180000)
    expect(getRecoveringReadCount()).toBe(1)
    expect(fetch.mock.calls.length).toBeLessThan(12)
    fetch.mockResolvedValue(json([{ id: 1 }]))
    await vi.advanceTimersByTimeAsync(30000)
    await expect(operation).resolves.toEqual([{ id: 1 }])
    expect(getRecoveringReadCount()).toBe(0)
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('cancels retries when a view unmounts or its filter changes', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const operation = recoverRead(signal => api.folders.list({}, signal), controller.signal)
    const stopped = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    await stopped
    const count = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(count)
    expect(getRecoveringReadCount()).toBe(0)
  })

  it('aborts a stalled read attempt and recovers instead of leaving loading stuck', async () => {
    const fetch = vi.fn().mockImplementationOnce((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })).mockResolvedValue(json([{ id: 1 }]))
    vi.stubGlobal('fetch', fetch)
    const operation = recoverRead(signal => api.libraries.list(signal))
    await vi.advanceTimersByTimeAsync(11000)
    await expect(operation).resolves.toEqual([{ id: 1 }])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(getRecoveringReadCount()).toBe(0)
  })

  it('pauses hidden-tab retries and coalesces visibility, focus, and online wakeups', async () => {
    const browser = new EventTarget()
    const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', page)
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(json([{ id: 1 }]))
    vi.stubGlobal('fetch', fetch)
    const operation = recoverRead(signal => api.libraries.list(signal))
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledOnce()
    browser.dispatchEvent(new Event('focus'))
    expect(fetch).toHaveBeenCalledOnce()
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    browser.dispatchEvent(new Event('focus'))
    browser.dispatchEvent(new Event('online'))
    await expect(operation).resolves.toEqual([{ id: 1 }])
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(getRecoveringReadCount()).toBe(0)
  })
})
