import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import axios from 'axios'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it, vi } from 'vitest'
const settings = vi.hoisted(() => ({ value: { proxy_mode: 'direct', proxy_url: '' } as Record<string, string> }))
vi.mock('../../db/instance', () => ({ settingsDb: { get: (key: string) => settings.value[key] } }))
import { networkAxiosConfig, networkFetch, networkFailure } from '../network'
import { proxyTunnelAgent } from '../image-tunnel'
const servers: http.Server[] = []
const sockets = new Set<net.Socket>()
async function listen(server: http.Server): Promise<number> {
  servers.push(server)
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  settings.value = { proxy_mode: 'direct', proxy_url: '' }
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})
async function fixture(secureProxy = false, trust = true) {
  const cert = await generate([{ name: 'commonName', value: 'origin.example' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'origin.example' }, { type: 7, ip: '127.0.0.1' }] }],
  })
  const hits = vi.fn((_req, res) => res.end('secure response'))
  const origin = https.createServer({ key: cert.private, cert: cert.cert }, hits)
  const originPort = await listen(origin)
  const targets: string[] = []
  const tunnel = secureProxy ? https.createServer({ key: cert.private, cert: cert.cert }) : http.createServer()
  tunnel.on('connect', (request, client, head) => {
    targets.push(request.url!)
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client)
    })
    sockets.add(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  if (trust) {
    const realConnect = tls.connect
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions, ...rest: any[]) =>
      realConnect({ ...options, ca: cert.cert }, ...rest)) as typeof tls.connect)
  }
  const proxyUrl = (secureProxy ? 'https' : 'http') + '://127.0.0.1:' + await listen(tunnel)
  settings.value = { proxy_mode: 'manual', proxy_url: proxyUrl }
  return { hits, targets, proxyUrl, cert }
}
describe('selected proxy real CONNECT and TLS', () => {
  it.each([403, 407])('reports Fetch CONNECT rejection %s without attempting the origin', async status => {
    const hits = vi.fn()
    const proxy = http.createServer()
    proxy.on('connect', (_req, client) => { hits(); client.end('HTTP/1.1 ' + status + ' Rejected\r\n\r\n') })
    settings.value = { proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:' + await listen(proxy) }
    await expect(networkFetch('https://origin.example/api')).rejects.toMatchObject({ code: status === 407 ? 'PROXY_AUTH_UNSUPPORTED' : 'PROXY_CONNECT_FAILED' })
    expect(hits).toHaveBeenCalledOnce()
  })
  it('keeps transport timeouts distinct from connection refusals', () => {
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'timeout', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(networkFailure({ code }, true)).toMatchObject({ code: 'PROXY_TIMEOUT' })
    }
    expect(networkFailure({ code: 'ECONNREFUSED' }, true)).toMatchObject({ code: 'PROXY_CONNECTION_FAILED' })
  })
  it.each([false, true])('uses a %s TLS proxy without changing origin identity (Axios and Fetch)', async secureProxy => {
    const f = await fixture(secureProxy)
    const connection = networkAxiosConfig('https://origin.example/image')
    try {
      const response = await axios.get('https://origin.example/image', connection.config)
      expect(response.data).toBe('secure response')
    } finally { connection.dispose() }
    const response = await networkFetch('https://origin.example/api')
    expect(await response.text()).toBe('secure response')
    expect(f.targets).toEqual(['origin.example:443', 'origin.example:443'])
    expect(f.hits).toHaveBeenCalledTimes(2)
  })
  it('rejects an untrusted origin certificate, with no HTTP request and no direct fallback', async () => {
    const f = await fixture(false, false)
    await expect(networkFetch('https://origin.example/api')).rejects.toMatchObject({ code: 'NETWORK_TLS_FAILED' })
    expect(f.targets).toEqual(['origin.example:443'])
    expect(f.hits).not.toHaveBeenCalled()
  })
  it('rejects an untrusted HTTPS proxy certificate before sending CONNECT', async () => {
    const f = await fixture(true, false)
    await expect(networkFetch('https://origin.example/api')).rejects.toMatchObject({ code: 'NETWORK_TLS_FAILED' })
    expect(f.targets).toEqual([])
    expect(f.hits).not.toHaveBeenCalled()
  })
  it('rejects a mismatched origin certificate even when the issuing certificate is trusted', async () => {
    const f = await fixture()
    const connection = networkAxiosConfig('https://wrong.example/image')
    try { await expect(axios.get('https://wrong.example/image', connection.config)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }
    finally { connection.dispose() }
    expect(f.hits).not.toHaveBeenCalled()
    expect(f.targets).toEqual(['wrong.example:443'])
  })
  it('CONNECTs to a pinned public address but verifies the original hostname', async () => {
    const f = await fixture()
    const connection = networkAxiosConfig('https://origin.example/image', undefined, { pinnedAddress: { address: '93.184.216.34', family: 4 } })
    try { expect((await axios.get('https://origin.example/image', connection.config)).data).toBe('secure response') }
    finally { connection.dispose() }
    expect(f.targets).toEqual(['93.184.216.34:443'])
  })
  it('refuses proxy authentication requests and does not resend directly', async () => {
    const hits = vi.fn()
    const proxy = http.createServer()
    proxy.on('connect', (_req, client) => { hits(); client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n') })
    settings.value = { proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:' + await listen(proxy) }
    const connection = networkAxiosConfig('https://origin.example/image')
    try { await expect(axios.get('https://origin.example/image', connection.config)).rejects.toMatchObject({ code: 'PROXY_AUTH_UNSUPPORTED' }) }
    finally { connection.dispose() }
    expect(hits).toHaveBeenCalledOnce()
  })
  it('cancels a stalled CONNECT and destroys its socket', async () => {
    let accepted: net.Socket | undefined
    const proxy = http.createServer()
    proxy.on('connect', (_req, socket) => { accepted = socket as net.Socket; socket.resume(); socket.on('end', () => socket.end()) })
    settings.value = { proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:' + await listen(proxy) }
    const controller = new AbortController()
    const connection = networkAxiosConfig('https://origin.example/image', controller.signal)
    const promise = axios.get('https://origin.example/image', { ...connection.config, signal: controller.signal })
    const rejected = expect(promise).rejects.toBeDefined()
    await vi.waitFor(() => expect(accepted).toBeDefined())
    controller.abort()
    await rejected
    connection.dispose()
    await vi.waitFor(() => expect(accepted?.destroyed).toBe(true))
  })
  it('times out a stalled handshake without relaxing TLS or retaining sockets', async () => {
    const proxy = http.createServer()
    proxy.on('connect', (_req, socket) => { socket.resume(); socket.on('end', () => socket.end()) })
    const proxyUrl = 'http://127.0.0.1:' + await listen(proxy)
    const agent = proxyTunnelAgent(proxyUrl, new URL('https://origin.example/'), new AbortController().signal, undefined, 40)
    try { await expect(axios.get('https://origin.example/', { proxy: false, httpsAgent: agent })).rejects.toMatchObject({ code: 'PROXY_TIMEOUT' }) }
    finally { agent.destroy() }
  })
  it('direct mode ignores environment proxies and changing saved mode affects the next request', async () => {
    const origin = http.createServer((_req, res) => res.end('local direct'))
    const url = 'http://127.0.0.1:' + await listen(origin)
    vi.stubEnv('HTTP_PROXY', 'http://invalid.example:1')
    expect(await (await networkFetch(url)).text()).toBe('local direct')
    settings.value = { proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:1' }
    await expect(networkFetch(url)).rejects.toMatchObject({ code: 'PROXY_CONNECTION_FAILED' })
    settings.value = { proxy_mode: 'direct', proxy_url: 'http://127.0.0.1:1' }
    expect(await (await networkFetch(url)).text()).toBe('local direct')
  })
})
