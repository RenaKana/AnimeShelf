import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Button from '../../../src/components/ui/Button'
import PosterWall from '../../../src/components/PosterWall'
import PosterSizeControl from '../../../src/components/ui/PosterSizeControl'
import type { FolderView } from '../../../src/types'

const source = (file: string) => readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8')

describe('UI polish contracts', () => {
  beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null }))
  afterEach(() => vi.unstubAllGlobals())
  it('does not accidentally submit a form when a shared action button is pressed', () => {
    expect(renderToStaticMarkup(createElement(Button, null, '操作'))).toContain('type="button"')
    expect(renderToStaticMarkup(createElement(Button, { type: 'submit' }, '保存'))).toContain('type="submit"')
  })

  it('lets a large saved poster size shrink to fit a narrow content area', () => {
    const markup = renderToStaticMarkup(createElement(PosterWall, { items: [], onOpen: () => {} }))
    expect(markup).toMatch(/minmax\(min\(100%,\s*150px\),\s*1fr\)/)
  })

  it('gives poster navigation a short accessible name independent of its synopsis', () => {
    const item = { id: 1, name: '测试番剧', tags: [], synopsis: '很长的简介', has_poster: 0 } as unknown as FolderView
    const markup = renderToStaticMarkup(createElement(PosterWall, { items: [item], onOpen: () => {} }))
    expect(markup).toContain('aria-label="打开 测试番剧"')
    expect(markup).toContain('poster-selection')
    expect(markup).not.toContain('hover:-translate-y-1')
  })

  it('keeps poster size controls bounded and able to wrap on narrow screens', () => {
    const markup = renderToStaticMarkup(createElement(PosterSizeControl, { value: 280, min: 100, max: 280, onChange: () => {} }))
    expect(markup).toContain('flex-wrap')
    expect(markup).toContain('max-w-full')
    expect(markup).toContain('type="range"')
    expect(markup).toContain('poster-size-range')
    expect(markup).not.toContain('缩小海报大小')
    expect(markup).not.toContain('放大海报大小')
  })

  it('keeps media classification available from the bulk selection action', () => {
    const text = source('components/LibrarySelectionActions.tsx')
    expect(text).toContain('修改媒体分类')
    expect(text).toContain('动漫 / 真人影视')
    expect(text).toContain("{ value: 'anime', label: '动漫' }")
    expect(text).toContain("{ value: 'live_action', label: '真人影视' }")
    expect(text).toContain("setBatchMediaDomain")
  })

  it('keeps navigation and poster images stationary while the synopsis expands', () => {
    expect(source('components/Sidebar.tsx').includes('transition-[width]')).toBe(false)
    expect(source('components/Sidebar.tsx').includes('sidebar-hover-scroll')).toBe(false)
    for (const file of ['components/PosterWall.tsx', '../modules/season/client/FavoritesView.tsx']) {
      const text = source(file)
      expect(text.includes('group-hover:scale-'), file).toBe(false)
      expect(text.includes('transition-[width]'), file).toBe(false)
    }
  })

  it('disables movement rather than accelerating it under reduced motion, without erasing positioning transforms', () => {
    const css = source('index.css')
    expect(css).toContain('animation: none !important')
    expect(css).toContain('transition-property: opacity, color, background-color, border-color !important')
    expect(css).not.toContain('0.01ms')
    expect(css).not.toMatch(/transform:\s*none\s*!important/)
    expect(css).toContain('@media (hover: hover) and (pointer: fine)')
  })

  it('makes remote wishlist search results keyboard-operable native buttons', () => {
    const text = source('../modules/season/client/FavoritesView.tsx')
    expect(/<button\s+key=\{itemId\}\s+type="button"/.test(text)).toBe(true)
    expect(text.includes('disabled={added || Boolean(addingId)}')).toBe(true)
  })

  it('keeps the settings preview consistent with the poster reveal and usable without hover', () => {
    const text = source('../modules/season/client/SeasonSettings.tsx')
    expect(text).toContain('poster-card')
    expect(text).toContain('poster-synopsis-reveal')
    expect(text).toContain('aria-label="心愿单海报预览"')
    expect(text).not.toContain('group-hover:min-h-')
    expect(text).not.toContain('group-hover:-translate-y-')
  })
})
