import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import FilterBar, { clearAdditionalFilters, filterDimensionCount, type FilterState } from '../../../src/components/FilterBar'
import type { Tag } from '../../../src/types'

describe('FilterBar', () => {
  const value: FilterState = {
    q: '搜索',
    tag: ['喜剧', '科幻'],
    status: ['状态:在看'],
    libraryIds: [7],
    mediaDomain: 'live_action',
    tagMatch: 'all',
    showSeasons: false,
    view: 'poster',
    sort: 'year',
    order: 'desc',
  }

  it('keeps search, domain, and display controls stable while view settings stay in the menu by default', () => {
    const tags: Tag[] = [
      { id: 1, name: '喜剧', color: '#fff', kind: 'custom' },
      { id: 2, name: '科幻', color: '#fff', kind: 'custom' },
    ]
    const markup = renderToStaticMarkup(createElement(FilterBar, {
      value,
      onChange: () => {},
      tags,
      showMediaDomainFilter: true,
    }))

    expect(markup).not.toContain('<select')
    expect(markup).toContain('搜索名称或路径')
    expect(markup).toContain('清除搜索')
    expect(markup).toContain('浏览与显示 · 2')
    expect(markup).toContain('aria-haspopup="dialog" aria-expanded="false"')
    expect(markup).not.toContain('切换为表格')
    expect(markup).not.toContain('aria-label="显示方式"')
    expect(markup).toContain('媒体域')
    expect(markup).toContain('全部')
    expect(markup).toContain('动漫')
    expect(markup).toContain('真人影视')
    expect(markup).toContain('待确认')
  })

  it('omits media type choices for a single library while retaining its browsing controls', () => {
    const markup = renderToStaticMarkup(createElement(FilterBar, {
      value,
      onChange: () => {},
      tags: [],
    }))

    expect(markup).not.toContain('aria-label="媒体域"')
    expect(markup).not.toContain('真人影视')
    expect(markup).not.toContain('待确认')
    expect(markup).toContain('搜索名称或路径')
    expect(markup).toContain('浏览与显示 · 2')
    expect(markup).not.toContain('切换为表格')
  })

  it('clears only additional filters and preserves browsing state', () => {
    const cleared = clearAdditionalFilters(value)

    expect(cleared.tag).toEqual([])
    expect(cleared.status).toEqual([])
    expect(cleared.tagMatch).toBe('any')
    expect(cleared.q).toBe(value.q)
    expect(cleared.libraryIds).toEqual(value.libraryIds)
    expect(cleared.mediaDomain).toBe(value.mediaDomain)
    expect(cleared.showSeasons).toBe(value.showSeasons)
    expect(cleared.view).toBe(value.view)
    expect(cleared.sort).toBe(value.sort)
    expect(cleared.order).toBe(value.order)
  })

  it('counts active filter dimensions instead of selected values', () => {
    expect(filterDimensionCount({ tag: ['喜剧', '科幻'], status: ['状态:在看'], libraryIds: [7, 8] })).toBe(2)
    expect(filterDimensionCount({ tag: ['喜剧'], status: [], libraryIds: [] })).toBe(1)
    expect(filterDimensionCount({ tag: [], status: [], libraryIds: [] })).toBe(0)
    expect(filterDimensionCount({ tag: [], status: [], libraryIds: [7] })).toBe(0)
  })
})
