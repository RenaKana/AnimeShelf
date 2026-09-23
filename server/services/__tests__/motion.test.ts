import { describe, expect, it } from 'vitest'
import { motionDuration, normalizeMotionLevel, type MotionKind } from '../../../src/lib/motion'
describe('shared motion policy', () => {
  it('defaults missing and invalid preferences to balanced, preserves all three levels', () => {
    for (const value of [null, undefined, '', 'legacy', 3]) expect(normalizeMotionLevel(value)).toBe('balanced')
    for (const value of ['minimal', 'balanced', 'rich']) expect(normalizeMotionLevel(value)).toBe(value)
  })
  it('controls every shared surface and system reduction takes precedence', () => {
    const kinds: MotionKind[] = ['press', 'segment', 'menu', 'dialog', 'sidebar', 'content']
    for (const kind of kinds) {
      expect(motionDuration(kind, 'minimal', false)).toBe(0)
      for (const level of ['balanced', 'rich'] as const) {
        expect(motionDuration(kind, level, false)).toBeGreaterThan(0)
        expect(motionDuration(kind, level, false)).toBeLessThanOrEqual(250)
        expect(motionDuration(kind, level, true)).toBeLessThanOrEqual(100)
      }
    }
  })
})
