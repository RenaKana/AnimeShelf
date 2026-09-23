import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/pages/Settings.tsx'), 'utf8')

describe('settings page organization', () => {
  it('uses one ordered section list for navigation and content', () => {
    const declaration = source.indexOf('const settingsSections:')
    const navigation = source.indexOf('{settingsSections.map(({ id, label }) => (')
    const content = source.indexOf('{settingsSections.map(({ id, content }) => (')

    expect(declaration).toBeGreaterThanOrEqual(0)
    expect(navigation).toBeGreaterThan(declaration)
    expect(content).toBeGreaterThan(navigation)
    expect((source.match(/settingsSections\.map/g) ?? []).length).toBe(2)
  })

  it('keeps the custom-tags section addressable from the shared list', () => {
    expect(source).toContain("id: 'settings-custom-tags', label: '自定义标签'")
    expect(source).toContain('<section id="settings-custom-tags"')
    expect(source).toContain('href={`#${id}`}')
  })
})
