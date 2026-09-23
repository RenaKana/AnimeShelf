import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FilterBar from '../../../src/components/FilterBar'
import PosterWall from '../../../src/components/PosterWall'
import type { FolderView } from '../../../src/types'
import {
  clearLibraryRouteFilter,
  libraryRouteKey,
  readLibraryRouteDomain,
  readLibraryRouteFilter,
  writeLibraryRouteDomain,
  writeLibraryRouteFilter,
} from '../../../src/lib/libraryRouteState'
import type { FilterState } from '../../../src/components/FilterBar'

// Desktop-only migration. Android view-state code and its two platform-specific
// cases remain together in the 5342 worktree; no mobile changes are imported here.

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

const fallback: FilterState = {
  q: '', tag: [], status: [], libraryIds: [], mediaDomain: 'all', tagMatch: 'any', showSeasons: true,
  view: 'table', sort: 'name', order: 'asc',
}

describe('library route-scoped browsing state', () => {
  beforeEach(() => vi.stubGlobal('localStorage', storage()))
  afterEach(() => {
    clearLibraryRouteFilter()
    vi.unstubAllGlobals()
  })

  it('keeps desktop filters for one library without leaking them to another route', () => {
    const first = libraryRouteKey(1)
    const second = libraryRouteKey(2)
    const filtered = { ...fallback, q: 'Dandadan', tag: ['收藏'], status: ['状态:在看'], libraryIds: [1], tagMatch: 'all' as const, sort: 'year' as const, order: 'desc' as const }

    writeLibraryRouteFilter(first, filtered)

    expect(readLibraryRouteFilter(first, fallback)).toEqual({ ...filtered, libraryIds: [] })
    expect(readLibraryRouteFilter(second, fallback)).toEqual(fallback)
    expect(libraryRouteKey(undefined, true)).toBe('all')
  })

  it('keeps desktop query and sorting isolated by media domain and restores the selected domain', () => {
    const base = libraryRouteKey(1)
    const anime = libraryRouteKey(1, false, 'anime')
    const liveAction = libraryRouteKey(1, false, 'live_action')
    writeLibraryRouteDomain(base, 'anime')
    writeLibraryRouteFilter(anime, { ...fallback, mediaDomain: 'anime', q: '同名作品', sort: 'year', order: 'desc' })

    expect(readLibraryRouteDomain(base)).toBe('anime')
    expect(readLibraryRouteFilter(anime, fallback)).toMatchObject({ mediaDomain: 'anime', q: '同名作品', sort: 'year', order: 'desc' })
    expect(readLibraryRouteFilter(liveAction, fallback)).toEqual(fallback)
  })

  it('drops retired library restrictions from cached and initial scopes without losing other filters', () => {
    for (const domain of ['all', 'anime', 'live_action'] as const) {
      const key = libraryRouteKey(undefined, true, domain)
      const legacy = { ...fallback, mediaDomain: domain, libraryIds: [7], q: '旅途', tag: ['冒险'], sort: 'year' as const }
      const loaded = readLibraryRouteFilter(key, legacy)
      expect(loaded).toMatchObject({ libraryIds: [], mediaDomain: domain, q: '旅途', tag: ['冒险'], sort: 'year' })
      // Also normalize old values already present in an in-memory route cache.
      loaded.libraryIds = [8]
      expect(readLibraryRouteFilter(key, fallback).libraryIds).toEqual([])
      expect(writeLibraryRouteFilter(key, legacy).libraryIds).toEqual([])
    }
  })

  it('normalizes legacy scalar filter fields and clears an active route on reset', () => {
    const key = libraryRouteKey(3)
    writeLibraryRouteFilter(key, { ...fallback, q: 'keep', tag: ['旧'], status: [], libraryIds: [] })
    const legacy = readLibraryRouteFilter(key, fallback)
    expect(legacy.tag).toEqual(['旧'])

    clearLibraryRouteFilter(key)
    expect(readLibraryRouteFilter(key, fallback)).toEqual(fallback)
  })

  it('renders every desktop status beside the poster title instead of the selection corner', () => {
    const item = {
      id: 1,
      name: '一个很长的测试番剧标题',
      tags: [
        { id: 1, name: '状态:在看', color: '#8b5cf6', kind: 'system' },
        { id: 2, name: '状态:看完', color: '#88d7b4', kind: 'system' },
        { id: 3, name: '喜剧', color: '#fff', kind: 'custom' },
      ],
      has_poster: 0,
      synopsis: null,
    } as unknown as FolderView
    const markup = renderToStaticMarkup(createElement(PosterWall, { items: [item], onOpen: () => {} }))

    expect(markup).toContain('aria-label="状态"')
    expect(markup).toContain('在看')
    expect(markup).toContain('看完')
    expect(markup).not.toContain('left-9 top-2')
    expect(markup.indexOf('一个很长的测试番剧标题')).toBeLessThan(markup.indexOf('在看'))
  })

  it('keeps the search clear action without a legacy global reset control', () => {
    const markup = renderToStaticMarkup(createElement(FilterBar, {
      value: { ...fallback, q: '搜索' },
      onChange: () => {},
      tags: [],
    }))
    const cleanMarkup = renderToStaticMarkup(createElement(FilterBar, {
      value: fallback,
      onChange: () => {},
      tags: [],
    }))

    expect(markup).toContain('清除搜索')
    expect(markup).not.toContain('重置筛选')
    expect(cleanMarkup).not.toContain('清除搜索')
  })
})
