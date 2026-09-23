import type { FolderView, Tag } from '../types'

export type LibrarySort = 'name' | 'size' | 'file_count' | 'rating' | 'year'
export type SortOrder = 'asc' | 'desc'

export const isStatusFilterTag = (name: string) => name.startsWith('状态:') || name === '追番中'

export const customFilterTags = (tags: Tag[]) => tags.filter(tag => !isStatusFilterTag(tag.name))

export const recommendedSortOrder = (sort: LibrarySort): SortOrder => sort === 'name' ? 'asc' : 'desc'

/** Format positive owned season numbers into compact, human-readable ranges. */
export function formatOwnedSeasons(seasons: number[] | null | undefined): string | null {
  const values = [...new Set((seasons ?? []).filter(season => Number.isInteger(season) && season > 0))].sort((a, b) => a - b)
  if (values.length === 0) return null

  const ranges: string[] = []
  let start = values[0]
  let end = values[0]
  for (const value of values.slice(1)) {
    if (value === end + 1) {
      end = value
      continue
    }
    ranges.push(start === end ? `S${start}` : `S${start}-S${end}`)
    start = value
    end = value
  }
  ranges.push(start === end ? `S${start}` : `S${start}-S${end}`)
  return ranges.join('、')
}

export function sortLibraryItems(items: FolderView[], sort: LibrarySort, order: SortOrder): FolderView[] {
  const direction = order === 'asc' ? 1 : -1
  const byName = (a: FolderView, b: FolderView) => a.name.localeCompare(b.name, 'zh')

  return [...items].sort((a, b) => {
    if (sort === 'name') return byName(a, b) * direction

    const valueA = a[sort]
    const valueB = b[sort]
    const missingA = valueA === null || valueA === undefined
    const missingB = valueB === null || valueB === undefined

    if (missingA || missingB) {
      if (missingA && missingB) return byName(a, b)
      return missingA ? 1 : -1
    }

    const difference = (valueA - valueB) * direction
    return difference || byName(a, b)
  })
}
