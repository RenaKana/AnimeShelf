import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AppBackground from '../client/AppBackground'

describe('background preview rendering', () => {
  it('streams the original WE video with looping during preview and after save', () => {
    const rendered = renderToStaticMarkup(createElement(AppBackground, {
      settings: { background_type: 'we', background_path: 'C:\\Wallpapers\\original.mp4' },
    }))
    expect(rendered).toContain('<video')
    expect(rendered).toContain('/api/wallpapers/file?p=C%3A%5CWallpapers%5Coriginal.mp4')
    expect(rendered).toContain('loop=""')
    expect(rendered).not.toContain('<img')
  })

  it('uses a local video preview stream without proxying an unsaved file path', () => {
    const rendered = renderToStaticMarkup(createElement(AppBackground, {
      settings: {
        background_type: 'video', background_path: 'C:\\saved.mp4',
        background_preview_type: 'video', background_preview_url: '/api/background/video-preview/test-session',
      },
    }))
    expect(rendered).toContain('<video')
    expect(rendered).toContain('src="/api/background/video-preview/test-session"')
    expect(rendered).not.toContain('/api/background/file?p=')
  })

  it('uses the temporary image object URL before falling back to saved-path proxying', () => {
    const preview = renderToStaticMarkup(createElement(AppBackground, {
      settings: {
        background_type: 'image',
        background_path: 'C:\\saved\\background.jpg',
        background_preview_url: 'blob:temporary-preview',
      },
    }))
    expect(preview).toContain('src="blob:temporary-preview"')
    expect(preview).not.toContain('/api/background/file?p=')
  })

  it('does not treat non-object preview values as local image sources', () => {
    const rendered = renderToStaticMarkup(createElement(AppBackground, {
      settings: {
        background_type: 'image',
        background_path: 'C:\\saved\\background.jpg',
        background_preview_url: 'https://example.test/temporary.jpg',
      },
    }))
    expect(rendered).toContain('/api/background/file?p=')
    expect(rendered).not.toContain('https://example.test/temporary.jpg')
  })
})
