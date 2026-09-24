import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/instance', () => ({ settingsDb: { get: () => null } }))
import { matchesProxyBypass, parseProxy, parseSystemProxy, proxyMode, resolveProxyFrom, validateProxySettings, ProxyError } from '../proxy'

const enabled = { enabled: true, server: 'http=127.0.0.1:7890;https=127.0.0.1:7897', bypass: '<local>;*.internal;example.net;https://secure.example:8443', pac: false }
describe('network route policy', () => {
  it('migrates empty settings to system and an old address to manual without writing data', () => {
    expect(proxyMode({})).toBe('system')
    expect(proxyMode({ proxy_url: 'http://127.0.0.1:7897' })).toBe('manual')
    expect(proxyMode({ proxy_mode: 'direct', proxy_url: 'http://127.0.0.1:7897' })).toBe('direct')
  })
  it('selects protocol-specific system proxies and preserves system bypass rules', () => {
    expect(resolveProxyFrom({}, 'https://anilist.co/', () => enabled).proxy?.port).toBe(7897)
    expect(resolveProxyFrom({}, 'http://example.org/', () => enabled).proxy?.port).toBe(7890)
    for (const url of ['http://printer/', 'https://api.internal/', 'https://example.net/', 'https://secure.example:8443/']) {
      expect(resolveProxyFrom({}, url, () => enabled).proxy).toBeUndefined()
    }
    expect(matchesProxyBypass(new URL('https://example.net.evil.test/'), 'example.net')).toBe(false)
    expect(matchesProxyBypass(new URL('https://secure.example/'), 'https://secure.example:8443')).toBe(false)
    expect(matchesProxyBypass(new URL('https://[::1]:8443/'), '[::1]:8443')).toBe(true)
  })
  it('ignores a disabled stale address, and does not select an HTTP entry for HTTPS', () => {
    expect(resolveProxyFrom({}, 'https://anilist.co/', () => ({ ...enabled, enabled: false, server: 'socks5://old' })).proxy).toBeUndefined()
    expect(resolveProxyFrom({}, 'https://anilist.co/', () => ({ ...enabled, server: 'http=127.0.0.1:7890' })).proxy).toBeUndefined()
  })
  it('manual and direct modes never read system settings, even with proxy environment variables', () => {
    const read = vi.fn(() => { throw new Error('must not read') })
    vi.stubEnv('HTTPS_PROXY', 'http://environment.invalid:9999')
    try {
      expect(resolveProxyFrom({ proxy_mode: 'direct' }, 'https://anilist.co/', read).proxy).toBeUndefined()
      expect(resolveProxyFrom({ proxy_mode: 'manual', proxy_url: 'https://proxy.example:8443' }, 'https://anilist.co/', read).proxy?.url).toBe('https://proxy.example:8443')
      expect(read).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })
  it('refuses invalid manual configuration, unsupported protocols, PAC and unreadable system settings without fallback', () => {
    for (const proxy_url of ['', 'socks5://127.0.0.1:1080', 'http://proxy:99999', 'http://proxy/path', 'http://user:secret@proxy:8888']) {
      expect(() => validateProxySettings({ proxy_mode: 'manual', proxy_url })).toThrow()
    }
    expect(() => resolveProxyFrom({}, 'https://anilist.co/', () => ({ ...enabled, pac: true }))).toThrow(/PAC/)
    expect(() => resolveProxyFrom({}, 'https://anilist.co/', () => { throw new ProxyError('cannot read') })).toThrow('cannot read')
    try { parseProxy('http://user:secret@proxy:8888') } catch (error) { expect(String(error)).not.toContain('secret') }
  })
  it('parses enabled flags, PAC and automatic-discovery flags', () => {
    expect(parseSystemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:7897\nProxyOverride REG_SZ <local>;*.test')).toMatchObject({ enabled: true, pac: false, bypass: '<local>;*.test' })
    expect(parseSystemProxy('AutoConfigURL REG_SZ https://example.org/proxy.pac').pac).toBe(true)
    expect(parseSystemProxy('AutoConfigURL REG_SZ https://old.example/proxy.pac\nDefaultConnectionSettings REG_BINARY 460000000000000001000000').pac).toBe(false)
    expect(parseSystemProxy('DefaultConnectionSettings REG_BINARY 460000000000000009000000').pac).toBe(true)
  })
  it('only bypasses local services when requested, never untrusted image URLs', () => {
    const settings = { proxy_mode: 'manual', proxy_url: 'http://127.0.0.1:7897' }
    for (const url of ['http://127.0.0.1:1234/', 'http://192.168.1.2:8080/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]:8080/', 'http://model.local/']) {
      expect(resolveProxyFrom(settings, url, undefined, true).proxy).toBeUndefined()
      expect(resolveProxyFrom(settings, url).proxy).toBeDefined()
    }
  })
})
