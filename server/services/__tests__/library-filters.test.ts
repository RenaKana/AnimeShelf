import { describe, expect, it } from 'vitest'
import {
  customFilterTags,
  formatOwnedSeasons,
  recommendedSortOrder,
  sortLibraryItems,
} from '../../../src/lib/libraryFilters'
import type { FolderView, Tag } from '../../../src/types'

const folder = (id: number, name: string, patch: Partial<FolderView> = {}): FolderView => ({
  id,
  library_id: 1,
  parent_id: null,
  name,
  path: name,
  is_series: 1,
  anilist_id: null,
  has_poster: 0,
  size: 0,
  file_count: 0,
  tags: [],
  created_at: '',
  updated_at: '',
  ...patch,
})

describe('library filters', () => {
  it('formats owned seasons into sorted unique ranges', () => {
    expect(formatOwnedSeasons([5, 3, 2, 1, 3])).toBe('S1-S3、S5')
    expect(formatOwnedSeasons([0, -1, 1.5, Number.NaN, 7])).toBe('S7')
    expect(formatOwnedSeasons([])).toBeNull()
    expect(formatOwnedSeasons(null)).toBeNull()
  })

  it('keeps custom tags while excluding status tags', () => {
    const tags: Tag[] = [
      { id: 1, name: '喜剧', color: '#fff', kind: 'custom' },
      { id: 2, name: '状态:在看', color: '#fff', kind: 'system' },
      { id: 3, name: '追番中', color: '#fff', kind: 'system' },
      { id: 4, name: '收藏', color: '#fff', kind: 'system' },
    ]

    expect(customFilterTags(tags).map(tag => tag.name)).toEqual(['喜剧', '收藏'])
  })

  it('uses sensible initial directions', () => {
    expect(recommendedSortOrder('name')).toBe('asc')
    for (const sort of ['size', 'file_count', 'rating', 'year'] as const) {
      expect(recommendedSortOrder(sort)).toBe('desc')
    }
  })

  it('sorts every field in both directions without moving missing metadata first', () => {
    const items = [
      folder(1, '乙', { size: 20, file_count: 2, rating: null, year: null }),
      folder(2, '甲', { size: 10, file_count: 1, rating: 8, year: 2020 }),
      folder(3, '丙', { size: 30, file_count: 3, rating: 6, year: 2010 }),
    ]
    const localizedNames = [...items].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(item => item.id)

    expect(sortLibraryItems(items, 'name', 'asc').map(item => item.id)).toEqual(localizedNames)
    expect(sortLibraryItems(items, 'name', 'desc').map(item => item.id)).toEqual([...localizedNames].reverse())
    expect(sortLibraryItems(items, 'size', 'asc').map(item => item.id)).toEqual([2, 1, 3])
    expect(sortLibraryItems(items, 'file_count', 'desc').map(item => item.id)).toEqual([3, 1, 2])
    expect(sortLibraryItems(items, 'rating', 'asc').map(item => item.id)).toEqual([3, 2, 1])
    expect(sortLibraryItems(items, 'rating', 'desc').map(item => item.id)).toEqual([2, 3, 1])
    expect(sortLibraryItems(items, 'year', 'asc').map(item => item.id)).toEqual([3, 2, 1])
    expect(sortLibraryItems(items, 'year', 'desc').map(item => item.id)).toEqual([2, 3, 1])
  })
})
