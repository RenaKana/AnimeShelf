import http from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { remoteMediaSrc } from '../../../shared/remote-media'
import { assertPublicRemoteAddress } from '../remote-addresses'
import { openRemoteMedia, parseRemoteMediaUrl, type RemoteMediaDependencies } from '../remote-media'
import type { ProxyRoute } from '../proxy'

const proxySession = require('../../../electron/proxy-session.cjs') as {
  BLOCKED_EXTERNAL_PROXY: Record<string, string>
  externalProxyConfig: (status: any) => { config: Record<string, string>; allowed: boolean }
  startExternalProxySync: (session: {
    setProxy: (config: Record<string, string>) => Promise<void>
    closeAllConnections: () => Promise<void>
    webRequest?: {
      onBeforeRequest: (filter: { urls: string[] }, listener: (details: any, callback: (response: { cancel: boolean }) => void) => void) => void
      onCompleted: (listener: (details: any) => void) => void
      onErrorOccurred: (listener: (details: any) => void) => void
      onBeforeRedirect: (listener: (details: any) => void) => void
    }
  }, statusUrl: string, options?: {
    intervalMs?: number
    requestTimeoutMs?: number
    fetchStatus?: (url: string) => Promise<any>
  }) => { ready: Promise<boolean>; refresh: () => Promise<boolean>; canOpenExternal: boolean; stop: () => void }
  fetchProxyStatus: (statusUrl: string) => Promise<any>
}

const directRoute = { mode: 'direct' as const, source: 'direct' as const, revision: 'direct:direct' }
const publicAddress = { address: '93.184.216.34', family: 4 }

function createElectronProxySession(events: string[] = []) {
  let beforeRequest: ((details: any, callback: (response: { cancel: boolean }) => void) => void) | undefined
  let requestFinished: ((details: any) => void) | undefined
  const session = {
    setProxy: vi.fn(async (_config: Record<string, string>) => { events.push('setProxy') }),
    closeAllConnections: vi.fn(async () => { events.push('closeAllConnections') }),
    webRequest: {
      onBeforeRequest: vi.fn((_filter: { urls: string[] }, listener: typeof beforeRequest) => { beforeRequest = listener }),
      onCompleted: vi.fn((listener: typeof requestFinished) => { requestFinished = listener }),
      onErrorOccurred: vi.fn((_listener: typeof requestFinished) => {}),
      onBeforeRedirect: vi.fn((_listener: typeof requestFinished) => {}),
    },
  }
  return {
    session,
    dispatch: (id: number) => new Promise<{ cancel: boolean }>((resolve, reject) => {
      if (!beforeRequest) { reject(new Error('request gate is not installed')); return }
      beforeRequest({ id, url: 'https://external.example.org/page' }, response => {
        events.push(`dispatch:${id}:${response.cancel}`)
        resolve(response)
      })
    }),
    complete: (id: number) => requestFinished?.({ id }),
    events,
  }
}

function imageResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
    data: Readable.from([Buffer.from('test')]),
    ...overrides,
  }
}

function createDependencies(responses: any[] = [], resolveProxyImpl: RemoteMediaDependencies['resolveProxy'] = () => directRoute) {
  const requests: Record<string, unknown>[] = []
  const transportOptions: Array<Record<string, unknown>> = []
  const dispose = vi.fn()
  const lookup = vi.fn(async (_hostname: string, _options: { all: true; verbatim: true }) => [publicAddress])
  const resolveProxy = vi.fn(resolveProxyImpl)
  const request = vi.fn(async (config: Record<string, unknown>) => {
    requests.push(config)
    return responses.shift() ?? imageResponse()
  })
  const networkAxiosConfig = vi.fn((_url: string, _signal: AbortSignal, options: Record<string, unknown> = {}) => {
    transportOptions.push(options)
    return { config: {}, dispose }
  })
  const dependencies = {
    lookup,
    resolveProxy,
    networkAxiosConfig,
    isTrustedImageOrigin: vi.fn(() => false),
    request,
  } as unknown as RemoteMediaDependencies
  return { dependencies, lookup, resolveProxy, request, requests, transportOptions, dispose }
}

describe('remote media', () => {
  it('rejects local and mixed public/private DNS destinations before requesting them', async () => {
    const direct = createDependencies()
    await expect(openRemoteMedia('http://127.0.0.1/private.png', { method: 'GET' }, new AbortController().signal, direct.dependencies))
      .rejects.toMatchObject({ code: 'REMOTE_MEDIA_ADDRESS_FORBIDDEN', status: 403 })
    expect(direct.request).not.toHaveBeenCalled()

    const mixed = createDependencies()
    mixed.lookup.mockResolvedValueOnce([publicAddress, { address: '10.0.0.8', family: 4 }])
    await expect(openRemoteMedia('https://images.example.org/poster.jpg', { method: 'GET' }, new AbortController().signal, mixed.dependencies))
      .rejects.toMatchObject({ code: 'REMOTE_MEDIA_ADDRESS_FORBIDDEN', status: 403 })
    expect(mixed.request).not.toHaveBeenCalled()
    expect(() => assertPublicRemoteAddress('::ffff:127.0.0.1')).toThrow()
    expect(assertPublicRemoteAddress('8.8.8.8')).toEqual({ address: '8.8.8.8', family: 4 })
  })

  it('pins the validated DNS address into the transport used for the request', async () => {
    const fixture = createDependencies()
    const opened = await openRemoteMedia('https://images.example.org/poster.jpg#preview', { method: 'GET' }, new AbortController().signal, fixture.dependencies)

    expect(fixture.lookup).toHaveBeenCalledWith('images.example.org', { all: true, verbatim: true })
    expect(fixture.transportOptions[0]).toMatchObject({ pinnedAddress: publicAddress, serverName: 'images.example.org' })
    expect(fixture.requests[0]).toMatchObject({ url: 'https://images.example.org/poster.jpg', maxRedirects: 0 })
    expect(opened.contentType).toBe('image/jpeg')
    opened.stream?.destroy()
    opened.dispose()
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })

  it('freezes proxy selection but rechecks and pins DNS after a cross-host redirect', async () => {
    const proxyRoute: ProxyRoute = {
      mode: 'manual',
      source: 'manual',
      revision: 'manual:http://127.0.0.1:7890',
      proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, url: 'http://127.0.0.1:7890' },
    }
    let resolutions = 0
    const fixture = createDependencies([
      { status: 302, headers: { location: 'https://cdn.example.org/image.jpg' }, data: Readable.from([]) },
      imageResponse(),
    ], () => ++resolutions === 1 ? proxyRoute : directRoute)
    fixture.lookup.mockImplementation(async hostname => [hostname === 'cdn.example.org'
      ? { address: '1.1.1.1', family: 4 }
      : publicAddress])

    const opened = await openRemoteMedia('https://images.example.org/poster.jpg', { method: 'GET' }, new AbortController().signal, fixture.dependencies)
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.transportOptions.map(options => options.pinnedAddress)).toEqual([
      publicAddress,
      { address: '1.1.1.1', family: 4 },
    ])
    expect(fixture.resolveProxy).toHaveBeenCalledOnce()
    expect(fixture.transportOptions.map(options => options.route)).toEqual([proxyRoute, proxyRoute])
    opened.stream?.destroy()
    opened.dispose()
  })

  it('blocks redirects to private addresses before making the redirected request', async () => {
    const fixture = createDependencies([
      { status: 302, headers: { location: 'http://127.0.0.1/admin' }, data: Readable.from([]) },
    ])

    await expect(openRemoteMedia('https://images.example.org/poster.jpg', { method: 'GET' }, new AbortController().signal, fixture.dependencies))
      .rejects.toMatchObject({ code: 'REMOTE_MEDIA_ADDRESS_FORBIDDEN', status: 403 })
    expect(fixture.request).toHaveBeenCalledOnce()
    expect(fixture.resolveProxy).toHaveBeenCalledOnce()
  })

  it('preserves range response metadata and streams the requested bytes', async () => {
    const fixture = createDependencies([imageResponse({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '4',
        'content-range': 'bytes 2-5/10',
        'accept-ranges': 'bytes',
      },
      data: Readable.from([Buffer.from('clip')]),
    })])
    const opened = await openRemoteMedia('https://video.example.org/clip.mp4', {
      method: 'GET', range: 'bytes=2-5', ifRange: '"v1"',
    }, new AbortController().signal, fixture.dependencies)
    const chunks: Buffer[] = []
    for await (const chunk of opened.stream!) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

    expect(fixture.requests[0]).toMatchObject({ headers: { Range: 'bytes=2-5', 'If-Range': '"v1"' } })
    expect(opened).toMatchObject({ status: 206, contentRange: 'bytes 2-5/10', acceptRanges: 'bytes', contentType: 'video/mp4' })
    expect(Buffer.concat(chunks).toString()).toBe('clip')
    opened.dispose()
  })

  it('wraps trimmed and protocol-relative HTTP(S) URLs while preserving local sources', () => {
    expect(remoteMediaSrc('https://cdn.example.org/a poster.jpg')).toBe('/api/remote-media?url=https%3A%2F%2Fcdn.example.org%2Fa%2520poster.jpg')
    expect(remoteMediaSrc('  https://cdn.example.org/a poster.jpg  ')).toBe('/api/remote-media?url=https%3A%2F%2Fcdn.example.org%2Fa%2520poster.jpg')
    const relayUrl = new URL(remoteMediaSrc('https://cdn.example.org/a poster.jpg'), 'http://localhost')
    expect(parseRemoteMediaUrl(relayUrl.searchParams.get('url')).pathname).toBe('/a%20poster.jpg')
    expect(remoteMediaSrc(' //cdn.example.org/poster.jpg ')).toBe('/api/remote-media?url=https%3A%2F%2Fcdn.example.org%2Fposter.jpg')
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    try {
      expect(remoteMediaSrc('//cdn.example.org/poster.jpg')).toBe('/api/remote-media?url=http%3A%2F%2Fcdn.example.org%2Fposter.jpg')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(remoteMediaSrc('/posters/local.jpg')).toBe('/posters/local.jpg')
    expect(remoteMediaSrc(null)).toBe('')
    expect(remoteMediaSrc('   ')).toBe('')
  })
})

describe('Electron external proxy session', () => {
  it('accepts explicit direct and fixed proxy modes and blocks missing status', () => {
    expect(proxySession.externalProxyConfig({ electron: { mode: 'direct' } })).toMatchObject({ allowed: true, config: { mode: 'direct' } })
    expect(proxySession.externalProxyConfig({ electron: { mode: 'fixed_servers', proxyRules: 'https://proxy.example.org:8443' } }))
      .toMatchObject({ allowed: true, config: { mode: 'fixed_servers', proxyRules: 'https://proxy.example.org:8443' } })
    expect(proxySession.externalProxyConfig({ error: { code: 'PROXY_SYSTEM_UNAVAILABLE' }, electron: { mode: 'direct' } }))
      .toEqual({ config: proxySession.BLOCKED_EXTERNAL_PROXY, allowed: false })
  })

  it('keeps external popups blocked when local proxy status cannot be read', async () => {
    const fixture = createElectronProxySession()
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      fetchStatus: vi.fn().mockRejectedValue(new Error('service unavailable')),
    })
    await sync.ready

    expect(sync.canOpenExternal).toBe(false)
    expect(fixture.session.setProxy).toHaveBeenCalledWith(proxySession.BLOCKED_EXTERNAL_PROXY)
    expect(fixture.session.closeAllConnections).toHaveBeenCalledOnce()
    sync.stop()
  })

  it('keeps the status refresh resolved when applying the fail-closed proxy fails', async () => {
    const fixture = createElectronProxySession()
    fixture.session.setProxy.mockRejectedValueOnce(new Error('proxy update failed'))
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      fetchStatus: vi.fn().mockRejectedValue(new Error('service unavailable')),
    })

    await expect(sync.ready).resolves.toBe(false)
    expect(sync.canOpenExternal).toBe(false)
    sync.stop()
  })

  it('keeps the status refresh resolved when closing the fail-closed proxy connections fails', async () => {
    const fixture = createElectronProxySession()
    fixture.session.closeAllConnections.mockRejectedValueOnce(new Error('connection cleanup failed'))
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      fetchStatus: vi.fn().mockRejectedValue(new Error('service unavailable')),
    })

    await expect(sync.ready).resolves.toBe(false)
    expect(sync.canOpenExternal).toBe(false)
    sync.stop()
  })

  it('rejects an interrupted local proxy status response', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
      response.write('{"mode":', () => response.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as { port: number }).port

    try {
      await expect(proxySession.fetchProxyStatus(`http://127.0.0.1:${port}/api/settings/proxy-status`)).rejects.toThrow()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('applies changed proxy settings before the next external request is dispatched', async () => {
    let status: any = { mode: 'direct', source: 'direct', revision: 'direct:v1', electron: { mode: 'direct' } }
    const fetchStatus = vi.fn(async () => status)
    const fixture = createElectronProxySession()
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      fetchStatus,
    })
    await sync.ready
    expect(await fixture.dispatch(101)).toEqual({ cancel: false })
    fixture.events.length = 0
    status = {
      mode: 'manual',
      source: 'manual',
      revision: 'manual:http://proxy.example.org:8080',
      electron: { mode: 'fixed_servers', proxyRules: 'http://proxy.example.org:8080' },
    }

    const pendingRequest = fixture.dispatch(102)
    await vi.waitFor(() => {
      expect(fetchStatus).toHaveBeenCalledTimes(3)
      expect(sync.canOpenExternal).toBe(false)
    })
    expect(fixture.session.setProxy).toHaveBeenCalledOnce()
    expect(fixture.session.closeAllConnections).toHaveBeenCalledOnce()

    fixture.complete(101)
    const decision = await pendingRequest

    expect(decision).toEqual({ cancel: false })
    expect(fixture.events).toEqual(['setProxy', 'closeAllConnections', 'dispatch:102:false'])
    expect(fixture.session.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example.org:8080',
      proxyBypassRules: '',
    })
    expect(sync.refresh).toBeTypeOf('function')
    fixture.complete(102)
    sync.stop()
  })

  it('cancels a new request on timeout without closing an active connection', async () => {
    let status: any = { mode: 'direct', source: 'direct', revision: 'direct:v1', electron: { mode: 'direct' } }
    const fetchStatus = vi.fn(async () => status)
    const fixture = createElectronProxySession()
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      requestTimeoutMs: 40,
      fetchStatus,
    })
    await sync.ready
    expect(await fixture.dispatch(201)).toEqual({ cancel: false })
    fixture.events.length = 0
    status = {
      mode: 'manual',
      source: 'manual',
      revision: 'manual:http://proxy.example.org:8080',
      electron: { mode: 'fixed_servers', proxyRules: 'http://proxy.example.org:8080' },
    }

    expect(await fixture.dispatch(202)).toEqual({ cancel: true })
    expect(fixture.events).toEqual(['dispatch:202:true'])
    expect(fixture.session.setProxy).toHaveBeenCalledOnce()
    expect(fixture.session.closeAllConnections).toHaveBeenCalledOnce()

    fixture.complete(201)
    expect(await sync.refresh()).toBe(true)
    expect(fixture.session.setProxy).toHaveBeenCalledTimes(2)
    expect(fixture.session.closeAllConnections).toHaveBeenCalledTimes(2)
    sync.stop()
  })

  it('cancels pending gates and releases proxy waiters on stop without closing active requests', async () => {
    let status: any = { mode: 'direct', source: 'direct', revision: 'direct:v1', electron: { mode: 'direct' } }
    const fetchStatus = vi.fn(async () => status)
    const fixture = createElectronProxySession()
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      fetchStatus,
    })
    await sync.ready
    expect(await fixture.dispatch(301)).toEqual({ cancel: false })
    fixture.events.length = 0
    status = {
      mode: 'manual',
      source: 'manual',
      revision: 'manual:http://proxy.example.org:8080',
      electron: { mode: 'fixed_servers', proxyRules: 'http://proxy.example.org:8080' },
    }
    const pendingRequest = fixture.dispatch(302)
    await vi.waitFor(() => expect(sync.canOpenExternal).toBe(false))

    sync.stop()
    expect(await pendingRequest).toEqual({ cancel: true })
    expect(await sync.refresh()).toBe(false)
    expect(fixture.session.setProxy).toHaveBeenCalledOnce()
    expect(fixture.session.closeAllConnections).toHaveBeenCalledOnce()
    expect(fixture.events).toEqual(['dispatch:302:true'])
    fixture.complete(301)
  })

  it('cancels the next external request when a fresh status check fails', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ mode: 'direct', source: 'direct', revision: 'direct:v1', electron: { mode: 'direct' } })
      .mockRejectedValueOnce(new Error('service unavailable'))
    const fixture = createElectronProxySession()
    const sync = proxySession.startExternalProxySync(fixture.session, 'http://127.0.0.1:3002/api/settings/proxy-status', {
      intervalMs: 0,
      fetchStatus,
    })
    await sync.ready
    const decision = await fixture.dispatch(401)

    expect(decision).toEqual({ cancel: true })
    expect(sync.canOpenExternal).toBe(false)
    expect(fixture.session.setProxy).toHaveBeenLastCalledWith(proxySession.BLOCKED_EXTERNAL_PROXY)
    expect(fixture.session.closeAllConnections).toHaveBeenCalledTimes(2)
    sync.stop()
  })
})
