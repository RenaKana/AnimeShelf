import { Database } from 'node-sqlite3-wasm'
import path from 'path'
import fs from 'fs'
import { installFilesystemHistorySchema } from './filesystem-history-schema'
import { acquireDatabaseLease, type DatabaseLease } from '../../scripts/database-lease.cjs'
import { assertDatabaseIntegrity } from './maintenance'
import { assertDesktopEdition } from './desktop-edition'

export const DATA_DIR = process.env.ANIMESHELF_DATA_DIR
  ? path.resolve(process.env.ANIMESHELF_DATA_DIR)
  : path.join(process.cwd(), 'data')
export const POSTER_DIR = path.join(DATA_DIR, 'posters')
export const SYSTEM_TAGS = [
  { name: '状态:未看', color: '#64748b' },
  { name: '状态:在看', color: '#22c55e' },
  { name: '状态:看完', color: '#3b82f6' },
  { name: '追番中', color: '#f59e0b' },
]

// 旧版 Bangumi 搜索未限制条目类型，少数同名漫画曾被作为动画加入心愿单。
// 这些映射只修复已知的历史误绑定；标题也必须匹配，避免改动用户自行录入的条目。
const LEGACY_BANGUMI_FAVORITE_REPAIRS = [
  { oldId: '218102', newId: '378862', title: 'お兄ちゃんはおしまい！', titleZh: '别当欧尼酱了！', episodes: 12 },
  { oldId: '4526', newId: '2464', title: '荒川アンダー ザ ブリッジ', titleZh: '荒川爆笑团', episodes: 13 },
  { oldId: '110884', newId: '208754', title: '徒然チルドレン', titleZh: '徒然喜欢你', episodes: 12 },
  { oldId: '16880', newId: '10742', title: 'よんでますよ、アザゼルさん。', titleZh: '恶魔阿萨谢尔在召唤你', episodes: 13 },
  { oldId: '361988', newId: '527620', title: 'タコピーの原罪', titleZh: '章鱼哔的原罪', episodes: 6 },
] as const

function repairLegacyBangumiFavoriteBindings(db: Database): void {
  const targetExists = db.prepare('SELECT 1 FROM season_favorites WHERE item_id = ?')
  const normalizeTitleZh = db.prepare(`
    UPDATE season_favorites SET title_zh = ?
    WHERE item_id = ? AND title = ? AND (title_zh IS NULL OR title_zh = title)
  `)
  const update = db.prepare(`
    UPDATE season_favorites
    SET item_id = ?,
        bangumi_id = ?,
        links = ?,
        title_zh = COALESCE(title_zh, ?),
        aired_episodes = ?,
        total_episodes = ?,
        air_status = 'finished'
    WHERE item_id = ? AND title = ? AND media_type = 'anime'
  `)
  try {
    for (const repair of LEGACY_BANGUMI_FAVORITE_REPAIRS) {
      const oldItemId = `manual-bangumi-${repair.oldId}`
      const newItemId = `manual-bangumi-${repair.newId}`
      if (!targetExists.get(newItemId)) {
        update.run([
          newItemId,
          repair.newId,
          JSON.stringify([{ name: '番组计划', url: `https://bgm.tv/subject/${repair.newId}` }]),
          repair.titleZh,
          repair.episodes,
          repair.episodes,
          oldItemId,
          repair.title,
        ])
      }
      normalizeTitleZh.run([repair.titleZh, newItemId, repair.title])
    }
  } finally {
    targetExists.finalize()
    normalizeTitleZh.finalize()
    update.finalize()
  }
}

export function createDb(dbPath: string): Database {
  const db = new Database(dbPath)
  try { return initializeSchema(db) }
  catch (error) { try { db.close() } catch { /* Retain initialization failure. */ } throw error }
}

function initializeSchema(db: Database): Database {
  assertDesktopEdition(db)
  // Snapshots require DELETE journaling; exclusive locking can otherwise make
  // SQLite accept WAL even though this VFS has no shared-memory implementation.
  db.exec(`PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'anime',
      everything_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      is_series INTEGER NOT NULL DEFAULT 0,
      anilist_id INTEGER,
      has_poster INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'anilist',
      tmdb_media_type TEXT CHECK (tmdb_media_type IN ('movie', 'tv')),
      rating REAL,
      genres TEXT,
      synopsis TEXT,
      year INTEGER,
      episodes INTEGER,
      filesystem_identity TEXT,
      path_missing INTEGER NOT NULL DEFAULT 0,
      missing_source TEXT,
      display_metadata_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      size INTEGER,
      date_modified INTEGER,
      ext TEXT NOT NULL,
      filesystem_identity TEXT,
      path_missing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS media_series (
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
    CREATE TABLE IF NOT EXISTS folder_media_entries (
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
    -- Canonical media inventory. The legacy media_series/folder_media_entries
    -- tables remain authoritative for the compatibility response, while these
    -- tables retain stable logical item identities and physical mappings.
    CREATE TABLE IF NOT EXISTS media_items (
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
    CREATE TABLE IF NOT EXISTS media_item_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (media_item_id, source, external_id)
    );
    CREATE TABLE IF NOT EXISTS media_work_groups (
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
    CREATE TABLE IF NOT EXISTS media_work_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_group_id INTEGER NOT NULL REFERENCES media_work_groups(id) ON DELETE CASCADE,
      media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      relation_role TEXT NOT NULL DEFAULT 'main'
        CHECK (relation_role IN ('main', 'side_story', 'spin_off', 'unknown')),
      manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (media_item_id)
    );
    -- Durable per-root opt-out for automatic work-group membership. Unlike a
    -- synthetic one-item group, this records that the item should remain
    -- visible but intentionally ungrouped after future rebuilds.
    CREATE TABLE IF NOT EXISTS media_work_group_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (root_folder_id, media_item_id)
    );
    -- User-owned collection layout. Keys deliberately are not foreign keys to
    -- semantic catalog rows so preferences survive undo/rebuild replacement.
    CREATE TABLE IF NOT EXISTS media_collection_presentation (
      root_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      entry_key TEXT NOT NULL,
      display_title TEXT,
      position INTEGER CHECK (position IS NULL OR position >= 0),
      UNIQUE (root_folder_id, entry_key)
    );
    -- User-owned organization has no foreign keys to replaceable catalog rows.
    CREATE TABLE IF NOT EXISTS media_collection_organization (
      root_folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
      organization_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
    );
    CREATE TRIGGER IF NOT EXISTS trg_media_work_groups_scope_insert
    BEFORE INSERT ON media_work_groups
    WHEN (SELECT library_id FROM folders WHERE id = NEW.root_folder_id) IS NOT NEW.library_id
      OR (NEW.anchor_folder_id IS NOT NULL
        AND (SELECT library_id FROM folders WHERE id = NEW.anchor_folder_id) IS NOT NEW.library_id)
      OR (NEW.anchor_folder_id IS NOT NULL AND NOT EXISTS (
        WITH RECURSIVE anchor_lineage(id, parent_id) AS (
          SELECT id, parent_id FROM folders WHERE id = NEW.anchor_folder_id
          UNION ALL
          SELECT f.id, f.parent_id
          FROM folders f JOIN anchor_lineage a ON f.id = a.parent_id
        )
        SELECT 1 FROM anchor_lineage WHERE id = NEW.root_folder_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'media work group folder scope mismatch');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_media_work_groups_scope_update
    BEFORE UPDATE OF library_id, root_folder_id, anchor_folder_id ON media_work_groups
    WHEN (SELECT library_id FROM folders WHERE id = NEW.root_folder_id) IS NOT NEW.library_id
      OR (NEW.anchor_folder_id IS NOT NULL
        AND (SELECT library_id FROM folders WHERE id = NEW.anchor_folder_id) IS NOT NEW.library_id)
      OR (NEW.anchor_folder_id IS NOT NULL AND NOT EXISTS (
        WITH RECURSIVE anchor_lineage(id, parent_id) AS (
          SELECT id, parent_id FROM folders WHERE id = NEW.anchor_folder_id
          UNION ALL
          SELECT f.id, f.parent_id
          FROM folders f JOIN anchor_lineage a ON f.id = a.parent_id
        )
        SELECT 1 FROM anchor_lineage WHERE id = NEW.root_folder_id
      ))
      OR EXISTS (
        SELECT 1
        FROM media_work_group_members m
        JOIN media_items i ON i.id = m.media_item_id
        WHERE m.work_group_id = OLD.id
          AND (i.library_id IS NOT NEW.library_id OR i.root_folder_id IS NOT NEW.root_folder_id)
      )
    BEGIN
      SELECT RAISE(ABORT, 'media work group folder scope mismatch');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_media_work_group_members_scope_insert
    BEFORE INSERT ON media_work_group_members
    WHEN NOT EXISTS (
      SELECT 1
      FROM media_work_groups g
      JOIN media_items i
        ON i.library_id = g.library_id AND i.root_folder_id = g.root_folder_id
      WHERE g.id = NEW.work_group_id AND i.id = NEW.media_item_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'media work group member scope mismatch');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_media_work_group_members_scope_update
    BEFORE UPDATE OF work_group_id, media_item_id ON media_work_group_members
    WHEN NOT EXISTS (
      SELECT 1
      FROM media_work_groups g
      JOIN media_items i
        ON i.library_id = g.library_id AND i.root_folder_id = g.root_folder_id
      WHERE g.id = NEW.work_group_id AND i.id = NEW.media_item_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'media work group member scope mismatch');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_media_items_work_group_scope_update
    BEFORE UPDATE OF library_id, root_folder_id ON media_items
    WHEN EXISTS (
      SELECT 1
      FROM media_work_group_members m
      JOIN media_work_groups g ON g.id = m.work_group_id
      WHERE m.media_item_id = OLD.id
        AND (g.library_id IS NOT NEW.library_id OR g.root_folder_id IS NOT NEW.root_folder_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'media item work group scope mismatch');
    END;
    CREATE TABLE IF NOT EXISTS folder_media_mappings (
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
    CREATE TABLE IF NOT EXISTS folder_media_catalog_exclusions (
      folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
      manual_kind TEXT,
      manual_season_numbers TEXT,
      manual_part_number INTEGER,
      manual_custom_label TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS media_catalog_ai_undo_journal (
      root_folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      undo_id TEXT NOT NULL UNIQUE,
      state_format_version INTEGER NOT NULL,
      changes_json TEXT NOT NULL,
      before_snapshot_version TEXT NOT NULL,
      after_snapshot_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#8b5cf6',
      kind TEXT NOT NULL DEFAULT 'custom'
    );
    CREATE TABLE IF NOT EXISTS tag_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('folder','file')),
      target_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (tag_id, target_type, target_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_api_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      port INTEGER NOT NULL DEFAULT 3003 CHECK (port BETWEEN 1024 AND 65535)
    );
    INSERT OR IGNORE INTO external_api_config(id, enabled, port) VALUES (1, 0, 3003);
    CREATE TABLE IF NOT EXISTS external_api_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('files', 'edit', 'read', 'disabled')),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS external_api_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      method TEXT NOT NULL,
      route TEXT NOT NULL,
      status INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS season_favorites (
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
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_media_series_library ON media_series(library_id);
    CREATE INDEX IF NOT EXISTS idx_media_series_root_folder ON media_series(root_folder_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_series_library_key ON media_series(library_id, series_key);
    CREATE INDEX IF NOT EXISTS idx_folder_media_entries_folder ON folder_media_entries(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folder_media_entries_series ON folder_media_entries(series_id);
    CREATE INDEX IF NOT EXISTS idx_folder_media_entries_kind_season ON folder_media_entries(kind, season_number);
    CREATE INDEX IF NOT EXISTS idx_media_items_library ON media_items(library_id);
    CREATE INDEX IF NOT EXISTS idx_media_items_root_folder ON media_items(root_folder_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_key ON media_items(library_id, item_key);
    CREATE INDEX IF NOT EXISTS idx_media_item_sources_item ON media_item_sources(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_media_item_sources_identity ON media_item_sources(source, external_id);
    CREATE INDEX IF NOT EXISTS idx_media_work_groups_library_root ON media_work_groups(library_id, root_folder_id);
    CREATE INDEX IF NOT EXISTS idx_media_work_groups_anchor ON media_work_groups(anchor_folder_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_work_groups_key ON media_work_groups(library_id, root_folder_id, group_key);
    CREATE INDEX IF NOT EXISTS idx_media_work_group_members_group ON media_work_group_members(work_group_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_work_group_members_item ON media_work_group_members(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_media_work_group_exclusions_root ON media_work_group_exclusions(root_folder_id);
    CREATE INDEX IF NOT EXISTS idx_media_work_group_exclusions_item ON media_work_group_exclusions(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_folder_media_mappings_folder ON folder_media_mappings(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folder_media_mappings_item ON folder_media_mappings(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_folder_media_mappings_root ON folder_media_mappings(root_folder_id);
    CREATE INDEX IF NOT EXISTS idx_folder_media_catalog_exclusions_updated ON folder_media_catalog_exclusions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_type, target_id);
  `)
  // 兼容迁移：旧版季度清单排除记录没有保存手动识别值，逐列补充。
  const catalogExclusionCols = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(folder_media_catalog_exclusions)`).all())
  const catalogExclusionColNames = new Set(catalogExclusionCols.map(c => c.name))
  for (const [col, ddl] of [
    ['manual_kind', 'TEXT'],
    ['manual_season_numbers', 'TEXT'],
    ['manual_part_number', 'INTEGER'],
    ['manual_custom_label', 'TEXT'],
  ] as const) {
    if (!catalogExclusionColNames.has(col)) db.exec(`ALTER TABLE folder_media_catalog_exclusions ADD COLUMN ${col} ${ddl}`)
  }
  // 兼容迁移：旧版季度清单物理记录没有保存自定义类型标签。
  for (const table of ['folder_media_entries', 'folder_media_mappings'] as const) {
    const columns = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(${table})`).all())
    if (!columns.some(column => column.name === 'custom_label')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN custom_label TEXT`)
    }
  }
  // 兼容迁移：旧版 season_favorites 以 anilist_id 为主键（收藏数据为空，直接重建为新结构）
  let favCols = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(season_favorites)`).all())
  if (favCols.some(c => c.name === 'anilist_id')) {
    db.exec('DROP TABLE season_favorites')
    db.exec(`
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
      )
    `)
    // 后续逐列迁移必须基于重建后的真实结构，不能继续使用旧表的列快照。
    favCols = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(season_favorites)`).all())
  } else if (!favCols.some(c => c.name === 'bangumi_id')) {
    // 兼容迁移：旧 item_id 结构缺 bangumi_id 列
    db.exec('ALTER TABLE season_favorites ADD COLUMN bangumi_id TEXT')
  }
  if (!favCols.some(c => c.name === 'links')) {
    // 兼容迁移：收藏快照缺 links（多平台链接）列
    db.exec('ALTER TABLE season_favorites ADD COLUMN links TEXT')
  }
  if (!favCols.some(c => c.name === 'image')) {
    // 兼容迁移：收藏快照缺 image（海报路径）列
    db.exec('ALTER TABLE season_favorites ADD COLUMN image TEXT')
  }
  if (!favCols.some(c => c.name === 'synopsis')) {
    // 兼容迁移：收藏快照缺 synopsis（简介）列
    db.exec('ALTER TABLE season_favorites ADD COLUMN synopsis TEXT')
  }
  if (!favCols.some(c => c.name === 'synopsis_original')) {
    // 兼容迁移：收藏快照缺 synopsis_original（原文简介）列
    db.exec('ALTER TABLE season_favorites ADD COLUMN synopsis_original TEXT')
  }
  if (!favCols.some(c => c.name === 'aired_episodes')) {
    // 兼容迁移：已播出集数（NULL=未知；>0 在播，0 未开播）
    db.exec('ALTER TABLE season_favorites ADD COLUMN aired_episodes INTEGER')
  }
  if (!favCols.some(c => c.name === 'total_episodes')) {
    // 兼容迁移：总集数（AniList episodes）
    db.exec('ALTER TABLE season_favorites ADD COLUMN total_episodes INTEGER')
  }
  if (!favCols.some(c => c.name === 'air_status')) {
    // 兼容迁移：放送状态；NULL 仅表示尚未完成首次元数据回填
    db.exec("ALTER TABLE season_favorites ADD COLUMN air_status TEXT CHECK (air_status IN ('airing', 'finished', 'upcoming'))")
  }
  if (!favCols.some(c => c.name === 'media_type')) {
    // 兼容迁移：媒体类型（anime 动漫 / live 真人影视）；旧 tmdb 前缀收藏默认真人
    db.exec("ALTER TABLE season_favorites ADD COLUMN media_type TEXT NOT NULL DEFAULT 'anime'")
    db.exec("UPDATE season_favorites SET media_type = 'live' WHERE item_id LIKE 'manual-tmdb-%'")
  }
  if (!favCols.some(c => c.name === 'lib_match_override')) {
    // 用户可覆盖“媒体库已有”的自动判断；NULL 表示继续自动检测。
    db.exec("ALTER TABLE season_favorites ADD COLUMN lib_match_override TEXT CHECK (lib_match_override IN ('present', 'absent'))")
  }
  repairLegacyBangumiFavoriteBindings(db)
  // Additive classification storage. Legacy enum defaults are not evidence.
  for (const table of ['folders', 'season_favorites']) {
    const columns = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(${table})`).all())
    if (!columns.some(column => column.name === 'media_domain_override')) db.exec(`ALTER TABLE ${table} ADD COLUMN media_domain_override TEXT CHECK (media_domain_override IN ('anime', 'live_action', 'unknown'))`)
    if (!columns.some(column => column.name === 'media_domain_evidence')) db.exec(`ALTER TABLE ${table} ADD COLUMN media_domain_evidence TEXT`)
  }
  // 兼容迁移：folders 缺元数据列（海报墙用）时逐列补充
  const folderCols = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(folders)`).all())
  if (!folderCols.some(c => c.name === 'path_missing')) db.exec('ALTER TABLE folders ADD COLUMN path_missing INTEGER NOT NULL DEFAULT 0')
  if (!folderCols.some(c => c.name === 'filesystem_identity')) db.exec('ALTER TABLE folders ADD COLUMN filesystem_identity TEXT')
  if (!folderCols.some(c => c.name === 'missing_source')) db.exec('ALTER TABLE folders ADD COLUMN missing_source TEXT')
  const fileCols = as<{ name: string }[]>(db.prepare(`PRAGMA table_info(files)`).all())
  if (!fileCols.some(c => c.name === 'path_missing')) db.exec('ALTER TABLE files ADD COLUMN path_missing INTEGER NOT NULL DEFAULT 0')
  if (!fileCols.some(c => c.name === 'filesystem_identity')) db.exec('ALTER TABLE files ADD COLUMN filesystem_identity TEXT')
  installFilesystemHistorySchema(db)
  if (!folderCols.some(c => c.name === 'renamed')) {
    // 兼容迁移：用户重命名标记（扫描 upsert 不覆盖已重命名的 name）
    db.exec('ALTER TABLE folders ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0')
  }
  if (!folderCols.some(c => c.name === 'pinned')) {
    // 兼容迁移：合集标记（虚拟拎出——磁盘目录不动，仅界面层作为合集显示）
    db.exec('ALTER TABLE folders ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
  }
  if (!folderCols.some(c => c.name === 'display_metadata_folder_id')) {
    // 主目录可显式选择自身或后代目录作为海报墙/详情页的展示元数据来源。
    db.exec('ALTER TABLE folders ADD COLUMN display_metadata_folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_folders_display_metadata ON folders(display_metadata_folder_id)')
  const folderColNames = new Set(folderCols.map(c => c.name))
  for (const [col, ddl] of [
    ['rating', 'REAL'],
    ['genres', 'TEXT'],
    ['synopsis', 'TEXT'],
    ['year', 'INTEGER'],
    ['episodes', 'INTEGER'],
    ['source', "TEXT NOT NULL DEFAULT 'anilist'"],
    ['tmdb_media_type', "TEXT CHECK (tmdb_media_type IN ('movie', 'tv'))"],
  ] as const) {
    if (!folderColNames.has(col)) db.exec(`ALTER TABLE folders ADD COLUMN ${col} ${ddl}`)
  }
  return db
}

export function ensureSystemTags(db: Database): void {
  for (const t of SYSTEM_TAGS) {
    db.prepare(`INSERT OR IGNORE INTO tags (name, color, kind) VALUES (?, ?, 'system')`).run([t.name, t.color])
  }
}

const as = <T>(v: unknown): T => v as T

// 惰性单例（生产用文件库）：整个进程共享同一连接，避免 node-sqlite3-wasm 的锁冲突
let appDb: Database | null = null
let appLease: DatabaseLease | null = null
let initializationFailure: unknown = null
let opening: Promise<Database> | null = null
let closing: Promise<void> | null = null
export function openAppDb(): Promise<Database> {
  if (closing) return closing.then(() => openAppDb())
  if (initializationFailure) return Promise.reject(initializationFailure)
  if (appDb) return appDb.isOpen ? Promise.resolve(appDb) : Promise.reject(new Error('数据库仍在等待释放，请完成关闭后再启动。'))
  if (opening) return opening
  opening = (async () => {
    const dbPath = path.join(DATA_DIR, 'animeshelf.db')
    const lease = await acquireDatabaseLease(dbPath)
    let database: Database | undefined
    try {
      const existing = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0
      database = new Database(dbPath)
      lease.recordLock(database)
      if (existing) assertDatabaseIntegrity(database)
      initializeSchema(database)
      ensureSystemTags(database)
      appLease = lease
      return appDb = database
    } catch (error) {
      // A connection that failed to close must retain its ownership endpoint.
      if (database?.isOpen) {
        try { database.close() }
        catch (closeError) { appDb = database; appLease = lease; initializationFailure = error; console.error('数据库初始化失败且关闭未完成', closeError); throw error }
      }
      await lease.release()
      throw error
    }
  })().finally(() => { opening = null })
  return opening
}

export function closeAppDb(database: Database | null = appDb): Promise<void> {
  if (!database) return Promise.resolve()
  if (appDb !== database) return Promise.resolve()
  if (closing) return closing
  closing = (async () => {
    if (database.isOpen) database.close()
    await appLease?.release()
    appDb = null
    appLease = null
    initializationFailure = null
  })().finally(() => { closing = null })
  return closing
}
export { as }
