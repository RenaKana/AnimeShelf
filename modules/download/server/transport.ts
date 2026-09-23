import { getProxy } from '../../../server/services/proxy'
import { settingsDb } from '../../../server/db/instance'
import type { SourceId } from '../shared/types'
import { sourceInfo } from '../shared/sources'
import { requestUrl } from './security'
import { DownloadNetworkError, resolvePublic, sendPinned, type PinnedSend } from './network'
import { downloadRequestPacer, type DownloadRequestPacer } from './request-pacing'

export interface ListRequest { source: SourceId; baseUrl: string; url: string; method: 'GET' | 'POST'; body?: unknown }
export interface ListResponse { status: number; body: string; retryAfter?: string }
export type Transport = (request: ListRequest, signal: AbortSignal) => Promise<ListResponse>

export function createTransport(options: {
  send?: PinnedSend; resolve?: typeof resolvePublic; proxy?: () => unknown; pacer?: DownloadRequestPacer
} = {}): Transport {
  const send = options.send ?? sendPinned
  const resolve = options.resolve ?? resolvePublic
  const pacer = options.pacer ?? downloadRequestPacer
  const proxy = options.proxy ?? (() => getProxy() || settingsDb.get('proxy_url')?.trim()
    || ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'].some(key => Boolean(process.env[key])))
  return async (request, signal) => {
    if (request.baseUrl !== sourceInfo(request.source)?.url) throw new DownloadNetworkError('unsafe_target', '下载请求只能访问内置来源')
    let url = requestUrl(request.source, request.url, request.method, request.baseUrl)
    if (proxy()) throw new DownloadNetworkError('proxy_unsupported', '下载来源暂不支持当前代理的安全目标校验；未发起请求，也未改为直连')
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted()
      const address = await resolve(url.hostname, signal)
      signal.throwIfAborted()
      const response = await pacer.send(request.source, signal, () => send(url, request, address, signal))
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.location
        if (typeof location !== 'string' || hop === 3) throw new Error('Invalid redirect')
        // POST redirects may change semantics; never resend a search body to a new endpoint.
        if (request.method !== 'GET') throw new Error('Search redirect refused')
        const next = requestUrl(request.source, new URL(location, url).href, 'GET', request.baseUrl)
        // Preserve category/search/page scope when the origin redirects a list.
        const parameters = (value: URL) => JSON.stringify([...value.searchParams].sort())
        if (next.pathname !== url.pathname || parameters(next) !== parameters(url)) throw new Error('Redirect changed list scope')
        url = next
        continue
      }
      return { status: response.status, body: response.body, retryAfter: response.retryAfter }
    }
    throw new Error('Too many redirects')
  }
}
