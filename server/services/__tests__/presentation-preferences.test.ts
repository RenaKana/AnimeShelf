import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDisplayPins, readLibraryView, readTitlePosition, setDisplayPins, setLibraryView, setTitlePosition, toggleDisplayPin } from '../../../src/lib/presentationPreferences'
import { clearLibraryRouteFilter, libraryRouteKey, readLibraryRouteFilter, writeLibraryRouteFilter } from '../../../src/lib/libraryRouteState'
import type { FilterState } from '../../../src/components/FilterBar'

let values: Map<string, string>
const fallback: FilterState = { q: '', tag: [], status: [], libraryIds: [], mediaDomain: 'all', tagMatch: 'any', showSeasons: true, view: 'table', sort: 'name', order: 'asc' }
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  clearLibraryRouteFilter()
})
afterEach(() => vi.unstubAllGlobals())

describe('single desktop presentation preferences', () => {
  it.each([[undefined, 'overlay'], ['classic', 'overlay'], ['liquid', 'below']] as const)('migrates %s only when a new title preference is absent', (old, expected) => {
    if (old) values.set('animeshelf.ui-design', old)
    expect(readTitlePosition('library')).toBe(expected)
    expect(readTitlePosition('favorite')).toBe(expected)
    expect(values.get('animeshelf.library-title-position')).toBe(expected)
    setTitlePosition('library', 'below')
    setTitlePosition('favorite', 'overlay')
    expect(readTitlePosition('library')).toBe('below')
    expect(readTitlePosition('favorite')).toBe('overlay')
    expect(values.get('animeshelf.ui-design')).toBe(old)
  })
  it('preserves explicit new values over the old design', () => {
    values.set('animeshelf.ui-design', 'liquid')
    values.set('animeshelf.library-title-position', 'overlay')
    expect(readTitlePosition('library')).toBe('overlay')
    expect(readTitlePosition('favorite')).toBe('below')
  })
  it('never lets old domain or library view caches override the latest view, in both directions', () => {
    const keys = ['all', 'anime', 'live_action', 'unknown'].map(domain => libraryRouteKey(undefined, true, domain as FilterState['mediaDomain']))
    keys.push(libraryRouteKey(1), libraryRouteKey(2))
    keys.forEach((key, index) => writeLibraryRouteFilter(key, { ...fallback, q: `scope${index}`, tag: [`tag${index}`], sort: 'year', view: index % 2 ? 'poster' : 'table' }))
    for (const view of ['poster', 'table', 'poster'] as const) {
      setLibraryView(view)
      keys.forEach((key, index) => {
        expect(readLibraryRouteFilter(key, fallback)).toMatchObject({ view, q: `scope${index}`, tag: [`tag${index}`], sort: 'year' })
        // A stale write must not update the global view.
        writeLibraryRouteFilter(key, { ...readLibraryRouteFilter(key, fallback), view: view === 'table' ? 'poster' : 'table' })
        expect(readLibraryView()).toBe(view)
      })
    }
    clearLibraryRouteFilter()
    expect(readLibraryRouteFilter(keys[0], fallback).view).toBe('poster')
    expect(values.get('animeshelf.view')).toBe('poster')
  })
  it('restores the persisted view on a fresh module load', async () => {
    setLibraryView('poster')
    vi.resetModules()
    const fresh = await import('../../../src/lib/presentationPreferences')
    expect(fresh.readLibraryView()).toBe('poster')
  })
  it('keeps the chosen view and independent titles when storage is denied', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('quota') } })
    expect(setLibraryView('poster')).toBe(false)
    expect(readLibraryView()).toBe('poster')
    expect(readLibraryRouteFilter('all:domain:anime', fallback).view).toBe('poster')
    expect(setTitlePosition('favorite', 'below')).toBe(false)
    expect(readTitlePosition('favorite')).toBe('below')
    expect(readTitlePosition('library')).toBe('overlay')
  })
  it('persists independent library and favorite display pins in menu order', () => {
    expect(readDisplayPins('library')).toEqual([])
    expect(readDisplayPins('favorite')).toEqual([])
    setDisplayPins('favorite', ['posterSize', 'view', 'view'])
    expect(readDisplayPins('library')).toEqual([])
    expect(readDisplayPins('favorite')).toEqual(['view', 'posterSize'])
    toggleDisplayPin('library', 'sort')
    expect(readDisplayPins('library')).toEqual(['sort'])
    toggleDisplayPin('library', 'sort')
    expect(readDisplayPins('library')).toEqual([])
  })
  it('keeps pins active for the current session when local storage is denied', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('quota') } })
    expect(setDisplayPins('library', ['title', 'view'])).toBe(false)
    expect(readDisplayPins('library')).toEqual(['view', 'title'])
    expect(readDisplayPins('favorite')).toEqual([])
  })
})
