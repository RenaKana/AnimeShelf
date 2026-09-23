import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { decodeCursor, detailUrl, encodeCursor, parseQuery, requestUrl } from '../server/security'
import { createTransport } from '../server/transport'
import { resolvePublic } from '../server/network'
import { safeDetailUrl, safeSourceUrl } from '../client/links'
import { TEST_SOURCE_URLS } from './test-helpers'

const require = createRequire(import.meta.url)
const { externalHttpsUrl, installExternalLinks } = require('../../../electron/external-links.cjs')

const cursorOrigin = 'https://bangumi.moe/'
const builtinAcgOrigin = 'https://acg.rip/'

describe('download URL and input boundaries', () => {
  it('rejects unknown/duplicate source, malformed keyword, retired revision input and cross-query cursors', () => {
    for (const source of ['https://localhost/', ['bangumi', 'nyaa'], '__proto__', 'toString']) expect(() => parseQuery({ source })).toThrow()
    expect(() => parseQuery({ source: 'bangumi', keyword: ['x'] })).toThrow()
    expect(() => parseQuery({ source: 'bangumi', keyword: 'a\nsecret' })).toThrow()
    expect(() => parseQuery({ source: 'bangumi', keyword: 'x'.repeat(201) })).toThrow()
    expect(() => parseQuery({ source: 'bangumi', keyword: 'Sample', revision: cursorOrigin })).toThrow()
    const cursor = encodeCursor('bangumi', '古見さん', 2, cursorOrigin)
    expect(decodeCursor({ source: 'bangumi', keyword: '古見さん', cursor }, cursorOrigin)).toBe(2)
    expect(() => decodeCursor({ source: 'nyaa', keyword: '古見さん', cursor }, cursorOrigin)).toThrow()
    expect(() => decodeCursor({ source: 'bangumi', keyword: 'Komi', cursor }, cursorOrigin)).toThrow()
    expect(() => decodeCursor({ source: 'bangumi', keyword: '古見さん', cursor }, 'https://bangumi-new.example/')).toThrow()
  })

  it('allows only configured-site HTTPS detail and list paths', () => {
    const base = TEST_SOURCE_URLS.acgrip
    expect(detailUrl('acgrip', '/t/123', base)).toBe(`${base}t/123`)
    for (const raw of ['http://acgrip.example/t/123', 'https://acgrip.example.evil.com/t/123', '//evil.com/t/123', 'https://user@acgrip.example/t/123', 'https://acgrip.example:444/t/123', 'javascript:alert(1)', '/t/123?redirect=https://evil.example', '/t/123#x', '/t/123.torrent', '/t/123\\x']) {
      expect(detailUrl('acgrip', raw, base), raw).toBeNull()
    }
    expect(() => requestUrl('bangumi', 'https://bangumi.example/api/user/login', 'POST', TEST_SOURCE_URLS.bangumi)).toThrow()
    expect(() => requestUrl('acgrip', 'https://acgrip.example/?url=http://localhost', 'GET', base)).toThrow()
    expect(() => requestUrl('acgrip', 'https://acgrip.example/', 'GET', base)).toThrow()
    expect(safeSourceUrl(base)).toBe(base)
    for (const escape of ['%2F', '%5c', '%00', '%0a', '%7f', '%252F']) {
      const url = `${TEST_SOURCE_URLS.dmhy}topics/view/123_x${escape}admin.html`
      expect(detailUrl('dmhy', url, TEST_SOURCE_URLS.dmhy)).toBeNull()
      expect(safeDetailUrl('dmhy', url, TEST_SOURCE_URLS.dmhy)).toBeNull()
    }
  })

  it('rejects configured proxy paths before any direct request', async () => {
    const send = vi.fn()
    const resolve = vi.fn()
    const proxy = vi.fn(() => ({ protocol: 'http' as const, host: '127.0.0.1', port: 7897 }))
    const transport = createTransport({ send: send as never, resolve: resolve as never, proxy })
    await expect(transport({ source: 'acgrip', baseUrl: builtinAcgOrigin, url: `${builtinAcgOrigin}1`, method: 'GET' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'proxy_unsupported' })
    expect(send).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(proxy).toHaveBeenCalledOnce()
  })

  it('rejects a substituted origin before DNS, proxy selection or network access', async () => {
    const send = vi.fn(), resolve = vi.fn(), proxy = vi.fn(() => null)
    const transport = createTransport({ send: send as never, resolve: resolve as never, proxy })
    await expect(transport({ source: 'acgrip', baseUrl: 'https://alternate.example/',
      url: 'https://alternate.example/1', method: 'GET' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unsafe_target' })
    expect(resolve).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(() => parseQuery({ source: 'acgrip', url: 'https://alternate.example/' })).toThrow()
  })

  it('validates each redirect before another network request', async () => {
    const send = vi.fn().mockResolvedValue({ status: 302, body: '', location: 'http://127.0.0.1/private' })
    const resolve = vi.fn().mockResolvedValue({ address: '93.184.216.34', family: 4 })
    const transport = createTransport({ send: send as never, resolve: resolve as never, proxy: () => null })
    await expect(transport({ source: 'acgrip', baseUrl: builtinAcgOrigin, url: `${builtinAcgOrigin}1`, method: 'GET' }, new AbortController().signal)).rejects.toThrow()
    expect(send).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('accepts a same-site allowed redirect and rejects a same-host non-list path', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ status: 302, body: '', location: '/1?term=Komi' })
      .mockResolvedValueOnce({ status: 200, body: 'list' })
    const resolve = vi.fn().mockResolvedValue({ address: '93.184.216.34', family: 4 })
    const request = { source: 'acgrip' as const, baseUrl: builtinAcgOrigin, url: `${builtinAcgOrigin}1?term=Komi`, method: 'GET' as const }
    expect(await createTransport({ send: send as never, resolve: resolve as never, proxy: () => null })(request, new AbortController().signal)).toMatchObject({ body: 'list' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(() => requestUrl('acgrip', 'https://acgrip.example/t/123.torrent', 'GET', TEST_SOURCE_URLS.acgrip)).toThrow()

    const refused = vi.fn().mockResolvedValue({ status: 302, body: '', location: '/t/123' })
    await expect(createTransport({ send: refused as never, resolve: resolve as never, proxy: () => null })(request, new AbortController().signal)).rejects.toThrow()
    expect(refused).toHaveBeenCalledOnce()
  })

  it('checks every DNS answer and supports cancellation without connecting', async () => {
    const mixedLookup = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.20', family: 4 },
    ])
    await expect(resolvePublic('acg.rip', new AbortController().signal, mixedLookup)).rejects.toMatchObject({ code: 'unsafe_target' })
    expect(mixedLookup).toHaveBeenCalledWith('acg.rip', { all: true, verbatim: true })

    const pendingLookup = vi.fn(() => new Promise<never>(() => {}))
    const controller = new AbortController()
    const pending = resolvePublic('acg.rip', controller.signal, pendingLookup)
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('Electron external link dispatch', () => {
  it('permits configured source home links and refuses unsafe schemes, credentials and local destinations', () => {
    for (const url of Object.values(TEST_SOURCE_URLS)) expect(externalHttpsUrl(url)).toBe(url)
    for (const raw of ['javascript:alert(1)', 'file:///C:/Windows', 'magnet:?xt=foo', 'http://acgrip.example/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://user:secret@acgrip.example/', 'https://acgrip.example:444/', 'https://local.internal/']) expect(externalHttpsUrl(raw)).toBeNull()
  })

  it('opens HTTPS in OS browser, keeps internal windows and blocks external takeover', async () => {
    const contents = new EventEmitter() as EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> }
    contents.setWindowOpenHandler = vi.fn()
    const open = vi.fn().mockResolvedValue(undefined)
    installExternalLinks(contents, 'http://127.0.0.1:5173', open)
    const handler = contents.setWindowOpenHandler.mock.calls[0][0]
    expect(handler({ url: `${TEST_SOURCE_URLS.acgrip}t/123` })).toEqual({ action: 'deny' })
    expect(open).toHaveBeenCalledWith(`${TEST_SOURCE_URLS.acgrip}t/123`)
    expect(handler({ url: 'http://127.0.0.1:5173/folder/4' }).action).toBe('allow')
    expect(handler({ url: 'http://example.org/anime' })).toMatchObject({ action: 'allow', overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, sandbox: true } } })
    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, `${TEST_SOURCE_URLS.nyaa}view/1`)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    contents.emit('will-navigate', event, 'http://127.0.0.1:5173/all')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    handler({ url: 'file:///C:/Windows' })
    expect(open).toHaveBeenCalledTimes(2)
  })
})
