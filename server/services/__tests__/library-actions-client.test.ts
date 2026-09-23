import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getFolderRenameHistory,
  openFolderLocation,
  relinkFolder,
  revealFileLocation,
  undoFolderRename,
  updateFolderDisplayName,
} from '../../../src/lib/libraryActions'

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response

afterEach(() => vi.unstubAllGlobals())

describe('library action client', () => {
  it('uses the display-name, history, undo, and relink contracts', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ name: 'Displayed' }))
      .mockResolvedValueOnce(ok({ items: [] }))
      .mockResolvedValueOnce(ok({ id: 7, name: 'Show', path: 'D:\\Anime\\Show', libraryId: 1 }))
      .mockResolvedValueOnce(ok({ id: 7, name: 'Show', path: 'D:\\Anime\\Moved', libraryId: 1 }))
    vi.stubGlobal('fetch', fetch)

    await updateFolderDisplayName(7, 'Displayed')
    await getFolderRenameHistory(7)
    await undoFolderRename(7, 'op-1', 'D:\\Anime\\Show')
    await relinkFolder(7, 'D:\\Anime\\Show', 'D:\\Anime\\Moved')

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/folders/7/display-name', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Displayed' }) }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/folders/7/rename-history', { headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }, cache: 'no-store' })
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/folders/7/undo-rename', expect.objectContaining({ method: 'POST', body: JSON.stringify({ operationId: 'op-1', expectedPath: 'D:\\Anime\\Show' }) }))
    expect(fetch).toHaveBeenNthCalledWith(4, '/api/folders/7/relink', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedPath: 'D:\\Anime\\Show', path: 'D:\\Anime\\Moved' }) }))
  })

  it('marks local Explorer actions as owner requests', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ ok: true, path: 'D:\\Anime\\Show' }))
    vi.stubGlobal('fetch', fetch)

    await openFolderLocation(7)
    await revealFileLocation(9)

    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ method: 'POST', headers: { 'X-AnimeShelf-Owner': '1' } })
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/local-files/folder/7/open',
      '/api/local-files/file/9/reveal',
    ])
  })
})
