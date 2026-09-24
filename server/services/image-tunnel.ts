import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { parseProxy, ProxyError } from './proxy'

export interface PinnedAddress { address: string; family: number }
/** The proxy is a selected gateway. HTTPS identity always belongs to the origin. */
export function proxyTunnelAgent(proxyUrl: string, target: URL, signal: AbortSignal,
  pinned?: PinnedAddress, timeoutMs = 15000): http.Agent | https.Agent {
  const proxy = parseProxy(proxyUrl)
  const secureTarget = target.protocol === 'https:'
  const agent = secureTarget ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const destination = pinned?.address ?? hostname
  const authority = (net.isIP(destination) === 6 ? '[' + destination + ']' : destination) + ':' + (target.port || (secureTarget ? 443 : 80))
  const sockets = new Set<net.Socket>()
  const track = <T extends net.Socket>(socket: T): T => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket
  }
  const aborted = () => signal.reason instanceof Error ? signal.reason : new DOMException('请求已取消', 'AbortError')
  const cancel = () => { for (const socket of sockets) socket.destroy() }
  const destroy = agent.destroy.bind(agent)
  agent.destroy = () => { signal.removeEventListener('abort', cancel); cancel(); destroy() }
  signal.addEventListener('abort', cancel, { once: true })
  agent.createConnection = (_options, callback) => {
    if (signal.aborted) { callback?.(aborted(), undefined as never); return undefined }
    let settled = false
    let result: net.Socket | undefined
    const transport = track(proxy.protocol === 'https'
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host, rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(proxy.host, cert) })
      : net.connect({ host: proxy.host, port: proxy.port }))
    const timer = setTimeout(() => finish(new ProxyError('代理连接或 TLS 握手超时', 'PROXY_TIMEOUT')), timeoutMs)
    timer.unref()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { transport.destroy(); result?.destroy() }
      callback?.(error ?? null, error ? undefined as never : result!)
    }
    transport.on('error', error => finish(error))
    transport.once('end', () => finish(new ProxyError('代理提前关闭连接', 'PROXY_CONNECTION_FAILED')))
    transport.once('close', () => { if (!settled) finish(signal.aborted ? aborted() : new ProxyError('代理连接已关闭', 'PROXY_CONNECTION_FAILED')) })
    transport.once(proxy.protocol === 'https' ? 'secureConnect' : 'connect', () => {
      transport.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\nConnection: close\r\n\r\n')
    })
    let header = Buffer.alloc(0)
    const receive = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if ((end < 0 && header.length > 16384) || end > 16384) { finish(new ProxyError('代理响应头过大', 'PROXY_CONNECT_FAILED')); return }
      if (end < 0) return
      transport.removeListener('data', receive)
      const status = header.subarray(0, end).toString('latin1').match(/^HTTP\/1\.[01] (\d{3})(?: |\r\n)/)?.[1]
      if (status !== '200') { finish(new ProxyError(status === '407' ? '代理要求身份认证，暂不支持' : '代理拒绝建立连接', status === '407' ? 'PROXY_AUTH_UNSUPPORTED' : 'PROXY_CONNECT_FAILED')); return }
      transport.pause()
      const remaining = header.subarray(end + 4)
      if (remaining.length) transport.unshift(remaining)
      if (secureTarget) {
        result = track(tls.connect({ socket: transport, servername: net.isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
          checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname, cert) }))
        result.on('error', error => finish(error))
        result.once('secureConnect', () => finish())
      } else { result = transport; finish(); transport.resume() }
      if (signal.aborted) cancel()
    }
    transport.on('data', receive)
    return undefined
  }
  return agent
}
/** Legacy image call signature; policy selection is owned by the request caller. */
export function imageTunnelAgent(proxyUrl: string, signal: AbortSignal): https.Agent {
  // The Agent target is provided by https.request. Keep this adapter for old callers/tests.
  const wrapper = new https.Agent({ keepAlive: false })
  const agents = new Set<http.Agent>()
  wrapper.createConnection = (options, callback) => {
    const target = new URL('https://' + String(options.host) + ':' + (options.port || 443))
    const agent = proxyTunnelAgent(proxyUrl, target, signal)
    agents.add(agent)
    return agent.createConnection(options, callback)
  }
  const destroy = wrapper.destroy.bind(wrapper)
  wrapper.destroy = () => { for (const agent of agents) agent.destroy(); agents.clear(); destroy() }
  return wrapper
}
