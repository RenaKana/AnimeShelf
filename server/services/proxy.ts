import { execFileSync } from 'node:child_process'
import { isIP } from 'node:net'
import { settingsDb } from '../db/instance'

export type ProxyMode = 'system' | 'manual' | 'direct'
export interface ProxyConfig { protocol: 'http' | 'https'; host: string; port: number; url: string }
export interface SystemProxy { enabled: boolean; server: string; bypass: string; pac: boolean }
export interface ProxyRoute { mode: ProxyMode; source: ProxyMode; proxy?: ProxyConfig; revision: string; reason?: string }
export interface ProxyStatus {
  mode: ProxyMode; source: ProxyMode; proxyUrl?: string; message: string
  error?: { code: string; message: string }
  electron?: { mode: 'direct' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string }
}
export class ProxyError extends Error {
  readonly status = 400
  constructor(message: string, readonly code = 'PROXY_CONFIG_INVALID') { super(message); this.name = 'ProxyError' }
}
export function proxyMode(settings: Record<string, string>): ProxyMode {
  const mode = settings.proxy_mode || (settings.proxy_url?.trim() ? 'manual' : 'system')
  if (!['system', 'manual', 'direct'].includes(mode)) throw new ProxyError('代理模式无效')
  return mode as ProxyMode
}
export function parseProxy(raw: string): ProxyConfig {
  let url: URL
  try { url = new URL(raw.includes('://') ? raw.trim() : 'http://' + raw.trim()) }
  catch { throw new ProxyError('代理地址无效，请填写 HTTP/HTTPS 地址和端口') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ProxyError('仅支持 HTTP/HTTPS 代理，暂不支持 SOCKS 或 PAC', 'PROXY_UNSUPPORTED')
  if (url.username || url.password) throw new ProxyError('暂不支持带账号密码的代理，请移除认证信息', 'PROXY_AUTH_UNSUPPORTED')
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(raw)) throw new ProxyError('代理地址不能包含路径、查询参数或空白字符')
  return { protocol: url.protocol.slice(0, -1) as 'http' | 'https', host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url: url.origin }
}
export function validateProxySettings(settings: Record<string, string>): void {
  const mode = proxyMode(settings)
  if (mode === 'manual' && !settings.proxy_url?.trim()) throw new ProxyError('手动代理模式需要填写代理地址')
  // Never store credentials, even in an inactive draft.
  if (settings.proxy_url?.trim()) parseProxy(settings.proxy_url)
}
export function parseSystemProxy(registry: string): SystemProxy {
  const field = (name: string, type: string) => registry.match(new RegExp('^\\s*' + name + '\\s+' + type + '\\s+([^\\r\\n]+)', 'im'))?.[1].trim() ?? ''
  const binary = field('DefaultConnectionSettings', 'REG_BINARY')
  const hasFlags = /^[a-f\d]{18,}$/i.test(binary)
  const flags = hasFlags ? Number.parseInt(binary.slice(16, 18), 16) : 0
  return {
    enabled: /^0x1$/i.test(field('ProxyEnable', 'REG_DWORD')),
    server: field('ProxyServer', 'REG_SZ'), bypass: field('ProxyOverride', 'REG_SZ'),
    pac: hasFlags ? (flags & 12) !== 0 : Boolean(field('AutoConfigURL', 'REG_SZ')) || /^0x1$/i.test(field('AutoDetect', 'REG_DWORD')),
  }
}
export function readSystemProxy(): SystemProxy {
  if (process.platform !== 'win32') throw new ProxyError('无法读取 Windows 系统代理，请选择手动代理或直连', 'PROXY_SYSTEM_UNAVAILABLE')
  try {
    return parseSystemProxy(execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/s'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }))
  } catch (error) {
    if (error instanceof ProxyError) throw error
    throw new ProxyError('无法读取 Windows 系统代理，请检查系统设置或选择手动代理/直连', 'PROXY_SYSTEM_UNAVAILABLE')
  }
}
function systemEntries(system: SystemProxy): Record<string, string> {
  if (system.pac) throw new ProxyError('系统使用 PAC/自动检测代理，暂不支持；请填写 HTTP/HTTPS 代理或选择直连', 'PROXY_UNSUPPORTED')
  if (!system.enabled) return {}
  if (!system.server) throw new ProxyError('系统代理已启用，但没有可用的代理地址')
  if (!system.server.includes('=')) return { http: parseProxy(system.server).url, https: parseProxy(system.server).url }
  const entries: Record<string, string> = {}
  for (const part of system.server.split(';').map(value => value.trim()).filter(Boolean)) {
    const match = /^(http|https|socks)=(.+)$/i.exec(part)
    if (!match || match[1].toLowerCase() === 'socks') throw new ProxyError('系统代理包含不支持的协议，请使用 HTTP/HTTPS', 'PROXY_UNSUPPORTED')
    const key = match[1].toLowerCase()
    if (entries[key]) throw new ProxyError('系统代理存在重复的协议配置')
    entries[key] = parseProxy(match[2]).url
  }
  return entries
}
export function matchesProxyBypass(target: URL, rules: string): boolean {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  for (const rule of rules.split(';').map(value => value.trim().toLowerCase()).filter(Boolean)) {
    if (rule === '<local>') { if (!host.includes('.') && !host.includes(':') && !isIP(host)) return true; continue }
    if (rule === '<-loopback>') continue
    const match = /^(?:(https?):\/\/)?([^/]+)$/.exec(rule)
    if (!match || (match[1] && match[1] + ':' !== target.protocol)) continue
    const candidate = match[2]
    const withPort = /:\d+$/.test(candidate) && !candidate.endsWith(']')
    const actual = withPort ? target.hostname.toLowerCase() + ':' + (target.port || (target.protocol === 'https:' ? '443' : '80')) : host
    const pattern = (withPort ? candidate : candidate.replace(/^\[|\]$/g, '')).split('*').map(part => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('.*')
    if (new RegExp('^' + pattern + '$', 'i').test(actual)) return true
  }
  return false
}
/** Only for explicitly configured services; never bypass untrusted remote media. */
export function isLocalService(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (!host.includes('.') && !host.includes(':'))) return true
  if (host === '::1' || /^f[cd][\da-f]{2}:/.test(host) || /^fe[89ab][\da-f]:/.test(host)) return true
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(host)
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
    return isLocalService(new URL('http://' + [high >> 8, high & 255, low >> 8, low & 255].join('.')))
  }
  const parts = host.split('.').map(Number)
  return parts.length === 4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254))
}
export function resolveProxyFrom(settings: Record<string, string>, target: string, systemReader = readSystemProxy, localBypass = false): ProxyRoute {
  const url = new URL(target)
  const mode = proxyMode(settings)
  const direct = (reason: string): ProxyRoute => ({ mode, source: mode, revision: mode + ':direct', reason })
  if (localBypass && isLocalService(url)) return direct('本机或局域网服务直连')
  if (mode === 'direct') return direct('已选择直连')
  if (mode === 'manual') {
    if (!settings.proxy_url?.trim()) throw new ProxyError('手动代理模式需要填写代理地址')
    const proxy = parseProxy(settings.proxy_url)
    return { mode, source: mode, proxy, revision: mode + ':' + proxy.url }
  }
  const system = systemReader()
  const entries = systemEntries(system)
  if (!system.enabled) return direct('系统代理未启用，使用直连')
  if (matchesProxyBypass(url, system.bypass)) return direct('按系统绕过规则直连')
  const selected = entries[url.protocol.slice(0, -1)]
  if (!selected) return direct('系统未为此协议配置代理，使用直连')
  const proxy = parseProxy(selected)
  return { mode, source: mode, proxy, revision: mode + ':' + proxy.url }
}
let systemCache: { value: SystemProxy; at: number } | undefined
function currentSystem(): SystemProxy {
  if (!systemCache || Date.now() - systemCache.at > 1000) systemCache = { value: readSystemProxy(), at: Date.now() }
  return systemCache.value
}
export function invalidateProxySettings(): void { systemCache = undefined }
function savedSettings(): Record<string, string> {
  return { proxy_mode: settingsDb.get('proxy_mode') ?? '', proxy_url: settingsDb.get('proxy_url') ?? '' }
}
export function resolveProxy(target: string, options: { localBypass?: boolean } = {}): ProxyRoute {
  return resolveProxyFrom(savedSettings(), target, currentSystem, options.localBypass)
}
export function getProxyStatus(): ProxyStatus {
  let mode: ProxyMode = 'system'
  try {
    const settings = savedSettings()
    mode = proxyMode(settings)
    if (mode === 'direct') return { mode, source: mode, message: '直连，不使用系统代理或代理环境变量', electron: { mode: 'direct' } }
    if (mode === 'manual') {
      const route = resolveProxyFrom(settings, 'https://example.org/')
      return { mode, source: mode, proxyUrl: route.proxy!.url, message: '使用手动代理；尚未测试连接', electron: { mode: 'fixed_servers', proxyRules: route.proxy!.url } }
    }
    const system = currentSystem()
    const entries = systemEntries(system)
    if (!system.enabled) return { mode, source: mode, message: '系统代理未启用，使用直连', electron: { mode: 'direct' } }
    return { mode, source: mode, proxyUrl: entries.https ?? entries.http,
      message: '跟随已启用的系统代理，部分地址按系统规则直连；尚未测试连接',
      electron: { mode: 'fixed_servers', proxyRules: Object.entries(entries).map(([scheme, address]) => scheme + '=' + address).join(';'), proxyBypassRules: system.bypass },
    }
  } catch (error) {
    const failure = error instanceof ProxyError ? error : new ProxyError('读取代理配置失败')
    return { mode, source: mode, message: failure.message, error: { code: failure.code, message: failure.message } }
  }
}
export function getProxy(target = 'https://example.org/'): ProxyConfig | null { return resolveProxy(target).proxy ?? null }
