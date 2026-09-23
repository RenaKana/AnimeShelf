import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('global high-contrast text setting', () => {
  it('applies contrast above the application and portaled controls', () => {
    const app = source('src/App.tsx')
    expect(app).toContain('textContrastMode(settings)')
    expect(app).toContain('document.documentElement')
    expect(app).toContain("setAttribute('data-text-contrast', contrast)")
    expect(app).not.toContain('data-collection-text-contrast')
  })

  it('offers a global control with the existing appearance save and preview flow', () => {
    const settings = source('src/pages/Settings.tsx')

    expect(settings).toContain("'high_contrast_text'")
    expect(settings).toContain('高对比度文字')
    expect(settings).toContain("checked={textContrastMode(settings) === 'high'}")
    expect(settings).toContain("set('high_contrast_text', e.target.checked ? '1' : '0', true)")
    expect(settings).toContain('所有页面')
    expect(settings.includes("patch[k] = k === 'high_contrast_text'")).toBe(true)
  })

  it('uses shared readable surfaces and semantic text tokens without whitening every state', () => {
    const css = source('src/index.css')
    const collection = source('modules/media-catalog/client/collections/collection.css')
    expect(css).toContain("[data-text-contrast='high']")
    expect(css).toContain('--ui-text-primary:')
    expect(css).toContain('--ui-text-secondary:')
    expect(css).toContain('.page-header')
    expect(css).toContain('.page-breadcrumb')
    expect(css).not.toMatch(/\[data-text-contrast='high'\]\s*\*\s*\{[^}]*color:/s)
    expect(collection).not.toContain('data-collection-text-contrast')
  })
  it('loads the shared palette through a reloadable CommonJS Tailwind configuration', () => {
    const config = source('tailwind.config.cjs')
    expect(config).toContain('module.exports =')
    expect(config).toContain('var(--ui-text-primary)')
    expect(config).toContain('var(--ui-text-secondary)')
  })
  it('connects collection copy to the same neutral text colors', () => {
    const file = 'modules/media-catalog/client/collections/collection.css'
    const css = source(file)
    expect(css.includes('color: #9aa4b5'), file).toBe(false)
    expect(css.includes('color: #e5e9f0'), file).toBe(false)
    expect(css.includes('rgb(var(--ui-text-secondary))'), file).toBe(true)
    expect(/color: #(aeb7c5|7f8999|b2bac7|8d97a7|d8dee8|adb6c4|858f9f|e5e7eb)/i.test(css), file).toBe(false)
  })
})
