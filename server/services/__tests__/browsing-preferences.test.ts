import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DataTable from '../../../src/components/DataTable'
import { readBooleanPref, readNumberPref, readStringPref } from '../../../src/lib/uiPreferences'
import type { FolderView } from '../../../src/types'

const items: FolderView[] = [1, 2].map(id => ({
  id, name: `Series ${id}`, path: `D:/Anime/${id}`, size: 1024,
  file_count: 1, tags: [], is_series: 1,
  library_id: 1, parent_id: null, anilist_id: null, has_poster: 0, created_at: '', updated_at: '',
}))

function table(selected: number[], rows = items) {
  return renderToStaticMarkup(createElement(DataTable, {
    items: rows, selected: new Set(selected), onToggleSelect: () => {},
    onSelectAll: () => {}, onOpen: () => {},
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('library selection affordances', () => {
  it('keeps select-all visible and disables it only for an empty table', () => {
    expect(table([], [])).toMatch(/aria-label="选择全部"[^>]*disabled=""/)
    expect(table([999])).toMatch(/aria-label="选择全部"[^>]*aria-checked="false"/)
    expect(table([])).toContain('aria-label="选择 Series 1"')
  })

  it('marks a partial selection indeterminate and checks it only when all visible rows are selected', () => {
    expect(table([1])).toMatch(/aria-label="选择全部"[^>]*aria-checked="mixed"[^>]*type="checkbox"/)
    expect(table([1, 2])).toMatch(/aria-label="选择全部"[^>]*checked=""/)
  })

  it('shows owned season ranges and marks missing folders without an owned badge', () => {
    const markup = table([], [
      { ...items[0], owned_season_numbers: [5, 3, 2, 1] },
      { ...items[1], path_missing: 1, owned_season_numbers: [1, 2] },
    ])
    expect(markup).toContain('S1-S3、S5')
    expect(markup).toContain('>缺失</span>')
    expect(markup).not.toContain('title="已拥有季数">S1-S2</span>')
  })

  it('shows each effective media domain in its row without classification headings', () => {
    const markup = table([], [
      { ...items[0], media_domain: 'anime' },
      { ...items[1], media_domain: 'live_action' },
      { ...items[0], id: 3, media_domain: 'unknown' },
      { ...items[0], id: 4 },
    ])
    expect(markup).toMatch(/>媒体类型<\/th>/)
    const rows = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)![1].match(/<tr\b[\s\S]*?<\/tr>/g)!
    expect(rows).toHaveLength(4)
    ;['动漫', '真人影视', '待确认', '待确认'].forEach((label, index) => {
      expect(rows[index]).toContain(`>${label}</td>`)
    })
    expect(markup).not.toContain('<h2')
  })

  it('shares one header and selection state across all media types', () => {
    const markup = table([1], [
      { ...items[0], media_domain: 'anime' },
      { ...items[1], media_domain: 'live_action' },
    ])
    expect(markup.match(/<thead\b/g)).toHaveLength(1)
    expect(markup.match(/aria-label="选择全部"/g)).toHaveLength(1)
    expect(markup).toMatch(/aria-label="选择全部"[^>]*aria-checked="mixed"/)
    expect(markup.match(/<tbody>/g)).toHaveLength(1)
    expect(markup.match(/aria-label="选择 Series /g)).toHaveLength(2)
  })
})

describe('numeric UI preferences', () => {
  it('keeps the main-workspace defaults when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage unavailable') } })
    expect(readNumberPref('fav-anim-dur', 500, 100, 1500)).toBe(500)
    expect(readStringPref('animeshelf.view', 'poster')).toBe('poster')
    expect(readBooleanPref('animeshelf.sidebar-pinned', false)).toBe(false)
  })

  it.each([null, '', '  '])('uses the default for an unset preference (%s), not zero', value => {
    vi.stubGlobal('localStorage', { getItem: () => value })
    expect(readNumberPref('delay', 500, 0, 3000)).toBe(500)
  })

  it('preserves an explicitly saved zero delay', () => {
    vi.stubGlobal('localStorage', { getItem: () => '0' })
    expect(readNumberPref('delay', 500, 0, 3000)).toBe(0)
  })

  it.each(['-1', '3001', 'NaN', 'Infinity'])('rejects an invalid delay (%s)', value => {
    vi.stubGlobal('localStorage', { getItem: () => value })
    expect(readNumberPref('delay', 500, 0, 3000)).toBe(500)
  })
})
