import { afterEach, describe, expect, it } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import {
  clearCatalogDirty,
  listDirtyCatalogLibraries,
  maintainCatalogIntegrity,
  markCatalogDirty,
} from '../../core/catalog-integrity'

describe('catalog integrity custodian', () => {
  let db: ReturnType<typeof createDb> | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('rehomes retained manual catalog state without loading the classifier', () => {
    db = createDb(':memory:')
    const libraries = makeLibraryDb(db)
    const folders = makeFolderDb(db)
    const sourceLibrary = libraries.create('Source', 'D:\\Source', 'anime')
    const targetLibrary = libraries.create('Target', 'D:\\Target', 'anime')

    folders.upsertTree(sourceLibrary.id, [
      'D:\\Source',
      'D:\\Source\\Moved',
      'D:\\Source\\Moved\\Season 7',
      'D:\\Source\\Moved\\Movie',
      'D:\\Source\\Stationary',
      'D:\\Source\\Stationary\\Season 1',
    ])
    folders.upsertTree(targetLibrary.id, ['D:\\Target'])
    const byPath = new Map((db.prepare('SELECT id, path FROM folders').all() as Array<{ id: number; path: string }>)
      .map(folder => [folder.path, folder.id]))
    const movedRootId = byPath.get('D:\\Source\\Moved')!
    const movedSeasonId = byPath.get('D:\\Source\\Moved\\Season 7')!
    const movedMovieId = byPath.get('D:\\Source\\Moved\\Movie')!
    const stationaryRootId = byPath.get('D:\\Source\\Stationary')!
    const stationarySeasonId = byPath.get('D:\\Source\\Stationary\\Season 1')!
    const targetRootId = byPath.get('D:\\Target')!
    db.prepare('UPDATE folders SET is_series = 1, pinned = 1 WHERE id IN (?, ?)')
      .run([movedRootId, stationaryRootId])

    const movedSeries = db.prepare(`
      INSERT INTO media_series
        (library_id, root_folder_id, series_key, title, manual_locked)
      VALUES (?, ?, ?, 'Retained manual collection', 1)
    `).run([sourceLibrary.id, movedRootId, `folder:${movedRootId}`])
    const stationarySeries = db.prepare(`
      INSERT INTO media_series
        (library_id, root_folder_id, series_key, title)
      VALUES (?, ?, ?, 'Stationary collection')
    `).run([sourceLibrary.id, stationaryRootId, `folder:${stationaryRootId}`])
    const manualEntry = db.prepare(`
      INSERT INTO folder_media_entries
        (folder_id, series_id, kind, season_number, part_number, source,
         external_id, confidence, detected_by, manual_locked)
      VALUES (?, ?, 'season', 7, 2, 'bangumi', '4200', 1, 'manual', 1)
    `).run([movedSeasonId, movedSeries.lastInsertRowid])

    const sharedItem = db.prepare(`
      INSERT INTO media_items
        (library_id, root_folder_id, item_key, title, kind, season_number,
         confidence, manual_locked)
      VALUES (?, ?, 'bangumi:4200', 'Retained work', 'season', 7, 1, 1)
    `).run([sourceLibrary.id, movedRootId])
    const movieItem = db.prepare(`
      INSERT INTO media_items
        (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'anilist:9900', 'Retained movie', 'movie', 1)
    `).run([sourceLibrary.id, movedRootId])
    const orphanItem = db.prepare(`
      INSERT INTO media_items
        (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'orphan:1', 'Orphan', 'unknown', 0)
    `).run([sourceLibrary.id, stationaryRootId])
    db.prepare(`
      INSERT INTO media_item_sources
        (media_item_id, source, external_id, is_primary)
      VALUES (?, 'bangumi', '4200', 1), (?, 'anilist', '9900', 1),
             (?, 'manual', 'orphan', 1)
    `).run([sharedItem.lastInsertRowid, movieItem.lastInsertRowid, orphanItem.lastInsertRowid])
    db.prepare(`
      INSERT INTO folder_media_mappings
        (folder_id, media_item_id, root_folder_id, series_id, content_role,
         kind, season_number, part_number, confidence, detected_by, manual_locked)
      VALUES (?, ?, ?, ?, 'main', 'season', 7, 2, 1, 'manual', 1)
    `).run([movedSeasonId, sharedItem.lastInsertRowid, movedRootId, movedSeries.lastInsertRowid])
    db.prepare(`
      INSERT INTO folder_media_mappings
        (folder_id, media_item_id, root_folder_id, series_id, content_role,
         kind, season_number, confidence, detected_by)
      VALUES (?, ?, ?, ?, 'main', 'season', 1, 1, 'directory')
    `).run([stationarySeasonId, sharedItem.lastInsertRowid, stationaryRootId, stationarySeries.lastInsertRowid])
    db.prepare(`
      INSERT INTO folder_media_mappings
        (folder_id, media_item_id, root_folder_id, series_id, content_role,
         kind, confidence, detected_by, manual_locked)
      VALUES (?, ?, ?, ?, 'movie', 'movie', 1, 'manual', 1)
    `).run([movedMovieId, movieItem.lastInsertRowid, movedRootId, movedSeries.lastInsertRowid])

    const group = db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked)
      VALUES (?, ?, ?, 'manual:retained', 'Retained manual group', 1)
    `).run([sourceLibrary.id, movedRootId, movedSeasonId])
    db.prepare(`
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role, manual_locked)
      VALUES (?, ?, 'main', 1), (?, ?, 'side_story', 1)
    `).run([group.lastInsertRowid, sharedItem.lastInsertRowid, group.lastInsertRowid, movieItem.lastInsertRowid])

    db.exec('BEGIN IMMEDIATE')
    db.prepare('UPDATE folders SET library_id = ? WHERE id IN (?, ?, ?)')
      .run([targetLibrary.id, movedRootId, movedSeasonId, movedMovieId])
    db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run([targetRootId, movedRootId])
    maintainCatalogIntegrity(db, [targetLibrary.id, sourceLibrary.id])
    db.exec('COMMIT')

    expect(listDirtyCatalogLibraries(db)).toEqual([targetLibrary.id, sourceLibrary.id])
    expect(db.prepare(`
      SELECT e.id, e.kind, e.season_number, e.part_number, e.manual_locked,
             s.library_id, s.root_folder_id, s.title, s.manual_locked AS series_manual_locked
      FROM folder_media_entries e
      JOIN media_series s ON s.id = e.series_id
      WHERE e.id = ?
    `).get(manualEntry.lastInsertRowid)).toEqual({
      id: Number(manualEntry.lastInsertRowid),
      kind: 'season',
      season_number: 7,
      part_number: 2,
      manual_locked: 1,
      library_id: targetLibrary.id,
      root_folder_id: movedRootId,
      title: 'Retained manual collection',
      series_manual_locked: 1,
    })

    expect(db.prepare(`
      SELECT id, library_id, root_folder_id FROM media_items WHERE id = ?
    `).get(sharedItem.lastInsertRowid)).toEqual({
      id: Number(sharedItem.lastInsertRowid),
      library_id: sourceLibrary.id,
      root_folder_id: stationaryRootId,
    })

    const movedMapping = db.prepare(`
      SELECT m.media_item_id, m.root_folder_id, m.manual_locked,
             i.library_id AS item_library_id, i.manual_locked AS item_manual_locked
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      WHERE m.folder_id = ?
    `).get(movedSeasonId) as {
      media_item_id: number
      root_folder_id: number
      manual_locked: number
      item_library_id: number
      item_manual_locked: number
    }
    expect(movedMapping).toMatchObject({
      root_folder_id: movedRootId,
      manual_locked: 1,
      item_library_id: targetLibrary.id,
      item_manual_locked: 1,
    })
    expect(movedMapping.media_item_id).not.toBe(Number(sharedItem.lastInsertRowid))
    expect(db.prepare(`
      SELECT source, external_id, is_primary
      FROM media_item_sources WHERE media_item_id = ?
    `).all(movedMapping.media_item_id)).toEqual([
      { source: 'bangumi', external_id: '4200', is_primary: 1 },
    ])
    expect(db.prepare(`
      SELECT g.library_id, g.root_folder_id, g.anchor_folder_id, g.title,
             g.manual_locked, m.media_item_id, m.relation_role,
             m.manual_locked AS member_manual_locked
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.id = ?
      ORDER BY m.id
    `).all(group.lastInsertRowid)).toEqual([
      {
        library_id: targetLibrary.id,
        root_folder_id: movedRootId,
        anchor_folder_id: movedSeasonId,
        title: 'Retained manual group',
        manual_locked: 1,
        media_item_id: movedMapping.media_item_id,
        relation_role: 'main',
        member_manual_locked: 1,
      },
      {
        library_id: targetLibrary.id,
        root_folder_id: movedRootId,
        anchor_folder_id: movedSeasonId,
        title: 'Retained manual group',
        manual_locked: 1,
        media_item_id: Number(movieItem.lastInsertRowid),
        relation_role: 'side_story',
        member_manual_locked: 1,
      },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(orphanItem.lastInsertRowid))
      .toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_item_sources WHERE media_item_id = ?').get(orphanItem.lastInsertRowid))
      .toEqual({ count: 0 })

    clearCatalogDirty(db, [targetLibrary.id])
    expect(listDirtyCatalogLibraries(db)).toEqual([sourceLibrary.id])
    markCatalogDirty(db, [targetLibrary.id, targetLibrary.id])
    expect(listDirtyCatalogLibraries(db)).toEqual([sourceLibrary.id, targetLibrary.id])
  })

  it('rebuilds dirty libraries even when the recognition rule version is current', async () => {
    db = createDb(':memory:')
    const libraries = makeLibraryDb(db)
    const folders = makeFolderDb(db)
    const untouchedLibrary = libraries.create('Untouched', 'D:\\Untouched', 'anime')
    const dirtyLibrary = libraries.create('Dirty', 'D:\\Dirty', 'anime')
    folders.upsertTree(untouchedLibrary.id, [
      'D:\\Untouched',
      'D:\\Untouched\\Show',
      'D:\\Untouched\\Show\\Season 1',
    ])
    folders.upsertTree(dirtyLibrary.id, [
      'D:\\Dirty',
      'D:\\Dirty\\Show',
      'D:\\Dirty\\Show\\Season 1',
    ])
    db.prepare("UPDATE folders SET is_series = 1 WHERE path IN ('D:\\Untouched\\Show', 'D:\\Dirty\\Show')").run()
    const dirtySeason = db.prepare("SELECT id FROM folders WHERE path = 'D:\\Dirty\\Show\\Season 1'").get() as { id: number }
    const untouchedSeason = db.prepare("SELECT id FROM folders WHERE path = 'D:\\Untouched\\Show\\Season 1'").get() as { id: number }
    db.prepare(`
      INSERT INTO files (folder_id, library_id, name, path, size, date_modified, ext)
      VALUES (?, ?, 'S01E01.mkv', 'D:\\Dirty\\Show\\Season 1\\S01E01.mkv', 1, 1, 'mkv'),
             (?, ?, 'S01E01.mkv', 'D:\\Untouched\\Show\\Season 1\\S01E01.mkv', 1, 1, 'mkv')
    `).run([dirtySeason.id, dirtyLibrary.id, untouchedSeason.id, untouchedLibrary.id])

    const mediaCatalog = await import('../../../modules/media-catalog/server/media-catalog')
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(['media_catalog_rule_version', mediaCatalog.MEDIA_CATALOG_RULE_VERSION])
    markCatalogDirty(db, [dirtyLibrary.id])

    const result = mediaCatalog.ensureMediaCatalogsCurrent(db)

    expect(result).toMatchObject({ rebuilt: true, ruleVersion: mediaCatalog.MEDIA_CATALOG_RULE_VERSION })
    expect(result.result?.libraryCount).toBe(1)
    expect(Object.keys(result.result?.results ?? {})).toEqual([String(dirtyLibrary.id)])
    expect(db.prepare('SELECT library_id FROM media_series ORDER BY library_id').all())
      .toEqual([{ library_id: dirtyLibrary.id }])
    expect(listDirtyCatalogLibraries(db)).toEqual([])
  })
})
