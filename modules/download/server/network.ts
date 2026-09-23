import dns from 'node:dns/promises'
import https from 'node:https'
import tls from 'node:tls'
import { BlockList, isIP } from 'node:net'
import type { ListRequest, ListResponse } from './transport'

export class DownloadNetworkError extends Error {
  constructor(readonly code: 'unsafe_target' | 'proxy_unsupported' | 'timeout' | 'connection', message: string) { super(message) }
}
export interface Address { address: string; family: number }
const denied4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied4.addSubnet(address, prefix, 'ipv4')
const global6 = new BlockList()
global6.addSubnet('2000::', 3, 'ipv6')
const denied6 = new BlockList()
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) denied6.addSubnet(address, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !denied4.check(address, 'ipv4')
  return family === 6 && !address.includes('%') && global6.check(address, 'ipv6') && !denied6.check(address, 'ipv6')
}

export async function resolvePublic(hostname: string, signal: AbortSignal, lookup = dns.lookup): Promise<Address> {
  signal.throwIfAborted()
  let abort!: () => void
  let timer!: ReturnType<typeof setTimeout>
  try {
    const records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(new DownloadNetworkError('timeout', '域名解析超时')), 10_000)
      }),
    ])
    signal.throwIfAborted()
    if (!records.length || records.length > 64 || records.some(item => !isPublicAddress(item.address) || item.family !== isIP(item.address))) {
      throw new DownloadNetworkError('unsafe_target', '站点解析到了非公网地址，已阻止连接')
    }
    return records[0]
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

/** No second DNS lookup. Verify the connected peer AND the original hostname's TLS identity. */
export function pinnedAgent(hostname: string, address: Address, signal: AbortSignal, connect = tls.connect): https.Agent {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = (_options, callback) => {
    let settled = false
    const socket = connect({ host: address.address, port: 443,
      servername: hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
      checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(hostname, certificate),
    })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) socket.destroy()
      callback?.(error ?? null, error ? undefined as never : socket)
    }
    const cancel = () => { finish(new Error('请求已取消')); socket.destroy() }
    socket.setTimeout(15_000, () => finish(new DownloadNetworkError('timeout', '安全连接超时')))
    socket.on('error', finish)
    socket.once('close', () => {
      signal.removeEventListener('abort', cancel)
      if (!settled) finish(new Error('连接提前关闭'))
    })
    socket.once('secureConnect', () => {
      const pinned = new BlockList()
      pinned.addAddress(address.address, address.family === 6 ? 'ipv6' : 'ipv4')
      const remote = socket.remoteAddress ?? ''
      if (!socket.authorized || !isPublicAddress(remote) || !pinned.check(remote, isIP(remote) === 6 ? 'ipv6' : 'ipv4')) {
        finish(new DownloadNetworkError('unsafe_target', '实际连接目标或证书校验失败'))
      } else finish()
    })
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    return undefined
  }
  return agent
}

export type PinnedSend = (url: URL, request: ListRequest, address: Address, signal: AbortSignal) => Promise<ListResponse & { location?: string }>
export const sendPinned: PinnedSend = async (url, request, address, signal) => {
  const data = request.body === undefined ? undefined : JSON.stringify(request.body)
  if (data && Buffer.byteLength(data) > 8192) throw new Error('Request too large')
  const agent = pinnedAgent(url.hostname, address, signal)
  try {
    return await new Promise((resolve, reject) => {
      const req = https.request(url, { agent, signal, method: request.method, maxHeaderSize: 16384,
        headers: { Accept: 'application/json, text/html, application/rss+xml;q=0.9',
          'Accept-Encoding': 'identity', 'User-Agent': 'AnimeShelf/1.0 (resource lists)',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, response => {
        let size = 0
        const chunks: Buffer[] = []
        const encoding = response.headers['content-encoding']
        if ((encoding && encoding !== 'identity') || Number(response.headers['content-length']) > 2 * 1024 * 1024) {
          req.destroy(new Error('Unsupported or oversized response')); return
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2 * 1024 * 1024) { req.destroy(new Error('Response too large')); return }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('aborted', () => reject(new Error('Response interrupted')))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
          location: response.headers.location, retryAfter: response.headers['retry-after'] }))
      })
      req.setTimeout(15_000, () => req.destroy(new DownloadNetworkError('timeout', '请求超时')))
      req.on('error', reject)
      req.end(data)
    })
  } finally { agent.destroy() }
}
