import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import NetworkSettings, { networkSettingsPayload, resolveProxyMode } from '../../../src/components/settings/NetworkSettings'

describe('core network settings', () => {
  it('honors saved mode and infers manual mode for legacy proxy addresses', () => {
    expect(resolveProxyMode({ proxy_url: 'http://127.0.0.1:7897' })).toBe('manual')
    expect(resolveProxyMode({ proxy_url_configured: '1' })).toBe('manual')
    expect(resolveProxyMode({ proxy_mode: 'direct', proxy_url: 'http://127.0.0.1:7897' })).toBe('direct')
    expect(resolveProxyMode({})).toBe('system')
  })

  it('sends only proxy fields and clears the inactive saved URL', () => {
    expect(networkSettingsPayload('manual', '  https://proxy.example:8443  ')).toEqual({
      proxy_mode: 'manual',
      proxy_url: 'https://proxy.example:8443',
    })
    expect(networkSettingsPayload('system', 'http://127.0.0.1:7897')).toEqual({ proxy_mode: 'system', proxy_url: '' })
    expect(networkSettingsPayload('direct', 'http://127.0.0.1:7897')).toEqual({ proxy_mode: 'direct', proxy_url: '' })
  })

  it('shows the proxy modes and host-managed network boundaries', () => {
    const markup = renderToStaticMarkup(createElement(NetworkSettings))
    expect(markup).toContain('代理模式')
    expect(markup).toContain('系统')
    expect(markup).toContain('手动')
    expect(markup).toContain('直连')
    expect(markup).toContain('本机服务直连')
    expect(markup).toContain('Wallpaper Engine')
  })
})
