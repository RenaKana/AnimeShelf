import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Database } from 'node-sqlite3-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFileDb } from '../../db/files'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { deleteFolderOnDisk, moveFolderToLibraryRoot, renameFolderOnDisk } from '../folder-operations'
import { rebuildLibraryMediaCatalog } from '../../../modules/media-catalog/server/media-catalog'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

describe('folder operations', () => {
  let tempDir: string
  let db: Database

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-folder-ops-'))
    db = createDb(path.join(tempDir, 'test.db'))
    bindTestModuleCapabilities(db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('renames a directory on disk and keeps its subtree records and tags', async () => {
    const root = path.join(tempDir, 'library-a')
    const source = path.join(root, 'Old Name')
    const season = path.join(source, 'Season 1')
    const episode = path.join(season, 'episode-01.mkv')
    fs.mkdirSync(season, { recursive: true })
    fs.writeFileSync(episode, 'video')

    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    makeFolderDb(db).upsertTree(library.id, [root, source, season])
    const sourceRow = makeFolderDb(db).getByLibrary(library.id).find(folder => folder.path === source)!
    const seasonRow = makeFolderDb(db).getByLibrary(library.id).find(folder => folder.path === season)!
    makeFileDb(db).upsertMany(library.id, [{
      path: episode,
      folder_id: seasonRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    const fileRow = db.prepare('SELECT id FROM files WHERE path = ?').get(episode) as { id: number }
    const tag = db.prepare("INSERT INTO tags (name, color, kind) VALUES ('保留标签', '#ffffff', 'custom')").run()
    db.prepare("INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, 'folder', ?)").run([tag.lastInsertRowid, sourceRow.id])

    const destination = path.join(root, 'New Name')
    const result = await renameFolderOnDisk(db, sourceRow.id, { name: 'New Name', expectedPath: source })

    expect(result).toMatchObject({ id: sourceRow.id, name: 'New Name', path: destination, libraryId: library.id })
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.readFileSync(path.join(destination, 'Season 1', 'episode-01.mkv'), 'utf8')).toBe('video')

    const renamed = db.prepare('SELECT id, name, path, renamed FROM folders WHERE id = ?').get(sourceRow.id) as any
    expect(renamed).toEqual({ id: sourceRow.id, name: 'New Name', path: destination, renamed: 0 })
    expect(db.prepare('SELECT path FROM folders WHERE id = ?').get(seasonRow.id)).toEqual({ path: path.join(destination, 'Season 1') })
    expect(db.prepare('SELECT id, path FROM files WHERE id = ?').get(fileRow.id)).toEqual({ id: fileRow.id, path: path.join(destination, 'Season 1', 'episode-01.mkv') })
    expect(db.prepare("SELECT COUNT(*) AS count FROM tag_links WHERE target_type = 'folder' AND target_id = ?").get(sourceRow.id)).toEqual({ count: 1 })
  })

  it('rebuilds catalog classification after renaming a series folder', async () => {
    const root = path.join(tempDir, 'library-a')
    const source = path.join(root, 'Unclear')
    const episode = path.join(source, 'episode-01.mkv')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(episode, 'video')

    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [root, source])
    const sourceRow = folderDb.getByLibrary(library.id).find(folder => folder.path === source)!
    makeFileDb(db).upsertMany(library.id, [{
      path: episode,
      folder_id: sourceRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(sourceRow.id)
    rebuildLibraryMediaCatalog(db, library.id)

    await renameFolderOnDisk(db, sourceRow.id, { name: 'Season 2', expectedPath: source })

    expect(db.prepare('SELECT kind, season_number FROM folder_media_entries WHERE folder_id = ?').all(sourceRow.id)).toEqual([
      { kind: 'season', season_number: 2 },
    ])
  })

  it('recalculates series roots before rebuilding after renaming a base folder', async () => {
    const root = path.join(tempDir, 'library-a')
    const base = path.join(root, 'Series')
    const show = path.join(base, 'Show')
    const episode = path.join(show, 'episode-01.mkv')
    fs.mkdirSync(show, { recursive: true })
    fs.writeFileSync(episode, 'video')

    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [root, base, show])
    const baseRow = folderDb.getByLibrary(library.id).find(folder => folder.path === base)!
    const showRow = folderDb.getByLibrary(library.id).find(folder => folder.path === show)!
    makeFileDb(db).upsertMany(library.id, [{
      path: episode,
      folder_id: showRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    folderDb.markSeries(library.id)

    await renameFolderOnDisk(db, baseRow.id, { name: 'Renamed', expectedPath: base })

    expect(db.prepare('SELECT is_series FROM folders WHERE id = ?').get(baseRow.id)).toEqual({ is_series: 1 })
  })

  it('moves a directory to another library root while preserving record ids and tags', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const season = path.join(source, 'Season 1')
    const episode = path.join(season, 'episode-01.mkv')
    fs.mkdirSync(season, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })
    fs.writeFileSync(episode, 'video')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source, season])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!
    const seasonRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === season)!
    const targetRootRow = folderDb.getByLibrary(targetLibrary.id).find(folder => folder.path === targetRoot)!
    makeFileDb(db).upsertMany(sourceLibrary.id, [{
      path: episode,
      folder_id: seasonRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    const fileRow = db.prepare('SELECT id FROM files WHERE path = ?').get(episode) as { id: number }
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(sourceRow.id)
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)
    const sourceSeries = db.prepare('SELECT id FROM media_series WHERE library_id = ? AND root_folder_id = ?').get([sourceLibrary.id, sourceRow.id]) as any
    db.prepare(`
      INSERT INTO folder_media_entries
        (folder_id, series_id, kind, season_number, part_number, source, confidence, detected_by, manual_locked)
      VALUES (?, ?, 'season', 9, 1, 'manual', 1, 'manual', 1)
    `).run([seasonRow.id, sourceSeries.id])
    db.prepare(`
      INSERT INTO folder_media_entries
        (folder_id, series_id, kind, source, confidence, detected_by, manual_locked)
      VALUES (?, ?, 'special', 'manual', 1, 'manual', 1)
    `).run([sourceRow.id, sourceSeries.id])
    const tag = db.prepare("INSERT INTO tags (name, color, kind) VALUES ('移动保留', '#ffffff', 'custom')").run()
    db.prepare("INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, 'folder', ?)").run([tag.lastInsertRowid, sourceRow.id])
    db.prepare("UPDATE folders SET anilist_id = 12345, has_poster = 1, source = 'anilist', rating = 8.5 WHERE id = ?").run(sourceRow.id)

    const destination = path.join(targetRoot, 'Series A')
    const result = await moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })

    expect(result).toMatchObject({ id: sourceRow.id, name: 'Series A', path: destination, libraryId: targetLibrary.id })
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.readFileSync(path.join(destination, 'Season 1', 'episode-01.mkv'), 'utf8')).toBe('video')

    expect(db.prepare('SELECT id, library_id, parent_id, path, anilist_id, has_poster, rating FROM folders WHERE id = ?').get(sourceRow.id)).toEqual({
      id: sourceRow.id,
      library_id: targetLibrary.id,
      parent_id: targetRootRow.id,
      path: destination,
      anilist_id: 12345,
      has_poster: 1,
      rating: 8.5,
    })
    expect(db.prepare('SELECT library_id, path FROM folders WHERE id = ?').get(seasonRow.id)).toEqual({
      library_id: targetLibrary.id,
      path: path.join(destination, 'Season 1'),
    })
    expect(db.prepare('SELECT id, library_id, path FROM files WHERE id = ?').get(fileRow.id)).toEqual({
      id: fileRow.id,
      library_id: targetLibrary.id,
      path: path.join(destination, 'Season 1', 'episode-01.mkv'),
    })
    expect(db.prepare("SELECT COUNT(*) AS count FROM tag_links WHERE target_type = 'folder' AND target_id = ?").get(sourceRow.id)).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT e.kind, e.season_number, s.library_id
      FROM folder_media_entries e JOIN media_series s ON s.id = e.series_id
      WHERE e.folder_id = ? AND e.manual_locked = 0
    `).all(seasonRow.id)).toEqual([])
    expect(db.prepare(`
      SELECT e.kind, e.season_number, e.manual_locked, s.library_id
      FROM folder_media_entries e JOIN media_series s ON s.id = e.series_id
      WHERE e.folder_id = ? AND e.manual_locked = 1
    `).all(seasonRow.id)).toEqual([{ kind: 'season', season_number: 9, manual_locked: 1, library_id: targetLibrary.id }])
    expect(db.prepare(`
      SELECT e.kind, e.manual_locked, s.library_id
      FROM folder_media_entries e JOIN media_series s ON s.id = e.series_id
      WHERE e.folder_id = ? AND e.manual_locked = 1
    `).all(sourceRow.id)).toEqual([{ kind: 'special', manual_locked: 1, library_id: targetLibrary.id }])
    expect(db.prepare('SELECT id FROM media_series WHERE library_id = ? AND root_folder_id = ?').all([sourceLibrary.id, sourceRow.id])).toEqual([])
  })

  it('rehomes manual canonical mappings and media items during a cross-library move', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const season = path.join(source, 'Season 1')
    const episode = path.join(season, 'episode-01.mkv')
    fs.mkdirSync(season, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })
    fs.writeFileSync(episode, 'video')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source, season])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!
    const seasonRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === season)!
    makeFileDb(db).upsertMany(sourceLibrary.id, [{
      path: episode,
      folder_id: seasonRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(sourceRow.id)
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 12345 WHERE id = ?").run(seasonRow.id)
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)

    const canonicalBefore = db.prepare(`
      SELECT m.id AS mapping_id, m.media_item_id, m.root_folder_id, i.library_id
      FROM folder_media_mappings m JOIN media_items i ON i.id = m.media_item_id
      WHERE m.folder_id = ?
    `).get(seasonRow.id) as any
    db.prepare('UPDATE folder_media_mappings SET manual_locked = 1, detected_by = \'manual\' WHERE id = ?').run(canonicalBefore.mapping_id)
    const groupBefore = db.prepare(`
      SELECT g.id, g.title, m.id AS member_id
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ? AND m.media_item_id = ?
    `).get([sourceRow.id, canonicalBefore.media_item_id]) as any
    db.prepare("UPDATE media_work_groups SET title = '手动移动组', manual_locked = 1 WHERE id = ?").run(groupBefore.id)
    db.prepare("UPDATE media_work_group_members SET relation_role = 'side_story', manual_locked = 1 WHERE id = ?").run(groupBefore.member_id)

    await moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })

    expect(db.prepare(`
      SELECT m.media_item_id, m.root_folder_id, m.manual_locked,
             i.library_id AS item_library_id, f.library_id AS folder_library_id
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      JOIN folders f ON f.id = m.folder_id
      WHERE m.folder_id = ?
    `).get(seasonRow.id)).toEqual({
      media_item_id: canonicalBefore.media_item_id,
      root_folder_id: sourceRow.id,
      manual_locked: 1,
      item_library_id: targetLibrary.id,
      folder_library_id: targetLibrary.id,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM folder_media_mappings m JOIN folders f ON f.id = m.folder_id
      WHERE f.library_id = ? AND m.media_item_id = ?
    `).get(sourceLibrary.id, canonicalBefore.media_item_id)).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT g.id, g.library_id, g.root_folder_id, g.title, g.manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ?
    `).get(sourceRow.id)).toEqual({
      id: groupBefore.id,
      library_id: targetLibrary.id,
      root_folder_id: sourceRow.id,
      title: '手动移动组',
      manual_locked: 1,
      media_item_id: canonicalBefore.media_item_id,
      relation_role: 'side_story',
      member_manual_locked: 1,
    })
  })

  it('clones a shared canonical item for a moved locked work-group relationship', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const seasonA = path.join(source, 'Season 1')
    const stationary = path.join(sourceRoot, 'Series B')
    const seasonB = path.join(stationary, 'Season 1')
    const episodeA = path.join(seasonA, 'episode-01.mkv')
    const episodeB = path.join(seasonB, 'episode-01.mkv')
    fs.mkdirSync(seasonA, { recursive: true })
    fs.mkdirSync(seasonB, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })
    fs.writeFileSync(episodeA, 'video-a')
    fs.writeFileSync(episodeB, 'video-b')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source, seasonA, stationary, seasonB])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceFolders = folderDb.getByLibrary(sourceLibrary.id)
    const sourceRow = sourceFolders.find(folder => folder.path === source)!
    const seasonARow = sourceFolders.find(folder => folder.path === seasonA)!
    const stationaryRow = sourceFolders.find(folder => folder.path === stationary)!
    const seasonBRow = sourceFolders.find(folder => folder.path === seasonB)!
    makeFileDb(db).upsertMany(sourceLibrary.id, [
      {
        path: episodeA,
        folder_id: seasonARow.id,
        name: path.basename(episodeA),
        size: 5,
        date_modified: 1,
        ext: 'mkv',
      },
      {
        path: episodeB,
        folder_id: seasonBRow.id,
        name: path.basename(episodeB),
        size: 5,
        date_modified: 1,
        ext: 'mkv',
      },
    ])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id IN (?, ?)').run([sourceRow.id, stationaryRow.id])
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8301 WHERE id IN (?, ?)").run([seasonARow.id, seasonBRow.id])
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)

    const canonicalBefore = db.prepare(`
      SELECT m.id AS mapping_id, m.media_item_id
      FROM folder_media_mappings m
      WHERE m.folder_id = ?
    `).get(seasonARow.id) as any
    const groupBefore = db.prepare(`
      SELECT g.id, m.id AS member_id
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ? AND m.media_item_id = ?
    `).get([sourceRow.id, canonicalBefore.media_item_id]) as any
    db.prepare("UPDATE folder_media_mappings SET manual_locked = 1, detected_by = 'manual' WHERE id = ?").run(canonicalBefore.mapping_id)
    db.prepare("UPDATE media_work_groups SET title = '共享移动组', manual_locked = 1 WHERE id = ?").run(groupBefore.id)
    db.prepare("UPDATE media_work_group_members SET relation_role = 'spin_off', manual_locked = 1 WHERE id = ?").run(groupBefore.member_id)

    await moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })

    const sourceItem = db.prepare(`
      SELECT id, library_id, root_folder_id
      FROM media_items WHERE id = ?
    `).get(canonicalBefore.media_item_id) as any
    expect(sourceItem).toEqual({ id: canonicalBefore.media_item_id, library_id: sourceLibrary.id, root_folder_id: stationaryRow.id })
    const targetItem = db.prepare(`
      SELECT id, library_id, root_folder_id, item_key
      FROM media_items
      WHERE library_id = ? AND root_folder_id = ?
    `).get([targetLibrary.id, sourceRow.id]) as any
    expect(targetItem).toMatchObject({
      library_id: targetLibrary.id,
      root_folder_id: sourceRow.id,
      item_key: 'bangumi:8301',
    })
    expect(targetItem.id).not.toBe(canonicalBefore.media_item_id)
    expect(db.prepare(`
      SELECT g.id, g.library_id, g.root_folder_id, g.title, g.manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ?
    `).get(sourceRow.id)).toEqual({
      id: groupBefore.id,
      library_id: targetLibrary.id,
      root_folder_id: sourceRow.id,
      title: '共享移动组',
      manual_locked: 1,
      media_item_id: targetItem.id,
      relation_role: 'spin_off',
      member_manual_locked: 1,
    })
    expect(db.prepare(`
      SELECT source, external_id
      FROM media_item_sources WHERE media_item_id = ?
    `).all(targetItem.id)).toEqual([{ source: 'bangumi', external_id: '8301' }])
  })

  it('clones a moved item when the target identity has manual mappings and preserves both work groups', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const sourceSeason = path.join(source, 'Season 1')
    const targetSeries = path.join(targetRoot, 'Existing Series')
    const targetSeason = path.join(targetSeries, 'Season 1')
    const sourceEpisode = path.join(sourceSeason, 'episode-01.mkv')
    const targetEpisode = path.join(targetSeason, 'episode-01.mkv')
    fs.mkdirSync(sourceSeason, { recursive: true })
    fs.mkdirSync(targetSeason, { recursive: true })
    fs.writeFileSync(sourceEpisode, 'source video')
    fs.writeFileSync(targetEpisode, 'target video')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source, sourceSeason])
    folderDb.upsertTree(targetLibrary.id, [targetRoot, targetSeries, targetSeason])
    const sourceRows = folderDb.getByLibrary(sourceLibrary.id)
    const targetRows = folderDb.getByLibrary(targetLibrary.id)
    const sourceRow = sourceRows.find(folder => folder.path === source)!
    const sourceSeasonRow = sourceRows.find(folder => folder.path === sourceSeason)!
    const targetSeriesRow = targetRows.find(folder => folder.path === targetSeries)!
    const targetSeasonRow = targetRows.find(folder => folder.path === targetSeason)!
    makeFileDb(db).upsertMany(sourceLibrary.id, [{
      path: sourceEpisode,
      folder_id: sourceSeasonRow.id,
      name: path.basename(sourceEpisode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    makeFileDb(db).upsertMany(targetLibrary.id, [{
      path: targetEpisode,
      folder_id: targetSeasonRow.id,
      name: path.basename(targetEpisode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id IN (?, ?)').run([sourceRow.id, targetSeriesRow.id])
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8302 WHERE id IN (?, ?)").run([sourceSeasonRow.id, targetSeasonRow.id])
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)
    rebuildLibraryMediaCatalog(db, targetLibrary.id)

    const sourceBefore = db.prepare(`
      SELECT m.id AS mapping_id, m.media_item_id
      FROM folder_media_mappings m
      WHERE m.folder_id = ?
    `).get(sourceSeasonRow.id) as any
    const targetBefore = db.prepare(`
      SELECT m.id AS mapping_id, m.media_item_id
      FROM folder_media_mappings m
      WHERE m.folder_id = ?
    `).get(targetSeasonRow.id) as any
    const sourceGroupBefore = db.prepare(`
      SELECT g.id, m.id AS member_id
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ? AND m.media_item_id = ?
    `).get([sourceRow.id, sourceBefore.media_item_id]) as any
    const targetGroupBefore = db.prepare(`
      SELECT g.id, m.id AS member_id
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ? AND m.media_item_id = ?
    `).get([targetSeriesRow.id, targetBefore.media_item_id]) as any
    db.prepare("UPDATE folder_media_mappings SET manual_locked = 1, detected_by = 'manual' WHERE id = ?").run(targetBefore.mapping_id)
    db.prepare("UPDATE media_work_groups SET title = '源人工组', manual_locked = 1 WHERE id = ?").run(sourceGroupBefore.id)
    db.prepare("UPDATE media_work_group_members SET relation_role = 'spin_off', manual_locked = 1 WHERE id = ?").run(sourceGroupBefore.member_id)
    db.prepare("UPDATE media_work_groups SET title = '目标人工组', manual_locked = 1 WHERE id = ?").run(targetGroupBefore.id)
    db.prepare("UPDATE media_work_group_members SET relation_role = 'side_story', manual_locked = 1 WHERE id = ?").run(targetGroupBefore.member_id)

    await moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })
    rebuildLibraryMediaCatalog(db, targetLibrary.id)

    const movedMapping = db.prepare(`
      SELECT m.media_item_id, m.manual_locked, m.detected_by, i.item_key,
             i.library_id AS item_library_id, f.library_id AS folder_library_id
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      JOIN folders f ON f.id = m.folder_id
      WHERE m.folder_id = ?
    `).get(sourceSeasonRow.id) as any
    expect(movedMapping).toMatchObject({
      manual_locked: 0,
      item_library_id: targetLibrary.id,
      folder_library_id: targetLibrary.id,
    })
    expect(movedMapping.media_item_id).not.toBe(targetBefore.media_item_id)
    expect(movedMapping.item_key).not.toBe('bangumi:8302')

    expect(db.prepare(`
      SELECT m.media_item_id, m.manual_locked, m.detected_by, i.item_key,
             i.library_id AS item_library_id, f.library_id AS folder_library_id
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      JOIN folders f ON f.id = m.folder_id
      WHERE m.folder_id = ?
    `).get(targetSeasonRow.id)).toEqual({
      media_item_id: targetBefore.media_item_id,
      manual_locked: 1,
      detected_by: 'manual',
      item_key: 'bangumi:8302',
      item_library_id: targetLibrary.id,
      folder_library_id: targetLibrary.id,
    })

    expect(db.prepare(`
      SELECT g.id, g.title, g.manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ?
    `).get(targetSeriesRow.id)).toEqual({
      id: targetGroupBefore.id,
      title: '目标人工组',
      manual_locked: 1,
      media_item_id: targetBefore.media_item_id,
      relation_role: 'side_story',
      member_manual_locked: 1,
    })
    expect(db.prepare(`
      SELECT g.id, g.title, g.manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ?
    `).get(sourceRow.id)).toEqual({
      id: sourceGroupBefore.id,
      title: '源人工组',
      manual_locked: 1,
      media_item_id: movedMapping.media_item_id,
      relation_role: 'spin_off',
      member_manual_locked: 1,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items WHERE id = ?').get(sourceBefore.media_item_id)).toEqual({ count: 0 })
  })

  it('clones a moved mapping when a stationary source work group still owns the item', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const season = path.join(source, 'Season 1')
    const stationary = path.join(sourceRoot, 'Stationary Group')
    const episode = path.join(season, 'episode-01.mkv')
    fs.mkdirSync(season, { recursive: true })
    fs.mkdirSync(stationary, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })
    fs.writeFileSync(episode, 'source video')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source, season, stationary])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceRows = folderDb.getByLibrary(sourceLibrary.id)
    const sourceRow = sourceRows.find(folder => folder.path === source)!
    const seasonRow = sourceRows.find(folder => folder.path === season)!
    const stationaryRow = sourceRows.find(folder => folder.path === stationary)!
    makeFileDb(db).upsertMany(sourceLibrary.id, [{
      path: episode,
      folder_id: seasonRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id IN (?, ?)').run([sourceRow.id, stationaryRow.id])
    db.prepare("UPDATE folders SET source = 'bangumi', anilist_id = 8304 WHERE id = ?").run(seasonRow.id)
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)

    const sourceItem = db.prepare(`
      SELECT id, item_key
      FROM media_items WHERE library_id = ?
    `).get(sourceLibrary.id) as any
    db.prepare('DELETE FROM media_work_group_members WHERE media_item_id = ?').run(sourceItem.id)
    db.prepare("UPDATE folder_media_mappings SET manual_locked = 1, detected_by = 'manual' WHERE media_item_id = ?").run(sourceItem.id)
    db.prepare('UPDATE media_items SET root_folder_id = ? WHERE id = ?').run([stationaryRow.id, sourceItem.id])
    const groupInsert = db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked)
      VALUES (?, ?, NULL, ?, ?, 1)
    `).run([sourceLibrary.id, stationaryRow.id, 'manual:stationary', '源库驻留人工组'])
    db.prepare(`
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role, manual_locked)
      VALUES (?, ?, 'side_story', 1)
    `).run([groupInsert.lastInsertRowid, sourceItem.id])

    await moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })

    const movedMapping = db.prepare(`
      SELECT m.media_item_id, m.root_folder_id, i.library_id AS item_library_id
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      WHERE m.folder_id = ?
    `).get(seasonRow.id) as any
    expect(movedMapping).toMatchObject({
      root_folder_id: sourceRow.id,
      item_library_id: targetLibrary.id,
    })
    expect(movedMapping.media_item_id).not.toBe(sourceItem.id)
    expect(db.prepare('SELECT id, library_id, root_folder_id FROM media_items WHERE id = ?').get(sourceItem.id)).toEqual({
      id: sourceItem.id,
      library_id: sourceLibrary.id,
      root_folder_id: stationaryRow.id,
    })
    expect(db.prepare(`
      SELECT g.id, g.library_id, g.root_folder_id, g.title, g.manual_locked,
             m.media_item_id, m.relation_role, m.manual_locked AS member_manual_locked
      FROM media_work_groups g
      JOIN media_work_group_members m ON m.work_group_id = g.id
      WHERE g.root_folder_id = ?
    `).get(stationaryRow.id)).toEqual({
      id: groupInsert.lastInsertRowid,
      library_id: sourceLibrary.id,
      root_folder_id: stationaryRow.id,
      title: '源库驻留人工组',
      manual_locked: 1,
      media_item_id: sourceItem.id,
      relation_role: 'side_story',
      member_manual_locked: 1,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM folder_media_mappings
      WHERE media_item_id = ?
    `).get(sourceItem.id)).toEqual({ count: 0 })
  })

  it('rolls back a cross-library move when catalog rebuilding fails', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const season = path.join(source, 'Season 1')
    const targetSeries = path.join(targetRoot, 'Existing Series')
    const targetSeason = path.join(targetSeries, 'Season 2')
    const episode = path.join(season, 'episode-01.mkv')
    const targetEpisode = path.join(targetSeason, 'episode-01.mkv')
    fs.mkdirSync(season, { recursive: true })
    fs.mkdirSync(targetSeason, { recursive: true })
    fs.writeFileSync(episode, 'source video')
    fs.writeFileSync(targetEpisode, 'target video')

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source, season])
    folderDb.upsertTree(targetLibrary.id, [targetRoot, targetSeries, targetSeason])
    const sourceRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!
    const seasonRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === season)!
    const targetSeriesRow = folderDb.getByLibrary(targetLibrary.id).find(folder => folder.path === targetSeries)!
    const targetSeasonRow = folderDb.getByLibrary(targetLibrary.id).find(folder => folder.path === targetSeason)!
    makeFileDb(db).upsertMany(sourceLibrary.id, [{
      path: episode,
      folder_id: seasonRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    makeFileDb(db).upsertMany(targetLibrary.id, [{
      path: targetEpisode,
      folder_id: targetSeasonRow.id,
      name: path.basename(targetEpisode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    db.prepare('UPDATE folders SET is_series = 1 WHERE id IN (?, ?)').run([sourceRow.id, targetSeriesRow.id])
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)
    rebuildLibraryMediaCatalog(db, targetLibrary.id)
    const sourceSeries = db.prepare('SELECT id FROM media_series WHERE library_id = ? AND root_folder_id = ?')
      .get([sourceLibrary.id, sourceRow.id]) as any
    db.prepare(`
      INSERT INTO folder_media_entries
        (folder_id, series_id, kind, season_number, source, confidence, detected_by, manual_locked)
      VALUES (?, ?, 'season', 9, 'manual', 1, 'manual', 1)
    `).run([seasonRow.id, sourceSeries.id])

    db.exec(`
      CREATE TRIGGER fail_cross_library_catalog_rebuild
      BEFORE INSERT ON folder_media_entries
      WHEN NEW.manual_locked = 0
      BEGIN
        SELECT RAISE(ABORT, 'injected cross-library rebuild failure');
      END;
    `)

    await expect(moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })).rejects.toThrow('injected cross-library rebuild failure')

    expect(fs.existsSync(source)).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'Series A'))).toBe(false)
    const sourceRootRow = db.prepare('SELECT id FROM folders WHERE path = ?').get(sourceRoot) as { id: number }
    expect(db.prepare('SELECT library_id, path, parent_id FROM folders WHERE id = ?').get(sourceRow.id)).toEqual({
      library_id: sourceLibrary.id,
      path: source,
      parent_id: sourceRootRow.id,
    })
    expect(db.prepare('SELECT library_id, path FROM files WHERE path = ?').get(episode)).toEqual({
      library_id: sourceLibrary.id,
      path: episode,
    })
    expect(db.prepare(`
      SELECT e.kind, e.season_number, e.manual_locked, s.library_id
      FROM folder_media_entries e JOIN media_series s ON s.id = e.series_id
      WHERE e.folder_id = ?
    `).all(seasonRow.id)).toEqual([
      { kind: 'season', season_number: 1, manual_locked: 0, library_id: sourceLibrary.id },
      { kind: 'season', season_number: 9, manual_locked: 1, library_id: sourceLibrary.id },
    ])
  })

  it('clears external display metadata references when moving a subtree but keeps internal references', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const collection = path.join(sourceRoot, 'Collection')
    const series = path.join(collection, 'Series A')
    const season = path.join(series, 'Season 1')
    fs.mkdirSync(season, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })

    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, collection, series, season])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceFolders = folderDb.getByLibrary(sourceLibrary.id)
    const collectionRow = sourceFolders.find(folder => folder.path === collection)!
    const seriesRow = sourceFolders.find(folder => folder.path === series)!
    const seasonRow = sourceFolders.find(folder => folder.path === season)!
    db.prepare('UPDATE folders SET display_metadata_folder_id = ? WHERE id = ?')
      .run([seriesRow.id, collectionRow.id])
    db.prepare('UPDATE folders SET display_metadata_folder_id = ? WHERE id = ?')
      .run([seasonRow.id, seriesRow.id])

    await moveFolderToLibraryRoot(db, seriesRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: series,
    })

    expect(db.prepare('SELECT display_metadata_folder_id FROM folders WHERE id = ?').get(collectionRow.id))
      .toEqual({ display_metadata_folder_id: null })
    expect(db.prepare('SELECT display_metadata_folder_id FROM folders WHERE id = ?').get(seriesRow.id))
      .toEqual({ display_metadata_folder_id: seasonRow.id })
  })

  it('deletes a directory subtree from disk and clears database records and tag links', async () => {
    const root = path.join(tempDir, 'library-a')
    const source = path.join(root, 'Delete Me')
    const season = path.join(source, 'Season 1')
    const episode = path.join(season, 'episode-01.mkv')
    fs.mkdirSync(season, { recursive: true })
    fs.writeFileSync(episode, 'video')

    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [root, source, season])
    const sourceRow = folderDb.getByLibrary(library.id).find(folder => folder.path === source)!
    const seasonRow = folderDb.getByLibrary(library.id).find(folder => folder.path === season)!
    makeFileDb(db).upsertMany(library.id, [{
      path: episode,
      folder_id: seasonRow.id,
      name: path.basename(episode),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    const fileRow = db.prepare('SELECT id FROM files WHERE path = ?').get(episode) as { id: number }
    const tag = db.prepare("INSERT INTO tags (name, color, kind) VALUES ('删除标签', '#ffffff', 'custom')").run()
    db.prepare("INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, 'folder', ?)").run([tag.lastInsertRowid, sourceRow.id])
    db.prepare("INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, 'file', ?)").run([tag.lastInsertRowid, fileRow.id])

    await deleteFolderOnDisk(db, sourceRow.id, { expectedPath: source })

    expect(fs.existsSync(source)).toBe(false)
    expect(db.prepare('SELECT id FROM folders WHERE id IN (?, ?)').all([sourceRow.id, seasonRow.id])).toEqual([])
    expect(db.prepare('SELECT id FROM files WHERE id = ?').get(fileRow.id)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links WHERE target_id IN (?, ?)').get([sourceRow.id, fileRow.id])).toEqual({ count: 0 })
  })

  it('rejects invalid Windows names without changing the disk or database', async () => {
    const root = path.join(tempDir, 'library-a')
    const source = path.join(root, 'Keep Me')
    fs.mkdirSync(source, { recursive: true })
    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    makeFolderDb(db).upsertTree(library.id, [root, source])
    const sourceRow = makeFolderDb(db).getByLibrary(library.id).find(folder => folder.path === source)!

    await expect(renameFolderOnDisk(db, sourceRow.id, { name: 'CON', expectedPath: source })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_NAME',
    })

    expect(fs.existsSync(source)).toBe(true)
    expect(db.prepare('SELECT name, path FROM folders WHERE id = ?').get(sourceRow.id)).toEqual({ name: 'Keep Me', path: source })
  })

  it('protects the configured library root from rename and delete operations', async () => {
    const root = path.join(tempDir, 'library-a')
    fs.mkdirSync(root, { recursive: true })
    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    makeFolderDb(db).upsertTree(library.id, [root])
    const rootRow = makeFolderDb(db).getByLibrary(library.id).find(folder => folder.path === root)!

    await expect(renameFolderOnDisk(db, rootRow.id, { name: 'Renamed Root', expectedPath: root })).rejects.toMatchObject({
      status: 403,
      code: 'ROOT_FOLDER_PROTECTED',
    })
    await expect(deleteFolderOnDisk(db, rootRow.id, { expectedPath: root })).rejects.toMatchObject({
      status: 403,
      code: 'ROOT_FOLDER_PROTECTED',
    })
    expect(fs.existsSync(root)).toBe(true)
  })

  it('rejects stale requests and destination collisions before touching the filesystem', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    const collision = path.join(targetRoot, 'Series A')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(collision, { recursive: true })
    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source])
    folderDb.upsertTree(targetLibrary.id, [targetRoot, collision])
    const sourceRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!

    await expect(deleteFolderOnDisk(db, sourceRow.id, { expectedPath: `${source}-stale` })).rejects.toMatchObject({
      status: 409,
      code: 'STALE_FOLDER_PATH',
    })
    await expect(moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })).rejects.toMatchObject({ status: 409, code: 'DESTINATION_EXISTS' })
    expect(fs.existsSync(source)).toBe(true)
    expect(fs.existsSync(collision)).toBe(true)
  })

  it('serializes file operations per database without holding a transaction across the awaited move', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })
    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!

    const realRename = fs.promises.rename.bind(fs.promises)
    let entered!: () => void
    let release!: () => void
    const renameEntered = new Promise<void>(resolve => { entered = resolve })
    const renameRelease = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === source) {
        entered()
        await renameRelease
      }
      return realRename(from, to)
    })

    const moving = moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })
    await renameEntered

    expect(db.inTransaction).toBe(false)
    db.prepare("INSERT INTO settings (key, value) VALUES ('concurrent-owner-write', 'ok')").run()
    expect(db.prepare("SELECT value FROM settings WHERE key = 'concurrent-owner-write'").get()).toEqual({ value: 'ok' })
    await expect(renameFolderOnDisk(db, sourceRow.id, {
      name: 'Concurrent Rename',
      expectedPath: source,
    })).rejects.toMatchObject({ status: 409, code: 'FILE_OPERATION_IN_PROGRESS' })

    release()
    await expect(moving).resolves.toMatchObject({ path: path.join(targetRoot, 'Series A') })
  })

  it('keeps the delete tombstone recoverable until the database transaction commits', async () => {
    const root = path.join(tempDir, 'library-a')
    const source = path.join(root, 'Delete Me')
    fs.mkdirSync(source, { recursive: true })
    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [root, source])
    const sourceRow = folderDb.getByLibrary(library.id).find(folder => folder.path === source)!
    db.exec(`
      CREATE TRIGGER fail_external_delete
      BEFORE DELETE ON folders WHEN OLD.id = ${sourceRow.id}
      BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;
    `)
    const rmSpy = vi.spyOn(fs.promises, 'rm')

    await expect(deleteFolderOnDisk(db, sourceRow.id, { expectedPath: source }))
      .rejects.toThrow('injected delete failure')

    expect(rmSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(source)).toBe(true)
    expect(fs.readdirSync(root).some(name => name.startsWith('.animeshelf-delete-'))).toBe(false)
    expect(db.prepare('SELECT id, path FROM folders WHERE id = ?').get(sourceRow.id)).toEqual({ id: sourceRow.id, path: source })
  })

  it('commits deletion before cleanup and preserves a tombstone when cleanup fails', async () => {
    const root = path.join(tempDir, 'library-a')
    const source = path.join(root, 'Delete Me')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'keep-until-commit.txt'), 'payload')
    const library = makeLibraryDb(db).create('Library A', root, 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [root, source])
    const sourceRow = folderDb.getByLibrary(library.id).find(folder => folder.path === source)!
    const cleanupWarning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(Object.assign(new Error('cleanup denied'), { code: 'EPERM' }))

    const deleted = await deleteFolderOnDisk(db, sourceRow.id, { expectedPath: source })
    expect(deleted).toMatchObject({ id: sourceRow.id, cleanupPending: true })
    expect(deleted.cleanupPath).toContain('.animeshelf-delete-')

    expect(fs.existsSync(source)).toBe(false)
    expect(db.prepare('SELECT id FROM folders WHERE id = ?').get(sourceRow.id)).toBeNull()
    const tombstone = fs.readdirSync(root).find(name => name.startsWith('.animeshelf-delete-'))
    expect(tombstone).toBeDefined()
    expect(fs.readFileSync(path.join(root, tombstone!, 'keep-until-commit.txt'), 'utf8')).toBe('payload')
    expect(cleanupWarning).toHaveBeenCalled()
  })

  it('supports a case-only rename on Windows', async () => {
    if (process.platform !== 'win32') return
    const root = path.join(tempDir, 'case-only')
    const source = path.join(root, 'series')
    fs.mkdirSync(source, { recursive: true })
    const library = makeLibraryDb(db).create('Case only', root, 'anime')
    const folders = makeFolderDb(db)
    folders.upsertTree(library.id, [root, source])
    const row = folders.getByLibrary(library.id).find(folder => folder.path === source)!
    const result = await renameFolderOnDisk(db, row.id, { expectedPath: source, name: 'Series' })
    expect(result.path).toBe(path.join(root, 'Series'))
    expect(fs.readdirSync(root)).toEqual(['Series'])
    expect(db.prepare('SELECT name, path FROM folders WHERE id = ?').get(row.id)).toEqual({ name: 'Series', path: result.path })
  })

  it('rejects cross-device moves instead of falling back to copy and delete', async () => {
    const sourceRoot = path.join(tempDir, 'library-a')
    const targetRoot = path.join(tempDir, 'library-b')
    const source = path.join(sourceRoot, 'Series A')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(targetRoot, { recursive: true })
    fs.writeFileSync(path.join(source, 'episode.mkv'), 'video')
    const libraryDb = makeLibraryDb(db)
    const folderDb = makeFolderDb(db)
    const sourceLibrary = libraryDb.create('Library A', sourceRoot, 'anime')
    const targetLibrary = libraryDb.create('Library B', targetRoot, 'anime')
    folderDb.upsertTree(sourceLibrary.id, [sourceRoot, source])
    folderDb.upsertTree(targetLibrary.id, [targetRoot])
    const sourceRow = folderDb.getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))

    await expect(moveFolderToLibraryRoot(db, sourceRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: source,
    })).rejects.toMatchObject({ status: 409, code: 'CROSS_DEVICE_MOVE_UNSUPPORTED' })

    expect(fs.existsSync(source)).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'Series A'))).toBe(false)
    expect(db.prepare('SELECT library_id, path FROM folders WHERE id = ?').get(sourceRow.id)).toEqual({
      library_id: sourceLibrary.id,
      path: source,
    })
  })

  it('rejects source-ancestor and target-root junctions before touching data', async () => {
    if (process.platform !== 'win32') return

    const sourceRoot = path.join(tempDir, 'library-a')
    const outsideSource = path.join(tempDir, 'outside-source')
    const sourceJunction = path.join(sourceRoot, 'linked')
    const source = path.join(sourceJunction, 'Series A')
    fs.mkdirSync(sourceRoot, { recursive: true })
    fs.mkdirSync(path.join(outsideSource, 'Series A'), { recursive: true })
    fs.symlinkSync(outsideSource, sourceJunction, 'junction')
    const sourceLibrary = makeLibraryDb(db).create('Library A', sourceRoot, 'anime')
    makeFolderDb(db).upsertTree(sourceLibrary.id, [sourceRoot, sourceJunction, source])
    const sourceRow = makeFolderDb(db).getByLibrary(sourceLibrary.id).find(folder => folder.path === source)!

    await expect(renameFolderOnDisk(db, sourceRow.id, {
      name: 'Renamed',
      expectedPath: source,
    })).rejects.toMatchObject({ status: 403, code: 'UNSAFE_PATH_LINK' })
    expect(fs.existsSync(path.join(outsideSource, 'Series A'))).toBe(true)

    const safeRoot = path.join(tempDir, 'safe-source')
    const safeSource = path.join(safeRoot, 'Move Me')
    const outsideTarget = path.join(tempDir, 'outside-target')
    const targetJunction = path.join(tempDir, 'target-junction')
    fs.mkdirSync(safeSource, { recursive: true })
    fs.mkdirSync(outsideTarget, { recursive: true })
    fs.symlinkSync(outsideTarget, targetJunction, 'junction')
    const safeLibrary = makeLibraryDb(db).create('Safe Source', safeRoot, 'anime')
    const targetLibrary = makeLibraryDb(db).create('Linked Target', targetJunction, 'anime')
    makeFolderDb(db).upsertTree(safeLibrary.id, [safeRoot, safeSource])
    const safeRow = makeFolderDb(db).getByLibrary(safeLibrary.id).find(folder => folder.path === safeSource)!

    await expect(moveFolderToLibraryRoot(db, safeRow.id, {
      targetLibraryId: targetLibrary.id,
      expectedPath: safeSource,
    })).rejects.toMatchObject({ status: 403, code: 'UNSAFE_PATH_LINK' })
    expect(fs.existsSync(safeSource)).toBe(true)
    expect(fs.existsSync(path.join(outsideTarget, 'Move Me'))).toBe(false)
  })
})
