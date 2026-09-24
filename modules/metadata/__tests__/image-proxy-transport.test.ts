import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Duplex } from 'node:stream'
import { generate } from 'selfsigned'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const proxy = vi.hoisted(() => ({ url: '' }))
const mockDnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]))
const mockResolveProxy = vi.hoisted(() => vi.fn())
vi.mock('../../../server/db/instance', () => ({ db: undefined, settingsDb: { get: () => null } }))
vi.mock('node:dns/promises', () => ({ lookup: mockDnsLookup }))
vi.mock('../../../server/services/image-proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/image-proxy')>(),
  getImageProxy: () => proxy.url,
}))
vi.mock('../../../server/services/proxy', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/services/proxy')>(),
  resolveProxy: mockResolveProxy,
}))
import { fetchRemoteImage } from '../server/metadata'

const servers: http.Server[] = []
const sockets = new Set<net.Socket>()
beforeEach(() => {
  mockDnsLookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  mockResolveProxy.mockReset().mockImplementation(() => {
    if (!proxy.url) return { mode: 'direct', source: 'direct', revision: 'test:direct' }
    const parsed = new URL(proxy.url)
    return {
      mode: 'manual', source: 'manual', revision: `test:${parsed.origin}`,
      proxy: { protocol: parsed.protocol.slice(0, -1), host: parsed.hostname, port: Number(parsed.port), url: parsed.origin },
    }
  })
})
async function listen(server: http.Server): Promise<number> {
  servers.push(server)
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}
afterEach(async () => {
  proxy.url = ''
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('real loopback CONNECT transport, no external service', () => {
  it('uses the proxy to resolve a trusted CDN without a local DNS lookup', async () => {
    const certificate = await generate([{ name: 'commonName', value: 'lain.bgm.tv' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' })
    const requested = vi.fn((_req, res) => res.end('must not be reached'))
    const origin = https.createServer({ key: certificate.private, cert: certificate.cert }, requested)
    const originPort = await listen(origin)
    const targets: string[] = []
    const tunnel = http.createServer()
    tunnel.on('connect', (request, socket, head) => {
      targets.push(request.url!)
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket)
      })
      sockets.add(upstream)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
    })
    proxy.url = `http://127.0.0.1:${await listen(tunnel)}`
    await expect(fetchRemoteImage('https://lain.bgm.tv/trusted-cdn-fixture.jpg', { force: true })).rejects.toMatchObject({ code: 'NETWORK_TLS_FAILED' })
    expect(mockDnsLookup).not.toHaveBeenCalled()
    expect(targets).toEqual(['lain.bgm.tv:443'])
    expect(requested).not.toHaveBeenCalled()
  })

  it('pins an untrusted image host to its validated DNS address through the selected proxy', async () => {
    const host = 'untrusted.example.test'
    const certificate = await generate([{ name: 'commonName', value: host }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' })
    const requested = vi.fn((_req, res) => res.end('must not be reached'))
    const origin = https.createServer({ key: certificate.private, cert: certificate.cert }, requested)
    const originPort = await listen(origin)
    const targets: string[] = []
    const tunnel = http.createServer()
    tunnel.on('connect', (request, socket, head) => {
      targets.push(request.url!)
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket)
      })
      sockets.add(upstream)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
    })
    proxy.url = `http://127.0.0.1:${await listen(tunnel)}`
    await expect(fetchRemoteImage(`https://${host}/untrusted-fixture.jpg`, { force: true })).rejects.toMatchObject({ code: 'NETWORK_TLS_FAILED' })
    expect(mockDnsLookup).toHaveBeenCalledWith(host, { all: true, verbatim: true })
    expect(targets).toEqual(['93.184.216.34:443'])
    expect(requested).not.toHaveBeenCalled()
  })

  it('aborts a stalled CONNECT handshake and closes its socket', async () => {
    const connected = vi.fn()
    const tunnel = http.createServer()
    tunnel.on('connect', (request, socket, head) => {
      connected(request, socket, head)
      socket.resume()
      socket.on('end', () => socket.end())
    })
    proxy.url = `http://127.0.0.1:${await listen(tunnel)}`
    const controller = new AbortController()
    const result = fetchRemoteImage('https://lain.bgm.tv/stalled-fixture.jpg', { force: true, signal: controller.signal })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
    const socket = connected.mock.calls[0][1] as net.Socket
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(socket.destroyed).toBe(true), { timeout: 1000 })
  })

  it('shuts down during a stalled TLS handshake without a late unhandled socket error', async () => {
    let tunnelSocket: Duplex | undefined
    const handshake = vi.fn()
    const tunnel = http.createServer()
    tunnel.on('connect', (_request, socket) => {
      tunnelSocket = socket
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.on('data', handshake)
      socket.on('end', () => socket.end())
    })
    proxy.url = `http://127.0.0.1:${await listen(tunnel)}`
    const controller = new AbortController()
    const shutdown = new Error('Service host is shutting down')
    const result = fetchRemoteImage('https://lain.bgm.tv/stalled-tls.jpg', { force: true, signal: controller.signal })
    const rejected = expect(result).rejects.toBe(shutdown)
    await vi.waitFor(() => expect(handshake).toHaveBeenCalled())
    controller.abort(shutdown)
    await rejected
    await vi.waitFor(() => expect(tunnelSocket?.destroyed).toBe(true), { timeout: 1000 })
  })
})
