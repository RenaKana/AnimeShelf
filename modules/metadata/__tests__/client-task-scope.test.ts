import { afterEach, describe, expect, it, vi } from 'vitest'
import { metadataApi } from '../client/api'

afterEach(() => vi.unstubAllGlobals())

describe('poster task restore scope', () => {
  it.each([[], [0], [NaN], [-1], [1.5]])('rejects invalid explicit roots without requesting a broader job: %j', async (...ids: number[]) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(metadataApi.latestPosterRepair(undefined, false, ids)).rejects.toThrow('有效作品')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves scoped roots and the legacy unscoped lookup separately', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => null })
    vi.stubGlobal('fetch', fetch)
    await metadataApi.latestPosterRepair(undefined, false, [7, 12])
    await metadataApi.latestPosterRepair(4)
    const urls = fetch.mock.calls.map(([url]) => new URL(url, 'http://localhost'))
    expect(urls[0].searchParams.get('folderIds')).toBe('7,12')
    expect(urls[1].searchParams.has('folderIds')).toBe(false)
    expect(urls[1].searchParams.get('libraryId')).toBe('4')
  })
})
