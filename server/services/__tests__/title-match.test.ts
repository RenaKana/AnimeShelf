import { describe, expect, it } from 'vitest'
import { normalizeLibraryTitle, titlesLikelySame } from '../title-match'

describe('library title matching', () => {
  it('matches the same title after removing release metadata', () => {
    expect(normalizeLibraryTitle('[VCB-Studio] 命运石之门 (Steins;Gate) [2011]')).toBe('命运石之门')
    expect(titlesLikelySame('命运石之门', '[VCB-Studio] 命运石之门 (Steins;Gate) [2011]')).toBe(true)
  })

  it('does not treat a franchise container as a new installment', () => {
    expect(titlesLikelySame('飙马野郎 JOJO的奇妙冒险 第一赛段', 'JOJO的奇妙冒险')).toBe(false)
    expect(titlesLikelySame('JOJO的奇妙冒险 石之海', 'JOJO的奇妙冒险')).toBe(false)
  })

  it('preserves season distinctions during fallback matching', () => {
    expect(titlesLikelySame('间谍过家家 Season 2', '间谍过家家')).toBe(false)
  })
})
