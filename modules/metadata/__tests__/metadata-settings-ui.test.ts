import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SensitiveInput from '../../../src/components/ui/SensitiveInput'
import { metadataSettingsPayload } from '../client/MetadataSettings'

describe('metadata settings credential UI', () => {
  it('does not send saved secrets back when the fields are untouched', () => {
    expect(metadataSettingsPayload({
      settings: {
        auto_match_metadata: '1',
        proxy_url: 'http://127.0.0.1:7897',
        tmdb_key_configured: '1',
        bangumi_token_configured: '1',
      },
      tmdbKeyDraft: '',
      clearTmdbKey: false,
      bangumiTokenDraft: '',
      clearBangumiToken: false,
    })).toEqual({ auto_match_metadata: '1', proxy_url: 'http://127.0.0.1:7897' })
  })

  it('sends only intentional replacements or explicit clears', () => {
    const replaced = metadataSettingsPayload({
      settings: {},
      tmdbKeyDraft: '  tmdb-new  ',
      clearTmdbKey: false,
      bangumiTokenDraft: '',
      clearBangumiToken: false,
    })
    expect(replaced).toEqual({ auto_match_metadata: '', proxy_url: '', tmdb_key: 'tmdb-new' })

    const cleared = metadataSettingsPayload({
      settings: {},
      tmdbKeyDraft: 'ignored',
      clearTmdbKey: true,
      bangumiTokenDraft: '',
      clearBangumiToken: true,
    })
    expect(cleared).toEqual({ auto_match_metadata: '', proxy_url: '', clear_tmdb_key: '1', clear_bangumi_token: '1' })
  })

  it('renders credential inputs as password fields with an explicit visibility control', () => {
    const markup = renderToStaticMarkup(createElement(SensitiveInput, {
      value: 'private-secret',
      onChange: () => undefined,
      'aria-label': '测试密钥',
    }))
    expect(markup).toMatch(/<input[^>]*type="password"/)
    expect(markup).toContain('aria-label="显示密钥"')
    expect(markup).toContain('显示')
    expect(markup).toContain('aria-pressed="false"')
  })
})
