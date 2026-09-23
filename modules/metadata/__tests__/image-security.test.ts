import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockDnsLookup = vi.hoisted(() => vi.fn())
const mockGet = vi.hoisted(() => vi.fn())
const mockLocalProxyFallbacks = vi.hoisted(() => vi.fn())
const mockImageProxy = vi.hoisted(() => vi.fn())
vi.mock('../../../server/services/image-proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/image-proxy')>(),
  getImageProxy: mockImageProxy,
}))

vi.mock('node:dns/promises', () => ({ lookup: mockDnsLookup }))
vi.mock('../../../server/db/instance', () => ({ db: undefined, settingsDb: { get: vi.fn(() => null) } }))
vi.mock('../../../server/services/proxy', () => ({
  getProxy: vi.fn(() => null),
  getLocalProxyFallbacks: mockLocalProxyFallbacks,
}))
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: mockGet,
    create: vi.fn(() => ({ post: vi.fn(), get: mockGet, defaults: {} })),
  },
}))

import { cachePoster, fetchRemoteImage, isValidPosterImage } from '../server/metadata'

const JPEG_IMAGE = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//9k=', 'base64')

describe('remote image download security', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    mockDnsLookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockGet.mockReset()
    mockImageProxy.mockReset().mockReturnValue(null)
    mockLocalProxyFallbacks.mockReset().mockReturnValue([])
  })

  it('rejects non-http URLs and URLs carrying credentials before DNS or HTTP', async () => {
    for (const url of ['file:///tmp/poster.jpg', 'ftp://example.com/poster.jpg', 'https://user:secret@example.com/poster.jpg']) {
      await expect(fetchRemoteImage(url)).rejects.toThrow()
    }
    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('rejects literal private, loopback, link-local, reserved, and IPv4-mapped addresses', async () => {
    const urls = [
      'http://10.0.0.1/poster.jpg',
      'http://172.16.0.1/poster.jpg',
      'http://192.168.1.1/poster.jpg',
      'http://169.254.169.254/poster.jpg',
      'http://127.0.0.1/poster.jpg',
      'http://0.0.0.0/poster.jpg',
      'http://[::1]/poster.jpg',
      'http://[fe80::1]/poster.jpg',
      'http://[fc00::1]/poster.jpg',
      'http://[::ffff:127.0.0.1]/poster.jpg',
    ]

    for (const url of urls) await expect(fetchRemoteImage(url), url).rejects.toThrow(/不允许/)
    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('rejects a hostname that resolves to a private address or cannot be resolved', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '192.168.10.20', family: 4 }])
    await expect(fetchRemoteImage('https://private.example.test/poster.jpg')).rejects.toThrow(/私人/)

    mockDnsLookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    await expect(fetchRemoteImage('https://unresolved.example.test/poster.jpg')).rejects.toThrow(/无法解析/)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('bounds redirects, response size, and keeps the download timeout', async () => {
    mockGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://127.0.0.1/private.jpg' },
      data: JPEG_IMAGE,
    })
    await expect(fetchRemoteImage('https://redirect.example.test/poster.jpg')).rejects.toThrow()
    expect(mockGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, timeout: 6000 })

    mockGet.mockReset().mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(32 * 1024 * 1024 + 1) },
      data: JPEG_IMAGE,
    })
    await expect(fetchRemoteImage('https://oversized.example.test/poster.jpg')).rejects.toThrow(/过大/)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized chunked response bodies without a trustworthy Content-Length and leaves no cache file', async () => {
    const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-stream-limit-'))
    const oversizedBody = Buffer.concat([Buffer.alloc(32 * 1024 * 1024), Buffer.from([0])])
    try {
      for (const [url, headers, id] of [
        ['https://chunked-no-length.example.test/poster.jpg', { 'content-type': 'image/jpeg' }, 'chunked_no_length'],
        ['https://chunked-fake-length.example.test/poster.jpg', { 'content-type': 'image/jpeg', 'content-length': '1' }, 'chunked_fake_length'],
      ] as const) {
        mockGet.mockResolvedValueOnce({ status: 200, headers, data: oversizedBody })
        await expect(cachePoster(url, id, { directory: posterDir, force: true })).resolves.toBeNull()
        expect(fs.existsSync(path.join(posterDir, `${id}.jpg`))).toBe(false)
      }
      expect(mockGet).toHaveBeenCalledTimes(2)
    } finally {
      fs.rmSync(posterDir, { recursive: true, force: true })
    }
  })

  it('accepts a valid public image while enforcing the response limits', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG_IMAGE.length) },
      data: JPEG_IMAGE,
    })

    const result = await fetchRemoteImage('https://public.example.test/poster.jpg')
    expect(result.data).toEqual(JPEG_IMAGE)
    expect(result.contentType).toBe('image/jpeg')
    expect(mockGet.mock.calls[0][1]).toMatchObject({
      responseType: 'arraybuffer',
      maxContentLength: 32 * 1024 * 1024,
      maxBodyLength: 32 * 1024 * 1024,
      maxRedirects: 0,
      timeout: 6000,
      proxy: false,
    })
  })

  it('rejects an already-aborted request before DNS, including a valid cache hit', async () => {
    const url = 'https://aborted-cache.example.test/poster.jpg'
    mockGet.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG_IMAGE.length) },
      data: JPEG_IMAGE,
    })
    await expect(fetchRemoteImage(url)).resolves.toMatchObject({ data: JPEG_IMAGE })

    const controller = new AbortController()
    controller.abort()
    mockDnsLookup.mockClear()
    mockGet.mockClear()
    await expect(fetchRemoteImage(url, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('times out a DNS lookup that never resolves without creating an HTTP request', async () => {
    vi.useFakeTimers()
    mockDnsLookup.mockReturnValueOnce(new Promise(() => {}))
    const pending = fetchRemoteImage('https://dns-timeout.example.test/poster.jpg')
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(6000)
    await assertion
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('does not create an HTTP request when DNS resolves after the caller aborts', async () => {
    let resolveDns!: (addresses: Array<{ address: string; family: number }>) => void
    mockDnsLookup.mockReturnValueOnce(new Promise(resolve => { resolveDns = resolve }))
    const controller = new AbortController()
    const pending = fetchRemoteImage('https://late-dns.example.test/poster.jpg', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resolveDns([{ address: '93.184.216.34', family: 4 }])
    await Promise.resolve()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('passes the shared abort signal to a slow image request and aborts the stream', async () => {
    let rejectRequest!: (error: Error) => void
    mockGet.mockImplementationOnce((_url: string, config: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      rejectRequest = reject
      config.signal.addEventListener('abort', () => rejectRequest(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
    }))
    const controller = new AbortController()
    const pending = fetchRemoteImage('https://slow-stream.example.test/poster.jpg', { signal: controller.signal })
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockGet.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(mockGet.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('cleans the absolute timeout and external abort listener after success, error, and abort', async () => {
    vi.useFakeTimers()

    const successController = new AbortController()
    const successRemove = vi.spyOn(successController.signal, 'removeEventListener')
    mockGet.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'image/jpeg' }, data: JPEG_IMAGE })
    await expect(fetchRemoteImage('https://cleanup-success.example.test/poster.jpg', { signal: successController.signal })).resolves.toMatchObject({ data: JPEG_IMAGE })
    expect(successRemove).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    const errorController = new AbortController()
    const errorRemove = vi.spyOn(errorController.signal, 'removeEventListener')
    mockGet.mockRejectedValueOnce(new Error('offline'))
    await expect(fetchRemoteImage('https://cleanup-error.example.test/poster.jpg', { signal: errorController.signal })).rejects.toThrow(/代理路径被拒绝|offline/)
    expect(errorRemove).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    const abortController = new AbortController()
    const abortRemove = vi.spyOn(abortController.signal, 'removeEventListener')
    mockGet.mockClear()
    mockGet.mockImplementationOnce((_url: string, config: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      config.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
    }))
    const pending = fetchRemoteImage('https://cleanup-abort.example.test/poster.jpg', { signal: abortController.signal })
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    abortController.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(abortRemove).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a failed direct request through an unpinned proxy', async () => {
    mockLocalProxyFallbacks.mockReturnValue([{ protocol: 'http', host: '127.0.0.1', port: 7897 }])
    mockGet.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))

    await expect(fetchRemoteImage('https://proxy-fallback.example.test/poster.jpg')).rejects.toThrow('connection reset')
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0][1]).toMatchObject({ proxy: false })
  })

  it('rejects JPEGs whose decoded dimensions exceed the memory budget', () => {
    const oversized = Buffer.from(JPEG_IMAGE)
    const sof = oversized.indexOf(Buffer.from([0xff, 0xc0]))
    expect(sof).toBeGreaterThanOrEqual(0)
    oversized.writeUInt16BE(20_000, sof + 5)
    oversized.writeUInt16BE(20_000, sof + 7)
    expect(isValidPosterImage(oversized)).toBe(false)
  })

  it('uses configured CONNECT only for built-in CDNs, without resolving fake IPs locally', async () => {
    mockImageProxy.mockReturnValue('http://127.0.0.1:7890')
    mockDnsLookup.mockResolvedValue([{ address: '198.18.0.43', family: 4 }])
    mockGet.mockResolvedValue({ status: 200, headers: { 'content-type': 'image/jpeg' }, data: JPEG_IMAGE })
    await expect(fetchRemoteImage('https://lain.bgm.tv/test-proxy.jpg', { force: true })).resolves.toMatchObject({ data: JPEG_IMAGE })
    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(mockGet.mock.calls[0][1]).toMatchObject({ proxy: false, maxRedirects: 0, timeout: 6000, httpsAgent: expect.anything() })
    expect(mockGet.mock.calls[0][1]).not.toHaveProperty('lookup')
    await expect(fetchRemoteImage('https://not-a-cdn.test/test.jpg')).rejects.toThrow(/私人/)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('never falls back around a CDN certificate error or redirect and preserves existing cache', async () => {
    mockImageProxy.mockReturnValue('http://127.0.0.1:7890')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-certificate-'))
    try {
      const file = path.join(directory, 'bg_99.jpg')
      fs.writeFileSync(file, JPEG_IMAGE)
      mockGet.mockRejectedValueOnce(Object.assign(new Error('certificate failed'), { code: 'CERT_HAS_EXPIRED' }))
      await expect(cachePoster('https://lain.bgm.tv/cert.jpg', 'bg_99', { directory, force: true, throwOnError: true })).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' })
      expect(fs.readFileSync(file)).toEqual(JPEG_IMAGE)
      expect(mockGet).toHaveBeenCalledTimes(1)
      mockGet.mockResolvedValueOnce({ status: 302, headers: { location: 'http://127.0.0.1/private' }, data: JPEG_IMAGE })
      await expect(fetchRemoteImage('https://lain.bgm.tv/redirect.jpg', { force: true })).rejects.toThrow()
      expect(mockGet).toHaveBeenCalledTimes(2)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
})
