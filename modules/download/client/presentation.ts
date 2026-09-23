import { DOWNLOAD_SOURCES } from '../shared/sources'
import type { DownloadResource, DownloadSource } from '../shared/types'

export const DOWNLOAD_SORT_COLUMNS = [
  ['title', '标题'], ['source', '来源'], ['group', '发布组'],
  ['size', '大小'], ['publishedAt', '时间'], ['seeders', '做种'],
] as const
export type DownloadSortKey = typeof DOWNLOAD_SORT_COLUMNS[number][0]
export interface DownloadViewPreferences {
  sortKey: DownloadSortKey
  sortDirection: 'asc' | 'desc'
  collectionsOnly: boolean
}
export const DEFAULT_DOWNLOAD_VIEW: DownloadViewPreferences = {
  sortKey: 'publishedAt', sortDirection: 'desc', collectionsOnly: false,
}

export function parseSizeBytes(value: string | null): number | null {
  if (!value) return null
  const match = value.trim().match(/^(\d+(?:,\d{3})*(?:\.\d+)?)\s*(B|[KMGTPE]i?B)$/i)
  if (!match) return null
  const amount = Number(match[1].replace(/,/g, ''))
  const unit = match[2].toUpperCase()
  const power = unit === 'B' ? 0 : 'KMGTPE'.indexOf(unit[0]) + 1
  const bytes = amount * (unit.includes('I') ? 1024 : 1000) ** power
  return Number.isFinite(bytes) ? bytes : null
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function selectDownloadResources(
  resources: readonly DownloadResource[],
  view: DownloadViewPreferences,
  sources: readonly DownloadSource[] = DOWNLOAD_SOURCES,
): DownloadResource[] {
  const names = new Map(sources.map(source => [source.id, source.name]))
  const value = (resource: DownloadResource): number | string | null => {
    switch (view.sortKey) {
      case 'size': return parseSizeBytes(resource.size)
      case 'publishedAt': {
        const time = resource.publishedAt ? Date.parse(resource.publishedAt) : NaN
        return Number.isFinite(time) ? time : null
      }
      case 'seeders': return typeof resource.seeders === 'number' && Number.isFinite(resource.seeders) && resource.seeders >= 0 ? resource.seeders : null
      case 'source': return names.get(resource.source) ?? resource.source
      default: return resource[view.sortKey]?.trim() || null
    }
  }
  // Sort a copy; stable ties retain the controller's merge order across pages.
  return resources.filter(resource => !view.collectionsOnly || resource.isCollection === true).sort((left, right) => {
    const a = value(left), b = value(right)
    if (a === null) return b === null ? 0 : 1
    if (b === null) return -1
    const comparison = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))
    return view.sortDirection === 'asc' ? comparison : -comparison
  })
}
