import axios from 'axios'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'
import { isTrustedImageOrigin } from './image-proxy'
import { networkAxiosConfig, networkFailure } from './network'
import { resolveProxy, type ProxyRoute } from './proxy'
import { assertPublicRemoteAddress, assertPublicRemoteHostname } from './remote-addresses'

const MAX_URL_LENGTH = 4096
const MAX_REDIRECTS = 3
const HEADER_TIMEOUT_MS = 12000
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024

export class RemoteMediaError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'RemoteMediaError'
  }
}

export interface RemoteMediaRequest {
  method: 'GET' | 'HEAD'
  range?: string
  ifRange?: string
}

export interface RemoteMediaResult {
  status: number
  contentType?: string
  contentLength?: number
  contentRange?: string
  acceptRanges?: string
  contentEncoding?: string
  maxBytes: number
  stream?: Readable
  dispose: () => void
}

export interface RemoteMediaDependencies {
  lookup: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>
  resolveProxy: (url: string) => ProxyRoute
  networkAxiosConfig: typeof networkAxiosConfig
  isTrustedImageOrigin: (url: URL) => boolean
  request: (config: Record<string, unknown>) => Promise<any>
}

const defaultDependencies: RemoteMediaDependencies = {
  lookup: dnsLookup as RemoteMediaDependencies['lookup'],
  resolveProxy,
  networkAxiosConfig,
  isTrustedImageOrigin,
  request: config => axios.request(config as any),
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('远程媒体请求已取消')
  error.name = 'AbortError'
  return error
}

function withSignal<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    Promise.resolve(promise).then(value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
  })
}

export function parseRemoteMediaUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH || /[\x00-\x20\x7f\\]/.test(value)) {
    throw new RemoteMediaError('远程媒体 URL 无效', 400, 'REMOTE_MEDIA_URL_INVALID')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RemoteMediaError('远程媒体 URL 无效', 400, 'REMOTE_MEDIA_URL_INVALID')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteMediaError('远程媒体仅支持 HTTP 或 HTTPS', 400, 'REMOTE_MEDIA_URL_INVALID')
  }
  if (url.username || url.password) {
    throw new RemoteMediaError('远程媒体 URL 不允许携带凭据', 400, 'REMOTE_MEDIA_CREDENTIALS_FORBIDDEN')
  }
  url.hash = ''
  return url
}

async function pinnedPublicAddress(url: URL, signal: AbortSignal, dependencies: RemoteMediaDependencies): Promise<{ address: string; family: 4 | 6 }> {
  let hostname: string
  try { hostname = assertPublicRemoteHostname(url.hostname) }
  catch { throw new RemoteMediaError('远程媒体主机不允许使用本机或保留名称', 403, 'REMOTE_MEDIA_ADDRESS_FORBIDDEN') }
  const family = isIP(hostname)
  if (family === 4 || family === 6) {
    try { return assertPublicRemoteAddress(hostname, family) }
    catch { throw new RemoteMediaError('远程媒体目标不允许指向私人或保留地址', 403, 'REMOTE_MEDIA_ADDRESS_FORBIDDEN') }
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await withSignal(dependencies.lookup(hostname, { all: true, verbatim: true }), signal)
  } catch {
    if (signal.aborted) throw abortReason(signal)
    throw new RemoteMediaError('远程媒体主机无法解析', 502, 'REMOTE_MEDIA_DNS_FAILED')
  }
  if (!addresses.length) throw new RemoteMediaError('远程媒体主机无法解析', 502, 'REMOTE_MEDIA_DNS_FAILED')
  let first: { address: string; family: 4 | 6 } | undefined
  try {
    for (const item of addresses) {
      const checked = assertPublicRemoteAddress(item.address, item.family)
      first ??= checked
    }
  } catch {
    throw new RemoteMediaError('远程媒体目标不允许指向私人或保留地址', 403, 'REMOTE_MEDIA_ADDRESS_FORBIDDEN')
  }
  if (!first) throw new RemoteMediaError('远程媒体主机无法解析', 502, 'REMOTE_MEDIA_DNS_FAILED')
  return first
}

function header(headers: any, name: string): unknown {
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name)
  return headers[name.toLowerCase()] ?? headers[name] ?? headers[name.toUpperCase()]
}

function headerText(value: unknown, maxLength = 1024): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n\x00]/.test(value)) return undefined
  return value
}

function contentLength(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const raw = String(value)
  if (!/^\d{1,16}$/.test(raw)) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function destroyStream(stream: unknown): void {
  if (stream && typeof (stream as Readable).destroy === 'function') (stream as Readable).destroy()
}

function mediaType(value: unknown): string | undefined {
  const raw = headerText(value, 256)
  if (!raw) return undefined
  const type = raw.split(';', 1)[0].trim().toLowerCase()
  if (type === 'image/svg+xml' || (!type.startsWith('image/') && !type.startsWith('video/'))) return undefined
  return type
}

function safeEncoding(value: unknown): string | undefined {
  const raw = headerText(value, 32)?.trim().toLowerCase()
  return raw && /^(identity|gzip|deflate|br)$/.test(raw) ? raw : undefined
}

function safeContentRange(value: unknown): string | undefined {
  const raw = headerText(value, 128)
  return raw && /^bytes (?:\d+-\d+\/\d+|\*\/\d+)$/i.test(raw) ? raw : undefined
}

function remoteFailure(error: unknown, proxied: boolean): RemoteMediaError {
  const sanitized = networkFailure(error, proxied)
  const code = (sanitized as Error & { code?: string }).code ?? 'REMOTE_MEDIA_NETWORK_ERROR'
  return new RemoteMediaError(sanitized.message, 502, String(code))
}

export async function openRemoteMedia(
  rawUrl: unknown,
  request: RemoteMediaRequest,
  signal: AbortSignal,
  dependencies: RemoteMediaDependencies = defaultDependencies,
): Promise<RemoteMediaResult> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new RemoteMediaError('仅支持读取远程媒体', 405, 'METHOD_NOT_ALLOWED')
  }
  let target = parseRemoteMediaUrl(rawUrl)
  let requestRoute: ProxyRoute | undefined
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (signal.aborted) throw abortReason(signal)
    let route: ProxyRoute
    let pinnedAddress: { address: string; family: 4 | 6 } | undefined
    try {
      requestRoute ??= dependencies.resolveProxy(target.href)
      route = requestRoute
      if (!(dependencies.isTrustedImageOrigin(target) && route.proxy)) {
        pinnedAddress = await pinnedPublicAddress(target, signal, dependencies)
      }
    } catch (error) {
      if (error instanceof RemoteMediaError) throw error
      const config = error as { status?: number; code?: string; message?: string }
      if (config?.status === 400) throw new RemoteMediaError(config.message ?? '代理设置无效', 400, config.code ?? 'PROXY_CONFIG_INVALID')
      throw remoteFailure(error, false)
    }

    let transport: ReturnType<RemoteMediaDependencies['networkAxiosConfig']>
    try {
      transport = dependencies.networkAxiosConfig(target.href, signal, {
        pinnedAddress,
        serverName: target.hostname.replace(/^\[|\]$/g, ''),
        route,
      })
    } catch (error) {
      throw remoteFailure(error, Boolean(route.proxy))
    }

    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
    if (request.range && request.range.length <= 128 && /^bytes=\d*-\d*(?:,\d*-\d*)*$/.test(request.range)) headers.Range = request.range
    if (request.ifRange && request.ifRange.length <= 256 && !/[\r\n\x00]/.test(request.ifRange)) headers['If-Range'] = request.ifRange
    let response: any
    try {
      response = await dependencies.request({
        ...transport.config,
        url: target.href,
        method: request.method,
        headers,
        signal,
        responseType: 'stream',
        timeout: HEADER_TIMEOUT_MS,
        maxRedirects: 0,
        decompress: false,
        validateStatus: () => true,
      })
    } catch (error) {
      transport.dispose()
      if (signal.aborted) throw abortReason(signal)
      throw remoteFailure(error, Boolean(route.proxy))
    }

    const status = Number(response?.status)
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = headerText(header(response.headers, 'location'), MAX_URL_LENGTH)
      destroyStream(response.data)
      transport.dispose()
      if (!location || redirectCount >= MAX_REDIRECTS) {
        throw new RemoteMediaError('远程媒体重定向无效或超过限制', 502, 'REMOTE_MEDIA_REDIRECT_BLOCKED')
      }
      try {
        target = parseRemoteMediaUrl(new URL(location, target).href)
      } catch {
        throw new RemoteMediaError('远程媒体重定向目标无效', 502, 'REMOTE_MEDIA_REDIRECT_BLOCKED')
      }
      continue
    }
    if (status !== 200 && status !== 206 && status !== 416) {
      destroyStream(response.data)
      transport.dispose()
      throw new RemoteMediaError('远程媒体服务器返回错误状态', 502, 'REMOTE_MEDIA_UPSTREAM_STATUS')
    }

    const contentRange = safeContentRange(header(response.headers, 'content-range'))
    if (status === 416 && (!request.range || !contentRange?.startsWith('bytes */'))) {
      destroyStream(response.data)
      transport.dispose()
      throw new RemoteMediaError('远程媒体服务器返回无效范围', 502, 'REMOTE_MEDIA_UPSTREAM_RANGE')
    }
    const type = status === 416 ? undefined : mediaType(header(response.headers, 'content-type'))
    if (status !== 416 && !type) {
      destroyStream(response.data)
      transport.dispose()
      throw new RemoteMediaError('远程资源不是支持的图片或视频', 415, 'REMOTE_MEDIA_TYPE_UNSUPPORTED')
    }
    const maxBytes = type?.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    const length = contentLength(header(response.headers, 'content-length'))
    if (length != null && length > maxBytes) {
      destroyStream(response.data)
      transport.dispose()
      throw new RemoteMediaError('远程媒体响应超过大小限制', 413, 'REMOTE_MEDIA_TOO_LARGE')
    }
    if (request.method === 'HEAD' || status === 416) {
      destroyStream(response.data)
      transport.dispose()
      return {
        status,
        contentType: type,
        contentLength: status === 416 ? undefined : length,
        contentRange,
        acceptRanges: headerText(header(response.headers, 'accept-ranges'), 64),
        contentEncoding: safeEncoding(header(response.headers, 'content-encoding')),
        maxBytes,
        dispose: () => {},
      }
    }
    return {
      status,
      contentType: type,
      contentLength: length,
      contentRange,
      acceptRanges: headerText(header(response.headers, 'accept-ranges'), 64),
      contentEncoding: safeEncoding(header(response.headers, 'content-encoding')),
      maxBytes,
      stream: response.data as Readable,
      dispose: transport.dispose,
    }
  }
  throw new RemoteMediaError('远程媒体重定向无效或超过限制', 502, 'REMOTE_MEDIA_REDIRECT_BLOCKED')
}
