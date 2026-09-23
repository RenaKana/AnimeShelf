import { afterEach, describe, expect, it, vi } from 'vitest'
import { restartService } from '../../../src/lib/serviceRestart'

const health = (instanceId = 'before') => ({ ok: true, instanceId, restartSupported: true })
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('service restart client', () => {
  it('sends one owner request and waits past old or unavailable health until a new instance is ready', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(health()))
      .mockResolvedValueOnce(json({ instanceId: 'before' }, 202))
      .mockResolvedValueOnce(json(health()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'starting' }, 503))
      .mockResolvedValueOnce(json(health('after')))
    vi.stubGlobal('fetch', fetch)
    const accepted = vi.fn()
    const finished = vi.fn()
    const operation = restartService({ signal: new AbortController().signal, onAccepted: accepted }).then(finished)
    await vi.advanceTimersByTimeAsync(500)
    expect(accepted).toHaveBeenCalledOnce()
    expect(finished).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    await operation
    expect(finished).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith('/api/service/restart', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' },
    }))
    expect(fetch.mock.calls.filter(([url]) => url === '/api/health').every(([, options]) => options.cache === 'no-store')).toBe(true)
  })

  it('reports an owner rejection without waiting or retrying the restart', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(health())).mockResolvedValueOnce(json({ error: '仅允许本机所有者重启服务' }, 403))
    vi.stubGlobal('fetch', fetch)
    await expect(restartService({ signal: new AbortController().signal })).rejects.toThrow('仅允许本机所有者重启服务')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('continues checking health when the restart acknowledgement is lost', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(json(health())).mockRejectedValueOnce(new TypeError('connection closed')).mockResolvedValueOnce(json(health('after')))
    vi.stubGlobal('fetch', fetch)
    const operation = restartService({ signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(1000)
    await operation
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('gives an actionable message for a server that predates restart support', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    await expect(restartService({ signal: new AbortController().signal })).rejects.toThrow('手动重启一次')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops polling when the page unmounts', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue(json(health()))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const operation = restartService({ signal: controller.signal })
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()
    await rejection
    const calls = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('times out if only the old instance ever answers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(health())))
    const operation = restartService({ signal: new AbortController().signal })
    const rejection = expect(operation).rejects.toThrow('未能确认服务重启完成')
    await vi.advanceTimersByTimeAsync(125_000)
    await rejection
  })
})
