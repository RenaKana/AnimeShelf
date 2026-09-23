import { describe, expect, it } from 'vitest'
import { classifyCollection } from '../shared/collections'

describe('download collection classification', () => {
  it.each([
    '[Group] Show 全集 [1080p]',
    '[Group] Show 全季 [1080p]',
    '[Group] Show 全 24 話 [1080p]',
    '[Group] Show Complete [1080p]',
    '[Group] Show [Batch] [1080p]',
    '[Group] Show - Batch 1080p',
    '[Group] Show Batch',
    '[Group] Show [01-12 END] [1080p]',
    '[Group] Show [S1-2 Fin] [1080p]',
    '[Group] Show Season 1-3 完结 [1080p]',
    '[Group] Show [2026-09-10] [01-12 END]',
  ])('accepts an explicit collection release: %s', title => {
    expect(classifyCollection(title)).toBe(true)
  })

  it.each([
    '[Group] Incomplete Hero - 03 [1080p]',
    '[Group] The Bad Batch - 03 [1080p]',
    '[Group] Show - 12 END [1080p]',
    '[Group] Show - 12 Fin [1080p]',
    '[Group] Show Final [1080p]',
    '[Group] Show [01-12] [1080p]',
    '[Group] Show BDRip [68 GB]',
    '[Group] Show S2 END [1080p]',
    '[Group] Show [2026-09-10] - 12 END',
  ])('rejects an ambiguous or single-episode release: %s', title => {
    expect(classifyCollection(title)).toBe(false)
  })

  it('accepts a source-confirmed collection without title evidence', () => {
    expect(classifyCollection('[Group] The Bad Batch - 03 [1080p]', true)).toBe(true)
  })
})
