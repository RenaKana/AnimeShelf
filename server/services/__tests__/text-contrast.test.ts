import { describe, expect, it } from 'vitest'
import { colorTheme, textContrastMode } from '../../../src/lib/appearance'

describe('color theme preference', () => {
  it('defaults to dark for existing installations and invalid values', () => {
    expect(colorTheme({})).toBe('dark')
    expect(colorTheme({ color_theme: 'invalid' })).toBe('dark')
  })
  it('honors an explicit light or dark choice without changing contrast', () => {
    expect(colorTheme({ color_theme: 'light', high_contrast_text: '1' })).toBe('light')
    expect(colorTheme({ color_theme: 'dark' })).toBe('dark')
  })
})

describe('global contrast preference compatibility', () => {
  it('keeps normal contrast by default', () => {
    expect(textContrastMode({})).toBe('normal')
  })
  it('honors the previous collection preference until the global control is saved', () => {
    expect(textContrastMode({ collection_high_contrast_text: '1' })).toBe('high')
    expect(textContrastMode({ collection_high_contrast_text: '0' })).toBe('normal')
  })
  it('lets an explicit global choice override either legacy value without mutating settings', () => {
    const settings = Object.freeze({ high_contrast_text: '0', collection_high_contrast_text: '1' })
    expect(textContrastMode(settings)).toBe('normal')
    expect(textContrastMode({ high_contrast_text: '1', collection_high_contrast_text: '0' })).toBe('high')
  })
})
