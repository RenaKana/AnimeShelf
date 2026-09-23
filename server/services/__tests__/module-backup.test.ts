import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'node-sqlite3-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('module-aware backup restore', () => {
  let tempDir: string
  let previousDataDir: string | undefined
  let currentDb: Database | null

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-module-backup-'))
    previousDataDir = process.env.ANIMESHELF_DATA_DIR
    process.env.ANIMESHELF_DATA_DIR = tempDir
    currentDb = null
    vi.resetModules()
  })

  afterEach(() => {
    try { currentDb?.close() } catch { /* preserve test failure */ }
    if (previousDataDir === undefined) delete process.env.ANIMESHELF_DATA_DIR
    else process.env.ANIMESHELF_DATA_DIR = previousDataDir
    vi.resetModules()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  async function initializeCurrent() {
    const schema = await import('../../db/schema')
    const database = await import('../../db/instance')
    currentDb = schema.createDb(path.join(tempDir, 'animeshelf.db'))
    database.initializeDatabase(currentDb)
    database.settingsDb.set('backup_include_posters', '0')
    return { ...schema, ...database, db: currentDb }
  }

  it('restores an old backup with missing new tables while preserving the current migration journal', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      INSERT INTO libraries (name, root_path, type) VALUES ('current', 'D:/current', 'anime');
      CREATE TABLE module_config (module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      INSERT INTO module_config VALUES ('season', 0);
      CREATE TABLE catalog_dirty_libraries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id INTEGER NOT NULL UNIQUE REFERENCES libraries(id) ON DELETE CASCADE,
        dirty_at TEXT NOT NULL
      );
      INSERT INTO catalog_dirty_libraries (library_id, dirty_at) VALUES (1, 'current');
      CREATE TABLE module_migrations (
        module_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (module_id, migration_id)
      );
      INSERT INTO module_migrations VALUES ('season', '002-current', '2026-09-08');
      INSERT INTO season_favorites (item_id, title) VALUES ('current-favorite', 'Current');
    `)

    const sourcePath = path.join(tempDir, 'old-backup.db')
    const source = createDb(sourcePath)
    source.exec(`
      INSERT INTO libraries (name, root_path, type) VALUES ('backup', 'D:/backup', 'anime');
      DROP TABLE season_favorites;
      CREATE TABLE module_migrations (
        module_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (module_id, migration_id)
      );
      INSERT INTO module_migrations VALUES ('season', '001-old', '2025-01-01');
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    const { inspectRestore, resolveRestorePreview } = await import('../restore-preview')
    const preview = inspectRestore(db, sourcePath)
    resolveRestorePreview(db, preview.previewId, preview.entries.map(entry => ({ folderId: entry.folderId, keepMissing: true })))
    await expect(restoreFromPath(sourcePath, preview.previewId)).resolves.toMatchObject({ tables: expect.any(Number) })

    expect(db.prepare('SELECT name FROM libraries').all()).toEqual([{ name: 'backup' }])
    expect(db.prepare('SELECT COUNT(*) AS count FROM module_config').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_dirty_libraries').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM season_favorites').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT module_id, migration_id, applied_at FROM module_migrations').all()).toEqual([
      { module_id: 'season', migration_id: '002-current', applied_at: '2026-09-08' },
    ])
  })

  it('uses real backup columns for empty and quoted module tables while applying current defaults', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      CREATE TABLE "inactive ""module"" records" (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL,
        restored_default TEXT NOT NULL DEFAULT 'current-default'
      );
      INSERT INTO "inactive ""module"" records" VALUES (9, 'current-value', 'current-value');
      CREATE TABLE empty_module_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO empty_module_records VALUES (1, 'remove-me');
    `)

    const sourcePath = path.join(tempDir, 'module-backup.db')
    const source = createDb(sourcePath)
    source.exec(`
      CREATE TABLE "inactive ""module"" records" (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO "inactive ""module"" records" VALUES (4, 'backup-value');
      CREATE TABLE empty_module_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await restoreFromPath(sourcePath)

    expect(db.prepare('SELECT id, value, restored_default FROM "inactive ""module"" records"').all()).toEqual([
      { id: 4, value: 'backup-value', restored_default: 'current-default' },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM empty_module_records').get()).toEqual({ count: 0 })
  })

  it('includes retained inactive-module data in a full snapshot and restores it', async () => {
    const { db, settingsDb } = await initializeCurrent()
    db.exec(`
      CREATE TABLE module_config (module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      INSERT INTO module_config VALUES ('season', 1);
      CREATE TABLE retained_module_data (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO retained_module_data VALUES (1, 'snapshot-value');
    `)
    const backupDir = path.join(tempDir, 'automatic')
    const protectionDir = path.join(tempDir, 'protection')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.mkdirSync(protectionDir, { recursive: true })
    settingsDb.set('backup_dir_auto', backupDir)

    const { autoBackup, restoreFromPath } = await import('../backup')
    const snapshotPath = autoBackup()
    expect(snapshotPath).toBeTruthy()
    db.prepare("UPDATE retained_module_data SET payload = 'changed'").run()
    db.prepare("UPDATE module_config SET enabled = 0 WHERE module_id = 'season'").run()
    settingsDb.set('backup_dir_auto', protectionDir)

    await restoreFromPath(snapshotPath!)

    expect(db.prepare('SELECT payload FROM retained_module_data WHERE id = 1').get()).toEqual({ payload: 'snapshot-value' })
    expect(db.prepare("SELECT enabled FROM module_config WHERE module_id = 'season'").get()).toEqual({ enabled: 1 })
  })


  it('round-trips folder links and catalog relationships without foreign-key damage', async () => {
    const { db, settingsDb } = await initializeCurrent()
    db.exec(`
      INSERT INTO libraries (id, name, root_path, type) VALUES (101, 'Backup Library', 'D:/backup', 'anime');
      INSERT INTO folders (id, library_id, parent_id, name, path, is_series)
        VALUES (201, 101, NULL, 'Collection', 'D:/backup/Collection', 1);
      INSERT INTO folders (id, library_id, parent_id, name, path, is_series)
        VALUES (202, 101, 201, 'Season 1', 'D:/backup/Collection/Season 1', 1);
      UPDATE folders SET display_metadata_folder_id = 202 WHERE id = 201;
      INSERT INTO media_series (id, library_id, root_folder_id, series_key, title)
        VALUES (301, 101, 201, 'series:collection', 'Collection');
      INSERT INTO folder_media_entries (id, folder_id, series_id, kind, season_number, confidence, detected_by)
        VALUES (302, 202, 301, 'season', 1, 1, 'test');
      INSERT INTO media_items (id, library_id, root_folder_id, item_key, title, kind, season_number, confidence)
        VALUES (401, 101, 201, 'item:season-1', 'Season 1', 'season', 1, 1);
      INSERT INTO media_item_sources (id, media_item_id, source, external_id, is_primary)
        VALUES (402, 401, 'anilist', '12345', 1);
      INSERT INTO media_work_groups (id, library_id, root_folder_id, anchor_folder_id, group_key, title)
        VALUES (501, 101, 201, 202, 'group:collection', 'Collection Group');
      INSERT INTO media_work_group_members (id, work_group_id, media_item_id, relation_role)
        VALUES (601, 501, 401, 'main');
      INSERT INTO folder_media_mappings (
        id, folder_id, media_item_id, root_folder_id, series_id, content_role, kind,
        season_number, confidence, detected_by
      ) VALUES (701, 202, 401, 201, 301, 'main', 'season', 1, 1, 'test');
    `)
    const backupDir = path.join(tempDir, 'round-trip')
    const protectionDir = path.join(tempDir, 'protection')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.mkdirSync(protectionDir, { recursive: true })
    settingsDb.set('backup_dir_auto', backupDir)

    const { autoBackup, restoreFromPath } = await import('../backup')
    const snapshotPath = autoBackup()
    expect(snapshotPath).toBeTruthy()
    db.exec('DELETE FROM libraries')
    settingsDb.set('backup_dir_auto', protectionDir)

    // This fixture intentionally has no physical media. Explicitly retain it as
    // missing through the same preflight the UI now requires.
    const { inspectRestore, resolveRestorePreview } = await import('../restore-preview')
    const preview = inspectRestore(db, snapshotPath!)
    resolveRestorePreview(db, preview.previewId, [{ folderId: 201, keepMissing: true }])
    await restoreFromPath(snapshotPath!, preview.previewId)

    expect(db.prepare('SELECT id, parent_id, display_metadata_folder_id FROM folders WHERE id IN (201, 202) ORDER BY id').all()).toEqual([
      { id: 201, parent_id: null, display_metadata_folder_id: 202 },
      { id: 202, parent_id: 201, display_metadata_folder_id: null },
    ])
    expect(db.prepare('SELECT id, folder_id, media_item_id, root_folder_id, series_id FROM folder_media_mappings').all()).toEqual([
      { id: 701, folder_id: 202, media_item_id: 401, root_folder_id: 201, series_id: 301 },
    ])
    expect(db.prepare('SELECT id, library_id, root_folder_id, anchor_folder_id FROM media_work_groups').all()).toEqual([
      { id: 501, library_id: 101, root_folder_id: 201, anchor_folder_id: 202 },
    ])
    expect(db.prepare('SELECT work_group_id, media_item_id FROM media_work_group_members').all()).toEqual([
      { work_group_id: 501, media_item_id: 401 },
    ])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('round-trips typed TMDB posters and presentation without merging a shared numeric id', async () => {
    const { db, settingsDb } = await initializeCurrent()
    db.exec(`
      INSERT INTO libraries (id, name, root_path, type) VALUES (101, 'TMDB library', 'D:/tmdb', 'movie');
      INSERT INTO folders (id, library_id, parent_id, name, path, is_series, anilist_id, has_poster, source, synopsis)
        VALUES (201, 101, NULL, 'TMDB library', 'D:/tmdb', 1, NULL, 0, 'anilist', 'root');
      INSERT INTO folders (id, library_id, parent_id, name, path, is_series, anilist_id, has_poster, source, synopsis, tmdb_media_type)
        VALUES
          (202, 101, 201, 'Movie', 'D:/tmdb/Movie', 1, 8, 1, 'tmdb', 'movie synopsis', 'movie'),
          (203, 101, 201, 'TV', 'D:/tmdb/TV', 1, 8, 1, 'tmdb', 'tv synopsis', 'tv'),
          (204, 101, 201, 'Unknown', 'D:/tmdb/Unknown', 1, 8, 1, 'tmdb', 'manual unknown synopsis', NULL);
      INSERT INTO media_items (id, library_id, root_folder_id, item_key, title, kind, confidence)
        VALUES
          (301, 101, 202, 'tmdb:movie:8', 'Movie', 'movie', 1),
          (302, 101, 203, 'tmdb:tv:8', 'TV', 'season', 1);
      INSERT INTO media_item_sources (id, media_item_id, source, external_id, is_primary)
        VALUES
          (401, 301, 'tmdb:movie', '8', 1),
          (402, 302, 'tmdb:tv', '8', 1);
      INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
        VALUES
          (202, 'item:tmdb:movie:8', 'Movie presentation', 0),
          (203, 'item:tmdb:tv:8', 'TV presentation', 0);
      INSERT INTO folder_media_mappings
        (id, folder_id, media_item_id, root_folder_id, content_role, kind, confidence, detected_by)
        VALUES
          (501, 202, 301, 202, 'movie', 'movie', 1, 'test'),
          (502, 203, 302, 203, 'main', 'season', 1, 'test');
    `)

    const posterDirectory = path.join(tempDir, 'posters')
    fs.mkdirSync(posterDirectory, { recursive: true })
    const moviePoster = path.join(posterDirectory, 'tm_movie_8.jpg')
    const tvPoster = path.join(posterDirectory, 'tm_tv_8.jpg')
    const manualPoster = path.join(posterDirectory, 'tm_8.jpg')
    fs.writeFileSync(moviePoster, Buffer.from('movie-poster-bytes'))
    fs.writeFileSync(tvPoster, Buffer.from('tv-poster-bytes'))
    fs.writeFileSync(manualPoster, Buffer.from('manual-unknown-poster'))

    const backupDir = path.join(tempDir, 'typed-posters')
    const protectionDir = path.join(tempDir, 'typed-posters-protection')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.mkdirSync(protectionDir, { recursive: true })
    settingsDb.set('backup_dir_auto', backupDir)
    settingsDb.set('backup_include_posters', '1')

    const { autoBackup, restoreFromPath } = await import('../backup')
    const snapshotPath = autoBackup()
    expect(snapshotPath).toBeTruthy()
    expect(fs.readFileSync(path.join(tempDir, 'backups', 'posters', 'tm_movie_8.jpg'))).toEqual(Buffer.from('movie-poster-bytes'))
    expect(fs.readFileSync(path.join(tempDir, 'backups', 'posters', 'tm_tv_8.jpg'))).toEqual(Buffer.from('tv-poster-bytes'))

    db.exec('DELETE FROM libraries')
    fs.rmSync(moviePoster, { force: true })
    fs.rmSync(tvPoster, { force: true })
    settingsDb.set('backup_dir_auto', protectionDir)

    const { inspectRestore, resolveRestorePreview } = await import('../restore-preview')
    const preview = inspectRestore(db, snapshotPath!)
    resolveRestorePreview(db, preview.previewId, [{ folderId: 201, keepMissing: true }])
    const result = await restoreFromPath(snapshotPath!, preview.previewId)

    expect(result).toMatchObject({ postersRestored: 2, missingPosters: 0 })
    expect(fs.readFileSync(moviePoster)).toEqual(Buffer.from('movie-poster-bytes'))
    expect(fs.readFileSync(tvPoster)).toEqual(Buffer.from('tv-poster-bytes'))
    expect(fs.readFileSync(manualPoster)).toEqual(Buffer.from('manual-unknown-poster'))
    expect(db.prepare(`
      SELECT id, source, anilist_id, tmdb_media_type, has_poster, synopsis
      FROM folders WHERE id IN (202, 203, 204) ORDER BY id
    `).all()).toEqual([
      { id: 202, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'movie', has_poster: 1, synopsis: 'movie synopsis' },
      { id: 203, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'tv', has_poster: 1, synopsis: 'tv synopsis' },
      { id: 204, source: 'tmdb', anilist_id: 8, tmdb_media_type: null, has_poster: 1, synopsis: 'manual unknown synopsis' },
    ])
    expect(db.prepare('SELECT source, external_id FROM media_item_sources ORDER BY id').all()).toEqual([
      { source: 'tmdb:movie', external_id: '8' },
      { source: 'tmdb:tv', external_id: '8' },
    ])
    expect(db.prepare('SELECT root_folder_id, entry_key, display_title FROM media_collection_presentation ORDER BY root_folder_id').all()).toEqual([
      { root_folder_id: 202, entry_key: 'item:tmdb:movie:8', display_title: 'Movie presentation' },
      { root_folder_id: 203, entry_key: 'item:tmdb:tv:8', display_title: 'TV presentation' },
    ])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('preserves restored child rows when later parent cleanup has cascading actions', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      CREATE TABLE module_cascade_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES module_cascade_parents(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE module_nullable_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES module_nullable_parents(id) ON DELETE SET NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE module_cascade_parents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE module_nullable_parents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO module_cascade_parents VALUES (7, 'current-parent');
      INSERT INTO module_nullable_parents VALUES (7, 'current-parent');
      INSERT INTO module_cascade_children VALUES (8, 7, 'current-child');
      INSERT INTO module_nullable_children VALUES (8, 7, 'current-child');
    `)

    const sourcePath = path.join(tempDir, 'cascading-module.db')
    const source = createDb(sourcePath)
    source.exec(`
      CREATE TABLE module_cascade_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES module_cascade_parents(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE module_nullable_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES module_nullable_parents(id) ON DELETE SET NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE module_cascade_parents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE module_nullable_parents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO module_cascade_parents VALUES (7, 'backup-parent');
      INSERT INTO module_nullable_parents VALUES (7, 'backup-parent');
      INSERT INTO module_cascade_children VALUES (8, 7, 'backup-child');
      INSERT INTO module_nullable_children VALUES (8, 7, 'backup-child');
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await restoreFromPath(sourcePath)

    expect(db.prepare('SELECT * FROM module_cascade_children').all()).toEqual([
      { id: 8, parent_id: 7, payload: 'backup-child' },
    ])
    expect(db.prepare('SELECT * FROM module_nullable_children').all()).toEqual([
      { id: 8, parent_id: 7, payload: 'backup-child' },
    ])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('defers valid module foreign keys when dependency tables were created later', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      CREATE TABLE module_child_records (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES module_parent_records(id),
        payload TEXT NOT NULL
      );
      CREATE TABLE module_parent_records (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO module_parent_records VALUES (1, 'current-parent');
      INSERT INTO module_child_records VALUES (1, 1, 'current-child');
    `)

    const sourcePath = path.join(tempDir, 'out-of-order-module.db')
    const source = createDb(sourcePath)
    source.exec(`
      CREATE TABLE module_child_records (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES module_parent_records(id),
        payload TEXT NOT NULL
      );
      CREATE TABLE module_parent_records (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO module_parent_records VALUES (7, 'backup-parent');
      INSERT INTO module_child_records VALUES (8, 7, 'backup-child');
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await restoreFromPath(sourcePath)

    expect(db.prepare('SELECT * FROM module_parent_records').all()).toEqual([{ id: 7, payload: 'backup-parent' }])
    expect(db.prepare('SELECT * FROM module_child_records').all()).toEqual([{ id: 8, parent_id: 7, payload: 'backup-child' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('checks deferred foreign keys before commit and rolls back invalid backup data', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      CREATE TABLE checked_parents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE checked_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES checked_parents(id) DEFERRABLE INITIALLY DEFERRED,
        payload TEXT NOT NULL
      );
      INSERT INTO checked_parents VALUES (1, 'current-parent');
      INSERT INTO checked_children VALUES (1, 1, 'current-child');
    `)

    const sourcePath = path.join(tempDir, 'invalid-foreign-key.db')
    const source = createDb(sourcePath)
    source.exec('PRAGMA foreign_keys = OFF')
    source.exec(`
      CREATE TABLE checked_parents (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE checked_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES checked_parents(id) DEFERRABLE INITIALLY DEFERRED,
        payload TEXT NOT NULL
      );
      INSERT INTO checked_children VALUES (9, 999, 'orphan');
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await expect(restoreFromPath(sourcePath)).rejects.toThrow('备份数据违反外键约束')

    expect(db.prepare('SELECT * FROM checked_parents').all()).toEqual([{ id: 1, payload: 'current-parent' }])
    expect(db.prepare('SELECT * FROM checked_children').all()).toEqual([{ id: 1, parent_id: 1, payload: 'current-child' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('resets AUTOINCREMENT sequences using a module table actual primary-key column', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      CREATE TABLE module_sequence_records (
        record_key INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL
      );
      INSERT INTO module_sequence_records (record_key, payload) VALUES (900, 'current');
    `)

    const sourcePath = path.join(tempDir, 'module-sequence.db')
    const source = createDb(sourcePath)
    source.exec(`
      CREATE TABLE module_sequence_records (
        record_key INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL
      );
      INSERT INTO module_sequence_records (record_key, payload) VALUES (41, 'backup');
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await restoreFromPath(sourcePath)
    db.prepare("INSERT INTO module_sequence_records (payload) VALUES ('next')").run()

    expect(db.prepare('SELECT record_key, payload FROM module_sequence_records ORDER BY record_key').all()).toEqual([
      { record_key: 41, payload: 'backup' },
      { record_key: 42, payload: 'next' },
    ])
  })

  it('rolls back all table changes when a restored row violates the current schema', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec(`
      CREATE TABLE restore_guard (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO restore_guard VALUES (1, 'current-guard');
      CREATE TABLE restore_constraint (id INTEGER PRIMARY KEY, value TEXT NOT NULL CHECK (value = 'valid'));
      INSERT INTO restore_constraint VALUES (1, 'valid');
    `)

    const sourcePath = path.join(tempDir, 'invalid-backup.db')
    const source = createDb(sourcePath)
    source.exec(`
      CREATE TABLE restore_guard (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO restore_guard VALUES (1, 'backup-guard');
      CREATE TABLE restore_constraint (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO restore_constraint VALUES (1, 'invalid');
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await expect(restoreFromPath(sourcePath)).rejects.toThrow()

    expect(db.prepare('SELECT value FROM restore_guard WHERE id = 1').get()).toEqual({ value: 'current-guard' })
    expect(db.prepare('SELECT value FROM restore_constraint WHERE id = 1').get()).toEqual({ value: 'valid' })
  })

  it('skips favorite poster recovery when the season module table is absent', async () => {
    const { db } = await initializeCurrent()
    db.exec('DROP TABLE season_favorites')

    const { restorePostersFromLibrary } = await import('../backup')

    expect(restorePostersFromLibrary()).toEqual({ restored: 0, missing: 0 })
  })

  it('reports a warning when poster recovery fails after the database has committed', async () => {
    const { createDb, db } = await initializeCurrent()
    db.exec("CREATE TABLE restore_marker (value TEXT); INSERT INTO restore_marker VALUES ('current')")
    const sourcePath = path.join(tempDir, 'poster-warning.db')
    const source = createDb(sourcePath)
    source.exec("CREATE TABLE restore_marker (value TEXT); INSERT INTO restore_marker VALUES ('backup')")
    source.close()
    fs.mkdirSync(path.join(tempDir, 'backups'), { recursive: true })
    // Simulate an inaccessible poster library without affecting the database snapshot.
    fs.writeFileSync(path.join(tempDir, 'backups', 'posters'), 'not a directory')

    const { restoreFromPath } = await import('../backup')
    await expect(restoreFromPath(sourcePath)).resolves.toMatchObject({ warning: expect.stringContaining('数据库已恢复') })
    expect(db.prepare('SELECT value FROM restore_marker').get()).toEqual({ value: 'backup' })
    db.run("INSERT INTO restore_marker VALUES ('subsequent write')")
  })
})

