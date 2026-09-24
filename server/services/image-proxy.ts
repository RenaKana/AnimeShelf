import { parseProxy, parseSystemProxy, resolveProxy, resolveProxyFrom } from './proxy'
const IMAGE_HOSTS = new Set(['image.tmdb.org', 'lain.bgm.tv', 's4.anilist.co'])
export function isTrustedImageOrigin(url: URL): boolean {
  return url.protocol === 'https:' && (!url.port || url.port === '443')
    && !url.username && !url.password && IMAGE_HOSTS.has(url.hostname)
}
export function parseImageProxy(value: string): string { return parseProxy(value).url }
export function systemImageProxy(registry: string): string | null {
  return resolveProxyFrom({ proxy_mode: 'system' }, 'https://image.tmdb.org/', () => parseSystemProxy(registry)).proxy?.url ?? null
}
export function getImageProxy(target = 'https://image.tmdb.org/'): string | null { return resolveProxy(target).proxy?.url ?? null }
