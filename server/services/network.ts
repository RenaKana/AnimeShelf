import http from 'node:http'
import https from 'node:https'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { resolveProxy, ProxyError, type ProxyRoute } from './proxy'
import { proxyTunnelAgent, type PinnedAddress } from './image-tunnel'

export function networkAxiosConfig(url: string, signal: AbortSignal = new AbortController().signal,
  options: { localBypass?: boolean; pinnedAddress?: PinnedAddress; serverName?: string; route?: ProxyRoute } = {}) {
  signal.throwIfAborted()
  const target = new URL(url)
  const route = options.route ?? resolveProxy(url, options)
  const lookup = options.pinnedAddress ? ((_host: string, opts: any, callback: any) => {
    const value = options.pinnedAddress!
    if (opts?.all) callback(null, [{ address: value.address, family: value.family }])
    else callback(null, value.address, value.family)
  }) : undefined
  const directHttp = new http.Agent({ keepAlive: false, lookup })
  const directHttps = new https.Agent({ keepAlive: false, lookup, rejectUnauthorized: true })
  const tunnel = route.proxy ? proxyTunnelAgent(route.proxy.url, target, signal, options.pinnedAddress) : undefined
  return {
    route,
    config: { proxy: false as const, maxRedirects: 0, httpAgent: target.protocol === 'http:' && tunnel ? tunnel : directHttp,
      httpsAgent: target.protocol === 'https:' && tunnel ? tunnel : directHttps },
    dispose: () => { tunnel?.destroy(); directHttp.destroy(); directHttps.destroy() },
  }
}
export function networkFailure(error: unknown, proxied = false): Error {
  if (error instanceof ProxyError || (error as Error)?.name === 'AbortError') return error as Error
  const causes: any[] = []
  for (let cause: any = error; cause && causes.length < 5; cause = cause.cause) causes.push(cause)
  const code = causes.map(cause => String(cause.code ?? '')).join(' ')
  const detail = causes.map(cause => String(cause.message ?? '')).find(message => /^Proxy response \(\d{3}\) !== 200 when HTTP Tunneling$/.test(message)) ?? ''
  if (code.includes('UND_ERR_ABORTED') && detail) {
    return detail.includes('(407)')
      ? new ProxyError('代理要求身份认证，暂不支持', 'PROXY_AUTH_UNSUPPORTED')
      : new ProxyError('代理拒绝建立连接，未改为直连', 'PROXY_CONNECT_FAILED')
  }
  if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return new ProxyError('TLS 证书验证失败，连接已停止', 'NETWORK_TLS_FAILED')
  if (/TIMEOUT|TIMEDOUT|ECONNABORTED/i.test(code) || (error as Error)?.name === 'TimeoutError') return new ProxyError(proxied ? '代理连接超时，未改为直连' : '连接超时', proxied ? 'PROXY_TIMEOUT' : 'NETWORK_TIMEOUT')
  return new ProxyError(proxied ? '代理连接失败，未改为直连；请检查代理服务与地址' : '网络连接失败', proxied ? 'PROXY_CONNECTION_FAILED' : 'NETWORK_CONNECTION_FAILED')
}
function makeNetworkFetch(localBypass: boolean): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = resolveProxy(url, { localBypass })
    const dispatcher = route.proxy
      ? new ProxyAgent({ uri: route.proxy.url, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } })
      : new Agent({ connect: { rejectUnauthorized: true } })
    try {
      // Explicit dispatcher prevents environment proxies/global dispatchers changing the selected route.
      // Redirects must be handled/validated by callers; never leak credentials across origins.
      const response = await undiciFetch(input as any, { ...init as any, redirect: init?.redirect ?? 'error', dispatcher })
      void dispatcher.close().catch(() => undefined) // graceful: waits for the response body to finish
      return response as unknown as Response
    } catch (error) {
      void dispatcher.destroy().catch(() => undefined)
      if (init?.signal?.aborted) throw init.signal.reason ?? error
      throw networkFailure(error, Boolean(route.proxy))
    }
  }) as typeof fetch
}
export const networkFetch = makeNetworkFetch(false)
/** For user-configured model/search/local service endpoints, not arbitrary image URLs. */
export const networkFetchLocal = makeNetworkFetch(true)
