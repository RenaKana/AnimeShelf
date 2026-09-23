import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Database } from 'node-sqlite3-wasm'
import { createDb, ensureSystemTags } from '../schema'
import { makeSettingsDb } from '../settings'
import { makeLibraryDb } from '../libraries'
import { makeFolderDb } from '../folders'
import { createDatabaseSnapshot, verifyDatabaseFile } from '../maintenance'

// This is the committed pre-tmdb_media_type catalog shape, intentionally
// excluding the current additive columns and collection-organization table.
// It is a real historical schema fixture, not a current-schema copy with a
// column removed after initialization.
const LEGACY_CATALOG_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'anime',
  everything_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  is_series INTEGER NOT NULL DEFAULT 0,
  anilist_id INTEGER,
  has_poster INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'anilist',
  rating REAL,
  genres TEXT,
  synopsis TEXT,
  year INTEGER,
  episodes INTEGER,
  display_metadata_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  size INTEGER,
  date_modified INTEGER,
  ext TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE media_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  series_key TEXT NOT NULL,
  title TEXT NOT NULL,
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (library_id, series_key)
);
CREATE TABLE folder_media_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES media_series(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('season', 'movie', 'ova', 'special', 'extras', 'unknown')),
  season_number INTEGER CHECK (season_number IS NULL OR season_number > 0),
  part_number INTEGER CHECK (part_number IS NULL OR part_number > 0),
  custom_label TEXT,
  source TEXT,
  external_id TEXT,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  detected_by TEXT NOT NULL DEFAULT 'unknown',
  conflict_reason TEXT,
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  title TEXT NOT NULL,
  title_zh TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('season', 'movie', 'ova', 'special', 'extras', 'unknown')),
  season_number INTEGER CHECK (season_number IS NULL OR season_number > 0),
  part_number INTEGER CHECK (part_number IS NULL OR part_number > 0),
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  conflict_reason TEXT,
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (library_id, item_key)
);
CREATE TABLE media_item_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (media_item_id, source, external_id)
);
CREATE TABLE media_work_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  anchor_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  group_key TEXT NOT NULL,
  title TEXT NOT NULL,
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (library_id, root_folder_id, group_key)
);
CREATE TABLE media_work_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_group_id INTEGER NOT NULL REFERENCES media_work_groups(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  relation_role TEXT NOT NULL DEFAULT 'main' CHECK (relation_role IN ('main', 'side_story', 'spin_off', 'unknown')),
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (media_item_id)
);
CREATE TABLE media_collection_presentation (
  root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  display_title TEXT,
  position INTEGER CHECK (position IS NULL OR position >= 0),
  UNIQUE (root_folder_id, entry_key)
);
CREATE TABLE folder_media_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  series_id INTEGER REFERENCES media_series(id) ON DELETE SET NULL,
  content_role TEXT NOT NULL CHECK (content_role IN ('main', 'movie', 'ova', 'special', 'extras', 'unknown')),
  kind TEXT NOT NULL CHECK (kind IN ('season', 'movie', 'ova', 'special', 'extras', 'unknown')),
  season_number INTEGER CHECK (season_number IS NULL OR season_number > 0),
  part_number INTEGER CHECK (part_number IS NULL OR part_number > 0),
  custom_label TEXT,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  conflict_reason TEXT,
  detected_by TEXT NOT NULL DEFAULT 'unknown',
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (folder_id, media_item_id, content_role, season_number, part_number)
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#8b5cf6',
  kind TEXT NOT NULL DEFAULT 'custom'
);
CREATE TABLE tag_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'file')),
  target_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (tag_id, target_type, target_id)
);
CREATE TABLE season_favorites (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_zh TEXT,
  air_day TEXT,
  air_time TEXT,
  begin TEXT,
  bangumi_id TEXT,
  links TEXT,
  image TEXT,
  synopsis TEXT,
  synopsis_original TEXT,
  aired_episodes INTEGER,
  total_episodes INTEGER,
  air_status TEXT CHECK (air_status IN ('airing', 'finished', 'upcoming')),
  media_type TEXT NOT NULL DEFAULT 'anime',
  lib_match_override TEXT CHECK (lib_match_override IN ('present', 'absent')),
  added_at TEXT DEFAULT (datetime('now'))
);
`

describe('schema', () => {
  let db: any
  let settingsDb: ReturnType<typeof makeSettingsDb>
  let libraryDb: ReturnType<typeof makeLibraryDb>
  beforeEach(() => {
    db = createDb(':memory:')
    ensureSystemTags(db)
    settingsDb = makeSettingsDb(db)
    libraryDb = makeLibraryDb(db)
  })

  it('creates all tables and system tags', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    expect(tables).toEqual(expect.arrayContaining([
      'libraries', 'folders', 'files', 'tags', 'tag_links', 'settings',
      'media_series', 'folder_media_entries', 'media_items', 'media_item_sources', 'folder_media_mappings',
      'media_work_groups', 'media_work_group_members',
      'media_work_group_exclusions',
      'folder_media_catalog_exclusions',
    ]))
    const tags = db.prepare('SELECT * FROM tags WHERE kind = ?').all('system')
    expect(tags.map((t: any) => t.name)).toEqual(['状态:未看', '状态:在看', '状态:看完', '追番中'])
  })

  it('stores an optional display metadata folder reference', () => {
    const columns = db.prepare('PRAGMA table_info(folders)').all().map((r: any) => r.name)
    expect(columns).toContain('display_metadata_folder_id')
  })

  it('indexes display metadata folder references', () => {
    const indexes = db.prepare('PRAGMA index_list(folders)').all().map((r: any) => r.name)
    expect(indexes).toContain('idx_folders_display_metadata')
  })

  it('creates season catalog indexes and permits multiple logical series on one root', () => {
    const seriesIndexes = db.prepare('PRAGMA index_list(media_series)').all().map((r: any) => r.name)
    const entryIndexes = db.prepare('PRAGMA index_list(folder_media_entries)').all().map((r: any) => r.name)
    expect(seriesIndexes).toEqual(expect.arrayContaining([
      'idx_media_series_library',
      'idx_media_series_root_folder',
      'idx_media_series_library_key',
    ]))
    expect(entryIndexes).toEqual(expect.arrayContaining([
      'idx_folder_media_entries_folder',
      'idx_folder_media_entries_series',
      'idx_folder_media_entries_kind_season',
    ]))

    const lib = libraryDb.create('Catalog', 'D:\\Catalog', 'anime')
    makeFolderDb(db).upsertTree(lib.id, ['D:\\Catalog', 'D:\\Catalog\\Show'])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Catalog\\Show') as any
    db.prepare(`
      INSERT INTO media_series (library_id, root_folder_id, series_key, title)
      VALUES (?, ?, ?, ?)
    `).run([lib.id, root.id, 'folder:' + root.id, 'Show'])
    db.prepare(`
      INSERT INTO media_series (library_id, root_folder_id, series_key, title)
      VALUES (?, ?, ?, ?)
    `).run([lib.id, root.id, 'logical:show-a', 'Show A'])
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_series WHERE root_folder_id = ?').get(root.id)).toEqual({ count: 2 })
  })

  it('creates canonical media item indexes and cascades source/mapping records', () => {
    const itemIndexes = db.prepare('PRAGMA index_list(media_items)').all().map((r: any) => r.name)
    const sourceIndexes = db.prepare('PRAGMA index_list(media_item_sources)').all().map((r: any) => r.name)
    const mappingIndexes = db.prepare('PRAGMA index_list(folder_media_mappings)').all().map((r: any) => r.name)
    expect(itemIndexes).toEqual(expect.arrayContaining([
      'idx_media_items_library',
      'idx_media_items_root_folder',
      'idx_media_items_key',
    ]))
    expect(sourceIndexes).toEqual(expect.arrayContaining([
      'idx_media_item_sources_item',
      'idx_media_item_sources_identity',
    ]))
    expect(mappingIndexes).toEqual(expect.arrayContaining([
      'idx_folder_media_mappings_folder',
      'idx_folder_media_mappings_item',
      'idx_folder_media_mappings_root',
    ]))

    const lib = libraryDb.create('Canonical', 'D:\\Canonical', 'anime')
    makeFolderDb(db).upsertTree(lib.id, [
      'D:\\Canonical', 'D:\\Canonical\\Show', 'D:\\Canonical\\Show\\Season 1',
    ])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Canonical\\Show') as any
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Canonical\\Show\\Season 1') as any
    const item = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, ?, ?, 'season', 1)
    `).run([lib.id, root.id, 'bangumi:100', 'Show'])
    db.prepare(`
      INSERT INTO media_item_sources (media_item_id, source, external_id, is_primary)
      VALUES (?, 'bangumi', '100', 1)
    `).run([item.lastInsertRowid])
    db.prepare(`
      INSERT INTO folder_media_mappings
        (folder_id, media_item_id, root_folder_id, content_role, kind, season_number, confidence, detected_by)
      VALUES (?, ?, ?, 'main', 'season', 1, 1, 'test')
    `).run([folder.id, item.lastInsertRowid, root.id])

    db.prepare('DELETE FROM folders WHERE id = ?').run(root.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_items').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_item_sources').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings').get()).toEqual({ count: 0 })
  })

  it('creates durable ungrouped-item exclusions and cascades them with their scope', () => {
    const columns = db.prepare('PRAGMA table_info(media_work_group_exclusions)').all().map((row: any) => row.name)
    expect(columns).toEqual(expect.arrayContaining([
      'root_folder_id', 'media_item_id', 'created_at', 'updated_at',
    ]))
    const indexes = db.prepare('PRAGMA index_list(media_work_group_exclusions)').all().map((row: any) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_media_work_group_exclusions_root',
      'idx_media_work_group_exclusions_item',
    ]))

    const lib = libraryDb.create('Ungrouped items', 'D:\\Ungrouped items', 'anime')
    makeFolderDb(db).upsertTree(lib.id, ['D:\\Ungrouped items', 'D:\\Ungrouped items\\Show'])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Ungrouped items\\Show') as any
    const item = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'folder:ungrouped', 'Ungrouped', 'season', 1)
    `).run([lib.id, root.id])
    db.prepare(`
      INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id)
      VALUES (?, ?)
    `).run([root.id, item.lastInsertRowid])
    db.prepare('DELETE FROM media_items WHERE id = ?').run(item.lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_exclusions').get()).toEqual({ count: 0 })
  })

  it('stores durable work groups with one group membership per media item', () => {
    const groupColumns = db.prepare('PRAGMA table_info(media_work_groups)').all().map((row: any) => row.name)
    const memberColumns = db.prepare('PRAGMA table_info(media_work_group_members)').all().map((row: any) => row.name)
    expect(groupColumns).toEqual(expect.arrayContaining([
      'id', 'library_id', 'root_folder_id', 'anchor_folder_id', 'group_key',
      'title', 'manual_locked', 'created_at', 'updated_at',
    ]))
    expect(memberColumns).toEqual(expect.arrayContaining([
      'id', 'work_group_id', 'media_item_id', 'relation_role',
      'manual_locked', 'created_at', 'updated_at',
    ]))

    const groupIndexes = db.prepare('PRAGMA index_list(media_work_groups)').all().map((row: any) => row.name)
    const memberIndexes = db.prepare('PRAGMA index_list(media_work_group_members)').all().map((row: any) => row.name)
    expect(groupIndexes).toEqual(expect.arrayContaining([
      'idx_media_work_groups_library_root',
      'idx_media_work_groups_anchor',
      'idx_media_work_groups_key',
    ]))
    expect(memberIndexes).toEqual(expect.arrayContaining([
      'idx_media_work_group_members_group',
      'idx_media_work_group_members_item',
    ]))

    const lib = libraryDb.create('Work groups', 'D:\\Work groups', 'anime')
    makeFolderDb(db).upsertTree(lib.id, [
      'D:\\Work groups',
      'D:\\Work groups\\Fate Series',
      'D:\\Work groups\\Fate Series\\Prisma Illya',
      'D:\\Work groups\\Fate Series\\Prisma Illya\\Season 1',
      'D:\\Work groups\\Fate Series\\Prisma Illya\\Movie',
    ])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Work groups\\Fate Series') as any
    const anchor = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Work groups\\Fate Series\\Prisma Illya') as any
    const seasonItem = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'anilist:14829', 'Prisma Illya', 'season', 1)
    `).run([lib.id, root.id])
    const movieItem = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'anilist:97757', 'Prisma Illya Movie', 'movie', 1)
    `).run([lib.id, root.id])
    const group = db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked)
      VALUES (?, ?, ?, 'folder:prisma', 'Prisma Illya', 1)
    `).run([lib.id, root.id, anchor.id])
    db.prepare(`
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role, manual_locked)
      VALUES (?, ?, 'main', 1)
    `).run([group.lastInsertRowid, seasonItem.lastInsertRowid])
    db.prepare(`
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role, manual_locked)
      VALUES (?, ?, 'side_story', 1)
    `).run([group.lastInsertRowid, movieItem.lastInsertRowid])

    expect(() => db.prepare(`
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role)
      VALUES (?, ?, 'main')
    `).run([group.lastInsertRowid, seasonItem.lastInsertRowid])).toThrow()

    db.prepare('DELETE FROM folders WHERE id = ?').run(anchor.id)
    expect(db.prepare('SELECT anchor_folder_id FROM media_work_groups WHERE id = ?').get(group.lastInsertRowid)).toEqual({ anchor_folder_id: null })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members').get()).toEqual({ count: 2 })

    db.prepare('DELETE FROM media_items WHERE id = ?').run(movieItem.lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members').get()).toEqual({ count: 1 })
  })

  it('persists work groups and manual member relationships across database reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-work-groups-'))
    const file = path.join(dir, 'work-groups.db')
    let persisted: any
    try {
      persisted = createDb(file)
      persisted.exec(`
        INSERT INTO libraries (name, root_path, type) VALUES ('Anime', 'D:\\Anime', 'anime');
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, NULL, 'Anime', 'D:\\Anime', 0);
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, 1, 'Fate Series', 'D:\\Anime\\Fate Series', 1);
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, 2, 'Prisma Illya', 'D:\\Anime\\Fate Series\\Prisma Illya', 0);
        INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
          VALUES (1, 2, 'anilist:14829', 'Prisma Illya', 'season', 1);
        INSERT INTO media_work_groups
          (library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked)
          VALUES (1, 2, 3, 'anchor:3', '魔法少女伊莉雅', 1);
        INSERT INTO media_work_group_members
          (work_group_id, media_item_id, relation_role, manual_locked)
          VALUES (1, 1, 'main', 1);
      `)
      persisted.close()
      persisted = createDb(file)

      expect(persisted.prepare(`
        SELECT group_key, title, manual_locked FROM media_work_groups
      `).all()).toEqual([
        { group_key: 'anchor:3', title: '魔法少女伊莉雅', manual_locked: 1 },
      ])
      expect(persisted.prepare(`
        SELECT relation_role, manual_locked FROM media_work_group_members
      `).all()).toEqual([
        { relation_role: 'main', manual_locked: 1 },
      ])
    } finally {
      try { persisted?.close() } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects work groups and members that cross library or canonical-root boundaries', () => {
    const libraryA = libraryDb.create('Library A', 'D:\\Library A', 'anime')
    const libraryB = libraryDb.create('Library B', 'D:\\Library B', 'anime')
    makeFolderDb(db).upsertTree(libraryA.id, [
      'D:\\Library A', 'D:\\Library A\\Root A', 'D:\\Library A\\Root A 2',
    ])
    makeFolderDb(db).upsertTree(libraryB.id, [
      'D:\\Library B', 'D:\\Library B\\Root B',
    ])
    const rootA = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Library A\\Root A') as any
    const rootA2 = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Library A\\Root A 2') as any
    const rootB = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Library B\\Root B') as any

    expect(() => db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, group_key, title)
      VALUES (?, ?, 'cross-library-root', 'Invalid')
    `).run([libraryA.id, rootB.id])).toThrow()
    expect(() => db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title)
      VALUES (?, ?, ?, 'cross-library-anchor', 'Invalid')
    `).run([libraryA.id, rootA.id, rootB.id])).toThrow()
    expect(() => db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title)
      VALUES (?, ?, ?, 'cross-root-anchor', 'Invalid')
    `).run([libraryA.id, rootA.id, rootA2.id])).toThrow()

    const group = db.prepare(`
      INSERT INTO media_work_groups
        (library_id, root_folder_id, anchor_folder_id, group_key, title)
      VALUES (?, ?, ?, 'valid', 'Valid')
    `).run([libraryA.id, rootA.id, rootA.id])
    const itemOtherLibrary = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'folder:other-library', 'Other library', 'season', 1)
    `).run([libraryB.id, rootB.id])
    const itemOtherRoot = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'folder:other-root', 'Other root', 'season', 1)
    `).run([libraryA.id, rootA2.id])

    for (const mediaItemId of [itemOtherLibrary.lastInsertRowid, itemOtherRoot.lastInsertRowid]) {
      expect(() => db.prepare(`
        INSERT INTO media_work_group_members
          (work_group_id, media_item_id, relation_role)
        VALUES (?, ?, 'main')
      `).run([group.lastInsertRowid, mediaItemId])).toThrow()
    }

    const validItem = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'folder:valid', 'Valid', 'season', 1)
    `).run([libraryA.id, rootA.id])
    const member = db.prepare(`
      INSERT INTO media_work_group_members
        (work_group_id, media_item_id, relation_role)
      VALUES (?, ?, 'main')
    `).run([group.lastInsertRowid, validItem.lastInsertRowid])

    expect(() => db.prepare('UPDATE media_work_groups SET anchor_folder_id = ? WHERE id = ?')
      .run([rootA2.id, group.lastInsertRowid])).toThrow()
    expect(() => db.prepare('UPDATE media_work_groups SET root_folder_id = ? WHERE id = ?')
      .run([rootA2.id, group.lastInsertRowid])).toThrow()
    expect(() => db.prepare('UPDATE media_items SET root_folder_id = ? WHERE id = ?')
      .run([rootA2.id, validItem.lastInsertRowid])).toThrow()
    expect(() => db.prepare('UPDATE media_work_group_members SET media_item_id = ? WHERE id = ?')
      .run([itemOtherRoot.lastInsertRowid, member.lastInsertRowid])).toThrow()
  })

  it('enforces work-group keys and cascades members with their group, root, or library', () => {
    const library = libraryDb.create('Cascade work groups', 'D:\\Cascade work groups', 'anime')
    makeFolderDb(db).upsertTree(library.id, [
      'D:\\Cascade work groups', 'D:\\Cascade work groups\\Root',
    ])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Cascade work groups\\Root') as any
    const insertItem = (key: string) => db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, ?, ?, 'season', 1)
    `).run([library.id, root.id, key, key])
    const insertGroup = (key: string) => db.prepare(`
      INSERT INTO media_work_groups (library_id, root_folder_id, group_key, title)
      VALUES (?, ?, ?, ?)
    `).run([library.id, root.id, key, key])
    const insertMember = (groupId: unknown, itemId: unknown) => db.prepare(`
      INSERT INTO media_work_group_members (work_group_id, media_item_id, relation_role)
      VALUES (?, ?, 'main')
    `).run([groupId, itemId])

    const firstGroup = insertGroup('stable-key')
    const firstItem = insertItem('folder:first')
    insertMember(firstGroup.lastInsertRowid, firstItem.lastInsertRowid)
    expect(() => insertGroup('stable-key')).toThrow()
    db.prepare('DELETE FROM media_work_groups WHERE id = ?').run(firstGroup.lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members').get()).toEqual({ count: 0 })

    const secondGroup = insertGroup('root-cascade')
    const secondItem = insertItem('folder:second')
    insertMember(secondGroup.lastInsertRowid, secondItem.lastInsertRowid)
    db.prepare('DELETE FROM folders WHERE id = ?').run(root.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members').get()).toEqual({ count: 0 })

    makeFolderDb(db).upsertTree(library.id, [
      'D:\\Cascade work groups', 'D:\\Cascade work groups\\Root again',
    ])
    const rootAgain = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Cascade work groups\\Root again') as any
    const thirdGroup = db.prepare(`
      INSERT INTO media_work_groups (library_id, root_folder_id, group_key, title)
      VALUES (?, ?, 'library-cascade', 'Library cascade')
    `).run([library.id, rootAgain.id])
    const thirdItem = db.prepare(`
      INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
      VALUES (?, ?, 'folder:third', 'Third', 'season', 1)
    `).run([library.id, rootAgain.id])
    insertMember(thirdGroup.lastInsertRowid, thirdItem.lastInsertRowid)
    db.prepare('DELETE FROM libraries WHERE id = ?').run(library.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_groups').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_members').get()).toEqual({ count: 0 })
  })

  it('persists folder-level catalog exclusions and cascades them with the folder', () => {
    const lib = libraryDb.create('Catalog exclusions', 'D:\\Catalog exclusions', 'anime')
    makeFolderDb(db).upsertTree(lib.id, ['D:\\Catalog exclusions', 'D:\\Catalog exclusions\\Show'])
    const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Catalog exclusions\\Show') as any

    const columns = db.prepare('PRAGMA table_info(folder_media_catalog_exclusions)').all().map((row: any) => row.name)
    expect(columns).toEqual(expect.arrayContaining([
      'folder_id', 'created_at', 'updated_at',
      'manual_kind', 'manual_season_numbers', 'manual_part_number',
    ]))
    db.prepare('INSERT INTO folder_media_catalog_exclusions (folder_id) VALUES (?)').run(folder.id)
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id)

    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_catalog_exclusions').get()).toEqual({ count: 0 })
  })

  it('adds custom catalog labels to physical rows and exclusion metadata', () => {
    expect(db.prepare('PRAGMA table_info(folder_media_entries)').all().map((row: any) => row.name)).toContain('custom_label')
    expect(db.prepare('PRAGMA table_info(folder_media_mappings)').all().map((row: any) => row.name)).toContain('custom_label')
    expect(db.prepare('PRAGMA table_info(folder_media_catalog_exclusions)').all().map((row: any) => row.name)).toContain('manual_custom_label')
  })

  it('adds manual exclusion metadata columns when opening an older catalog database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-catalog-exclusion-migration-'))
    const file = path.join(dir, 'legacy.db')
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE folder_media_catalog_exclusions (
        folder_id INTEGER PRIMARY KEY,
        created_at TEXT,
        updated_at TEXT
      )
    `)
    legacy.close()

    const migrated = createDb(file)
    try {
      const columns = migrated.prepare('PRAGMA table_info(folder_media_catalog_exclusions)').all().map((row: any) => row.name)
      expect(columns).toEqual(expect.arrayContaining(['manual_kind', 'manual_season_numbers', 'manual_part_number', 'manual_custom_label']))
    } finally {
      migrated.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds custom label columns when opening an older catalog database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-custom-label-migration-'))
    const file = path.join(dir, 'legacy.db')
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE folder_media_entries (
        id INTEGER PRIMARY KEY,
        folder_id INTEGER NOT NULL,
        series_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        season_number INTEGER,
        part_number INTEGER,
        source TEXT,
        external_id TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        detected_by TEXT NOT NULL DEFAULT 'unknown',
        conflict_reason TEXT,
        manual_locked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE folder_media_mappings (
        id INTEGER PRIMARY KEY,
        folder_id INTEGER NOT NULL,
        media_item_id INTEGER NOT NULL,
        root_folder_id INTEGER NOT NULL,
        series_id INTEGER,
        content_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        season_number INTEGER,
        part_number INTEGER,
        confidence REAL NOT NULL DEFAULT 0,
        conflict_reason TEXT,
        detected_by TEXT NOT NULL DEFAULT 'unknown',
        manual_locked INTEGER NOT NULL DEFAULT 0
      );
    `)
    legacy.close()

    let migrated: any
    try {
      migrated = createDb(file)
      expect(migrated.prepare('PRAGMA table_info(folder_media_entries)').all().map((row: any) => row.name)).toContain('custom_label')
      expect(migrated.prepare('PRAGMA table_info(folder_media_mappings)').all().map((row: any) => row.name)).toContain('custom_label')
    } finally {
      migrated?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists canonical item sources and mappings across database reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-canonical-schema-'))
    const file = path.join(dir, 'canonical.db')
    let persisted: any
    try {
      persisted = createDb(file)
      persisted.exec(`
        INSERT INTO libraries (name, root_path, type) VALUES ('Anime', 'D:\\Anime', 'anime');
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, NULL, 'Anime', 'D:\\Anime', 0);
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, 1, 'Show', 'D:\\Anime\\Show', 1);
        INSERT INTO folders (library_id, parent_id, name, path, is_series) VALUES (1, 2, 'S01', 'D:\\Anime\\Show\\S01', 0);
        INSERT INTO media_items (library_id, root_folder_id, item_key, title, kind, confidence)
          VALUES (1, 2, 'anilist:200', 'Show', 'season', 0.9);
        INSERT INTO media_item_sources (media_item_id, source, external_id, is_primary)
          VALUES (1, 'anilist', '200', 1);
        INSERT INTO media_item_sources (media_item_id, source, external_id, is_primary)
          VALUES (1, 'bangumi', '300', 0);
        INSERT INTO folder_media_mappings
          (folder_id, media_item_id, root_folder_id, content_role, kind, season_number, confidence, detected_by)
          VALUES (3, 1, 2, 'main', 'season', 1, 0.9, 'test');
      `)
      persisted.close()
      persisted = createDb(file)
      expect(persisted.prepare('SELECT item_key, title FROM media_items').all()).toEqual([
        { item_key: 'anilist:200', title: 'Show' },
      ])
      expect(persisted.prepare('SELECT source, external_id FROM media_item_sources ORDER BY source').all()).toEqual([
        { source: 'anilist', external_id: '200' },
        { source: 'bangumi', external_id: '300' },
      ])
      expect(persisted.prepare('SELECT content_role, season_number FROM folder_media_mappings').all()).toEqual([
        { content_role: 'main', season_number: 1 },
      ])
    } finally {
      try { persisted?.close() } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves a historical catalog graph while adding tmdb media type', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-tmdb-media-type-migration-'))
    const file = path.join(dir, 'legacy-catalog.db')
    const snapshot = path.join(dir, 'legacy-catalog.snapshot.db')
    let legacy: any
    let migrated: any
    let restored: any
    let reopened: any
    try {
      const queryAll = (database: any, sql: string, params: unknown[] = []) => {
        const statement = database.prepare(sql)
        try { return statement.all(params) as any[] } finally { statement.finalize() }
      }
      const queryGet = (database: any, sql: string, params: unknown[] = []) => {
        const statement = database.prepare(sql)
        try { return statement.get(params) as any } finally { statement.finalize() }
      }
      const run = (database: any, sql: string, params: unknown[] = []) => {
        const statement = database.prepare(sql)
        try { return statement.run(params) } finally { statement.finalize() }
      }
      legacy = new Database(file)
      legacy.exec(LEGACY_CATALOG_SCHEMA)
      legacy.exec(`
        INSERT INTO libraries (id, name, root_path, type, everything_url, created_at) VALUES
          (1, 'Legacy Anime', 'D:\\Legacy', 'anime', 'http://everything', '2026-01-01'),
          (2, 'Legacy Live', 'D:\\Live', 'movie', NULL, '2026-01-01');
        INSERT INTO folders
          (id, library_id, parent_id, name, path, is_series, anilist_id, has_poster, source, rating, genres, synopsis, year, episodes, created_at, updated_at)
        VALUES
          (1, 1, NULL, 'Legacy', 'D:\\Legacy', 1, 42, 1, 'anilist', 8.5, '["Action"]', 'Legacy root', 2020, 12, '2026-01-01', '2026-01-01'),
          (2, 1, 1, 'Show', 'D:\\Legacy\\Show', 1, 42, 1, 'anilist', 8.5, '["Drama"]', 'Legacy show', 2020, 12, '2026-01-01', '2026-01-01'),
          (3, 1, 2, 'Season 1', 'D:\\Legacy\\Show\\Season 1', 0, NULL, 1, 'anilist', NULL, NULL, NULL, 2020, 12, '2026-01-01', '2026-01-01'),
          (4, 2, NULL, 'Live', 'D:\\Live', 1, NULL, 0, 'tmdb', 7.1, '["Drama"]', 'Legacy live root', 2021, 8, '2026-01-01', '2026-01-01'),
          (5, 2, 4, 'Movie', 'D:\\Live\\Movie', 1, 8, 1, 'tmdb', 7.2, '["Drama"]', 'Legacy TMDB movie', 2021, 1, '2026-01-01', '2026-01-01'),
          (6, 2, 4, 'TV', 'D:\\Live\\TV', 1, 8, 1, 'tmdb', 7.3, '["Drama"]', 'Legacy TMDB TV', 2021, 8, '2026-01-01', '2026-01-01');
        INSERT INTO files (id, folder_id, library_id, name, path, size, date_modified, ext, created_at, updated_at)
          VALUES (1, 3, 1, 'episode-01.mkv', 'D:\\Legacy\\Show\\Season 1\\episode-01.mkv', 1234, 1700000000000, '.mkv', '2026-01-01', '2026-01-01');
        INSERT INTO media_series (id, library_id, root_folder_id, series_key, title, manual_locked, created_at, updated_at)
          VALUES (1, 1, 2, 'folder:2', 'Legacy Show', 1, '2026-01-01', '2026-01-01');
        INSERT INTO folder_media_entries
          (id, folder_id, series_id, kind, season_number, custom_label, source, external_id, confidence, detected_by, manual_locked, created_at, updated_at)
          VALUES (1, 3, 1, 'season', 1, '手工第一季', 'anilist', '42', 0.9, 'legacy', 1, '2026-01-01', '2026-01-01');
        INSERT INTO media_items
          (id, library_id, root_folder_id, item_key, title, title_zh, kind, season_number, confidence, manual_locked, created_at, updated_at)
          VALUES
            (1, 1, 2, 'anilist:42', 'Legacy Show', '旧作品', 'season', 1, 0.9, 1, '2026-01-01', '2026-01-01'),
            (2, 2, 5, 'tmdb:movie:8', 'Legacy Movie', '旧电影', 'movie', NULL, 0.8, 1, '2026-01-01', '2026-01-01'),
            (3, 2, 6, 'tmdb:tv:8', 'Legacy TV', '旧剧集', 'season', NULL, 0.8, 1, '2026-01-01', '2026-01-01');
        INSERT INTO media_item_sources (id, media_item_id, source, external_id, is_primary, created_at, updated_at) VALUES
          (1, 1, 'anilist', '42', 1, '2026-01-01', '2026-01-01'),
          (2, 1, 'bangumi', '84', 0, '2026-01-01', '2026-01-01'),
          (3, 2, 'tmdb:movie', '8', 1, '2026-01-01', '2026-01-01'),
          (4, 3, 'tmdb:tv', '8', 1, '2026-01-01', '2026-01-01');
        INSERT INTO media_work_groups
          (id, library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked, created_at, updated_at)
          VALUES (1, 1, 2, 2, 'folder:2', '手工合集', 1, '2026-01-01', '2026-01-01');
        INSERT INTO media_work_group_members
          (id, work_group_id, media_item_id, relation_role, manual_locked, created_at, updated_at)
          VALUES (1, 1, 1, 'main', 1, '2026-01-01', '2026-01-01');
        INSERT INTO folder_media_mappings
          (id, folder_id, media_item_id, root_folder_id, series_id, content_role, kind, season_number, custom_label, confidence, detected_by, manual_locked, created_at, updated_at)
          VALUES
            (1, 3, 1, 2, 1, 'main', 'season', 1, '手工第一季', 0.9, 'legacy', 1, '2026-01-01', '2026-01-01'),
            (2, 5, 2, 5, NULL, 'movie', 'movie', NULL, NULL, 0.8, 'legacy', 1, '2026-01-01', '2026-01-01'),
            (3, 6, 3, 6, NULL, 'main', 'season', NULL, NULL, 0.8, 'legacy', 1, '2026-01-01', '2026-01-01');
        INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
          VALUES
            (2, 'item:anilist:42', '手工展示名', 0),
            (5, 'item:tmdb:movie:8', '旧电影展示名', 0),
            (6, 'item:tmdb:tv:8', '旧剧集展示名', 0);
        INSERT INTO tags (id, name, color, kind) VALUES (1, '收藏', '#f59e0b', 'custom');
        INSERT INTO tag_links (id, tag_id, target_type, target_id, created_at)
          VALUES (1, 1, 'folder', 2, '2026-01-01');
        INSERT INTO season_favorites
          (item_id, title, title_zh, bangumi_id, links, synopsis, aired_episodes, total_episodes, air_status, media_type, added_at)
          VALUES ('manual-bangumi-42', 'Legacy Show', '旧作品', '42', '[{"name":"番组计划","url":"https://bgm.tv/subject/42"}]', '旧收藏简介', 3, 12, 'airing', 'anime', '2026-01-01');
      `)

      const preserved = {
        libraries: legacy.prepare('SELECT id, name, root_path, type, everything_url FROM libraries ORDER BY id').all(),
        folders: legacy.prepare('SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, rating, genres, synopsis, year, episodes FROM folders ORDER BY id').all(),
        files: legacy.prepare('SELECT id, folder_id, library_id, name, path, size, date_modified, ext FROM files ORDER BY id').all(),
        series: legacy.prepare('SELECT id, library_id, root_folder_id, series_key, title, manual_locked FROM media_series ORDER BY id').all(),
        entries: legacy.prepare('SELECT id, folder_id, series_id, kind, season_number, custom_label, source, external_id, manual_locked FROM folder_media_entries ORDER BY id').all(),
        items: legacy.prepare('SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind, season_number, confidence, manual_locked FROM media_items ORDER BY id').all(),
        sources: legacy.prepare('SELECT id, media_item_id, source, external_id, is_primary FROM media_item_sources ORDER BY id').all(),
        groups: legacy.prepare('SELECT id, library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked FROM media_work_groups ORDER BY id').all(),
        members: legacy.prepare('SELECT id, work_group_id, media_item_id, relation_role, manual_locked FROM media_work_group_members ORDER BY id').all(),
        mappings: legacy.prepare('SELECT id, folder_id, media_item_id, root_folder_id, series_id, content_role, kind, season_number, custom_label, confidence, manual_locked FROM folder_media_mappings ORDER BY id').all(),
        presentation: legacy.prepare('SELECT root_folder_id, entry_key, display_title, position FROM media_collection_presentation ORDER BY root_folder_id, position').all(),
        tags: legacy.prepare('SELECT id, name, color, kind FROM tags ORDER BY id').all(),
        tagLinks: legacy.prepare('SELECT id, tag_id, target_type, target_id FROM tag_links ORDER BY id').all(),
        favorites: legacy.prepare('SELECT item_id, title, title_zh, bangumi_id, links, synopsis, aired_episodes, total_episodes, air_status, media_type FROM season_favorites ORDER BY item_id').all(),
      }
      legacy.close()
      legacy = undefined

      migrated = createDb(file)
      expect(migrated.prepare('PRAGMA table_info(folders)').all().map((row: any) => row.name)).toContain('tmdb_media_type')
      expect(migrated.prepare('PRAGMA table_info(folders)').all().find((row: any) => row.name === 'tmdb_media_type')).toMatchObject({ notnull: 0, dflt_value: null })
      expect(migrated.prepare('SELECT id, tmdb_media_type FROM folders ORDER BY id').all()).toEqual([
        { id: 1, tmdb_media_type: null },
        { id: 2, tmdb_media_type: null },
        { id: 3, tmdb_media_type: null },
        { id: 4, tmdb_media_type: null },
        { id: 5, tmdb_media_type: null },
        { id: 6, tmdb_media_type: null },
      ])
      expect(queryAll(migrated, `
        SELECT id, source, anilist_id, tmdb_media_type
        FROM folders
        WHERE source = 'tmdb' AND anilist_id IS NOT NULL
        ORDER BY id
      `)).toEqual([
        { id: 5, source: 'tmdb', anilist_id: 8, tmdb_media_type: null },
        { id: 6, source: 'tmdb', anilist_id: 8, tmdb_media_type: null },
      ])
      expect(queryAll(migrated, `
        SELECT m.item_key, s.source, s.external_id
        FROM media_items m
        JOIN media_item_sources s ON s.media_item_id = m.id
        WHERE m.item_key LIKE 'tmdb:%'
        ORDER BY m.id
      `)).toEqual([
        { item_key: 'tmdb:movie:8', source: 'tmdb:movie', external_id: '8' },
        { item_key: 'tmdb:tv:8', source: 'tmdb:tv', external_id: '8' },
      ])
      expect({
        libraries: migrated.prepare('SELECT id, name, root_path, type, everything_url FROM libraries ORDER BY id').all(),
        folders: migrated.prepare('SELECT id, library_id, parent_id, name, path, is_series, anilist_id, source, rating, genres, synopsis, year, episodes FROM folders ORDER BY id').all(),
        files: migrated.prepare('SELECT id, folder_id, library_id, name, path, size, date_modified, ext FROM files ORDER BY id').all(),
        series: migrated.prepare('SELECT id, library_id, root_folder_id, series_key, title, manual_locked FROM media_series ORDER BY id').all(),
        entries: migrated.prepare('SELECT id, folder_id, series_id, kind, season_number, custom_label, source, external_id, manual_locked FROM folder_media_entries ORDER BY id').all(),
        items: migrated.prepare('SELECT id, library_id, root_folder_id, item_key, title, title_zh, kind, season_number, confidence, manual_locked FROM media_items ORDER BY id').all(),
        sources: migrated.prepare('SELECT id, media_item_id, source, external_id, is_primary FROM media_item_sources ORDER BY id').all(),
        groups: migrated.prepare('SELECT id, library_id, root_folder_id, anchor_folder_id, group_key, title, manual_locked FROM media_work_groups ORDER BY id').all(),
        members: migrated.prepare('SELECT id, work_group_id, media_item_id, relation_role, manual_locked FROM media_work_group_members ORDER BY id').all(),
        mappings: migrated.prepare('SELECT id, folder_id, media_item_id, root_folder_id, series_id, content_role, kind, season_number, custom_label, confidence, manual_locked FROM folder_media_mappings ORDER BY id').all(),
        presentation: migrated.prepare('SELECT root_folder_id, entry_key, display_title, position FROM media_collection_presentation ORDER BY root_folder_id, position').all(),
        tags: migrated.prepare('SELECT id, name, color, kind FROM tags ORDER BY id').all(),
        tagLinks: migrated.prepare('SELECT id, tag_id, target_type, target_id FROM tag_links ORDER BY id').all(),
        favorites: migrated.prepare('SELECT item_id, title, title_zh, bangumi_id, links, synopsis, aired_episodes, total_episodes, air_status, media_type FROM season_favorites ORDER BY item_id').all(),
      }).toEqual(preserved)

      run(migrated, 'UPDATE folders SET tmdb_media_type = ? WHERE id = ?', ['movie', 5])
      run(migrated, 'UPDATE folders SET tmdb_media_type = ? WHERE id = ?', ['tv', 6])
      expect(queryAll(migrated, `
        SELECT id, source, anilist_id, tmdb_media_type
        FROM folders
        WHERE tmdb_media_type IS NOT NULL
        ORDER BY id
      `)).toEqual([
        { id: 5, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'movie' },
        { id: 6, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'tv' },
      ])
      expect(queryGet(migrated, 'SELECT COUNT(*) AS count FROM folders WHERE source = ? AND anilist_id = ?', ['tmdb', 8])).toEqual({ count: 2 })
      expect(() => run(migrated, 'UPDATE folders SET tmdb_media_type = ? WHERE id = ?', ['episode', 1])).toThrow()

      const assertHealthy = (database: any) => {
        expect(database.prepare('PRAGMA integrity_check').all().map((row: any) => Object.values(row)[0])).toEqual(['ok'])
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      }
      assertHealthy(migrated)
      createDatabaseSnapshot(migrated, file, snapshot)
      verifyDatabaseFile(snapshot)
      restored = createDb(snapshot)
      expect(queryAll(restored, 'SELECT id, source, anilist_id, tmdb_media_type FROM folders WHERE tmdb_media_type IS NOT NULL ORDER BY id')).toEqual([
        { id: 5, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'movie' },
        { id: 6, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'tv' },
      ])
      expect(queryAll(restored, 'SELECT source, external_id FROM media_item_sources WHERE source LIKE \'tmdb:%\' ORDER BY source')).toEqual([
        { source: 'tmdb:movie', external_id: '8' },
        { source: 'tmdb:tv', external_id: '8' },
      ])
      assertHealthy(restored)
      restored.close()
      restored = undefined
      migrated.close()
      migrated = undefined

      reopened = createDb(file)
      expect(queryAll(reopened, 'SELECT id, source, anilist_id, tmdb_media_type FROM folders WHERE tmdb_media_type IS NOT NULL ORDER BY id')).toEqual([
        { id: 5, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'movie' },
        { id: 6, source: 'tmdb', anilist_id: 8, tmdb_media_type: 'tv' },
      ])
      expect(queryGet(reopened, 'SELECT COUNT(*) AS count FROM media_items')).toEqual({ count: 3 })
      expect(queryGet(reopened, 'SELECT COUNT(*) AS count FROM media_item_sources')).toEqual({ count: 4 })
      expect(queryGet(reopened, 'SELECT COUNT(*) AS count FROM media_collection_presentation')).toEqual({ count: 3 })
      expect(queryGet(reopened, 'SELECT COUNT(*) AS count FROM season_favorites')).toEqual({ count: 1 })
      assertHealthy(reopened)
    } finally {
      try { legacy?.close() } catch { /* already closed */ }
      try { migrated?.close() } catch { /* already closed */ }
      try { restored?.close() } catch { /* already closed */ }
      try { reopened?.close() } catch { /* already closed */ }
      if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup')
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cascades catalog records when their library or folder is deleted', () => {
    const lib = libraryDb.create('Catalog', 'D:\\Catalog', 'anime')
    makeFolderDb(db).upsertTree(lib.id, ['D:\\Catalog', 'D:\\Catalog\\Show', 'D:\\Catalog\\Show\\S01'])
    const root = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Catalog\\Show') as any
    const season = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Catalog\\Show\\S01') as any
    const series = db.prepare(`
      INSERT INTO media_series (library_id, root_folder_id, series_key, title)
      VALUES (?, ?, ?, ?)
    `).run([lib.id, root.id, 'folder:' + root.id, 'Show'])
    db.prepare(`
      INSERT INTO folder_media_entries
        (folder_id, series_id, kind, season_number, source, external_id, confidence, detected_by, manual_locked)
      VALUES (?, ?, 'season', 1, 'anilist', '123', 0.9, 'test', 0)
    `).run([season.id, series.lastInsertRowid])

    db.prepare('DELETE FROM folders WHERE id = ?').run(root.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_series').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries').get()).toEqual({ count: 0 })

    // Recreate the rows and verify library deletion also cascades through both FKs.
    makeFolderDb(db).upsertTree(lib.id, ['D:\\Catalog', 'D:\\Catalog\\Show'])
    const recreatedRoot = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Catalog\\Show') as any
    db.prepare(`
      INSERT INTO media_series (library_id, root_folder_id, series_key, title)
      VALUES (?, ?, ?, ?)
    `).run([lib.id, recreatedRoot.id, 'folder:' + recreatedRoot.id, 'Show'])
    db.prepare('DELETE FROM libraries WHERE id = ?').run(lib.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_series').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries').get()).toEqual({ count: 0 })
  })

  it('rebuilds legacy anilist_id favorites without duplicate-column migrations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-schema-'))
    const file = path.join(dir, 'legacy.db')
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE season_favorites (
        anilist_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        title_zh TEXT,
        air_day TEXT,
        air_time TEXT,
        added_at TEXT
      )
    `)
    legacy.close()

    let migrated: any
    try {
      expect(() => { migrated = createDb(file) }).not.toThrow()
      const columns = migrated.prepare('PRAGMA table_info(season_favorites)').all().map((r: any) => r.name)
      expect(columns).toEqual(expect.arrayContaining([
        'item_id', 'bangumi_id', 'links', 'image', 'synopsis',
        'synopsis_original', 'aired_episodes', 'total_episodes', 'air_status', 'media_type', 'lib_match_override',
      ]))
      expect(columns).not.toContain('anilist_id')
    } finally {
      migrated?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('repairs a known Bangumi manga favorite to its anime subject', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-bangumi-repair-'))
    const file = path.join(dir, 'favorites.db')
    const seeded = createDb(file)
    seeded.prepare(`
      INSERT INTO season_favorites
        (item_id, title, title_zh, links, aired_episodes, total_episodes, air_status, media_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run([
      'manual-bangumi-110884',
      '徒然チルドレン',
      '徒然喜欢你',
      JSON.stringify([{ name: '番组计划', url: 'https://bgm.tv/subject/110884' }]),
      212,
      212,
      'finished',
      'anime',
    ])
    seeded.close()

    let migrated: any
    try {
      migrated = createDb(file)
      expect(migrated.prepare('SELECT 1 FROM season_favorites WHERE item_id = ?').get('manual-bangumi-110884')).toBeNull()
      expect(migrated.prepare(`
        SELECT item_id, bangumi_id, links, aired_episodes, total_episodes, air_status
        FROM season_favorites WHERE item_id = ?
      `).get('manual-bangumi-208754')).toMatchObject({
        item_id: 'manual-bangumi-208754',
        bangumi_id: '208754',
        links: JSON.stringify([{ name: '番组计划', url: 'https://bgm.tv/subject/208754' }]),
        aired_episodes: 12,
        total_episodes: 12,
        air_status: 'finished',
      })
    } finally {
      migrated?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('settings round-trips', () => {
    settingsDb.set('everything_url', 'http://localhost:1223')
    expect(settingsDb.get('everything_url')).toBe('http://localhost:1223')
    expect(settingsDb.getAll()).toEqual({ everything_url: 'http://localhost:1223' })
  })

  it('libraries CRUD + unique root_path', () => {
    const lib = libraryDb.create('我的动漫', 'D:\\Anime', 'anime')
    expect(lib.id).toBeGreaterThan(0)
    expect(libraryDb.getById(lib.id)?.name).toBe('我的动漫')
    expect(() => libraryDb.create('重复', 'D:\\Anime', 'anime')).toThrow()
    libraryDb.delete(lib.id)
    expect(libraryDb.getById(lib.id)).toBeUndefined()
  })

  it('upsertTree preserves the collection marker across rescans', () => {
    const folderDb = makeFolderDb(db)
    const lib = libraryDb.create('TestLib', 'D:\\Media', 'anime')
    const paths = ['D:\\Media\\Fate Series', 'D:\\Media\\Fate Series\\Fate stay night']
    folderDb.upsertTree(lib.id, paths)
    const fate = db.prepare('SELECT id, pinned FROM folders WHERE path = ?').get('D:\\Media\\Fate Series') as any
    expect(fate).toBeTruthy()
    db.prepare('UPDATE folders SET pinned = 1 WHERE id = ?').run(fate.id)
    // 模拟再次扫描（相同路径 upsert）：合集标记必须保留
    folderDb.upsertTree(lib.id, paths)
    const after = db.prepare('SELECT pinned FROM folders WHERE id = ?').get(fate.id) as any
    expect(after.pinned).toBe(1)
    // renamed 标记同样不受影响
    db.prepare("UPDATE folders SET name = '自定义名', renamed = 1 WHERE id = ?").run(fate.id)
    folderDb.upsertTree(lib.id, paths)
    const renamed = db.prepare('SELECT name, renamed FROM folders WHERE id = ?').get(fate.id) as any
    expect(renamed.renamed).toBe(1)
    expect(renamed.name).toBe('自定义名')
  })
})
