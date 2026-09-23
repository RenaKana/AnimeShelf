import { beforeEach, describe, expect, it, vi } from 'vitest'
import { version } from '../../../package.json'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), setting: vi.fn(),
  proxy: vi.fn(), fallbacks: vi.fn(),
}))
vi.mock('axios', () => ({ default: { create: () => ({ get: mocks.get, post: mocks.post }) } }))
vi.mock('../../../server/db/instance', () => ({ db: undefined, settingsDb: { get: mocks.setting } }))
vi.mock('../../../server/services/proxy', () => ({ getProxy: mocks.proxy, getLocalProxyFallbacks: mocks.fallbacks }))

import { getBangumiDetail, searchBangumi } from '../server/metadata'

const expectedAgent = `Rena/AnimeShelf/${version}`
const detail = { data: { id: 7, type: 2, name: 'Synthetic', eps: 12 } }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.setting.mockReturnValue(null)
  mocks.proxy.mockReturnValue(null)
  mocks.fallbacks.mockReturnValue([])
  mocks.get.mockResolvedValue(detail)
  mocks.post.mockResolvedValue({ data: { data: [] } })
})

describe('Bangumi application identity', () => {
  it.each([null, 'synthetic-bangumi-token'])('identifies search and detail with optional authentication: %s', async token => {
    mocks.setting.mockImplementation(key => key === 'bangumi_token' ? token : null)
    await searchBangumi('Synthetic')
    await getBangumiDetail(7)
    const configs = [mocks.post.mock.calls[0][2], mocks.get.mock.calls[0][1]]
    for (const config of configs) {
      expect(config.headers['User-Agent']).toBe(expectedAgent)
      expect(config.headers['User-Agent']).not.toContain('synthetic-bangumi-token')
      if (token) expect(config.headers.Authorization).toBe(`Bearer ${token}`)
      else expect(config.headers).not.toHaveProperty('Authorization')
    }
  })

  it('keeps identity, cancellation and response limits on the legacy search fallback', async () => {
    const controller = new AbortController()
    mocks.post.mockRejectedValue({ response: { status: 404 } })
    mocks.get.mockResolvedValue({ data: { list: [] } })
    await searchBangumi('Synthetic', { signal: controller.signal, maxResponseBytes: 1024 })
    for (const config of [mocks.post.mock.calls[0][2], mocks.get.mock.calls[0][1]]) {
      expect(config).toMatchObject({ headers: { 'User-Agent': expectedAgent }, signal: controller.signal, maxContentLength: 1024 })
    }
  })

  it('keeps the same identity for a normal connection-error proxy fallback', async () => {
    const proxy = { protocol: 'http', host: '127.0.0.1', port: 7897 }
    mocks.fallbacks.mockReturnValue([proxy])
    mocks.get.mockRejectedValueOnce(Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }))
    await getBangumiDetail(7)
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.get.mock.calls[0][1]).toMatchObject({ proxy: false, headers: { 'User-Agent': expectedAgent } })
    expect(mocks.get.mock.calls[1][1]).toMatchObject({ proxy, headers: { 'User-Agent': expectedAgent } })
  })

  it('does not use the identity change to retry a 429 through a proxy or legacy API', async () => {
    mocks.fallbacks.mockReturnValue([{ protocol: 'http', host: '127.0.0.1', port: 7897 }])
    mocks.post.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': '10' } } })
    await expect(searchBangumi('Synthetic')).rejects.toMatchObject({ response: { status: 429 } })
    expect(mocks.post).toHaveBeenCalledOnce()
    expect(mocks.post.mock.calls[0][2].headers['User-Agent']).toBe(expectedAgent)
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
