import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDb } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import * as mediaCatalog from '../server/media-catalog'
import {
  identifyMediaFolder,
  rebuildLibraryMediaCatalog,
  getCanonicalMediaCatalogForRoot,
  getMediaCatalogForFolder,
  addMediaItemSource,
  setManualMediaCatalog,
  setMediaCatalogTitle,
} from '../server/media-catalog'

describe('identifyMediaFolder', () => {
  it('recognizes English and Chinese season markers', () => {
    expect(identifyMediaFolder({ name: 'Show S2' }).seasonNumbers).toEqual([2])
    expect(identifyMediaFolder({ name: 'Show Season 2' }).seasonNumbers).toEqual([2])
    expect(identifyMediaFolder({ name: 'Show 第二季' }).seasonNumbers).toEqual([2])
    expect(identifyMediaFolder({ name: 'Show 第2期' }).seasonNumbers).toEqual([2])
  })

  it('expands a season range and preserves a part number', () => {
    expect(identifyMediaFolder({ name: 'Show S01-S02 Part 1' })).toMatchObject({
      kind: 'season',
      seasonNumbers: [1, 2],
      partNumber: 1,
    })
  })

  it('inherits extras classification from an SPs ancestor', () => {
    expect(identifyMediaFolder({ name: 'Vol.1', ancestorNames: ['Show', 'SPs'] })).toMatchObject({
      kind: 'extras',
      seasonNumbers: [],
    })
  })

  it('keeps an explicit season when unrelated movie ancestors are present', () => {
    expect(identifyMediaFolder({
      name: 'Season 1',
      ancestorNames: ['Movies', 'Show'],
    })).toMatchObject({
      kind: 'season',
      seasonNumbers: [1],
    })
    expect(identifyMediaFolder({
      name: 'Season 1',
      ancestorNames: ['Movie Collection'],
    })).toMatchObject({
      kind: 'season',
      seasonNumbers: [1],
    })
  })

  it('does not inherit a distant extras marker through an unrelated folder', () => {
    expect(identifyMediaFolder({
      name: 'Disc 1',
      ancestorNames: ['Show', 'SPs', 'Vol.1'],
    })).toMatchObject({
      kind: 'unknown',
      seasonNumbers: [],
    })
  })

  it('classifies numbered SPs collections as extras', () => {
    expect(identifyMediaFolder({ name: 'SPs 01-06' })).toMatchObject({
      kind: 'extras',
      seasonNumbers: [],
    })
  })

  it('classifies common disc extras folders instead of leaving them pending', () => {
    for (const name of ['PV', 'CM', 'Preview', 'Previews', 'Sample', 'Samples', 'BD menu', 'Menus', 'CDs', 'Scans', 'Fonts', 'Trailers', '特典映像', 'NCOP', 'NCOP&NCED']) {
      expect(identifyMediaFolder({ name })).toMatchObject({ kind: 'extras', seasonNumbers: [] })
    }
  })

  it('uses TV episode evidence instead of classifying a mixed TV and SP release as special', () => {
    expect(identifyMediaFolder({
      name: 'Example Show [TV + SP]',
      fileNames: ['Example Show S01E01.mkv', 'Example Show SP01.mkv'],
    })).toMatchObject({
      kind: 'season',
      seasonNumbers: [1],
    })
    expect(identifyMediaFolder({
      name: 'Example Show [TV + SP]',
      fileNames: ['01.mkv', 'SP01.mkv'],
    })).toMatchObject({
      kind: 'unknown',
      seasonNumbers: [],
    })
  })

  it('does not turn a full main-release directory into extras because its name mentions bundled bonuses', () => {
    for (const name of [
      '[DBD-Raws][JOJO的奇妙冒险 不灭钻石][01-39全集+特典][1080P][BDRip]',
      '[DBD-Raws][JOJO的奇妙冒险 黄金之风][01-39全集+NCOP&NCED][1080P][BDRip]',
    ]) {
      expect(identifyMediaFolder({ name, fileNames: ['01.mkv', '02.mkv'] })).toMatchObject({
        kind: 'unknown',
        seasonNumbers: [],
      })
    }
  })

  it('does not assign seasons to movie or OVA folders', () => {
    expect(identifyMediaFolder({ name: 'Movie 剧场版 S1' })).toMatchObject({ kind: 'movie', seasonNumbers: [] })
    expect(identifyMediaFolder({ name: 'OVA S2' })).toMatchObject({ kind: 'ova', seasonNumbers: [] })
  })

  it('records a conflict when directory and file season markers disagree', () => {
    const result = identifyMediaFolder({ name: 'Show Season 2', fileNames: ['Show S01E01.mkv'] })
    expect(result).toMatchObject({ kind: 'season', seasonNumbers: [2] })
    expect(result.conflictReason).toContain('directory season 2')
    expect(result.conflictReason).toContain('file season 1')
    expect(result.confidence).toBeLessThan(0.8)
  })
})

describe('rebuildLibraryMediaCatalog', () => {
  let db: any
  let library: any

  beforeEach(() => {
    db = createDb(':memory:')
    library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
  })

  afterEach(() => db.close())

  function seedFolderTree(paths: string[], videoPaths: string[], seriesPath = 'D:\\Anime\\Show') {
    makeFolderDb(db).upsertTree(library.id, paths)
    const rows = db.prepare('SELECT id, path FROM folders WHERE library_id = ?').all(library.id) as { id: number; path: string }[]
    db.prepare('UPDATE folders SET is_series = 0 WHERE library_id = ?').run(library.id)
    const root = rows.find(row => row.path === seriesPath)
    if (!root) throw new Error(`missing series root ${seriesPath}`)
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(root.id)
    const insert = db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, size, date_modified, ext)
      VALUES (?, ?, ?, ?, 1, 1, ?)
    `)
    try {
      for (const filePath of videoPaths) {
        const folderPath = path.win32.dirname(filePath)
        const folder = rows.find(row => row.path === folderPath)
        if (!folder) throw new Error(`missing video folder ${folderPath}`)
        const name = path.win32.basename(filePath)
        insert.run([folder.id, library.id, name, filePath, path.win32.extname(name).slice(1).toLowerCase()])
      }
    } finally {
      insert.finalize()
    }
  }

  it('rebuilds one default series while keeping source-less unknown media and exposing only extras as candidates', () => {
    seedFolderTree([
      'D:\\Anime',
      'D:\\Anime\\Show',
      'D:\\Anime\\Show\\Season 2',
      'D:\\Anime\\Show\\S01-S02',
      'D:\\Anime\\Show\\SPs',
      'D:\\Anime\\Show\\SPs\\Vol.1',
      'D:\\Anime\\Show\\Movie',
      'D:\\Anime\\Show\\OVA',
      'D:\\Anime\\Show\\Feature',
    ], [
      'D:\\Anime\\Show\\Season 2\\S02E01.mkv',
      'D:\\Anime\\Show\\S01-S02\\01.mkv',
      'D:\\Anime\\Show\\SPs\\Vol.1\\sp.mkv',
      'D:\\Anime\\Show\\Movie\\movie.mkv',
      'D:\\Anime\\Show\\OVA\\ova.mkv',
      'D:\\Anime\\Show\\Feature\\feature.mkv',
    ])
    const seasonFolder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Season 2') as any
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 12345 WHERE id = ?").run(seasonFolder.id)

    const result = rebuildLibraryMediaCatalog(db, library.id)
    expect(result).toMatchObject({ rootCount: 1, foldersProcessed: 6, seasonEntries: 3, unknownEntries: 1 })
    expect(result.inserted).toBe(6)

    const rows = db.prepare(`
      SELECT e.*, f.path AS folder_path
      FROM folder_media_entries e JOIN folders f ON f.id = e.folder_id
      ORDER BY folder_path, e.kind, e.season_number
    `).all() as any[]
    expect(rows.filter(row => row.kind === 'season').map(row => row.season_number)).toEqual([1, 2, 2])
    expect(rows.find(row => row.folder_path.endsWith('Season 2'))).toMatchObject({
      source: 'bangumi', external_id: '12345', detected_by: expect.stringContaining('directory'),
    })
    expect(rows.find(row => row.folder_path.endsWith('SPs\\Vol.1'))).toBeUndefined()
    expect(rows.find(row => row.folder_path.endsWith('Movie'))).toMatchObject({ kind: 'movie', season_number: null })
    expect(rows.find(row => row.folder_path.endsWith('OVA'))).toMatchObject({ kind: 'ova', season_number: null })
    expect(rows.find(row => row.folder_path.endsWith('Feature'))).toMatchObject({ kind: 'unknown', season_number: null })
    expect(getMediaCatalogForFolder(db, db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show').id).candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_path: 'D:\\Anime\\Show\\SPs\\Vol.1', reason: 'extras' }),
    ]))
    expect(getMediaCatalogForFolder(db, db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show').id).candidates.some(candidate => candidate.folder_path.endsWith('Feature'))).toBe(false)
  })

  it('preserves manual records while replacing automatic records', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any
    const season = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Season 1') as any
    rebuildLibraryMediaCatalog(db, library.id)
    const series = db.prepare('SELECT id FROM media_series WHERE series_key = ?').get('folder:' + root.id) as any
    db.prepare(`
      INSERT INTO folder_media_entries
        (folder_id, series_id, kind, season_number, source, external_id, confidence, detected_by, manual_locked)
      VALUES (?, ?, 'season', 9, 'manual', 'manual-9', 1, 'manual', 1)
    `).run([season.id, series.id])
    db.prepare("INSERT INTO folder_media_entries (folder_id, series_id, kind, season_number, confidence, detected_by, manual_locked) VALUES (?, ?, 'season', 99, 0.1, 'stale', 0)").run([season.id, series.id])

    const result = rebuildLibraryMediaCatalog(db, library.id)
    expect(result.preservedManual).toBe(1)
    expect(result.removedAutomatic).toBe(2)
    expect(db.prepare('SELECT season_number, manual_locked FROM folder_media_entries WHERE series_id = ? ORDER BY manual_locked, season_number').all(series.id)).toEqual([
      { season_number: 9, manual_locked: 1 },
    ])
  })

  it('records a conflict on rebuilt entries when files disagree with the directory season', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 2',
    ], ['D:\\Anime\\Show\\Season 2\\S01E01.mkv'])
    const result = rebuildLibraryMediaCatalog(db, library.id)
    expect(result.conflicts).toBe(1)
    const row = db.prepare('SELECT kind, season_number, confidence, conflict_reason FROM folder_media_entries').get() as any
    expect(row).toMatchObject({ kind: 'season', season_number: 2 })
    expect(row.conflict_reason).toContain('directory season 2')
    expect(row.confidence).toBeLessThan(0.8)
  })

  it('keeps the catalog after closing and reopening the database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-media-catalog-'))
    const file = path.join(dir, 'catalog.db')
    let persisted: any
    try {
      persisted = createDb(file)
      // Use one SQL batch here so no unfinalized helper statements keep the
      // sqlite3-wasm lock while the persistence handle is reopened.
      persisted.exec(`
        INSERT INTO libraries (name, root_path, type) VALUES ('Anime', 'D:\\Anime', 'anime');
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, NULL, 'Anime', 'D:\\Anime', 0);
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, 1, 'Show', 'D:\\Anime\\Show', 1);
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, 2, 'S01', 'D:\\Anime\\Show\\S01', 0);
        INSERT INTO files (folder_id, library_id, name, path, ext) VALUES (3, 1, '01.mkv', 'D:\\Anime\\Show\\S01\\01.mkv', 'mkv');
      `)
      rebuildLibraryMediaCatalog(persisted, 1)
      persisted.close()
      persisted = createDb(file)
      expect(persisted.prepare('SELECT kind, season_number FROM folder_media_entries').all()).toEqual([
        { kind: 'season', season_number: 1 },
      ])
      persisted.close()
      persisted = null
    } finally {
      try { persisted?.close() } catch { /* the reopened handle is already closed above */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the nearest series catalog with physical paths and a deterministic summary', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show',
      'D:\\Anime\\Show\\Season 2', 'D:\\Anime\\Show\\Season 1 Part 2',
      'D:\\Anime\\Show\\Movie',
    ], [
      'D:\\Anime\\Show\\Season 2\\S02E01.mkv',
      'D:\\Anime\\Show\\Season 1 Part 2\\S01E02.mkv',
      'D:\\Anime\\Show\\Movie\\movie.mkv',
    ])
    rebuildLibraryMediaCatalog(db, library.id)
    const season = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Season 2') as any

    const read = (mediaCatalog as any).getMediaCatalogForFolder
    expect(typeof read).toBe('function')
    if (typeof read !== 'function') return
    const result = read(db, season.id)

    expect(result.entries.map((entry: any) => [entry.kind, entry.season_number, entry.part_number])).toEqual([
      ['season', 1, 2],
      ['season', 2, null],
      ['movie', null, null],
    ])
    expect(result.entries[0]).toMatchObject({
      folder_name: 'Season 1 Part 2',
      folder_path: 'D:\\Anime\\Show\\Season 1 Part 2',
      series_title: 'Show',
      series_key: expect.stringMatching(/^folder:\d+$/),
      manual_locked: 0,
      source: null,
      external_id: null,
    })
    expect(result.summary).toMatchObject({
      series_title: 'Show',
      entry_count: 3,
      season_numbers: [1, 2],
      manual_count: 0,
      conflict_count: 0,
      unknown_count: 0,
    })
  })

  it('persists manual entries for multiple seasons and keeps them after rebuild', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Unclear',
    ], ['D:\\Anime\\Show\\Unclear\\episode.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Unclear') as any
    rebuildLibraryMediaCatalog(db, library.id)

    const setManual = (mediaCatalog as any).setManualMediaCatalog
    expect(typeof setManual).toBe('function')
    if (typeof setManual !== 'function') return
    setManual(db, folder.id, { kind: 'season', seasonNumbers: [4, 5], partNumber: 2 })

    expect(db.prepare(`
      SELECT kind, season_number, part_number, manual_locked, source, confidence, detected_by
      FROM folder_media_entries WHERE folder_id = ? AND manual_locked = 1
      ORDER BY season_number
    `).all(folder.id)).toEqual([
      { kind: 'season', season_number: 4, part_number: 2, manual_locked: 1, source: 'manual', confidence: 1, detected_by: 'manual' },
      { kind: 'season', season_number: 5, part_number: 2, manual_locked: 1, source: 'manual', confidence: 1, detected_by: 'manual' },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id = ? AND manual_locked = 1').get(folder.id)).toEqual({ count: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id = ?').get(folder.id)).toEqual({ count: 2 })
  })

  it('clears manual entries and restores automatic detection', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Season 1') as any
    rebuildLibraryMediaCatalog(db, library.id)
    const setManual = (mediaCatalog as any).setManualMediaCatalog
    expect(typeof setManual).toBe('function')
    if (typeof setManual !== 'function') return
    setManual(db, folder.id, { kind: 'season', seasonNumbers: [9] })
    setManual(db, folder.id, { clearManual: true })

    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id = ? AND manual_locked = 1').get(folder.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT kind, season_number, manual_locked FROM folder_media_entries WHERE folder_id = ?').all(folder.id)).toEqual([
      { kind: 'season', season_number: 1, manual_locked: 0 },
    ])
  })

  it('mirrors manual classification into the canonical mapping and restores it with auto', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Unclear',
    ], ['D:\\Anime\\Show\\Unclear\\episode.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Unclear') as any
    const setManual = (mediaCatalog as any).setManualMediaCatalog
    expect(typeof setManual).toBe('function')
    if (typeof setManual !== 'function') return

    setManual(db, folder.id, { kind: 'season', seasonNumbers: [7], partNumber: 1 })
    expect(db.prepare(`
      SELECT kind, season_number, part_number, manual_locked, detected_by
      FROM folder_media_mappings WHERE folder_id = ?
    `).all(folder.id)).toEqual([{
      kind: 'season', season_number: 7, part_number: 1, manual_locked: 1, detected_by: 'manual',
    }])

    setManual(db, folder.id, { clearManual: true })
    expect(db.prepare(`
      SELECT kind, season_number, part_number, manual_locked
      FROM folder_media_mappings WHERE folder_id = ?
    `).all(folder.id)).toEqual([{ kind: 'season', season_number: 1, part_number: null, manual_locked: 0 }])
    expect(getMediaCatalogForFolder(db, folder.id).candidates.some(candidate => candidate.folder_id === folder.id)).toBe(false)
  })

  it('stores a custom manual label as unknown rows and projects it back as custom', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Higurashi 業',
    ], ['D:\\Anime\\Show\\Higurashi 業\\episode.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Higurashi 業') as any

    const snapshot = setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '  业  ' })
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: folder.id, kind: 'custom', custom_label: '业', season_number: null, manual_locked: 1 }),
    ]))
    expect(snapshot.canonical?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'custom', custom_label: '业' }),
    ]))
    expect(snapshot.canonical?.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: folder.id, kind: 'custom', custom_label: '业', content_role: 'main', manual_locked: 1 }),
    ]))

    expect(db.prepare('SELECT kind, custom_label FROM folder_media_entries WHERE folder_id = ?').all(folder.id)).toEqual([
      { kind: 'unknown', custom_label: '业' },
    ])
    expect(db.prepare('SELECT kind, custom_label, content_role FROM folder_media_mappings WHERE folder_id = ?').all(folder.id)).toEqual([
      { kind: 'unknown', custom_label: '业', content_role: 'main' },
    ])
    expect(db.prepare('SELECT kind FROM media_items').all()).toEqual([{ kind: 'unknown' }])

    rebuildLibraryMediaCatalog(db, library.id)
    const rebuilt = getMediaCatalogForFolder(db, folder.id)
    expect(rebuilt.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: folder.id, kind: 'custom', custom_label: '业', manual_locked: 1 }),
    ]))
    expect(rebuilt.canonical?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'custom', custom_label: '业' }),
    ]))
  })

  it('requires a non-empty bounded custom label and rejects season numbers for custom folders', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Unclear',
    ], ['D:\\Anime\\Show\\Unclear\\episode.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Unclear') as any

    expect(() => setManualMediaCatalog(db, folder.id, { kind: 'custom' })).toThrow(/customLabel/i)
    expect(() => setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '   ' })).toThrow(/customLabel/i)
    expect(() => setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: 'x'.repeat(33) })).toThrow(/customLabel/i)
    expect(() => setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '礼', seasonNumbers: [1] })).toThrow(/season/i)
  })

  it('clears a saved custom label when restoring automatic detection', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Unclear',
    ], ['D:\\Anime\\Show\\Unclear\\S01E01.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Unclear') as any

    setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '礼' })
    setManualMediaCatalog(db, folder.id, { clearManual: true })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id = ? AND manual_locked = 1').get(folder.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE folder_id = ? AND manual_locked = 1').get(folder.id)).toEqual({ count: 0 })
    expect(getMediaCatalogForFolder(db, folder.id).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'season', season_number: 1, custom_label: null, manual_locked: 0 }),
    ]))
  })

  it('keeps custom labels in the canonical key so two labels cannot merge by source id', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show',
      'D:\\Anime\\Show\\Arc A', 'D:\\Anime\\Show\\Arc B',
    ], [
      'D:\\Anime\\Show\\Arc A\\episode.mkv',
      'D:\\Anime\\Show\\Arc B\\episode.mkv',
    ])
    const folders = db.prepare('SELECT id, path FROM folders WHERE path IN (?, ?) ORDER BY path').all([
      'D:\\Anime\\Show\\Arc A', 'D:\\Anime\\Show\\Arc B',
    ]) as any[]
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9001 WHERE id IN (?, ?)").run([folders[0].id, folders[1].id])

    setManualMediaCatalog(db, folders[0].id, { kind: 'custom', customLabel: '业' })
    setManualMediaCatalog(db, folders[1].id, { kind: 'custom', customLabel: '卒' })
    const customItems = getCanonicalMediaCatalogForRoot(db, (db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any).id).items
      .filter(item => item.kind === 'custom')
    expect(customItems).toHaveLength(2)
    expect(customItems.map(item => item.custom_label).sort()).toEqual(['业', '卒'])
    expect(customItems.map(item => item.item_key)).toEqual(expect.arrayContaining([
      expect.stringContaining('custom:'),
    ]))
  })

  it('does not attach source identities to custom canonical items or merge them with same-source automatic items', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show',
      'D:\\Anime\\Show\\Higurashi 業', 'D:\\Anime\\Show\\Higurashi Season 1',
    ], [
      'D:\\Anime\\Show\\Higurashi 業\\episode.mkv',
      'D:\\Anime\\Show\\Higurashi Season 1\\episode.mkv',
    ])
    const folders = db.prepare('SELECT id, path FROM folders WHERE path IN (?, ?) ORDER BY path').all([
      'D:\\Anime\\Show\\Higurashi 業', 'D:\\Anime\\Show\\Higurashi Season 1',
    ]) as any[]
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9101 WHERE id IN (?, ?)").run([folders[0].id, folders[1].id])

    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, folders[0].id, { kind: 'custom', customLabel: '业' })

    const customItem = db.prepare("SELECT id, item_key, kind FROM media_items WHERE item_key LIKE 'custom:%'").get() as any
    expect(customItem).toMatchObject({ kind: 'unknown' })
    expect(db.prepare('SELECT source, external_id FROM media_item_sources WHERE media_item_id = ?').all(customItem.id)).toEqual([])

    const mappingItems = db.prepare(`
      SELECT folder_id, media_item_id
      FROM folder_media_mappings
      WHERE folder_id IN (?, ?)
      ORDER BY folder_id
    `).all([folders[0].id, folders[1].id]) as any[]
    expect(mappingItems).toHaveLength(2)
    expect(mappingItems[0].media_item_id).not.toBe(mappingItems[1].media_item_id)
  })

  it('removes a restored custom canonical item instead of reusing it for automatic detection', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Higurashi 業',
    ], ['D:\\Anime\\Show\\Higurashi 業\\S01E01.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Higurashi 業') as any
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9102 WHERE id = ?").run(folder.id)

    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '业' })
    const customItem = db.prepare("SELECT id FROM media_items WHERE item_key LIKE 'custom:%'").get() as any
    expect(customItem).toBeTruthy()
    // Simulate a database written by the previous implementation, where a
    // custom item incorrectly carried the folder's source identity.
    db.prepare(`
      INSERT OR IGNORE INTO media_item_sources (media_item_id, source, external_id, is_primary)
      VALUES (?, 'bangumi', '9102', 1)
    `).run(customItem.id)

    setManualMediaCatalog(db, folder.id, { clearManual: true })

    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(customItem.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT id, item_key, kind FROM media_items').all()).toEqual([
      expect.objectContaining({ item_key: 'bangumi:9102', kind: 'season' }),
    ])
  })

  it('replaces a custom canonical item inside a locked work group when its label changes', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Higurashi 業',
    ], ['D:\\Anime\\Show\\Higurashi 業\\episode.mkv'], 'D:\\Anime\\Show')
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Higurashi 業') as any

    setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '业' })
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const oldItem = before.items.find((item: any) => item.kind === 'custom')
    const group = before.work_groups.find((candidate: any) => candidate.item_ids.includes(oldItem.id))
    expect(oldItem).toBeTruthy()
    expect(group).toBeTruthy()

    db.prepare('UPDATE media_work_groups SET title = ?, manual_locked = 1 WHERE id = ?')
      .run(['寒蝉鸣泣之时', group.id])
    db.prepare(`
      UPDATE media_work_group_members
      SET relation_role = 'side_story', manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([group.id, oldItem.id])

    setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '卒' })

    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const newItem = after.items.find((item: any) => item.kind === 'custom' && item.custom_label === '卒')
    expect(newItem).toBeTruthy()
    expect(newItem.id).not.toBe(oldItem.id)
    expect(after.work_groups).toEqual([expect.objectContaining({
      id: group.id,
      title: '寒蝉鸣泣之时',
      manual_locked: 1,
      item_ids: [newItem.id],
      members: [expect.objectContaining({
        media_item_id: newItem.id,
        relation_role: 'side_story',
        manual_locked: 1,
      })],
      summary: expect.objectContaining({ physical_folder_count: 1 }),
    })])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE media_item_id = ?')
      .get(oldItem.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(oldItem.id))
      .toEqual({ count: 0 })
  })

  it('restores automatic detection without leaving a locked custom item ghost', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Higurashi Season 1',
    ], ['D:\\Anime\\Show\\Higurashi Season 1\\episode.mkv'], 'D:\\Anime\\Show')
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Higurashi Season 1') as any
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9201 WHERE id = ?").run(folder.id)

    setManualMediaCatalog(db, folder.id, { kind: 'custom', customLabel: '业' })
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const oldItem = before.items.find((item: any) => item.kind === 'custom')
    const group = before.work_groups.find((candidate: any) => candidate.item_ids.includes(oldItem.id))
    expect(oldItem).toBeTruthy()
    expect(group).toBeTruthy()

    db.prepare('UPDATE media_work_groups SET title = ?, manual_locked = 1 WHERE id = ?')
      .run(['寒蝉鸣泣之时', group.id])
    db.prepare(`
      UPDATE media_work_group_members
      SET relation_role = 'main', manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([group.id, oldItem.id])
    db.prepare(`
      INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run([root.id, oldItem.id])

    setManualMediaCatalog(db, folder.id, { clearManual: true })

    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const automatic = after.items.find((item: any) => item.item_key === 'bangumi:9201')
    expect(automatic).toMatchObject({ kind: 'season', season_number: 1 })
    expect(after.work_groups).toEqual([expect.objectContaining({
      id: group.id,
      title: '寒蝉鸣泣之时',
      manual_locked: 1,
      item_ids: [automatic.id],
      members: [expect.objectContaining({
        media_item_id: automatic.id,
        relation_role: 'main',
        manual_locked: 1,
      })],
      summary: expect.objectContaining({ physical_folder_count: 1 }),
    })])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE media_item_id = ?')
      .get(oldItem.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(oldItem.id))
      .toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_exclusions WHERE media_item_id = ?')
      .get(oldItem.id)).toEqual({ count: 0 })
  })

  it('sorts a custom canonical item using its projected custom kind', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show',
      'D:\\Anime\\Show\\Movie', 'D:\\Anime\\Show\\Higurashi 業',
    ], [
      'D:\\Anime\\Show\\Movie\\movie.mkv',
      'D:\\Anime\\Show\\Higurashi 業\\episode.mkv',
    ])
    const customFolder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Higurashi 業') as any
    setManualMediaCatalog(db, customFolder.id, { kind: 'custom', customLabel: '业' })

    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any
    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items.map((item: any) => item.kind)).toEqual(['custom', 'movie'])
    expect(snapshot.items[0]).toMatchObject({ custom_label: '业' })
  })

  it('rolls back clearing a manual entry when automatic rebuild fails', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Season 1') as any
    const setManual = (mediaCatalog as any).setManualMediaCatalog
    expect(typeof setManual).toBe('function')
    if (typeof setManual !== 'function') return
    setManual(db, folder.id, { kind: 'season', seasonNumbers: [9] })

    db.exec(`
      CREATE TRIGGER fail_media_catalog_rebuild
      BEFORE INSERT ON folder_media_entries
      WHEN NEW.manual_locked = 0
      BEGIN
        SELECT RAISE(ABORT, 'injected catalog rebuild failure');
      END;
    `)

    expect(() => setManual(db, folder.id, { clearManual: true })).toThrow('injected catalog rebuild failure')
    expect(db.prepare(`
      SELECT kind, season_number, manual_locked
      FROM folder_media_entries WHERE folder_id = ?
    `).all(folder.id)).toEqual([
      { kind: 'season', season_number: 9, manual_locked: 1 },
    ])
  })

  it('rejects invalid manual kind and non-positive season or part numbers', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Season 1') as any
    const setManual = (mediaCatalog as any).setManualMediaCatalog
    expect(typeof setManual).toBe('function')
    if (typeof setManual !== 'function') return

    expect(() => setManual(db, folder.id, { kind: 'side-story' })).toThrow(/kind/i)
    expect(() => setManual(db, folder.id, { kind: 'season', seasonNumbers: [0] })).toThrow(/season/i)
    expect(() => setManual(db, folder.id, { kind: 'season', seasonNumbers: [1.5] })).toThrow(/season/i)
    expect(() => setManual(db, folder.id, { kind: 'movie', partNumber: 0 })).toThrow(/part/i)
  })

  it('rebuilds every library for startup catalog backfill', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const second = makeLibraryDb(db).create('Other', 'D:\\Other', 'anime')
    makeFolderDb(db).upsertTree(second.id, ['D:\\Other', 'D:\\Other\\Series', 'D:\\Other\\Series\\Season 2'])
    const secondRows = db.prepare('SELECT id, path FROM folders WHERE library_id = ?').all(second.id) as any[]
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(secondRows.find(row => row.path === 'D:\\Other\\Series').id)
    db.prepare(`INSERT INTO files (folder_id, library_id, name, path, ext) VALUES (?, ?, 'S02E01.mkv', 'D:\\Other\\Series\\Season 2\\S02E01.mkv', 'mkv')`).run([
      secondRows.find(row => row.path === 'D:\\Other\\Series\\Season 2').id, second.id,
    ])

    const rebuildAll = (mediaCatalog as any).rebuildAllMediaCatalogs
    expect(typeof rebuildAll).toBe('function')
    if (typeof rebuildAll !== 'function') return
    const result = rebuildAll(db)

    expect(result.libraryCount).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries').get()).toEqual({ count: 2 })
  })

  it('backfills once per recognition rule version and skips unchanged startups', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const ensureCurrent = (mediaCatalog as any).ensureMediaCatalogsCurrent
    expect(typeof ensureCurrent).toBe('function')
    if (typeof ensureCurrent !== 'function') return

    const first = ensureCurrent(db, 'test-v1')
    const firstEntry = db.prepare('SELECT id FROM folder_media_entries').get() as any
    const second = ensureCurrent(db, 'test-v1')
    const secondEntry = db.prepare('SELECT id FROM folder_media_entries').get() as any
    const upgraded = ensureCurrent(db, 'test-v2')

    expect(first.rebuilt).toBe(true)
    expect(second.rebuilt).toBe(false)
    expect(secondEntry.id).toBe(firstEntry.id)
    expect(upgraded.rebuilt).toBe(true)
    expect(db.prepare("SELECT value FROM settings WHERE key = 'media_catalog_rule_version'").get())
      .toEqual({ value: 'test-v2' })
  })

  it('upgrades a database already marked with the previous V6 rule to the current V9 catalog and preserves manual mappings', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
      'D:\\Anime\\Show\\Manual', 'D:\\Anime\\Show\\SPs',
    ], [
      'D:\\Anime\\Show\\Season 1\\S01E01.mkv',
      'D:\\Anime\\Show\\Manual\\manual.mkv',
      'D:\\Anime\\Show\\SPs\\sp.mkv',
    ])
    const manualFolder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\Manual') as any
    const extrasFolder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show\\SPs') as any
    setManualMediaCatalog(db, manualFolder.id, { kind: 'season', seasonNumbers: [9] })
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any
    const series = db.prepare('SELECT id FROM media_series WHERE library_id = ? AND series_key = ?').get([library.id, `folder:${root.id}`]) as any
    db.prepare(`
      INSERT INTO folder_media_entries (
        folder_id, series_id, kind, season_number, part_number,
        source, external_id, confidence, detected_by, conflict_reason, manual_locked
      ) VALUES (?, ?, 'extras', NULL, NULL, NULL, NULL, 0.95, 'directory', NULL, 0)
    `).run([extrasFolder.id, series.id])
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('media_catalog_rule_version', '6')").run()

    const result = mediaCatalog.ensureMediaCatalogsCurrent(db)

    expect(mediaCatalog.MEDIA_CATALOG_RULE_VERSION).toBe('9')
    expect(result).toMatchObject({ rebuilt: true, ruleVersion: '9' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id = ? AND manual_locked = 0').get(extrasFolder.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT kind, season_number, manual_locked FROM folder_media_entries WHERE folder_id = ?').all(manualFolder.id)).toEqual([{
      kind: 'season', season_number: 9, manual_locked: 1,
    }])
    expect(db.prepare('SELECT kind, season_number, manual_locked FROM folder_media_mappings WHERE folder_id = ?').all(manualFolder.id)).toEqual([{
      kind: 'season', season_number: 9, manual_locked: 1,
    }])
    expect(db.prepare("SELECT value FROM settings WHERE key = 'media_catalog_rule_version'").get())
      .toEqual({ value: '9' })
  })

  it('removes an automatic series shell after its root loses videos and its series mark', () => {
    seedFolderTree([
      'D:\\Anime', 'D:\\Anime\\Show', 'D:\\Anime\\Show\\Season 1',
    ], ['D:\\Anime\\Show\\Season 1\\S01E01.mkv'])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Show') as any
    rebuildLibraryMediaCatalog(db, library.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_series WHERE library_id = ?').get(library.id)).toEqual({ count: 1 })

    db.prepare('DELETE FROM files WHERE library_id = ?').run(library.id)
    db.prepare('UPDATE folders SET is_series = 0 WHERE id = ?').run(root.id)
    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT COUNT(*) AS count FROM media_series WHERE library_id = ?').get(library.id)).toEqual({ count: 0 })
  })
})

describe('canonical media catalog V2', () => {
  let db: any
  let library: any

  beforeEach(() => {
    db = createDb(':memory:')
    library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
  })

  afterEach(() => db.close())

  function seed(paths: string[], files: string[], rootPath = 'D:\\Anime\\Collection') {
    makeFolderDb(db).upsertTree(library.id, paths)
    const rows = db.prepare('SELECT id, path FROM folders WHERE library_id = ?').all(library.id) as { id: number; path: string }[]
    db.prepare('UPDATE folders SET is_series = 0 WHERE library_id = ?').run(library.id)
    const root = rows.find(row => row.path === rootPath)
    if (!root) throw new Error(`missing root ${rootPath}`)
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(root.id)
    const insert = db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, size, date_modified, ext)
      VALUES (?, ?, ?, ?, 1, 1, ?)
    `)
    try {
      for (const filePath of files) {
        const folderPath = path.win32.dirname(filePath)
        const folder = rows.find(row => row.path === folderPath)
        if (!folder) throw new Error(`missing video folder ${folderPath}`)
        const name = path.win32.basename(filePath)
        insert.run([folder.id, library.id, name, filePath, path.win32.extname(name).slice(1).toLowerCase()])
      }
    } finally {
      insert.finalize()
    }
    return { root, rows }
  }

  function seedPinnedWorkGroups() {
    const seeded = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Show A', 'D:\\Anime\\Collection\\Show A\\Season 1',
      'D:\\Anime\\Collection\\Show B', 'D:\\Anime\\Collection\\Show B\\Season 1',
    ], [
      'D:\\Anime\\Collection\\Show A\\Season 1\\episode.mkv',
      'D:\\Anime\\Collection\\Show B\\Season 1\\episode.mkv',
    ])
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(seeded.root.id)
    const showA = seeded.rows.find(row => row.path.endsWith('Collection\\Show A'))!
    const showB = seeded.rows.find(row => row.path.endsWith('Collection\\Show B'))!
    const seasonA = seeded.rows.find(row => row.path.endsWith('Show A\\Season 1'))!
    const seasonB = seeded.rows.find(row => row.path.endsWith('Show B\\Season 1'))!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)")
      .run([seasonA.id, 9101, 9102, seasonA.id, seasonB.id])
    rebuildLibraryMediaCatalog(db, library.id)
    return { ...seeded, showA, showB, seasonA, seasonB }
  }

  function seedMultiMemberRoot() {
    const seeded = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Season 1',
      'D:\\Anime\\Collection\\OVA',
      'D:\\Anime\\Collection\\Movie',
    ], [
      'D:\\Anime\\Collection\\Season 1\\episode.mkv',
      'D:\\Anime\\Collection\\OVA\\episode.mkv',
      'D:\\Anime\\Collection\\Movie\\episode.mkv',
    ])
    rebuildLibraryMediaCatalog(db, library.id)
    return seeded
  }

  it('merges physical folders with the same external identity and keeps multiple source ids', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Show 1', 'D:\\Anime\\Collection\\Show 1 Season 1',
      'D:\\Anime\\Collection\\Show 1 Season 1 (1080p)',
    ], [
      'D:\\Anime\\Collection\\Show 1 Season 1\\01.mkv',
      'D:\\Anime\\Collection\\Show 1 Season 1 (1080p)\\01.mkv',
    ])
    // The same Bangumi subject exists in two physical releases. The first
    // directory also carries an AniList source that will be supplemented by
    // the canonical source helper below.
    const first = rows.find(row => row.path.endsWith('Show 1 Season 1'))!
    const second = rows.find(row => row.path.endsWith('Show 1 Season 1 (1080p)'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 100 WHERE id IN (?, ?)").run([first.id, second.id])
    rebuildLibraryMediaCatalog(db, library.id)

    const itemRows = db.prepare(`
      SELECT id, item_key, title FROM media_items WHERE library_id = ?
    `).all(library.id) as any[]
    expect(itemRows).toHaveLength(1)
    expect(itemRows[0].item_key).toBe('bangumi:100')
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM folder_media_mappings WHERE media_item_id = ?
    `).get(itemRows[0].id)).toEqual({ count: 2 })

    addMediaItemSource(db, itemRows[0].id, { source: 'anilist', externalId: '200' })
    expect(db.prepare(`
      SELECT source, external_id FROM media_item_sources WHERE media_item_id = ? ORDER BY source
    `).all(itemRows[0].id)).toEqual([
      { source: 'anilist', external_id: '200' },
      { source: 'bangumi', external_id: '100' },
    ])

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({ id: itemRows[0].id, item_key: 'bangumi:100' })
    expect(snapshot.items[0].source_ids).toEqual([
      { source: 'bangumi', external_id: '100', is_primary: 1 },
      { source: 'anilist', external_id: '200', is_primary: 0 },
    ])
    expect(snapshot.mappings).toHaveLength(2)
    expect(snapshot.summary).toMatchObject({ item_count: 1, mapping_count: 2 })
  })

  it('migrates a pinned collection from one source-collapsed item to stable local items idempotently', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Second Season',
      'D:\\Anime\\Collection\\Second Season\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Second Season\\Koimonogatari',
    ], [
      'D:\\Anime\\Collection\\Second Season\\Kabukimonogatari\\01.mkv',
      'D:\\Anime\\Collection\\Second Season\\Koimonogatari\\01.mkv',
    ])
    const kabuki = rows.find(row => row.path.endsWith('Second Season\\Kabukimonogatari'))!
    const koi = rows.find(row => row.path.endsWith('Second Season\\Koimonogatari'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?)").run([kabuki.id, koi.id])

    // Simulate the old catalog shape before this folder became a collection:
    // the provider subject alone collapsed both named chapters into one item.
    rebuildLibraryMediaCatalog(db, library.id)
    const oldItem = getCanonicalMediaCatalogForRoot(db, root.id).items[0]
    expect(oldItem).toBeTruthy()
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)

    rebuildLibraryMediaCatalog(db, library.id)
    const migrated = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(migrated.items.map((item: any) => ({
      id: item.id,
      item_key: item.item_key,
      title: item.title,
      sources: item.source_ids,
    }))).toEqual(expect.arrayContaining([
      {
        id: expect.any(Number),
        item_key: 'bangumi:594#content:kabukimonogatari',
        title: 'Kabukimonogatari',
        sources: [{ source: 'bangumi', external_id: '594', is_primary: 1 }],
      },
      {
        id: expect.any(Number),
        item_key: 'bangumi:594#content:koimonogatari',
        title: 'Koimonogatari',
        sources: [{ source: 'bangumi', external_id: '594', is_primary: 1 }],
      },
    ]))
    expect(migrated.items.some((item: any) => item.id === oldItem.id)).toBe(true)
    expect(new Set(migrated.mappings.map((mapping: any) => mapping.media_item_id)).size).toBe(2)
    const stableRows = db.prepare(`
      SELECT id, item_key, title, kind, season_number, manual_locked
      FROM media_items WHERE root_folder_id = ? ORDER BY item_key
    `).all(root.id)

    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare(`
      SELECT id, item_key, title, kind, season_number, manual_locked
      FROM media_items WHERE root_folder_id = ? ORDER BY item_key
    `).all(root.id)).toEqual(stableRows)
    expect(getCanonicalMediaCatalogForRoot(db, root.id).mappings).toHaveLength(2)
  })

  it('keeps quality variants of one named collection work as one logical item', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Kabukimonogatari\\1080p',
      'D:\\Anime\\Collection\\Kabukimonogatari\\2160p',
    ], [
      'D:\\Anime\\Collection\\Kabukimonogatari\\1080p\\01.mkv',
      'D:\\Anime\\Collection\\Kabukimonogatari\\2160p\\01.mkv',
    ])
    const fullHd = rows.find(row => row.path.endsWith('Kabukimonogatari\\1080p'))!
    const ultraHd = rows.find(row => row.path.endsWith('Kabukimonogatari\\2160p'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?)").run([fullHd.id, ultraHd.id])

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id)
    expect(snapshot.items).toEqual([expect.objectContaining({
      item_key: 'bangumi:594',
      title: expect.stringMatching(/1080p|2160p/),
      source_ids: [{ source: 'bangumi', external_id: '594', is_primary: 1 }],
    })])
    expect(snapshot.mappings).toHaveLength(2)
    expect(new Set(snapshot.mappings.map(mapping => mapping.media_item_id)).size).toBe(1)
  })

  it('ignores release-group wrappers when identifying collection content variants', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Kabukimonogatari\\[VCB-Studio]',
      'D:\\Anime\\Collection\\Kabukimonogatari\\[VCB-Studio]\\1080p',
      'D:\\Anime\\Collection\\Kabukimonogatari\\[Moozzi2]',
      'D:\\Anime\\Collection\\Kabukimonogatari\\[Moozzi2]\\2160p',
      'D:\\Anime\\Collection\\[VCB-Studio] Kabukimonogatari [1080p]',
      'D:\\Anime\\Collection\\[Moozzi2] Kabukimonogatari [2160p]',
    ], [
      'D:\\Anime\\Collection\\Kabukimonogatari\\[VCB-Studio]\\1080p\\01.mkv',
      'D:\\Anime\\Collection\\Kabukimonogatari\\[Moozzi2]\\2160p\\01.mkv',
      'D:\\Anime\\Collection\\[VCB-Studio] Kabukimonogatari [1080p]\\01.mkv',
      'D:\\Anime\\Collection\\[Moozzi2] Kabukimonogatari [2160p]\\01.mkv',
    ])
    const releases = rows.filter(row => [
      'Kabukimonogatari\\[VCB-Studio]\\1080p',
      'Kabukimonogatari\\[Moozzi2]\\2160p',
      'Collection\\[VCB-Studio] Kabukimonogatari [1080p]',
      'Collection\\[Moozzi2] Kabukimonogatari [2160p]',
    ].some(suffix => row.path.endsWith(suffix)))
    expect(releases).toHaveLength(4)
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?, ?, ?)")
      .run(releases.map(row => row.id))

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0].item_key).toBe('bangumi:594')
    expect(snapshot.mappings).toHaveLength(4)
  })

  it('preserves semantic movie and part prefixes in collection content identities', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\[Movie 1] Kizumonogatari [1080p]',
      'D:\\Anime\\Collection\\[Movie 2] Kizumonogatari [1080p]',
      'D:\\Anime\\Collection\\[Part 1] Kizumonogatari [1080p]',
      'D:\\Anime\\Collection\\[Part 2] Kizumonogatari [1080p]',
      'D:\\Anime\\Collection\\Kizumonogatari',
      'D:\\Anime\\Collection\\Kizumonogatari\\[Movie 1]',
      'D:\\Anime\\Collection\\Kizumonogatari\\[Movie 1]\\1080p',
      'D:\\Anime\\Collection\\Kizumonogatari\\[Movie 2]',
      'D:\\Anime\\Collection\\Kizumonogatari\\[Movie 2]\\1080p',
    ], [
      'D:\\Anime\\Collection\\[Movie 1] Kizumonogatari [1080p]\\01.mkv',
      'D:\\Anime\\Collection\\[Movie 2] Kizumonogatari [1080p]\\01.mkv',
      'D:\\Anime\\Collection\\[Part 1] Kizumonogatari [1080p]\\01.mkv',
      'D:\\Anime\\Collection\\[Part 2] Kizumonogatari [1080p]\\01.mkv',
      'D:\\Anime\\Collection\\Kizumonogatari\\[Movie 1]\\1080p\\01.mkv',
      'D:\\Anime\\Collection\\Kizumonogatari\\[Movie 2]\\1080p\\01.mkv',
    ])
    const directReleases = rows.filter(row => [
      '[Movie 1] Kizumonogatari [1080p]',
      '[Movie 2] Kizumonogatari [1080p]',
      '[Part 1] Kizumonogatari [1080p]',
      '[Part 2] Kizumonogatari [1080p]',
    ].some(suffix => row.path.endsWith(`Collection\\${suffix}`)))
    const nestedReleases = rows.filter(row => [
      'Kizumonogatari\\[Movie 1]\\1080p',
      'Kizumonogatari\\[Movie 2]\\1080p',
    ].some(suffix => row.path.endsWith(suffix)))
    expect(directReleases).toHaveLength(4)
    expect(nestedReleases).toHaveLength(2)
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 999 WHERE id IN (?, ?, ?, ?)")
      .run(directReleases.map(row => row.id))
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 1000 WHERE id IN (?, ?)")
      .run(nestedReleases.map(row => row.id))

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id)
    expect(snapshot.items.map(item => item.item_key)).toEqual(expect.arrayContaining([
      'bangumi:999#content:movie%201%20kizumonogatari',
      'bangumi:999#content:movie%202%20kizumonogatari',
      'bangumi:999#content:part%201%20kizumonogatari',
      'bangumi:999#content:part%202%20kizumonogatari',
      'bangumi:1000#content:movie%201',
      'bangumi:1000#content:movie%202',
    ]))
    expect(snapshot.items).toHaveLength(6)
    expect(new Set(snapshot.mappings.map(mapping => mapping.media_item_id)).size).toBe(6)
  })

  it('copies an existing presentation alias when a source item gains a local content key', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Koimonogatari',
    ], ['D:\\Anime\\Collection\\Kabukimonogatari\\01.mkv'])
    const kabuki = rows.find(row => row.path.endsWith('Collection\\Kabukimonogatari'))!
    const koi = rows.find(row => row.path.endsWith('Collection\\Koimonogatari'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?)").run([kabuki.id, koi.id])
    rebuildLibraryMediaCatalog(db, library.id)
    expect(getCanonicalMediaCatalogForRoot(db, root.id).items[0].item_key).toBe('bangumi:594')
    db.prepare(`
      INSERT INTO media_collection_presentation
        (root_folder_id, entry_key, display_title, position)
      VALUES (?, 'item:bangumi:594', '倾物语（自定义）', 7)
    `).run(root.id)
    db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, size, date_modified, ext)
      VALUES (?, ?, '01.mkv', ?, 1, 1, 'mkv')
    `).run([koi.id, library.id, `${koi.path}\\01.mkv`])

    rebuildLibraryMediaCatalog(db, library.id)

    const scopedKey = 'item:bangumi:594#content:kabukimonogatari'
    expect(getCanonicalMediaCatalogForRoot(db, root.id).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.any(Number), item_key: scopedKey.slice('item:'.length) }),
    ]))
    const presentationRows = db.prepare(`
      SELECT entry_key, display_title, position
      FROM media_collection_presentation
      WHERE root_folder_id = ? ORDER BY entry_key
    `).all(root.id)
    expect(presentationRows).toEqual([
      { entry_key: 'item:bangumi:594', display_title: '倾物语（自定义）', position: 7 },
      { entry_key: scopedKey, display_title: '倾物语（自定义）', position: 7 },
    ])

    rebuildLibraryMediaCatalog(db, library.id)
    expect(db.prepare(`
      SELECT entry_key, display_title, position
      FROM media_collection_presentation
      WHERE root_folder_id = ? ORDER BY entry_key
    `).all(root.id)).toEqual(presentationRows)
  })

  it('attaches another metadata source without merging folder-scoped collection items', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Koimonogatari',
    ], [
      'D:\\Anime\\Collection\\Kabukimonogatari\\01.mkv',
      'D:\\Anime\\Collection\\Koimonogatari\\01.mkv',
    ])
    const kabuki = rows.find(row => row.path.endsWith('Collection\\Kabukimonogatari'))!
    const koi = rows.find(row => row.path.endsWith('Collection\\Koimonogatari'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?)").run([kabuki.id, koi.id])
    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id)

    for (const item of before.items) {
      addMediaItemSource(db, item.id, { source: 'anilist', externalId: '99999' })
    }

    const after = getCanonicalMediaCatalogForRoot(db, root.id)
    expect(after.items).toHaveLength(2)
    expect(after.items.every(item => item.source_ids.some(source =>
      source.source === 'anilist' && source.external_id === '99999'))).toBe(true)
    expect(new Set(after.mappings.map(mapping => mapping.media_item_id)).size).toBe(2)
  })

  it('does not split an old source-collapsed item after its work-group relationship was manually confirmed', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Koimonogatari',
    ], [
      'D:\\Anime\\Collection\\Kabukimonogatari\\01.mkv',
      'D:\\Anime\\Collection\\Koimonogatari\\01.mkv',
    ])
    const kabuki = rows.find(row => row.path.endsWith('Collection\\Kabukimonogatari'))!
    const koi = rows.find(row => row.path.endsWith('Collection\\Koimonogatari'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?)").run([kabuki.id, koi.id])
    rebuildLibraryMediaCatalog(db, library.id)
    const oldItem = db.prepare('SELECT id FROM media_items WHERE root_folder_id = ?').get(root.id) as any
    const oldGroup = db.prepare('SELECT id FROM media_work_groups WHERE root_folder_id = ?').get(root.id) as any
    db.prepare("UPDATE media_items SET title = '手动确认的物语条目' WHERE id = ?").run(oldItem.id)
    db.prepare("UPDATE media_work_groups SET title = '手动物语合集', manual_locked = 1 WHERE id = ?").run(oldGroup.id)
    db.prepare("UPDATE media_work_group_members SET relation_role = 'side_story', manual_locked = 1 WHERE work_group_id = ? AND media_item_id = ?")
      .run([oldGroup.id, oldItem.id])
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: oldItem.id,
      item_key: 'bangumi:594',
      title: '手动确认的物语条目',
    })])
    expect(snapshot.mappings).toHaveLength(2)
    expect(snapshot.mappings.every((mapping: any) => mapping.media_item_id === oldItem.id)).toBe(true)
    expect(snapshot.work_groups).toEqual([expect.objectContaining({
      id: oldGroup.id,
      title: '手动物语合集',
      manual_locked: 1,
      members: [expect.objectContaining({
        media_item_id: oldItem.id,
        relation_role: 'side_story',
        manual_locked: 1,
      })],
    })])
  })

  it('does not reuse a manually protected same-source item from another canonical root', () => {
    const { root: foreignRoot, rows: initialRows } = seed([
      'D:\\Anime', 'D:\\Anime\\Foreign Series',
      'D:\\Anime\\Foreign Series\\Season 1',
    ], ['D:\\Anime\\Foreign Series\\Season 1\\S01E01.mkv'], 'D:\\Anime\\Foreign Series')
    const foreignSeason = initialRows.find(row => row.path.endsWith('Foreign Series\\Season 1'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id = ?").run(foreignSeason.id)
    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, foreignSeason.id, { kind: 'season', seasonNumbers: [1] })
    const foreignItem = db.prepare(`
      SELECT media_item_id FROM folder_media_mappings
      WHERE folder_id = ? AND manual_locked = 1
    `).get(foreignSeason.id) as any

    makeFolderDb(db).upsertTree(library.id, [
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Kabukimonogatari',
      'D:\\Anime\\Collection\\Koimonogatari',
    ])
    const collectionRows = db.prepare('SELECT id, path FROM folders WHERE library_id = ?').all(library.id) as any[]
    const collection = collectionRows.find(row => row.path === 'D:\\Anime\\Collection')!
    const kabuki = collectionRows.find(row => row.path.endsWith('Collection\\Kabukimonogatari'))!
    const koi = collectionRows.find(row => row.path.endsWith('Collection\\Koimonogatari'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(collection.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 594 WHERE id IN (?, ?)").run([kabuki.id, koi.id])
    const insertFile = db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, size, date_modified, ext)
      VALUES (?, ?, ?, ?, 1, 1, 'mkv')
    `)
    try {
      insertFile.run([kabuki.id, library.id, '01.mkv', `${kabuki.path}\\01.mkv`])
      insertFile.run([koi.id, library.id, '01.mkv', `${koi.path}\\01.mkv`])
    } finally {
      insertFile.finalize()
    }

    rebuildLibraryMediaCatalog(db, library.id)

    const collectionSnapshot = getCanonicalMediaCatalogForRoot(db, collection.id)
    expect(collectionSnapshot.items).toHaveLength(2)
    expect(collectionSnapshot.items.every(item => item.root_folder_id === collection.id)).toBe(true)
    expect(collectionSnapshot.items.every(item => item.id !== foreignItem.media_item_id)).toBe(true)
    expect(db.prepare(`
      SELECT media_item_id, root_folder_id, manual_locked
      FROM folder_media_mappings WHERE folder_id = ?
    `).get(foreignSeason.id)).toEqual({
      media_item_id: foreignItem.media_item_id,
      root_folder_id: foreignRoot.id,
      manual_locked: 1,
    })
  })

  it('splits collection members by explicit ids and does not guess seasons from folder order', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Fate Zero',
      'D:\\Anime\\Collection\\Fate stay night Unlimited Blade Works',
      'D:\\Anime\\Collection\\Disc 2',
    ], [
      'D:\\Anime\\Collection\\Fate Zero\\01.mkv',
      'D:\\Anime\\Collection\\Fate stay night Unlimited Blade Works\\01.mkv',
      'D:\\Anime\\Collection\\Disc 2\\01.mkv',
    ])
    db.prepare('UPDATE folders SET pinned = 1 WHERE id = ?').run(root.id)
    const fateZero = rows.find(row => row.path.endsWith('Fate Zero'))!
    const ubw = rows.find(row => row.path.endsWith('Unlimited Blade Works'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = CASE id WHEN ? THEN 43558 WHEN ? THEN 551918 END WHERE id IN (?, ?)")
      .run([fateZero.id, ubw.id, fateZero.id, ubw.id])

    rebuildLibraryMediaCatalog(db, library.id)

    const items = db.prepare(`
      SELECT item_key, kind, season_number FROM media_items WHERE library_id = ? ORDER BY item_key
    `).all(library.id) as any[]
    const discTwo = rows.find(row => row.path.endsWith('Disc 2'))!
    expect(items).toEqual(expect.arrayContaining([
      { item_key: 'bangumi:43558', kind: 'unknown', season_number: null },
      { item_key: 'bangumi:551918', kind: 'unknown', season_number: null },
      { item_key: `folder:${discTwo.id}`, kind: 'unknown', season_number: null },
    ]))
    expect(items).toHaveLength(3)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM media_items WHERE root_folder_id = ?
    `).get(root.id)).toEqual({ count: 3 })
    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id)
    expect(snapshot.summary).toMatchObject({ item_count: 3, unknown_count: 3, conflict_count: 0 })
    expect(snapshot.mappings.every((mapping: any) => mapping.season_number === null)).toBe(true)
    expect(snapshot.items.find(item => item.item_key === 'bangumi:43558')?.title).toBe('Fate Zero')
    expect(snapshot.items.find(item => item.item_key === 'bangumi:551918')?.title).toBe('Fate stay night Unlimited Blade Works')
  })

  it('uses a pinned non-series folder as the canonical root and gives it priority over inner series folders', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Inner Series',
      'D:\\Anime\\Collection\\Inner Series\\Season 1',
    ], ['D:\\Anime\\Collection\\Inner Series\\Season 1\\S01E01.mkv'])
    const inner = rows.find(row => row.path.endsWith('Inner Series'))!
    const season = rows.find(row => row.path.endsWith('Inner Series\\Season 1'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(inner.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const mapping = db.prepare('SELECT root_folder_id FROM folder_media_mappings WHERE folder_id = ?').get(season.id) as any
    expect(mapping).toEqual({ root_folder_id: root.id })
    expect(getCanonicalMediaCatalogForRoot(db, inner.id).root_folder_id).toBe(root.id)
    expect(getCanonicalMediaCatalogForRoot(db, root.id).mappings.every(item => item.root_folder_id === root.id)).toBe(true)
  })

  it('auto-groups source-less unknown members while continuing to exclude extras', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Direct Member',
      'D:\\Anime\\Collection\\Direct Member\\Nested Unknown',
      'D:\\Anime\\Collection\\SPs',
      'D:\\Anime\\Collection\\Previews',
      'D:\\Anime\\Ordinary Series', 'D:\\Anime\\Ordinary Series\\Unclear',
    ], [
      'D:\\Anime\\Collection\\Direct Member\\episode.mkv',
      'D:\\Anime\\Collection\\Direct Member\\Nested Unknown\\episode.mkv',
      'D:\\Anime\\Collection\\SPs\\sp.mkv',
      'D:\\Anime\\Collection\\Previews\\preview.mkv',
      'D:\\Anime\\Ordinary Series\\Unclear\\episode.mkv',
    ])
    const direct = rows.find(row => row.path.endsWith('Collection\\Direct Member'))!
    const nested = rows.find(row => row.path.endsWith('Direct Member\\Nested Unknown'))!
    const extras = rows.find(row => row.path.endsWith('Collection\\SPs'))!
    const previews = rows.find(row => row.path.endsWith('Collection\\Previews'))!
    const ordinaryRoot = rows.find(row => row.path.endsWith('Ordinary Series'))!
    const ordinaryUnknown = rows.find(row => row.path.endsWith('Ordinary Series\\Unclear'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(ordinaryRoot.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const legacyFolderIds = new Set((db.prepare('SELECT folder_id FROM folder_media_entries').all() as any[]).map(row => row.folder_id))
    const canonicalFolderIds = new Set((db.prepare('SELECT folder_id FROM folder_media_mappings').all() as any[]).map(row => row.folder_id))
    expect(legacyFolderIds.has(direct.id)).toBe(true)
    expect(canonicalFolderIds.has(direct.id)).toBe(true)
    expect(legacyFolderIds.has(nested.id)).toBe(true)
    expect(canonicalFolderIds.has(nested.id)).toBe(true)
    expect(legacyFolderIds.has(extras.id)).toBe(false)
    expect(canonicalFolderIds.has(extras.id)).toBe(false)
    expect(legacyFolderIds.has(previews.id)).toBe(false)
    expect(canonicalFolderIds.has(previews.id)).toBe(false)
    expect(legacyFolderIds.has(ordinaryUnknown.id)).toBe(true)
    expect(canonicalFolderIds.has(ordinaryUnknown.id)).toBe(true)

    expect(getMediaCatalogForFolder(db, root.id).candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: extras.id, reason: 'extras' }),
      expect.objectContaining({ folder_id: previews.id, reason: 'extras' }),
    ]))
    expect(getMediaCatalogForFolder(db, root.id).candidates.some(candidate => candidate.folder_id === nested.id)).toBe(false)
    expect(getMediaCatalogForFolder(db, ordinaryRoot.id).candidates.some(candidate => candidate.folder_id === ordinaryUnknown.id)).toBe(false)
  })

  it('uses the pinned collection root for legacy reads and manual catalog edits', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Inner Series',
      'D:\\Anime\\Collection\\Inner Series\\Season 1',
    ], ['D:\\Anime\\Collection\\Inner Series\\Season 1\\S01E01.mkv'])
    const inner = rows.find(row => row.path.endsWith('Inner Series'))!
    const season = rows.find(row => row.path.endsWith('Inner Series\\Season 1'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(inner.id)

    rebuildLibraryMediaCatalog(db, library.id)

    expect(getMediaCatalogForFolder(db, season.id).summary?.root_folder_id).toBe(root.id)
    const snapshot = setManualMediaCatalog(db, season.id, {
      kind: 'season',
      seasonNumbers: [3],
      partNumber: null,
    })

    expect(snapshot.summary?.root_folder_id).toBe(root.id)
    expect(snapshot.canonical?.root_folder_id).toBe(root.id)
    expect(snapshot.entries.find(entry => entry.folder_id === season.id)?.season_number).toBe(3)
    expect(snapshot.canonical?.mappings.find(mapping => mapping.folder_id === season.id)).toMatchObject({
      root_folder_id: root.id,
      season_number: 3,
      manual_locked: 1,
    })
  })

  it('persists a manually edited series title across catalog rebuilds', () => {
    const { root } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\S01E01.mkv'])
    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = setMediaCatalogTitle(db, root.id, '  Fate Collection  ')
    expect(snapshot.summary?.series_title).toBe('Fate Collection')
    expect(db.prepare('SELECT manual_locked, title FROM media_series WHERE root_folder_id = ?').get(root.id)).toEqual({
      manual_locked: 1,
      title: 'Fate Collection',
    })

    rebuildLibraryMediaCatalog(db, library.id)
    expect(getMediaCatalogForFolder(db, root.id).summary?.series_title).toBe('Fate Collection')
    expect(() => setMediaCatalogTitle(db, root.id, '   ')).toThrow('系列标题不能为空')
  })

  it('moves a manual mapping and its canonical item root within one library', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Root A', 'D:\\Anime\\Root A\\Season 1',
      'D:\\Anime\\Root B',
    ], ['D:\\Anime\\Root A\\Season 1\\episode.mkv'], 'D:\\Anime\\Root A')
    const rootA = rows.find(row => row.path === 'D:\\Anime\\Root A')!
    const rootB = rows.find(row => row.path === 'D:\\Anime\\Root B')!
    const season = rows.find(row => row.path === 'D:\\Anime\\Root A\\Season 1')!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(rootB.id)

    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, season.id, { kind: 'season', seasonNumbers: [2], partNumber: null })
    const before = db.prepare('SELECT media_item_id FROM folder_media_mappings WHERE folder_id = ?').get(season.id) as { media_item_id: number }
    expect(db.prepare('SELECT root_folder_id FROM folder_media_mappings WHERE folder_id = ?').get(season.id)).toEqual({ root_folder_id: rootA.id })

    db.prepare('UPDATE folders SET parent_id = ?, path = ? WHERE id = ?').run([rootB.id, 'D:\\Anime\\Root B\\Season 1', season.id])
    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT root_folder_id FROM folder_media_mappings WHERE folder_id = ?').get(season.id)).toEqual({ root_folder_id: rootB.id })
    expect(db.prepare('SELECT root_folder_id FROM media_items WHERE id = ?').get(before.media_item_id)).toEqual({ root_folder_id: rootB.id })
  })

  it('keeps an item root while another valid root still has a mapping', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Root A', 'D:\\Anime\\Root A\\Season 1',
      'D:\\Anime\\Root B', 'D:\\Anime\\Root B\\Season 1',
    ], [
      'D:\\Anime\\Root A\\Season 1\\episode.mkv',
      'D:\\Anime\\Root B\\Season 1\\episode.mkv',
    ], 'D:\\Anime\\Root A')
    const rootA = rows.find(row => row.path === 'D:\\Anime\\Root A')!
    const rootB = rows.find(row => row.path === 'D:\\Anime\\Root B')!
    const seasonA = rows.find(row => row.path === 'D:\\Anime\\Root A\\Season 1')!
    const seasonB = rows.find(row => row.path === 'D:\\Anime\\Root B\\Season 1')!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(rootB.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 2468 WHERE id IN (?, ?)").run([seasonA.id, seasonB.id])

    rebuildLibraryMediaCatalog(db, library.id)
    const item = db.prepare('SELECT id FROM media_items WHERE library_id = ?').get(library.id) as { id: number }
    const mappingA = db.prepare('SELECT * FROM folder_media_mappings WHERE folder_id = ?').get(seasonA.id) as any
    const mappingB = db.prepare('SELECT * FROM folder_media_mappings WHERE folder_id = ?').get(seasonB.id) as any
    expect(mappingA).toBeTruthy()
    expect(mappingB).toBeTruthy()

    // Keep both physical mappings manual, then reinsert A so B is the first
    // row seen by the rebuild. This reproduces the legitimate multi-root case
    // where roots[0] is not the item's current root.
    db.prepare("UPDATE folder_media_mappings SET manual_locked = 1, detected_by = 'manual' WHERE media_item_id = ?").run(item.id)
    db.prepare('DELETE FROM folder_media_mappings WHERE id = ?').run(mappingA.id)
    db.prepare(`
      INSERT INTO folder_media_mappings (
        folder_id, media_item_id, root_folder_id, series_id, content_role, kind,
        season_number, part_number, confidence, conflict_reason, detected_by, manual_locked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run([
      mappingA.folder_id, mappingA.media_item_id, mappingA.root_folder_id, mappingA.series_id,
      mappingA.content_role, mappingA.kind, mappingA.season_number, mappingA.part_number,
      mappingA.confidence, mappingA.conflict_reason, 'manual',
    ])
    db.prepare('UPDATE media_items SET root_folder_id = ? WHERE id = ?').run([rootA.id, item.id])

    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT root_folder_id FROM media_items WHERE id = ?').get(item.id)).toEqual({ root_folder_id: rootA.id })
    expect(db.prepare('SELECT root_folder_id FROM folder_media_mappings WHERE folder_id = ?').get(seasonA.id)).toEqual({ root_folder_id: rootA.id })
    expect(db.prepare('SELECT root_folder_id FROM folder_media_mappings WHERE folder_id = ?').get(seasonB.id)).toEqual({ root_folder_id: rootB.id })
  })

  it('removes canonical items and sources orphaned after a folder loses its video files', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 123 WHERE id = ?").run(season.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const item = db.prepare('SELECT id FROM media_items WHERE library_id = ?').get(library.id) as { id: number }
    expect(item).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_item_sources WHERE media_item_id = ?').get(item.id)).toEqual({ count: 1 })

    db.prepare('DELETE FROM folders WHERE id = ?').run(season.id)
    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(item.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_item_sources WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
    expect(getCanonicalMediaCatalogForRoot(db, root.id).items).toHaveLength(0)
  })

  it('removes canonical items orphaned when a pinned collection is later unpinned', () => {
    const { root } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
    ], ['D:\\Anime\\Collection\\episode.mkv'])
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 456 WHERE id = ?").run(root.id)

    rebuildLibraryMediaCatalog(db, library.id)
    const item = db.prepare('SELECT id FROM media_items WHERE library_id = ?').get(library.id) as { id: number }
    expect(item).toBeTruthy()

    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    rebuildLibraryMediaCatalog(db, library.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE media_item_id = ?').get(item.id)).toEqual({ count: 1 })

    db.prepare('UPDATE folders SET pinned = 0 WHERE id = ?').run(root.id)
    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(item.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_item_sources WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
  })

  it('projects manual mapping classification into V2 items without collapsing conflicting physical mappings', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Season 1',
      'D:\\Anime\\Collection\\Season 1 (1080p)',
    ], [
      'D:\\Anime\\Collection\\Season 1\\episode.mkv',
      'D:\\Anime\\Collection\\Season 1 (1080p)\\episode.mkv',
    ])
    const first = rows.find(row => row.path.endsWith('Season 1'))!
    const second = rows.find(row => row.path.endsWith('Season 1 (1080p)'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 789 WHERE id IN (?, ?)").run([first.id, second.id])

    rebuildLibraryMediaCatalog(db, library.id)
    const item = db.prepare('SELECT id FROM media_items WHERE library_id = ?').get(library.id) as { id: number }
    expect(getCanonicalMediaCatalogForRoot(db, root.id).items[0]).toMatchObject({
      kind: 'season',
      season_number: 1,
      part_number: null,
    })

    const single = setManualMediaCatalog(db, first.id, {
      kind: 'season',
      seasonNumbers: [2],
      partNumber: 3,
    })
    expect(single.canonical?.items.find(entry => entry.id === item.id)).toMatchObject({
      kind: 'unknown',
      season_number: null,
      part_number: null,
    })
    expect(single.canonical?.mappings.find(mapping => mapping.folder_id === first.id)).toMatchObject({
      kind: 'season',
      season_number: 2,
      part_number: 3,
      manual_locked: 1,
    })

    const aligned = setManualMediaCatalog(db, second.id, {
      kind: 'season',
      seasonNumbers: [2],
      partNumber: 3,
    })
    expect(aligned.canonical?.items.find(entry => entry.id === item.id)).toMatchObject({
      kind: 'season',
      season_number: 2,
      part_number: 3,
    })
  })

  it('does not inherit a collection root external id into unbound movie or SP folders', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Movie',
      'D:\\Anime\\Collection\\SP',
    ], [
      'D:\\Anime\\Collection\\01.mkv',
      'D:\\Anime\\Collection\\Movie\\movie.mkv',
      'D:\\Anime\\Collection\\SP\\sp.mkv',
    ])
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 900 WHERE id = ?").run(root.id)
    rebuildLibraryMediaCatalog(db, library.id)

    const movie = rows.find(row => row.path.endsWith('\\Movie'))!
    const sp = rows.find(row => row.path.endsWith('\\SP'))!
    const rowsByFolder = db.prepare(`
      SELECT i.item_key, m.media_item_id
      FROM folder_media_mappings m JOIN media_items i ON i.id = m.media_item_id
      WHERE m.folder_id IN (?, ?)
      ORDER BY m.folder_id
    `).all([movie.id, sp.id]) as any[]
    expect(rowsByFolder).toHaveLength(2)
    expect(rowsByFolder.map(row => row.item_key)).toEqual(expect.arrayContaining([
      `folder:${movie.id}`,
      `folder:${sp.id}`,
    ]))
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM media_item_sources
      WHERE media_item_id IN (?, ?)
    `).get([rowsByFolder[0].media_item_id, rowsByFolder[1].media_item_id])).toEqual({ count: 0 })
  })

  it('preserves a manually locked canonical mapping during rebuild', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Unclear',
    ], ['D:\\Anime\\Collection\\Unclear\\episode.mkv'])
    const folder = rows.find(row => row.path.endsWith('Unclear'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 24680 WHERE id = ?").run(folder.id)
    rebuildLibraryMediaCatalog(db, library.id)
    const before = db.prepare(`
      SELECT id, media_item_id FROM folder_media_mappings WHERE folder_id = ?
    `).get(folder.id) as any
    expect(before).toBeTruthy()
    db.prepare(`
      UPDATE folder_media_mappings
      SET content_role = 'main', kind = 'season', season_number = 9,
          confidence = 1, detected_by = 'manual', manual_locked = 1,
          conflict_reason = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(before.id)
    db.prepare("UPDATE folders SET name = 'Unclear Season 2' WHERE id = ?").run(folder.id)

    rebuildLibraryMediaCatalog(db, library.id)
    expect(db.prepare(`
      SELECT media_item_id, content_role, kind, season_number, confidence, detected_by, manual_locked
      FROM folder_media_mappings WHERE folder_id = ?
    `).all(folder.id)).toEqual([{
      media_item_id: before.media_item_id,
      content_role: 'main',
      kind: 'season',
      season_number: 9,
      confidence: 1,
      detected_by: 'manual',
      manual_locked: 1,
    }])
    expect(getCanonicalMediaCatalogForRoot(db, root.id).summary?.manual_count).toBe(1)
  })

  it('moves automatic extras and unsupported unknown folders to candidates while retaining unknown folders with external ids', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Season 1',
      'D:\\Anime\\Collection\\SPs',
      'D:\\Anime\\Collection\\Unclear',
      'D:\\Anime\\Collection\\Fate Zero',
    ], [
      'D:\\Anime\\Collection\\Season 1\\S01E01.mkv',
      'D:\\Anime\\Collection\\SPs\\sp.mkv',
      'D:\\Anime\\Collection\\Unclear\\episode.mkv',
      'D:\\Anime\\Collection\\Fate Zero\\episode.mkv',
    ])
    const fate = rows.find(row => row.path.endsWith('Fate Zero'))!
    const extras = rows.find(row => row.path.endsWith('SPs'))!
    const unclear = rows.find(row => row.path.endsWith('Unclear'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 43558 WHERE id = ?").run(fate.id)

    rebuildLibraryMediaCatalog(db, library.id)
    const snapshot = getMediaCatalogForFolder(db, root.id)
    const visibleFolderIds = new Set(snapshot.entries.map(entry => entry.folder_id))

    expect(visibleFolderIds.has(fate.id)).toBe(true)
    expect(visibleFolderIds.has(extras.id)).toBe(false)
    expect(visibleFolderIds.has(unclear.id)).toBe(true)
    expect(snapshot.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: extras.id, suggested_kind: 'extras', reason: 'extras' }),
    ]))
    expect(snapshot.candidates.some(candidate => candidate.folder_id === unclear.id)).toBe(false)
  })

  it('keeps a folder exclusion after rebuild and exposes it as a reversible candidate', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\SPs',
    ], ['D:\\Anime\\Collection\\SPs\\sp.mkv'])
    const extras = rows.find(row => row.path.endsWith('SPs'))!
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, extras.id, { excluded: true } as any)
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_catalog_exclusions WHERE folder_id = ?').get(extras.id)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE folder_id = ?').get(extras.id)).toEqual({ count: 0 })
    expect(getMediaCatalogForFolder(db, root.id).candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: extras.id, reason: 'excluded', folder_path: 'D:\\Anime\\Collection\\SPs' }),
    ]))

    rebuildLibraryMediaCatalog(db, library.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_catalog_exclusions WHERE folder_id = ?').get(extras.id)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE folder_id = ?').get(extras.id)).toEqual({ count: 0 })
    expect(getMediaCatalogForFolder(db, extras.id).candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: extras.id, reason: 'excluded' }),
    ]))
  })

  it('preserves manual classification as the default when an excluded folder is added again', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Unclear',
    ], ['D:\\Anime\\Collection\\Unclear\\episode.mkv'])
    const unclear = rows.find(row => row.path.endsWith('Unclear'))!
    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, unclear.id, { kind: 'season', seasonNumbers: [2, 3], partNumber: 4 })

    const excluded = setManualMediaCatalog(db, unclear.id, { excluded: true })
    const saved = db.prepare(`
      SELECT manual_kind, manual_season_numbers, manual_part_number
      FROM folder_media_catalog_exclusions WHERE folder_id = ?
    `).get(unclear.id) as any
    expect(saved).toEqual({ manual_kind: 'season', manual_season_numbers: '[2,3]', manual_part_number: 4 })
    const candidate = excluded.candidates.find(item => item.folder_id === unclear.id)
    expect(candidate).toMatchObject({
      reason: 'excluded',
      suggested_kind: 'season',
      suggested_season_numbers: [2, 3],
      suggested_part_number: 4,
    })

    const restored = setManualMediaCatalog(db, unclear.id, {
      kind: candidate!.suggested_kind,
      seasonNumbers: candidate!.suggested_season_numbers,
      partNumber: candidate!.suggested_part_number,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_catalog_exclusions WHERE folder_id = ?').get(unclear.id)).toEqual({ count: 0 })
    expect(restored.entries.filter(entry => entry.folder_id === unclear.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'season', season_number: 2, part_number: 4, manual_locked: 1 }),
      expect.objectContaining({ kind: 'season', season_number: 3, part_number: 4, manual_locked: 1 }),
    ]))
    expect(restored.candidates.some(item => item.folder_id === unclear.id)).toBe(false)
    expect(restored.canonical?.mappings.filter(mapping => mapping.folder_id === unclear.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'season', season_number: 2, part_number: 4, manual_locked: 1 }),
      expect.objectContaining({ kind: 'season', season_number: 3, part_number: 4, manual_locked: 1 }),
    ]))
    expect(restored.canonical?.root_folder_id).toBe(root.id)
  })

  it('does not store manual restore data when automatically excluding a folder', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\S01E01.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, season.id, { excluded: true })

    expect(db.prepare(`
      SELECT manual_kind, manual_season_numbers, manual_part_number
      FROM folder_media_catalog_exclusions WHERE folder_id = ?
    `).get(season.id)).toEqual({ manual_kind: null, manual_season_numbers: null, manual_part_number: null })
  })

  it('clears an exclusion when a folder is manually added to the catalog', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Unclear',
    ], ['D:\\Anime\\Collection\\Unclear\\episode.mkv'])
    const unclear = rows.find(row => row.path.endsWith('Unclear'))!
    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, unclear.id, { excluded: true } as any)

    const snapshot = setManualMediaCatalog(db, unclear.id, { kind: 'season', seasonNumbers: [3] })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_catalog_exclusions WHERE folder_id = ?').get(unclear.id)).toEqual({ count: 0 })
    expect(snapshot.entries.find(entry => entry.folder_id === unclear.id)).toMatchObject({ kind: 'season', season_number: 3, manual_locked: 1 })
    expect(snapshot.candidates.some(candidate => candidate.folder_id === unclear.id)).toBe(false)
    expect(snapshot.canonical?.mappings.some(mapping => mapping.folder_id === unclear.id)).toBe(true)
    expect(snapshot.canonical?.root_folder_id).toBe(root.id)
  })

  it('restores source identity when an excluded folder is manually added again', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Bangumi Show',
      'D:\\Anime\\Collection\\AniList Show',
    ], [
      'D:\\Anime\\Collection\\Bangumi Show\\episode.mkv',
      'D:\\Anime\\Collection\\AniList Show\\episode.mkv',
    ])
    const bangumi = rows.find(row => row.path.endsWith('Bangumi Show'))!
    const anilist = rows.find(row => row.path.endsWith('AniList Show'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = ? WHERE id = ?")
      .run([1001, bangumi.id])
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = ? WHERE id = ?")
      .run([2002, anilist.id])

    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, bangumi.id, { excluded: true })
    setManualMediaCatalog(db, anilist.id, { excluded: true })

    setManualMediaCatalog(db, bangumi.id, { kind: 'unknown' })
    setManualMediaCatalog(db, anilist.id, { kind: 'unknown' })

    expect(db.prepare(`
      SELECT item_key, title
      FROM media_items WHERE library_id = ? ORDER BY item_key
    `).all(library.id)).toEqual([
      { item_key: 'anilist:2002', title: 'AniList Show' },
      { item_key: 'bangumi:1001', title: 'Bangumi Show' },
    ])
    expect(db.prepare(`
      SELECT s.source, s.external_id, i.item_key
      FROM media_item_sources s
      JOIN media_items i ON i.id = s.media_item_id
      ORDER BY s.source
    `).all()).toEqual([
      { source: 'anilist', external_id: '2002', item_key: 'anilist:2002' },
      { source: 'bangumi', external_id: '1001', item_key: 'bangumi:1001' },
    ])
    expect(db.prepare(`
      SELECT f.name, e.source, e.external_id
      FROM folder_media_entries e
      JOIN folders f ON f.id = e.folder_id
      WHERE e.folder_id IN (?, ?)
      ORDER BY f.name
    `).all([bangumi.id, anilist.id])).toEqual([
      { name: 'AniList Show', source: 'anilist', external_id: '2002' },
      { name: 'Bangumi Show', source: 'bangumi', external_id: '1001' },
    ])
    expect(db.prepare("SELECT COUNT(*) AS count FROM media_items WHERE item_key LIKE 'folder:%'").get())
      .toEqual({ count: 0 })
  })

  it('replaces saved exclusion metadata when the restored manual classification changes', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Release',
    ], ['D:\\Anime\\Collection\\Release\\episode.mkv'])
    const release = rows.find(row => row.path.endsWith('Release'))!
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, release.id, { kind: 'season', seasonNumbers: [4], partNumber: 2 })
    setManualMediaCatalog(db, release.id, { excluded: true })
    setManualMediaCatalog(db, release.id, { kind: 'season', seasonNumbers: [6], partNumber: null })
    const snapshot = setManualMediaCatalog(db, release.id, { excluded: true })

    expect(snapshot.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        folder_id: release.id,
        reason: 'excluded',
        suggested_kind: 'season',
        suggested_season_numbers: [6],
        suggested_part_number: null,
      }),
    ]))
  })

  it('persists one root work group and summarizes a multi-season item once', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Fate Zero S01-S02',
    ], ['D:\\Anime\\Collection\\Fate Zero S01-S02\\01.mkv'])
    const fate = rows.find(row => row.path.endsWith('Fate Zero S01-S02'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 43558 WHERE id = ?").run(fate.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.work_groups).toHaveLength(1)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.mappings.map((mapping: any) => mapping.season_number)).toEqual([1, 2])
    expect(snapshot.items[0].source_ids).toEqual([
      { source: 'bangumi', external_id: '43558', is_primary: 1 },
    ])
    expect(snapshot.work_groups[0]).toMatchObject({
      id: expect.any(Number),
      key: `root:${root.id}`,
      title: 'Collection',
      anchor: root.id,
      manual_locked: 0,
      item_ids: [snapshot.items[0].id],
      summary: {
        item_count: 1,
        physical_folder_count: 1,
        season_numbers: [1, 2],
        manual_count: 0,
        conflict_count: 0,
        unknown_count: 0,
      },
    })
  })

  it('groups pinned collection items by their first child anchor without merging source identities', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Prisma Illya',
      'D:\\Anime\\Collection\\Prisma Illya\\Season 1',
      'D:\\Anime\\Collection\\Prisma Illya\\OVA',
      'D:\\Anime\\Collection\\Prisma Illya\\Movie Side Story',
    ], [
      'D:\\Anime\\Collection\\Prisma Illya\\Season 1\\01.mkv',
      'D:\\Anime\\Collection\\Prisma Illya\\OVA\\01.mkv',
      'D:\\Anime\\Collection\\Prisma Illya\\Movie Side Story\\01.mkv',
    ])
    const prisma = rows.find(row => row.path.endsWith('Collection\\Prisma Illya'))!
    const season = rows.find(row => row.path.endsWith('Prisma Illya\\Season 1'))!
    const ova = rows.find(row => row.path.endsWith('Prisma Illya\\OVA'))!
    const movie = rows.find(row => row.path.endsWith('Prisma Illya\\Movie Side Story'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 14829 WHERE id = ?").run(season.id)
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 97757 WHERE id = ?").run(ova.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 123456 WHERE id = ?").run(movie.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toHaveLength(3)
    expect(snapshot.work_groups).toHaveLength(1)
    expect(snapshot.work_groups[0]).toMatchObject({
      key: `anchor:${prisma.id}`,
      title: 'Prisma Illya',
      anchor: prisma.id,
      item_ids: expect.arrayContaining(snapshot.items.map((item: any) => item.id)),
      summary: {
        item_count: 3,
        physical_folder_count: 3,
      },
    })
    expect(snapshot.items.flatMap((item: any) => item.source_ids)).toEqual(expect.arrayContaining([
      { source: 'anilist', external_id: '14829', is_primary: 1 },
      { source: 'anilist', external_id: '97757', is_primary: 1 },
      { source: 'bangumi', external_id: '123456', is_primary: 1 },
    ]))
  })

  it('infers season one for a single unnumbered main candidate and marks the fallback', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Main',
    ], ['D:\\Anime\\Collection\\Main\\episode.mkv'])
    const main = rows.find(row => row.path.endsWith('Main'))!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 7001 WHERE id = ?").run(main.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({ kind: 'season', season_number: 1 })
    expect(snapshot.mappings).toEqual([expect.objectContaining({
      folder_id: main.id,
      kind: 'season',
      season_number: 1,
      detected_by: expect.stringMatching(/fallback/i),
    })])
    expect(getMediaCatalogForFolder(db, root.id).entries).toEqual([expect.objectContaining({
      folder_id: main.id,
      kind: 'season',
      season_number: 1,
      detected_by: expect.stringMatching(/fallback/i),
    })])
    expect(snapshot.work_groups[0].summary).toMatchObject({
      item_count: 1,
      physical_folder_count: 1,
      season_numbers: [1],
      unknown_count: 0,
    })
  })

  it('keeps multiple unnumbered main candidates unknown instead of guessing seasons', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Main A', 'D:\\Anime\\Collection\\Main B',
    ], [
      'D:\\Anime\\Collection\\Main A\\episode.mkv',
      'D:\\Anime\\Collection\\Main B\\episode.mkv',
    ])
    const mainA = rows.find(row => row.path.endsWith('Main A'))!
    const mainB = rows.find(row => row.path.endsWith('Main B'))!
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 7002 WHERE id = ?").run(mainA.id)
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = 7003 WHERE id = ?").run(mainB.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items.every((item: any) => item.kind === 'unknown' && item.season_number === null)).toBe(true)
    expect(snapshot.mappings.every((mapping: any) => mapping.kind === 'unknown' && mapping.season_number === null)).toBe(true)
    expect(snapshot.mappings.every((mapping: any) => !/fallback/i.test(mapping.detected_by))).toBe(true)
    expect(snapshot.work_groups[0].summary).toMatchObject({
      item_count: 2,
      physical_folder_count: 2,
      season_numbers: [],
      unknown_count: 2,
    })
  })

  it('preserves locked work group titles and member relationships during rebuild', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\S01E01.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!
    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const groupId = before.work_groups[0].id
    const itemId = before.items[0].id
    db.prepare("UPDATE media_work_groups SET title = '手动作品组', manual_locked = 1 WHERE id = ?").run(groupId)
    db.prepare("UPDATE media_work_group_members SET relation_role = 'side_story', manual_locked = 1 WHERE work_group_id = ? AND media_item_id = ?")
      .run([groupId, itemId])
    db.prepare("UPDATE folders SET name = 'Season 2' WHERE id = ?").run(season.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.work_groups).toEqual([expect.objectContaining({
      id: groupId,
      key: `root:${root.id}`,
      title: '手动作品组',
      manual_locked: 1,
      item_ids: [itemId],
    })])
    expect(db.prepare(`
      SELECT relation_role, manual_locked FROM media_work_group_members
      WHERE work_group_id = ? AND media_item_id = ?
    `).get([groupId, itemId])).toEqual({ relation_role: 'side_story', manual_locked: 1 })
  })

  it('sorts canonical items and mappings by season, special formats, movie, then unknown', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Fate Zero S01-S02',
      'D:\\Anime\\Collection\\Season 1 Part 2',
      'D:\\Anime\\Collection\\Season 2',
      'D:\\Anime\\Collection\\OVA',
      'D:\\Anime\\Collection\\Special',
      'D:\\Anime\\Collection\\Movie Side Story',
      'D:\\Anime\\Collection\\Unknown A',
      'D:\\Anime\\Collection\\Unknown B',
    ], [
      'D:\\Anime\\Collection\\Fate Zero S01-S02\\01.mkv',
      'D:\\Anime\\Collection\\Season 1 Part 2\\01.mkv',
      'D:\\Anime\\Collection\\Season 2\\01.mkv',
      'D:\\Anime\\Collection\\OVA\\01.mkv',
      'D:\\Anime\\Collection\\Special\\01.mkv',
      'D:\\Anime\\Collection\\Movie Side Story\\01.mkv',
      'D:\\Anime\\Collection\\Unknown A\\01.mkv',
      'D:\\Anime\\Collection\\Unknown B\\01.mkv',
    ])
    const sourceBySuffix: Record<string, number> = {
      'Fate Zero S01-S02': 7101,
      'Season 1 Part 2': 7102,
      'Season 2': 7103,
      OVA: 7104,
      Special: 7105,
      'Movie Side Story': 7106,
      'Unknown A': 7107,
      'Unknown B': 7108,
    }
    for (const row of rows) {
      const suffix = row.path.split('\\').at(-1)!
      const externalId = sourceBySuffix[suffix]
      if (externalId) db.prepare("UPDATE folders SET source = 'anilist', anilist_id = ? WHERE id = ?").run([externalId, row.id])
    }

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items.map((item: any) => item.title)).toEqual([
      'Fate Zero S01-S02', 'Season 1 Part 2', 'Season 2',
      'OVA', 'Special', 'Movie Side Story', 'Unknown A', 'Unknown B',
    ])
    expect(snapshot.mappings.map((mapping: any) => [mapping.folder_name, mapping.season_number])).toEqual([
      ['Fate Zero S01-S02', 1], ['Season 1 Part 2', 1],
      ['Fate Zero S01-S02', 2], ['Season 2', 2],
      ['OVA', null], ['Special', null], ['Movie Side Story', null],
      ['Unknown A', null], ['Unknown B', null],
    ])
  })

  it('retains a locked work-group member and its sources after its physical mapping disappears', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8101 WHERE id = ?").run(season.id)

    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const groupId = before.work_groups[0].id
    const itemId = before.items[0].id
    db.prepare(`
      UPDATE media_work_group_members
      SET manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([groupId, itemId])

    db.prepare('DELETE FROM files WHERE folder_id = ?').run(season.id)
    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE media_item_id = ?').get(itemId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(itemId)).toEqual({ count: 1 })
    expect(db.prepare('SELECT source, external_id FROM media_item_sources WHERE media_item_id = ?').all(itemId)).toEqual([
      { source: 'bangumi', external_id: '8101' },
    ])
    expect(db.prepare(`
      SELECT work_group_id, media_item_id, manual_locked
      FROM media_work_group_members
      WHERE work_group_id = ? AND media_item_id = ?
    `).get([groupId, itemId])).toEqual({ work_group_id: groupId, media_item_id: itemId, manual_locked: 1 })
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: itemId,
      source_ids: [{ source: 'bangumi', external_id: '8101', is_primary: 1 }],
    })])
    expect(snapshot.mappings).toEqual([])
    expect(snapshot.work_groups).toEqual([expect.objectContaining({
      id: groupId,
      item_ids: [itemId],
      summary: expect.objectContaining({ item_count: 1, physical_folder_count: 0 }),
    })])
  })

  it('removes a locked work-group member when its folder is explicitly excluded from the catalog', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8102 WHERE id = ?").run(season.id)

    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const groupId = before.work_groups[0].id
    const itemId = before.items[0].id
    db.prepare(`
      UPDATE media_work_group_members
      SET manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([groupId, itemId])

    const result = setManualMediaCatalog(db, season.id, { excluded: true })
    const snapshot = result.canonical as any
    expect(snapshot.items).toEqual([])
    expect(snapshot.mappings).toEqual([])
    expect(snapshot.work_groups).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE work_group_id = ?').get(groupId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups WHERE id = ?').get(groupId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(itemId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_item_sources WHERE media_item_id = ?').get(itemId)).toEqual({ count: 0 })
  })

  it('removes explicitly excluded orphan members, groups, and items even when they are locked', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8103 WHERE id = ?").run(season.id)

    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const groupId = before.work_groups[0].id
    const itemId = before.items[0].id
    db.prepare(`
      UPDATE media_work_group_members
      SET manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([groupId, itemId])

    const result = setManualMediaCatalog(db, season.id, { excluded: true })
    expect(result.canonical?.items).toEqual([])
    expect(result.canonical?.mappings).toEqual([])
    expect(result.canonical?.work_groups).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE work_group_id = ?').get(groupId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups WHERE id = ?').get(groupId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(itemId)).toEqual({ count: 0 })
    expect(result.candidates).toEqual([expect.objectContaining({ folder_id: season.id, reason: 'excluded' })])
  })

  it('migrates legacy detached groups and removes their excluded orphan state during rebuild', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!

    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const group = before.work_groups[0]
    const item = before.items[0]
    db.prepare(`
      UPDATE media_work_groups
      SET group_key = ?, manual_locked = 1
      WHERE id = ?
    `).run([`manual:detach:${root.id}:${item.id}`, group.id])
    db.prepare(`
      UPDATE media_work_group_members
      SET manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([group.id, item.id])
    db.prepare('INSERT INTO folder_media_catalog_exclusions (folder_id) VALUES (?)').run(season.id)
    db.prepare('DELETE FROM folder_media_mappings WHERE root_folder_id = ?').run(root.id)

    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups WHERE id = ?').get(group.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(item.id)).toEqual({ count: 0 })
    expect(getCanonicalMediaCatalogForRoot(db, root.id).items).toEqual([])
  })

  it('keeps a migrated detached item when its physical mapping is temporarily missing', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    const season = rows.find(row => row.path.endsWith('Season 1'))!

    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const group = before.work_groups[0]
    const item = before.items[0]
    db.prepare(`
      UPDATE media_work_groups
      SET group_key = ?, manual_locked = 1
      WHERE id = ?
    `).run([`manual:detach:${root.id}:${item.id}`, group.id])
    db.prepare(`
      UPDATE media_work_group_members
      SET manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([group.id, item.id])
    db.prepare('DELETE FROM folder_media_mappings WHERE root_folder_id = ?').run(root.id)

    rebuildLibraryMediaCatalog(db, library.id)

    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups WHERE id = ?').get(group.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(item.id)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_exclusions WHERE root_folder_id = ? AND media_item_id = ?').get([root.id, item.id])).toEqual({ count: 1 })

    const restored = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(restored.items).toEqual([expect.objectContaining({ id: item.id })])
    expect(restored.ungrouped_item_ids).toEqual([item.id])
  })

  it('infers season one for a single source-less unnumbered main candidate', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Main',
    ], ['D:\\Anime\\Collection\\Main\\episode.mkv'])
    const main = rows.find(row => row.path.endsWith('Main'))!

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toEqual([expect.objectContaining({ id: expect.any(Number), kind: 'season', season_number: 1 })])
    expect(snapshot.mappings).toEqual([expect.objectContaining({
      folder_id: main.id,
      kind: 'season',
      season_number: 1,
      detected_by: expect.stringMatching(/fallback/i),
    })])
    expect(snapshot.work_groups[0].summary).toMatchObject({
      item_count: 1,
      physical_folder_count: 1,
      season_numbers: [1],
      unknown_count: 0,
    })
  })

  it('projects season one to every unknown physical mapping sharing one canonical item', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Main Release A',
      'D:\\Anime\\Collection\\Main Release B',
    ], [
      'D:\\Anime\\Collection\\Main Release A\\episode.mkv',
      'D:\\Anime\\Collection\\Main Release B\\episode.mkv',
    ])
    const first = rows.find(row => row.path.endsWith('Main Release A'))!
    const second = rows.find(row => row.path.endsWith('Main Release B'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8203 WHERE id IN (?, ?)").run([first.id, second.id])

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toEqual([expect.objectContaining({
      item_key: 'bangumi:8203',
      kind: 'season',
      season_number: 1,
      conflict_reason: null,
    })])
    expect(snapshot.mappings).toHaveLength(2)
    expect(snapshot.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: first.id, kind: 'season', season_number: 1 }),
      expect.objectContaining({ folder_id: second.id, kind: 'season', season_number: 1 }),
    ]))
    expect(snapshot.mappings.every((mapping: any) => /fallback/i.test(mapping.detected_by))).toBe(true)
    expect(snapshot.summary).toMatchObject({
      item_count: 1,
      mapping_count: 2,
      unknown_count: 0,
      conflict_count: 0,
    })
    expect(db.prepare(`
      SELECT kind, season_number, conflict_reason
      FROM folder_media_entries
      WHERE folder_id IN (?, ?)
      ORDER BY folder_id
    `).all([first.id, second.id])).toEqual([
      { kind: 'season', season_number: 1, conflict_reason: null },
      { kind: 'season', season_number: 1, conflict_reason: null },
    ])
  })

  it('does not apply the season-one fallback when the canonical item has a manual movie mapping', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Manual Movie',
      'D:\\Anime\\Collection\\Unknown Release',
    ], [
      'D:\\Anime\\Collection\\Manual Movie\\movie.mkv',
      'D:\\Anime\\Collection\\Unknown Release\\episode.mkv',
    ])
    const manualMovie = rows.find(row => row.path.endsWith('Manual Movie'))!
    const unknownRelease = rows.find(row => row.path.endsWith('Unknown Release'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8205 WHERE id IN (?, ?)").run([manualMovie.id, unknownRelease.id])

    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, manualMovie.id, { kind: 'movie' })

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        folder_id: manualMovie.id,
        kind: 'movie',
        season_number: null,
        manual_locked: 1,
        detected_by: 'manual',
      }),
      expect.objectContaining({
        folder_id: unknownRelease.id,
        kind: 'unknown',
        season_number: null,
        manual_locked: 0,
      }),
    ]))
    expect(snapshot.mappings.find((mapping: any) => mapping.folder_id === unknownRelease.id).detected_by)
      .not.toMatch(/fallback/i)
    expect(snapshot.summary).toMatchObject({ mapping_count: 2 })
    expect(db.prepare(`
      SELECT kind, season_number, manual_locked, detected_by
      FROM folder_media_entries
      WHERE folder_id IN (?, ?)
      ORDER BY folder_id
    `).all([manualMovie.id, unknownRelease.id])).toEqual([
      { kind: 'movie', season_number: null, manual_locked: 1, detected_by: 'manual' },
      { kind: 'unknown', season_number: null, manual_locked: 0, detected_by: expect.not.stringMatching(/fallback/i) },
    ])
  })

  it('keeps multiple source-less unknown main candidates unknown instead of guessing seasons', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Main A', 'D:\\Anime\\Collection\\Main B',
    ], [
      'D:\\Anime\\Collection\\Main A\\episode.mkv',
      'D:\\Anime\\Collection\\Main B\\episode.mkv',
    ])

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items.every((item: any) => item.kind === 'unknown' && item.season_number === null)).toBe(true)
    expect(snapshot.mappings.every((mapping: any) => mapping.kind === 'unknown' && mapping.season_number === null)).toBe(true)
    expect(snapshot.work_groups[0].summary).toMatchObject({
      item_count: 2,
      physical_folder_count: 2,
      season_numbers: [],
      unknown_count: 2,
    })
  })

  it('infers one source-less main candidate beside OVA and movie entries without reclassifying those formats', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Main',
      'D:\\Anime\\Collection\\OVA',
      'D:\\Anime\\Collection\\Movie',
    ], [
      'D:\\Anime\\Collection\\Main\\episode.mkv',
      'D:\\Anime\\Collection\\OVA\\episode.mkv',
      'D:\\Anime\\Collection\\Movie\\episode.mkv',
    ])
    const main = rows.find(row => row.path.endsWith('Main'))!
    const ova = rows.find(row => row.path.endsWith('OVA'))!
    const movie = rows.find(row => row.path.endsWith('Movie'))!

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: main.id, kind: 'season', season_number: 1 }),
      expect.objectContaining({ folder_id: ova.id, kind: 'ova', season_number: null }),
      expect.objectContaining({ folder_id: movie.id, kind: 'movie', season_number: null }),
    ]))
    expect(snapshot.work_groups[0].summary).toMatchObject({
      item_count: 3,
      physical_folder_count: 3,
      season_numbers: [1],
    })
  })

  it('keeps an unnumbered nested release unknown inside a pinned collection', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Meaningful Show',
      'D:\\Anime\\Collection\\Meaningful Show\\Release',
    ], ['D:\\Anime\\Collection\\Meaningful Show\\Release\\episode.mkv'])
    const anchor = rows.find(row => row.path.endsWith('Meaningful Show'))!
    const release = rows.find(row => row.path.endsWith('Meaningful Show\\Release'))!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.mappings).toEqual([expect.objectContaining({
      folder_id: release.id,
      kind: 'unknown',
      season_number: null,
      detected_by: expect.not.stringMatching(/fallback/i),
    })])
    expect(snapshot.work_groups).toEqual([expect.objectContaining({
      key: `anchor:${anchor.id}`,
      title: 'Meaningful Show',
      anchor: anchor.id,
      summary: expect.objectContaining({ season_numbers: [], unknown_count: 1 }),
    })])
  })

  it('sorts a projected conflict item after classified items instead of using its season mapping', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Conflict Movie',
      'D:\\Anime\\Collection\\Conflict Season 1',
      'D:\\Anime\\Collection\\Season 2',
    ], [
      'D:\\Anime\\Collection\\Conflict Movie\\episode.mkv',
      'D:\\Anime\\Collection\\Conflict Season 1\\episode.mkv',
      'D:\\Anime\\Collection\\Season 2\\episode.mkv',
    ])
    const conflictMovie = rows.find(row => row.path.endsWith('Conflict Movie'))!
    const conflictSeason = rows.find(row => row.path.endsWith('Conflict Season 1'))!
    const seasonTwo = rows.find(row => row.path.endsWith('Season 2'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8201 WHERE id IN (?, ?)").run([conflictMovie.id, conflictSeason.id])
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8202 WHERE id = ?").run(seasonTwo.id)

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items.find((item: any) => item.item_key === 'bangumi:8201')).toMatchObject({ kind: 'unknown', season_number: null })
    expect(snapshot.items.map((item: any) => item.item_key)).toEqual(['bangumi:8202', 'bangumi:8201'])
  })

  it('recognizes Chinese and Japanese side-story markers independently of media kind', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Season 1 外传',
      'D:\\Anime\\Collection\\Season 2 外傳',
      'D:\\Anime\\Collection\\OVA 外伝',
      'D:\\Anime\\Collection\\Special 番外',
      'D:\\Anime\\Collection\\Movie Gaiden',
    ], [
      'D:\\Anime\\Collection\\Season 1 外传\\episode.mkv',
      'D:\\Anime\\Collection\\Season 2 外傳\\episode.mkv',
      'D:\\Anime\\Collection\\OVA 外伝\\episode.mkv',
      'D:\\Anime\\Collection\\Special 番外\\episode.mkv',
      'D:\\Anime\\Collection\\Movie Gaiden\\episode.mkv',
    ])
    rebuildLibraryMediaCatalog(db, library.id)

    const relationRows = db.prepare(`
      SELECT i.title, i.kind, m.relation_role
      FROM media_work_group_members m
      JOIN media_items i ON i.id = m.media_item_id
      JOIN media_work_groups g ON g.id = m.work_group_id
      WHERE g.root_folder_id = ?
      ORDER BY i.title
    `).all(root.id) as any[]
    expect(relationRows).toEqual(expect.arrayContaining([
      { title: 'Season 1 外传', kind: 'season', relation_role: 'side_story' },
      { title: 'Season 2 外傳', kind: 'season', relation_role: 'side_story' },
      { title: 'OVA 外伝', kind: 'ova', relation_role: 'side_story' },
      { title: 'Special 番外', kind: 'special', relation_role: 'side_story' },
      { title: 'Movie Gaiden', kind: 'movie', relation_role: 'spin_off' },
    ]))
  })

  it('exposes durable work-group members while retaining item_ids compatibility', () => {
    const { root } = seedPinnedWorkGroups()
    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const group = snapshot.work_groups.find((candidate: any) => candidate.anchor ===
      db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Collection\\Show A').id)
    expect(group).toBeTruthy()
    expect(group.item_ids).toEqual([snapshot.items.find((item: any) => item.item_key === 'anilist:9101').id])
    expect(group.members).toEqual([
      expect.objectContaining({
        id: expect.any(Number),
        media_item_id: group.item_ids[0],
        relation_role: 'main',
        manual_locked: 0,
      }),
    ])
  })

  it('renames a work group with a trimmed title, locks it, and preserves it after rebuild', () => {
    const { root } = seedPinnedWorkGroups()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const group = before.work_groups.find((candidate: any) => candidate.title === 'Show A')
    const rename = (mediaCatalog as any).setMediaWorkGroupTitle
    expect(typeof rename).toBe('function')
    if (typeof rename !== 'function') return

    const result = rename(db, root.id, group.id, '  手动作品组  ')
    expect(result.canonical.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: group.id, title: '手动作品组', manual_locked: 1 }),
    ]))
    expect(() => rename(db, root.id, group.id, '   ')).toThrowError(mediaCatalog.MediaCatalogValidationError)

    rebuildLibraryMediaCatalog(db, library.id)
    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(after.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: group.id, title: '手动作品组', manual_locked: 1 }),
    ]))
  })

  it('rejects non-string titles for rename and split mutations', () => {
    const { root } = seedMultiMemberRoot()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const group = before.work_groups[0]
    const selectedItemId = group.item_ids[0]
    const rename = (mediaCatalog as any).setMediaWorkGroupTitle
    const split = (mediaCatalog as any).splitMediaWorkGroup

    for (const invalidTitle of [{ title: '对象' }, ['数组'], 123]) {
      let renameError: any
      try {
        rename(db, root.id, group.id, invalidTitle)
      } catch (error) {
        renameError = error
      }
      expect(renameError).toBeInstanceOf(mediaCatalog.MediaCatalogValidationError)
      expect(renameError).toMatchObject({ status: 400, code: 'INVALID_MEDIA_WORK_GROUP_TITLE' })

      let splitError: any
      try {
        split(db, root.id, group.id, [selectedItemId], invalidTitle)
      } catch (error) {
        splitError = error
      }
      expect(splitError).toBeInstanceOf(mediaCatalog.MediaCatalogValidationError)
      expect(splitError).toMatchObject({ status: 400, code: 'INVALID_MEDIA_WORK_GROUP_TITLE' })
    }
  })

  it('merges source members into a target group, locks the result, and survives rebuild', () => {
    const { root } = seedPinnedWorkGroups()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const target = before.work_groups.find((candidate: any) => candidate.title === 'Show A')
    const source = before.work_groups.find((candidate: any) => candidate.title === 'Show B')
    const sourceItemId = source.item_ids[0]
    db.prepare('UPDATE media_work_group_members SET relation_role = ? WHERE work_group_id = ? AND media_item_id = ?')
      .run(['spin_off', source.id, sourceItemId])
    const merge = (mediaCatalog as any).mergeMediaWorkGroups
    expect(typeof merge).toBe('function')
    if (typeof merge !== 'function') return

    const result = merge(db, root.id, target.id, source.id)
    const merged = result.canonical.work_groups.find((candidate: any) => candidate.id === target.id)
    expect(merged).toMatchObject({ id: target.id, manual_locked: 1 })
    expect(merged.item_ids).toEqual(expect.arrayContaining([...target.item_ids, sourceItemId]))
    expect(merged.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ media_item_id: sourceItemId, relation_role: 'spin_off', manual_locked: 1 }),
    ]))
    expect(result.canonical.work_groups.some((candidate: any) => candidate.id === source.id)).toBe(false)

    rebuildLibraryMediaCatalog(db, library.id)
    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const rebuilt = after.work_groups.find((candidate: any) => candidate.id === target.id)
    expect(rebuilt).toMatchObject({ manual_locked: 1 })
    expect(rebuilt.item_ids).toEqual(expect.arrayContaining([...target.item_ids, sourceItemId]))
    expect(rebuilt.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ media_item_id: sourceItemId, relation_role: 'spin_off', manual_locked: 1 }),
    ]))
    expect(after.work_groups.some((candidate: any) => candidate.id === source.id)).toBe(false)
  })

  it('detaches one item into an explicit ungrouped state without creating a synthetic group', () => {
    const { root } = seedMultiMemberRoot()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const source = before.work_groups[0]
    const item = before.items.find((candidate: any) => candidate.title === 'OVA')
    const detach = (mediaCatalog as any).detachMediaWorkGroupItem
    expect(typeof detach).toBe('function')
    if (typeof detach !== 'function') return

    const result = detach(db, root.id, source.id, item.id)
    expect(result.canonical.ungrouped_item_ids).toEqual([item.id])
    expect(result.canonical.work_groups).toEqual([
      expect.objectContaining({
        id: source.id,
        item_ids: expect.arrayContaining(before.items.filter((candidate: any) => candidate.id !== item.id).map((candidate: any) => candidate.id)),
      }),
    ])
    expect(result.canonical.work_groups.some((candidate: any) => candidate.item_ids.includes(item.id))).toBe(false)
    expect(result.canonical.work_groups.find((candidate: any) => candidate.id === source.id).item_ids).not.toContain(item.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_exclusions WHERE root_folder_id = ? AND media_item_id = ?').get([root.id, item.id])).toEqual({ count: 1 })

    rebuildLibraryMediaCatalog(db, library.id)
    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(after.work_groups.find((candidate: any) => candidate.id === source.id).item_ids).not.toContain(item.id)
    expect(after.work_groups.some((candidate: any) => candidate.item_ids.includes(item.id))).toBe(false)
    expect(after.ungrouped_item_ids).toEqual([item.id])
  })

  it('detaches the only member and removes the now-empty locked work group', () => {
    const { root } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Season 1',
    ], ['D:\\Anime\\Collection\\Season 1\\episode.mkv'])
    rebuildLibraryMediaCatalog(db, library.id)
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const group = before.work_groups[0]
    const item = before.items[0]
    db.prepare('UPDATE media_work_groups SET manual_locked = 1 WHERE id = ?').run(group.id)
    db.prepare('UPDATE media_work_group_members SET manual_locked = 1 WHERE work_group_id = ?').run(group.id)

    const result = mediaCatalog.detachMediaWorkGroupItem(db, root.id, group.id, item.id)

    expect(result.canonical?.ungrouped_item_ids).toEqual([item.id])
    expect(result.canonical?.work_groups).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups WHERE id = ?').get(group.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members WHERE media_item_id = ?').get(item.id)).toEqual({ count: 0 })
  })

  it('projects same-season physical parts as one confirmed season instead of a conflict', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Show S03 Part 1',
      'D:\\Anime\\Collection\\Show S03 Part 2',
    ], [
      'D:\\Anime\\Collection\\Show S03 Part 1\\episode.mkv',
      'D:\\Anime\\Collection\\Show S03 Part 2\\episode.mkv',
    ])
    const partOne = rows.find(row => row.path.endsWith('Show S03 Part 1'))!
    const partTwo = rows.find(row => row.path.endsWith('Show S03 Part 2'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8104 WHERE id IN (?, ?)").run([partOne.id, partTwo.id])

    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(snapshot.items).toEqual([expect.objectContaining({
      item_key: 'bangumi:8104',
      kind: 'season',
      season_number: 3,
      part_number: null,
      conflict_reason: null,
    })])
    expect(snapshot.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: partOne.id, season_number: 3, part_number: 1 }),
      expect.objectContaining({ folder_id: partTwo.id, season_number: 3, part_number: 2 }),
    ]))
    expect(snapshot.summary).toMatchObject({ item_count: 1, mapping_count: 2, conflict_count: 0, unknown_count: 0 })
  })

  it('attaches an explicitly ungrouped item to an existing group and persists the choice', () => {
    const { root } = seedMultiMemberRoot()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const source = before.work_groups[0]
    const target = before.work_groups[0]
    const item = before.items.find((candidate: any) => candidate.title === 'OVA')
    const detach = (mediaCatalog as any).detachMediaWorkGroupItem
    const attach = (mediaCatalog as any).attachMediaWorkGroupItem
    expect(typeof attach).toBe('function')
    detach(db, root.id, source.id, item.id)

    const result = attach(db, root.id, target.id, item.id)
    expect(result.canonical.ungrouped_item_ids).toEqual([])
    expect(result.canonical.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: target.id,
        item_ids: expect.arrayContaining([item.id]),
        members: expect.arrayContaining([
          expect.objectContaining({ media_item_id: item.id, manual_locked: 1 }),
        ]),
      }),
    ]))
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_exclusions WHERE root_folder_id = ? AND media_item_id = ?').get([root.id, item.id])).toEqual({ count: 0 })

    rebuildLibraryMediaCatalog(db, library.id)
    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(after.work_groups.find((group: any) => group.id === target.id).item_ids).toContain(item.id)
    expect(after.ungrouped_item_ids).toEqual([])
  })

  it('rejects explicit non-string detach titles while preserving the item title fallback', () => {
    const { root } = seedMultiMemberRoot()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const source = before.work_groups[0]
    const item = before.items.find((candidate: any) => candidate.title === 'OVA')
    const detach = (mediaCatalog as any).detachMediaWorkGroupItem

    for (const invalidTitle of [{ title: '对象' }, ['数组'], 123]) {
      let error: any
      try {
        detach(db, root.id, source.id, item.id, invalidTitle)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(mediaCatalog.MediaCatalogValidationError)
      expect(error).toMatchObject({ status: 400, code: 'INVALID_MEDIA_WORK_GROUP_TITLE' })
    }

    const result = detach(db, root.id, source.id, item.id)
    expect(result.canonical.ungrouped_item_ids).toEqual([item.id])
    expect(result.canonical.work_groups).toHaveLength(1)
    expect(result.canonical.work_groups[0].item_ids).not.toContain(item.id)
  })

  it('splits a proper subset into a locked group while preserving member roles', () => {
    const { root } = seedMultiMemberRoot()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const source = before.work_groups[0]
    const selected = before.items.filter((candidate: any) => candidate.title !== 'Season 1')
    db.prepare(`
      UPDATE media_work_group_members
      SET relation_role = CASE media_item_id WHEN ? THEN 'side_story' ELSE 'spin_off' END
      WHERE work_group_id = ? AND media_item_id IN (?, ?)
    `).run([selected[0].id, source.id, selected[0].id, selected[1].id])
    const split = (mediaCatalog as any).splitMediaWorkGroup
    expect(typeof split).toBe('function')
    if (typeof split !== 'function') return

    const result = split(db, root.id, source.id, selected.map((item: any) => item.id), '  独立特别篇  ')
    const splitGroup = result.canonical.work_groups.find((candidate: any) => candidate.title === '独立特别篇')
    expect(splitGroup).toMatchObject({ manual_locked: 1, item_ids: selected.map((item: any) => item.id) })
    expect(splitGroup.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ media_item_id: selected[0].id, relation_role: 'side_story', manual_locked: 1 }),
      expect.objectContaining({ media_item_id: selected[1].id, relation_role: 'spin_off', manual_locked: 1 }),
    ]))
    expect(result.canonical.work_groups.find((candidate: any) => candidate.id === source.id).item_ids).toEqual([
      before.items.find((item: any) => item.title === 'Season 1').id,
    ])

    rebuildLibraryMediaCatalog(db, library.id)
    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    expect(after.work_groups.find((candidate: any) => candidate.title === '独立特别篇')).toMatchObject({
      manual_locked: 1,
      item_ids: selected.map((item: any) => item.id),
    })
  })

  it('moves an automatic replacement into the previous locked work group and removes its empty target group', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Release A', 'D:\\Anime\\Collection\\Release B',
    ], [
      'D:\\Anime\\Collection\\Release A\\episode.mkv',
      'D:\\Anime\\Collection\\Release B\\episode.mkv',
    ])
    const releaseA = rows.find(row => row.path.endsWith('Release A'))!
    const releaseB = rows.find(row => row.path.endsWith('Release B'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9301 WHERE id IN (?, ?)")
      .run([releaseA.id, releaseB.id])
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, releaseA.id, { kind: 'custom', customLabel: '业' })
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const customItem = before.items.find((item: any) => item.kind === 'custom')
    const automaticItem = before.items.find((item: any) => item.item_key === 'bangumi:9301')
    const defaultGroup = before.work_groups.find((group: any) => group.item_ids.includes(automaticItem.id))
    const split = (mediaCatalog as any).splitMediaWorkGroup
    expect(typeof split).toBe('function')
    if (typeof split !== 'function') return

    const splitResult = split(db, root.id, defaultGroup.id, [customItem.id], '寒蝉业章')
    const previousGroup = splitResult.canonical.work_groups.find((group: any) => group.title === '寒蝉业章')
    expect(previousGroup).toBeTruthy()

    setManualMediaCatalog(db, releaseA.id, { clearManual: true })

    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const replacement = after.items.find((item: any) => item.item_key === 'bangumi:9301')
    const migratedGroup = after.work_groups.find((group: any) => group.id === previousGroup.id)
    expect(migratedGroup).toMatchObject({
      id: previousGroup.id,
      title: '寒蝉业章',
      manual_locked: 1,
      item_ids: [replacement.id],
      members: [expect.objectContaining({
        media_item_id: replacement.id,
        relation_role: 'main',
        manual_locked: 1,
      })],
    })
    expect(after.work_groups.some((group: any) => group.id === defaultGroup.id)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(customItem.id))
      .toEqual({ count: 0 })
  })

  it('keeps a separately locked target work group instead of overriding it during replacement', () => {
    const { root, rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Release A', 'D:\\Anime\\Collection\\Release B',
    ], [
      'D:\\Anime\\Collection\\Release A\\episode.mkv',
      'D:\\Anime\\Collection\\Release B\\episode.mkv',
    ])
    const releaseA = rows.find(row => row.path.endsWith('Release A'))!
    const releaseB = rows.find(row => row.path.endsWith('Release B'))!
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9302 WHERE id IN (?, ?)")
      .run([releaseA.id, releaseB.id])
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, releaseA.id, { kind: 'custom', customLabel: '业' })
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const customItem = before.items.find((item: any) => item.kind === 'custom')
    const automaticItem = before.items.find((item: any) => item.item_key === 'bangumi:9302')
    const defaultGroup = before.work_groups.find((group: any) => group.item_ids.includes(automaticItem.id))
    const split = (mediaCatalog as any).splitMediaWorkGroup
    expect(typeof split).toBe('function')
    if (typeof split !== 'function') return

    const splitResult = split(db, root.id, defaultGroup.id, [customItem.id], '寒蝉业章')
    const previousGroup = splitResult.canonical.work_groups.find((group: any) => group.title === '寒蝉业章')
    expect(previousGroup).toBeTruthy()
    db.prepare('UPDATE media_work_groups SET manual_locked = 1 WHERE id = ?').run(defaultGroup.id)
    db.prepare(`
      UPDATE media_work_group_members
      SET relation_role = 'spin_off', manual_locked = 1
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([defaultGroup.id, automaticItem.id])

    setManualMediaCatalog(db, releaseA.id, { clearManual: true })

    const after = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const replacement = after.items.find((item: any) => item.item_key === 'bangumi:9302')
    const retainedGroup = after.work_groups.find((group: any) => group.id === defaultGroup.id)
    expect(retainedGroup).toMatchObject({
      id: defaultGroup.id,
      manual_locked: 1,
      item_ids: [replacement.id],
      members: [expect.objectContaining({
        media_item_id: replacement.id,
        relation_role: 'spin_off',
        manual_locked: 1,
      })],
    })
    expect(after.work_groups.some((group: any) => group.id === previousGroup.id)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(customItem.id))
      .toEqual({ count: 0 })
  })

  it('does not read or move a shared target member from another canonical root', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Root A', 'D:\\Anime\\Root A\\Release',
      'D:\\Anime\\Root B', 'D:\\Anime\\Root B\\Release',
    ], [
      'D:\\Anime\\Root A\\Release\\episode.mkv',
      'D:\\Anime\\Root B\\Release\\episode.mkv',
    ], 'D:\\Anime\\Root A')
    const rootA = rows.find(row => row.path === 'D:\\Anime\\Root A')!
    const rootB = rows.find(row => row.path === 'D:\\Anime\\Root B')!
    const releaseA = rows.find(row => row.path.endsWith('Root A\\Release'))!
    const releaseB = rows.find(row => row.path.endsWith('Root B\\Release'))!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(rootB.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9401 WHERE id IN (?, ?)")
      .run([releaseA.id, releaseB.id])
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, releaseA.id, { kind: 'custom', customLabel: '业' })
    const before = getCanonicalMediaCatalogForRoot(db, rootA.id) as any
    const customItem = before.items.find((item: any) => item.kind === 'custom')
    const previousGroup = before.work_groups.find((group: any) => group.item_ids.includes(customItem.id))
    db.prepare('UPDATE media_work_groups SET manual_locked = 1 WHERE id = ?').run(previousGroup.id)
    db.prepare('UPDATE media_work_group_members SET manual_locked = 1 WHERE work_group_id = ? AND media_item_id = ?')
      .run([previousGroup.id, customItem.id])

    const readOtherRootState = () => db.prepare(`
      SELECT g.id, g.group_key, g.title, g.manual_locked AS group_manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_group_members m
      JOIN media_work_groups g ON g.id = m.work_group_id
      WHERE g.root_folder_id = ?
      ORDER BY g.id, m.media_item_id
    `).all(rootB.id)
    const otherRootBefore = readOtherRootState()

    expect(() => setManualMediaCatalog(db, releaseA.id, { clearManual: true })).not.toThrow()

    const after = getCanonicalMediaCatalogForRoot(db, rootA.id) as any
    const replacementMapping = after.mappings.find((mapping: any) => mapping.folder_id === releaseA.id)
    const replacement = after.items.find((item: any) => item.id === replacementMapping?.media_item_id)
    expect(replacement).toBeTruthy()
    expect(replacement).toMatchObject({ root_folder_id: rootA.id })
    expect(replacement.item_key).toMatch(/^bangumi:9401#clone:/)
    expect(after.work_groups.find((group: any) => group.id === previousGroup.id)).toMatchObject({
      item_ids: [replacement.id],
      manual_locked: 1,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(customItem.id))
      .toEqual({ count: 0 })
    expect(readOtherRootState()).toEqual(otherRootBefore)
  })

  it('keeps another root clean when changing a custom label with a shared source identity', () => {
    const { rows } = seed([
      'D:\\Anime', 'D:\\Anime\\Root A', 'D:\\Anime\\Root A\\Release',
      'D:\\Anime\\Root B', 'D:\\Anime\\Root B\\Release',
    ], [
      'D:\\Anime\\Root A\\Release\\episode.mkv',
      'D:\\Anime\\Root B\\Release\\episode.mkv',
    ], 'D:\\Anime\\Root A')
    const rootA = rows.find(row => row.path === 'D:\\Anime\\Root A')!
    const rootB = rows.find(row => row.path === 'D:\\Anime\\Root B')!
    const releaseA = rows.find(row => row.path.endsWith('Root A\\Release'))!
    const releaseB = rows.find(row => row.path.endsWith('Root B\\Release'))!
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(rootB.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 9402 WHERE id IN (?, ?)")
      .run([releaseA.id, releaseB.id])
    rebuildLibraryMediaCatalog(db, library.id)

    setManualMediaCatalog(db, releaseA.id, { kind: 'custom', customLabel: '业' })
    const before = getCanonicalMediaCatalogForRoot(db, rootA.id) as any
    const customItem = before.items.find((item: any) => item.kind === 'custom')
    const previousGroup = before.work_groups.find((group: any) => group.item_ids.includes(customItem.id))
    db.prepare('UPDATE media_work_groups SET title = ?, manual_locked = 1 WHERE id = ?')
      .run(['寒蝉业章', previousGroup.id])
    db.prepare(`
      UPDATE media_work_group_members
      SET manual_locked = 1, relation_role = 'side_story'
      WHERE work_group_id = ? AND media_item_id = ?
    `).run([previousGroup.id, customItem.id])

    const readOtherRootState = () => db.prepare(`
      SELECT g.id, g.group_key, g.title, g.manual_locked AS group_manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_group_members m
      JOIN media_work_groups g ON g.id = m.work_group_id
      WHERE g.root_folder_id = ?
      ORDER BY g.id, m.media_item_id
    `).all(rootB.id)
    const otherRootBefore = readOtherRootState()
    expect(() => setManualMediaCatalog(db, releaseA.id, { kind: 'custom', customLabel: '卒' })).not.toThrow()

    const after = getCanonicalMediaCatalogForRoot(db, rootA.id) as any
    expect(after.work_groups.find((group: any) => group.id === previousGroup.id)).toMatchObject({
      title: '寒蝉业章',
      item_ids: [expect.any(Number)],
    })
    expect(readOtherRootState()).toEqual(otherRootBefore)
  })

  it('rejects out-of-scope group operations and rolls back invalid subset selection', () => {
    const { root } = seedPinnedWorkGroups()
    const before = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const source = before.work_groups.find((candidate: any) => candidate.title === 'Show A')
    const foreign = before.work_groups.find((candidate: any) => candidate.title === 'Show B')
    const foreignMemberBefore = db.prepare('SELECT work_group_id, manual_locked FROM media_work_group_members WHERE media_item_id = ?')
      .get(foreign.item_ids[0])
    const split = (mediaCatalog as any).splitMediaWorkGroup
    const rename = (mediaCatalog as any).setMediaWorkGroupTitle
    expect(typeof split).toBe('function')
    expect(typeof rename).toBe('function')
    if (typeof split !== 'function' || typeof rename !== 'function') return

    expect(() => rename(db, root.id, source.id + 100000, '无效组')).toThrowError(mediaCatalog.MediaCatalogValidationError)
    expect(() => split(db, root.id, source.id, [foreign.item_ids[0]], '错误拆分')).toThrowError(mediaCatalog.MediaCatalogValidationError)
    expect(db.prepare('SELECT title, manual_locked FROM media_work_groups WHERE id = ?').get(source.id)).toEqual({
      title: 'Show A', manual_locked: 0,
    })
    expect(db.prepare('SELECT work_group_id, manual_locked FROM media_work_group_members WHERE media_item_id = ?').get(foreign.item_ids[0]))
      .toEqual(foreignMemberBefore)
  })
})
