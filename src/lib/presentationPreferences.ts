import { useSyncExternalStore } from 'react'
import { UI_PREF_KEYS, usePreferenceError } from './uiPreferences'

export type TitlePosition = 'overlay' | 'below'
export type LibraryViewMode = 'table' | 'poster'
export type PresentationScope = 'library' | 'favorite'
export type PresentationPin = 'view' | 'sort' | 'title' | 'season' | 'posterSize'
type Preference = 'libraryView' | 'libraryTitle' | 'favoriteTitle' | 'libraryPins' | 'favoritePins'
const keys: Record<Preference, string> = {
  libraryView: UI_PREF_KEYS.libraryView,
  libraryTitle: 'animeshelf.library-title-position',
  favoriteTitle: 'animeshelf.favorite-title-position',
  libraryPins: 'animeshelf.library-display-pins',
  favoritePins: 'animeshelf.favorite-display-pins',
}
const memory = new Map<Preference, string>()
const pinSnapshots = new Map<PresentationScope, PresentationPin[]>()
const pinSnapshotRaw = new Map<PresentationScope, string>()
const listeners = new Set<() => void>()
let storageIdentity: Storage | undefined
let error = ''
const PIN_ORDER: readonly PresentationPin[] = ['view', 'sort', 'title', 'season', 'posterSize']
const PIN_SET = new Set<PresentationPin>(PIN_ORDER)

function pinPreference(scope: PresentationScope): Preference {
  return scope === 'library' ? 'libraryPins' : 'favoritePins'
}

function normalizePins(value: unknown): PresentationPin[] {
  if (!Array.isArray(value)) return []
  const selected = new Set(value.filter((item): item is PresentationPin => typeof item === 'string' && PIN_SET.has(item as PresentationPin)))
  return PIN_ORDER.filter(item => selected.has(item))
}
function storage() {
  let current: Storage | undefined
  try { current = localStorage } catch { /* Session preferences still work. */ }
  if (current !== storageIdentity) { memory.clear(); pinSnapshots.clear(); pinSnapshotRaw.clear(); storageIdentity = current; error = '' }
  return current
}
function read(name: Preference): string {
  const target = storage()
  const cached = memory.get(name)
  if (cached) return cached
  let value: string | null = null
  let legacy: string | null = null
  try { value = target?.getItem(keys[name]) ?? null; legacy = target?.getItem(UI_PREF_KEYS.uiDesign) ?? null } catch { /* Use defaults. */ }
  if (name === 'libraryView') return value === 'poster' ? 'poster' : 'table'
  if (name === 'libraryPins' || name === 'favoritePins') {
    const pins = value ?? '[]'
    memory.set(name, pins)
    return pins
  }
  if (value === 'overlay' || value === 'below') return value
  // Migration is per preference. Explicit new preferences always win.
  const migrated = legacy === 'liquid' ? 'below' : 'overlay'
  memory.set(name, migrated)
  try { target?.setItem(keys[name], migrated) } catch { /* No loss of the current session choice. */ }
  return migrated
}
export function readLibraryView(): LibraryViewMode { return read('libraryView') as LibraryViewMode }
export function readTitlePosition(scope: 'library' | 'favorite'): TitlePosition { return read(`${scope}Title`) as TitlePosition }
export function readDisplayPins(scope: PresentationScope): PresentationPin[] {
  const raw = read(pinPreference(scope))
  if (pinSnapshotRaw.get(scope) === raw) return pinSnapshots.get(scope) ?? []
  let next: PresentationPin[] = []
  try { next = normalizePins(JSON.parse(raw)) } catch { /* Treat malformed preferences as empty. */ }
  pinSnapshotRaw.set(scope, raw)
  pinSnapshots.set(scope, next)
  return next
}
function set(name: Preference, value: string): boolean {
  const target = storage()
  memory.set(name, value)
  let saved = false
  try { if (target) { target.setItem(keys[name], value); saved = true } } catch { /* Keep immediate feedback. */ }
  error = saved ? '' : '显示偏好已生效，但无法保存到本机；刷新后可能恢复。'
  listeners.forEach(listener => listener())
  return saved
}
export function setLibraryView(value: LibraryViewMode) { return set('libraryView', value) }
export function setTitlePosition(scope: 'library' | 'favorite', value: TitlePosition) { return set(`${scope}Title`, value) }
export function setDisplayPins(scope: PresentationScope, pins: PresentationPin[]): boolean {
  return set(pinPreference(scope), JSON.stringify(normalizePins(pins)))
}
export function toggleDisplayPin(scope: PresentationScope, pin: PresentationPin): boolean {
  const pins = readDisplayPins(scope)
  return setDisplayPins(scope, pins.includes(pin) ? pins.filter(item => item !== pin) : [...pins, pin])
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  const changed = (event: StorageEvent) => {
    for (const name of Object.keys(keys) as Preference[]) if (event.key === null || event.key === keys[name]) memory.delete(name)
    if (event.key === null || event.key === keys.libraryPins) { pinSnapshots.delete('library'); pinSnapshotRaw.delete('library') }
    if (event.key === null || event.key === keys.favoritePins) { pinSnapshots.delete('favorite'); pinSnapshotRaw.delete('favorite') }
    listener()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', changed)
  return () => { listeners.delete(listener); if (typeof window !== 'undefined') window.removeEventListener('storage', changed) }
}
export function useLibraryView() { return useSyncExternalStore(subscribe, readLibraryView, readLibraryView) }
export function useTitlePosition(scope: 'library' | 'favorite') {
  const snapshot = () => readTitlePosition(scope)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function useDisplayPins(scope: PresentationScope) {
  const snapshot = () => readDisplayPins(scope)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function usePresentationError() {
  const localError = usePreferenceError()
  return useSyncExternalStore(subscribe, () => error, () => '') || localError
}
