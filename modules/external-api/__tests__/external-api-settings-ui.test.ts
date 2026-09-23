import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExternalApiSettings from '../client/ExternalApiSettings'
import {
  createExternalApiToken,
  revokeExternalApiToken,
  updateExternalApiConfig,
  updateExternalApiToken,
} from '../client/externalApiClient'

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('external API settings UI', () => {
  it('renders the local-only controls, permission warning, and placeholder usage example', () => {
    const markup = renderToStaticMarkup(createElement(ExternalApiSettings))

    expect(markup).toContain('id="settings-external-api"')
    expect(markup).toContain('外部 API')
    expect(markup).toContain('127.0.0.1')
    expect(markup).toContain('文件管理')
    expect(markup).toContain('物理删除')
    expect(markup).toContain('TOKEN_PLACEHOLDER')
    expect(markup).toContain('type="datetime-local"')
  })

  it('adds the owner header to mutations without sending bearer authorization', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      enabled: true,
      port: 3003,
      status: 'running',
      base_url: 'http://127.0.0.1:3003/api/v1',
      error: null,
      tokens: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await updateExternalApiConfig({ enabled: true, port: 3003 })
    await createExternalApiToken({ name: 'reader', role: 'read' })
    await updateExternalApiToken('token/id', { role: 'edit' })
    await revokeExternalApiToken('token/id')

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/external-access', 'PUT'],
      ['/api/external-access/tokens', 'POST'],
      ['/api/external-access/tokens/token%2Fid', 'PATCH'],
      ['/api/external-access/tokens/token%2Fid', 'DELETE'],
    ])
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers)
      expect(headers.get('X-AnimeShelf-Owner')).toBe('1')
      expect(headers.has('Authorization')).toBe(false)
    }
  })

  it('keeps secret handling transient and integrates the section into Settings navigation', () => {
    const component = source('modules/external-api/client/ExternalApiSettings.tsx')
    const tokens = source('modules/external-api/client/ExternalApiTokenManager.tsx')
    const settings = source('src/pages/Settings.tsx')
    const entry = source('modules/external-api/client.tsx')

    expect(component).toContain('AbortController')
    expect(component).toContain('configDirtyRef')
    expect(component).toContain("next.status === 'error'")
    expect(component + tokens).not.toMatch(/localStorage|sessionStorage/)
    expect(component + tokens).not.toMatch(/console\.(?:log|info|debug).*token/i)
    expect(entry).toContain("import ExternalApiSettings from './client/ExternalApiSettings'")
    expect(entry).toContain("id: 'settings-external-api', label: '外部 API'")
    expect(entry).toContain('component: ExternalApiSettings')
    expect(settings).toContain('contribution.settingsSections')
  })
})
