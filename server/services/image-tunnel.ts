import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/** A single-request CONNECT agent whose pending handshake is also cancellable.
 * Only the prevalidated loopback proxy and built-in HTTPS origin reach here.
 */
export function imageTunnelAgent(proxyUrl: string, signal: AbortSignal): https.Agent {
  const proxy = new URL(proxyUrl)
  const agent = new https.Agent({ keepAlive: false })
  const sockets = new Set<net.Socket>()
  const track = <T extends net.Socket>(socket: T): T => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const aborted = () => signal.reason instanceof Error ? signal.reason : Object.assign(new Error('图片请求已取消'), { name: 'AbortError' })
  // The request/lifecycle owns the cancellation error. Injecting it into both
  // the transport and its TLS wrapper can emit it twice during shutdown, after
  // the request has detached. Close sockets silently; pending connections
  // report the abort reason from their close handler below.
  const cancel = () => { for (const socket of sockets) socket.destroy() }
  const destroy = agent.destroy.bind(agent)
  agent.destroy = () => {
    signal.removeEventListener('abort', cancel)
    for (const socket of sockets) socket.destroy()
    destroy()
  }
  signal.addEventListener('abort', cancel, { once: true })
  agent.createConnection = (options, callback) => {
    if (signal.aborted) { callback?.(aborted(), undefined as never); return undefined }
    const hostname = String(options.host)
    const host = proxy.hostname.replace(/^\[|\]$/g, '')
    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
    const transport = track(proxy.protocol === 'https:'
      ? tls.connect({ host, port, rejectUnauthorized: true })
      : net.connect({ host, port }))
    let secure: tls.TLSSocket | undefined
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) { transport.destroy(); secure?.destroy() }
      callback?.(error ?? null, secure as tls.TLSSocket)
    }
    // Keep the handler through close: a wrapped transport can forward a late
    // error after the handshake callback has already settled.
    transport.on('error', finish)
    transport.once('end', () => finish(new Error('海报代理提前关闭了连接')))
    transport.once('close', () => { if (!settled) finish(signal.aborted ? aborted() : new Error('海报代理连接已关闭')) })
    transport.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      transport.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nConnection: close\r\n\r\n`)
    })
    let header = Buffer.alloc(0)
    const receive = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if ((end < 0 && header.length > 16384) || end > 16384) {
        finish(Object.assign(new Error('海报代理响应头过大'), { code: 'ERR_REMOTE_IMAGE_VALIDATION' })); return
      }
      if (end < 0) return
      transport.removeListener('data', receive)
      const status = header.subarray(0, end).toString('latin1').match(/^HTTP\/1\.[01] (\d{3})(?: |\r\n)/)?.[1]
      if (status !== '200') {
        finish(Object.assign(new Error('海报代理拒绝建立安全连接'), { code: 'IMAGE_PROXY_CONNECT' })); return
      }
      transport.pause()
      const remaining = header.subarray(end + 4)
      if (remaining.length) transport.unshift(remaining)
      // Keep the origin hostname for SNI and certificate identity checks. Do
      // not inherit a process-wide TLS-disable setting, redirect or proxy auth.
      secure = track(tls.connect({ socket: transport, servername: hostname, rejectUnauthorized: true }))
      secure.on('error', finish)
      secure.once('secureConnect', () => finish())
      if (signal.aborted) cancel()
    }
    transport.on('data', receive)
    return undefined
  }
  return agent
}
