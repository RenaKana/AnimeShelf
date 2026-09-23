import type { FilterState } from '../components/FilterBar'
import type { MediaDomain } from '../../shared/media-domain'
import { readLibraryView } from './presentationPreferences'

export type LibraryRouteKey = string
export type LibraryMediaDomain = 'all' | MediaDomain

const filterByRoute = new Map<LibraryRouteKey, FilterState>()
const domainByRoute = new Map<LibraryRouteKey, LibraryMediaDomain>()
let knownStorage: Storage | undefined

function storageIdentity(): Storage | undefined {
  try {
    if (typeof window !== 'undefined') return window.localStorage
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // A restricted browser context has no usable storage; in-memory state is
    // still enough for list -> detail -> back within this document.
  }
  return undefined
}

function ensureSession(): void {
  const storage = storageIdentity()
  if (storage === knownStorage) return
  if (knownStorage !== undefined || storage !== undefined) {
    filterByRoute.clear()
    domainByRoute.clear()
  }
  knownStorage = storage
}

export function libraryRouteKey(libraryId?: number, showAll = false, mediaDomain?: LibraryMediaDomain): LibraryRouteKey {
  const base = showAll ? 'all' : `library:${libraryId ?? 'unknown'}`
  return mediaDomain ? `${base}:domain:${mediaDomain}` : base
}

export function readLibraryRouteDomain(key: LibraryRouteKey, fallback: LibraryMediaDomain = 'all'): LibraryMediaDomain {
  ensureSession()
  const existing = domainByRoute.get(key)
  if (existing) return existing
  domainByRoute.set(key, fallback)
  return fallback
}

export function writeLibraryRouteDomain(key: LibraryRouteKey, value: LibraryMediaDomain): LibraryMediaDomain {
  ensureSession()
  domainByRoute.set(key, value)
  return value
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

const sortKeys = new Set<FilterState['sort']>(['name', 'size', 'file_count', 'rating', 'year'])
const viewKeys = new Set<FilterState['view']>(['table', 'poster'])
const orderKeys = new Set<FilterState['order']>(['asc', 'desc'])
const mediaDomainKeys = new Set<LibraryMediaDomain>(['all', 'anime', 'live_action', 'unknown'])

export function normalizeLibraryFilter(value: unknown, fallback: FilterState): FilterState {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const sort = sortKeys.has(candidate.sort as FilterState['sort']) ? candidate.sort as FilterState['sort'] : fallback.sort
  const view = viewKeys.has(candidate.view as FilterState['view']) ? candidate.view as FilterState['view'] : fallback.view
  const order = orderKeys.has(candidate.order as FilterState['order']) ? candidate.order as FilterState['order'] : fallback.order
  return {
    q: typeof candidate.q === 'string' ? candidate.q : fallback.q,
    tag: strings(candidate.tag),
    status: strings(candidate.status),
    // Only page-level media domains and explicit library routes define scope.
    // Drop the retired multi-library filter so it cannot remain invisibly active.
    libraryIds: [],
    mediaDomain: mediaDomainKeys.has(candidate.mediaDomain as LibraryMediaDomain)
      ? candidate.mediaDomain as LibraryMediaDomain
      : fallback.mediaDomain && mediaDomainKeys.has(fallback.mediaDomain) ? fallback.mediaDomain : 'all',
    tagMatch: candidate.tagMatch === 'all' ? 'all' : candidate.tagMatch === 'any' ? 'any' : fallback.tagMatch,
    showSeasons: typeof candidate.showSeasons === 'boolean' ? candidate.showSeasons : fallback.showSeasons,
    view,
    sort,
    order,
  }
}

export function readLibraryRouteFilter(key: LibraryRouteKey, fallback: FilterState): FilterState {
  ensureSession()
  const existing = filterByRoute.get(key)
  const view = readLibraryView()
  if (existing?.view === view && existing.libraryIds.length === 0) return existing
  const initial = { ...normalizeLibraryFilter(existing ?? fallback, fallback), view }
  filterByRoute.set(key, initial)
  return initial
}

export function writeLibraryRouteFilter(key: LibraryRouteKey, value: FilterState): FilterState {
  ensureSession()
  const next = { ...normalizeLibraryFilter(value, value), view: readLibraryView() }
  filterByRoute.set(key, next)
  return next
}

export function clearLibraryRouteFilter(key?: LibraryRouteKey): void {
  ensureSession()
  if (key === undefined) {
    filterByRoute.clear()
    domainByRoute.clear()
  }
  else {
    filterByRoute.delete(key)
    domainByRoute.delete(key)
  }
}
