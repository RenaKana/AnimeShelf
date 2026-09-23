import { describe, expect, it } from 'vitest'
import { groupLibraryActionTargets, libraryActionTargets } from '../../../src/lib/libraryActionScope'
import type { FolderView } from '../../../src/types'
const items = [{ id: 1, library_id: 7 }, { id: 2, library_id: 8 }, { id: 3, library_id: 7 }] as FolderView[]
describe('library management scope', () => {
  it('prioritizes effective selection and excludes stale hidden IDs', () => {
    expect(libraryActionTargets(items, new Set([2, 900]))).toEqual([2])
    // A stale explicit selection is empty, never silently the entire result.
    expect(libraryActionTargets(items, new Set([900]))).toEqual([])
  })
  it('uses all filtered results, not a viewport slice, when not selected', () => {
    expect(libraryActionTargets(items, new Set())).toEqual([1, 2, 3])
    expect(libraryActionTargets([], new Set([1]))).toEqual([])
  })
  it('groups by actual owner and rejects empty or unknown scopes without widening', () => {
    expect([...groupLibraryActionTargets(items, [3, 2, 3, 1])]).toEqual([[7, [3, 1]], [8, [2]]])
    expect(() => groupLibraryActionTargets(items, [])).toThrow('没有作品')
    expect(() => groupLibraryActionTargets(items, [1, 900])).toThrow('已失效')
  })
})
