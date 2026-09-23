import { useSyncExternalStore } from 'react'

export const UI_PREF_KEYS = {
  uiDesign: 'animeshelf.ui-design',
  sidebarCollapsed: 'animeshelf.sidebar-collapsed',
  sidebarPinned: 'animeshelf.sidebar-pinned',
  motionLevel: 'animeshelf.motion-level',
  libraryView: 'animeshelf.view',
  libraryShowSeasons: 'animeshelf.library-show-seasons',
  posterCardWidth: 'wall-card-width',
  favoriteCardWidth: 'fav-card-width',
  favoriteFontScale: 'fav-font-scale',
  favoriteSynopsisAlpha: 'fav-synopsis-alpha',
  favoriteAnimationDuration: 'fav-anim-dur',
  favoriteView: 'animeshelf.favorite-view',
  mediaCatalogOpen: 'animeshelf.media-catalog-open',
} as const

export function mediaCatalogWorkGroupOpenKey(rootFolderId: number, groupId: number): string {
  return `animeshelf.media-catalog-work-group-open:${rootFolderId}:${groupId}`
}

const sessionPreferences = new Map<string, string>()
let preferenceStorage: Storage | undefined
let preferenceError = ''
function storage(): Storage | undefined {
  let current: Storage | undefined
  try { current = localStorage } catch { /* A denied storage getter must not break controls. */ }
  if (current !== preferenceStorage) { sessionPreferences.clear(); preferenceError = ''; preferenceStorage = current }
  return current
}
function storedPref(key: string): string | null {
  const target = storage()
  if (sessionPreferences.has(key)) return sessionPreferences.get(key)!
  try { return target?.getItem(key) ?? null } catch { return null }
}

export function readStringPref<T extends string>(key: string, fallback: T, allowed?: readonly T[]): T {
  const value = storedPref(key)
  if (!value) return fallback
  if (allowed && !allowed.includes(value as T)) return fallback
  return value as T
}

export function readNumberPref(key: string, fallback: number, min: number, max: number): number {
  const stored = storedPref(key)
  if (stored == null || stored.trim() === '') return fallback
  const value = Number(stored)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

export function readBooleanPref(key: string, fallback = false): boolean {
  const value = storedPref(key)
  if (value == null) return fallback
  return value === '1'
}

export function writePref(key: string, value: string | number | boolean): boolean {
  const target = storage()
  const serialized = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  sessionPreferences.set(key, serialized)
  try {
    if (!target) throw new Error('Storage unavailable')
    target.setItem(key, serialized)
    preferenceError = ''
  } catch { preferenceError = '显示偏好已生效，但无法保存到本机；刷新后可能恢复。' }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('animeshelf:preferences'))
  return preferenceError === ''
}

function subscribePreferences(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => { if (event.key === null) sessionPreferences.clear(); else sessionPreferences.delete(event.key); onChange() }
  window.addEventListener('storage', onStorage)
  window.addEventListener('animeshelf:preferences', onChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('animeshelf:preferences', onChange)
  }
}
export function usePreferenceError(): string { return useSyncExternalStore(subscribePreferences, () => preferenceError, () => '') }

export function useNumberPref(key: string, fallback: number, min: number, max: number): number {
  const snapshot = () => readNumberPref(key, fallback, min, max)
  return useSyncExternalStore(subscribePreferences, snapshot, snapshot)
}
