import { useSyncExternalStore } from 'react'
import { UI_PREF_KEYS } from './uiPreferences'

export type MotionLevel = 'minimal' | 'balanced' | 'rich'
export type MotionKind = 'press' | 'segment' | 'menu' | 'dialog' | 'sidebar' | 'content'
const durations: Record<MotionLevel, Record<MotionKind, number>> = {
  minimal: { press: 0, segment: 0, menu: 0, dialog: 0, sidebar: 0, content: 0 },
  balanced: { press: 100, segment: 160, menu: 160, dialog: 200, sidebar: 160, content: 160 },
  rich: { press: 160, segment: 200, menu: 200, dialog: 250, sidebar: 250, content: 180 },
}
export const normalizeMotionLevel = (value: unknown): MotionLevel => value === 'minimal' || value === 'rich' ? value : 'balanced'
let memoryLevel: MotionLevel | undefined
const listeners = new Set<() => void>()

export function readMotionLevel(): MotionLevel {
  if (memoryLevel) return memoryLevel
  try { return normalizeMotionLevel(localStorage.getItem(UI_PREF_KEYS.motionLevel)) } catch { return 'balanced' }
}
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
export function motionDuration(kind: MotionKind, level = readMotionLevel(), reduce = reducedMotion()): number {
  return reduce ? Math.min(100, durations[level][kind]) : durations[level][kind]
}
function applyMotion() {
  if (typeof document !== 'undefined') {
    const level = readMotionLevel(), reduce = reducedMotion(), root = document.documentElement
    root.dataset.motionLevel = level
    root.dataset.reducedMotion = String(reduce)
    for (const kind of Object.keys(durations[level]) as MotionKind[]) {
      root.style.setProperty(`--ui-duration-${kind}`, `${motionDuration(kind, level, reduce)}ms`)
    }
  }
  listeners.forEach(listener => listener())
}
export function setMotionLevel(level: MotionLevel): boolean {
  memoryLevel = normalizeMotionLevel(level)
  let saved = true
  try { localStorage.setItem(UI_PREF_KEYS.motionLevel, memoryLevel) } catch { saved = false }
  applyMotion()
  return saved
}
export function initializeMotion() {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const storage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== UI_PREF_KEYS.motionLevel) return
    memoryLevel = undefined
    applyMotion()
  }
  window.addEventListener('storage', storage)
  media.addEventListener('change', applyMotion)
  applyMotion()
  return () => { window.removeEventListener('storage', storage); media.removeEventListener('change', applyMotion) }
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => `${readMotionLevel()}:${reducedMotion()}`
export function useMotion() {
  const value = useSyncExternalStore(subscribe, snapshot, () => 'balanced:false')
  const [level, reduced] = value.split(':')
  return { level: level as MotionLevel, reduced: reduced === 'true' }
}
