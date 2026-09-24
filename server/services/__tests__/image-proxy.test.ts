import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/instance', () => ({ settingsDb: { get: () => null } }))
import { isTrustedImageOrigin, parseImageProxy, systemImageProxy } from '../image-proxy'

describe('configured image proxy boundary', () => {
  it('accepts only exact built-in HTTPS origins', () => {
    for (const host of ['image.tmdb.org', 'lain.bgm.tv', 's4.anilist.co']) expect(isTrustedImageOrigin(new URL(`https://${host}/image.jpg`))).toBe(true)
    for (const url of ['https://lain.bgm.tv.evil.test/a', 'http://lain.bgm.tv/a', 'https://lain.bgm.tv:444/a', 'https://user:password@lain.bgm.tv/a', 'https://127.0.0.1/a']) expect(isTrustedImageOrigin(new URL(url))).toBe(false)
  })
  it('accepts explicitly configured HTTP(S) gateways but rejects credentials, paths and unsupported protocols', () => {
    expect(parseImageProxy('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(parseImageProxy('http://proxy.test:8080')).toBe('http://proxy.test:8080')
    expect(parseImageProxy('https://[::1]:7890')).toBe('https://[::1]:7890')
    for (const value of ['socks5://127.0.0.1:1080', 'http://user:secret@127.0.0.1:7890', 'http://127.0.0.1:7890/path', 'http://127.0.0.1:7890?x=1']) expect(() => parseImageProxy(value)).toThrow()
  })
  it('uses only enabled system proxy and selects its HTTPS mapping', () => {
    expect(systemImageProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ 127.0.0.1:7890')).toBeNull()
    expect(systemImageProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:7890;https=127.0.0.1:7891')).toBe('http://127.0.0.1:7891')
    expect(systemImageProxy('')).toBeNull()
  })
})
