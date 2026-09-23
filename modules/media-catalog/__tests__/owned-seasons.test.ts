import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { rebuildLibraryMediaCatalog, setManualMediaCatalog } from '../server/media-catalog'
import { getOwnedSeasons } from '../server/owned-seasons'

function ensureMissingColumns(db: any): void {
  for (const table of ['folders', 'files']) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
    if (!columns.has('path_missing')) db.exec(`ALTER TABLE ${table} ADD COLUMN path_missing INTEGER NOT NULL DEFAULT 0`)
  }
}

describe('owned season lookup', () => {
  let db: any
  let showId: number
  let multiSeasonId: number
  let manualSeasonId: number
  let movieId: number
  let missingFolderId: number
  let missingFileFolderId: number
  let emptyManualId: number

  beforeEach(() => {
    db = createDb(':memory:')
    ensureMissingColumns(db)
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const folders = makeFolderDb(db)
    folders.upsertTree(library.id, [
      'D:\\Anime',
      'D:\\Anime\\Show',
      'D:\\Anime\\Show\\S01-S02',
      'D:\\Anime\\Show\\Manual release',
      'D:\\Anime\\Show\\Movie',
      'D:\\Anime\\Show\\Season 4',
      'D:\\Anime\\Show\\Season 5',
      'D:\\Anime\\Show\\Empty manual',
    ])
    const rows = db.prepare('SELECT id, path FROM folders WHERE library_id = ?').all(library.id) as Array<{ id: number; path: string }>
    const id = (suffix: string) => rows.find(row => row.path === `D:\\Anime\\Show${suffix}`)!.id
    showId = id('')
    multiSeasonId = id('\\S01-S02')
    manualSeasonId = id('\\Manual release')
    movieId = id('\\Movie')
    missingFolderId = id('\\Season 4')
    missingFileFolderId = id('\\Season 5')
    emptyManualId = id('\\Empty manual')
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(showId)

    const files = makeFileDb(db)
    files.upsertMany(library.id, [
      [multiSeasonId, 'S01-S02', '01.mkv'],
      [manualSeasonId, 'Manual release', 'episode.mkv'],
      [movieId, 'Movie', 'movie.mkv'],
      [missingFolderId, 'Season 4', 'S04E01.mkv'],
      [missingFileFolderId, 'Season 5', 'S05E01.mkv'],
    ].map(([folderId, folderName, fileName]) => ({
      folder_id: Number(folderId),
      path: `D:\\Anime\\Show\\${folderName}\\${fileName}`,
      name: String(fileName),
      size: 1,
      date_modified: 1,
      ext: 'mkv',
    })))

    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, manualSeasonId, { kind: 'season', seasonNumbers: [7] })
    setManualMediaCatalog(db, emptyManualId, { kind: 'season', seasonNumbers: [8] })
    db.prepare('UPDATE folders SET path_missing = 1 WHERE id = ?').run(missingFolderId)
    db.prepare('UPDATE files SET path_missing = 1 WHERE folder_id = ?').run(missingFileFolderId)
  })

  afterEach(() => db.close())

  it('deduplicates positive canonical seasons in the requested physical subtree and honors manual classification', () => {
    expect(getOwnedSeasons(db, [showId]).get(showId)).toEqual([1, 2, 7])
    expect(getOwnedSeasons(db, [multiSeasonId]).get(multiSeasonId)).toEqual([1, 2])
    expect(getOwnedSeasons(db, [manualSeasonId]).get(manualSeasonId)).toEqual([7])
  })

  it('excludes non-main classifications, missing inventory, and mappings without a present main video', () => {
    const result = getOwnedSeasons(db, [movieId, missingFolderId, missingFileFolderId, emptyManualId])
    expect(result.get(movieId)).toEqual([])
    expect(result.get(missingFolderId)).toEqual([])
    expect(result.get(missingFileFolderId)).toEqual([])
    expect(result.get(emptyManualId)).toEqual([])
  })

  it('returns stable empty entries for missing and invalid requested folders', () => {
    expect(getOwnedSeasons(db, [999_999, -1, Number.NaN])).toEqual(new Map([[999_999, []]]))
  })
})
