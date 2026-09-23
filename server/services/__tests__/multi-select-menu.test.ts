import { describe, expect, it } from 'vitest'
import { shouldToggleMultiSelectOption } from '../../../src/components/ui/MultiSelectMenu'

describe('MultiSelectMenu keyboard activation', () => {
  it('activates an option with Enter or Space but leaves the clear-all control alone', () => {
    for (const key of ['Enter', ' ', 'Spacebar']) {
      expect(shouldToggleMultiSelectOption(key, 'option')).toBe(true)
      expect(shouldToggleMultiSelectOption(key, undefined)).toBe(false)
      expect(shouldToggleMultiSelectOption(key, 'clear-all')).toBe(false)
    }
    expect(shouldToggleMultiSelectOption('ArrowDown', 'option')).toBe(false)
  })
})
