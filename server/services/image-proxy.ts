import { execFileSync } from 'node:child_process'
import { settingsDb } from '../db/instance'

const IMAGE_HOSTS = new Set(['image.tmdb.org', 'lain.bgm.tv', 's4.anilist.co'])

export function isTrustedImageOrigin(url: URL): boolean {
  return url.protocol === 'https:' && (!url.port || url.port === '443')
    && !url.username && !url.password && IMAGE_HOSTS.has(url.hostname)
}

/** Only a user-configured loopback HTTP(S) proxy may resolve built-in CDNs. */
export function parseImageProxy(value: string): string {
  let url: URL
  try { url = new URL(value.includes('://') ? value : `http://${value}`) }
  catch { throw proxyConfigurationError() }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw proxyConfigurationError()
  return url.origin
}

function proxyConfigurationError(): Error {
  return Object.assign(new Error('海报代理仅支持本机回环地址上的 HTTP/HTTPS 代理，请检查应用代理设置'), { code: 'IMAGE_PROXY_CONFIG' })
}

export function systemImageProxy(registry: string): string | null {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(registry)) return null
  const server = registry.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim()
  if (!server) return null
  const selected = server.includes('=')
    ? server.match(/(?:^|;)\s*https=([^;]+)/i)?.[1] ?? server.match(/(?:^|;)\s*http=([^;]+)/i)?.[1]
    : server
  return selected ? parseImageProxy(selected.trim()) : null
}

export function getImageProxy(): string | null {
  const configured = settingsDb.get('proxy_url')?.trim()
  if (configured) return parseImageProxy(configured)
  if (process.platform !== 'win32') return null
  let registry: string
  try {
    registry = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    })
  } catch { return null }
  return systemImageProxy(registry)
}
