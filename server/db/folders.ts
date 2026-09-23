import type { Database } from 'node-sqlite3-wasm'
import { win32 as path } from 'path'
import { as } from './schema'
import { sqlAll, sqlGet, sqlRun } from './sql'
import type { Folder } from '../types'
import type { MediaDomainEvidence } from '../../shared/media-domain'

export interface FolderUpsert { path: string; filesystem_identity?: string | null }

export function makeFolderDb(db: Database) {
  return {
    upsertTree(libraryId: number, folderPaths: Array<string | FolderUpsert>): Folder[] {
      const sorted = folderPaths.map(value => typeof value === 'string' ? { path: value, filesystem_identity: null } : value)
        .sort((a, b) => a.path.length - b.path.length)
      const created: Folder[] = []
      const findByPath = db.prepare('SELECT * FROM folders WHERE path = ?')
      let upsert: ReturnType<typeof db.prepare> | undefined
      try {
        upsert = db.prepare(`
          INSERT INTO folders (library_id, parent_id, name, path, filesystem_identity, path_missing, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
          ON CONFLICT(path) DO UPDATE SET
            library_id = excluded.library_id,
            parent_id = excluded.parent_id,
            name = CASE WHEN folders.renamed = 1 THEN folders.name ELSE excluded.name END,
            filesystem_identity = COALESCE(excluded.filesystem_identity, folders.filesystem_identity),
            path_missing = 0,
            missing_source = NULL,
            updated_at = CASE WHEN
              folders.library_id IS NOT excluded.library_id
              OR folders.parent_id IS NOT excluded.parent_id
              OR (folders.renamed = 0 AND folders.name IS NOT excluded.name)
              OR folders.path_missing <> 0
              OR folders.missing_source IS NOT NULL
              OR (folders.filesystem_identity IS NOT NULL AND excluded.filesystem_identity IS NOT NULL
                AND folders.filesystem_identity IS NOT excluded.filesystem_identity)
            THEN datetime('now') ELSE folders.updated_at END
          WHERE folders.library_id IS NOT excluded.library_id
             OR folders.parent_id IS NOT excluded.parent_id
             OR (folders.renamed = 0 AND folders.name IS NOT excluded.name)
             OR (excluded.filesystem_identity IS NOT NULL AND folders.filesystem_identity IS NOT excluded.filesystem_identity)
             OR folders.path_missing <> 0
             OR folders.missing_source IS NOT NULL
        `)
        for (const item of sorted) {
          const p = item.path
          const dir = path.dirname(p)
          const parent = dir === p ? null : as<Folder | undefined>(findByPath.get(dir) ?? undefined)
          const name = path.basename(p)
          upsert.run([libraryId, parent?.id ?? null, name, p, item.filesystem_identity ?? null])
          created.push(as<Folder>(findByPath.get(p)))
        }
      } finally {
        try { upsert?.finalize() } finally { findByPath.finalize() }
      }
      return created
    },

    deleteMissing(libraryId: number, keepPaths: Set<string>): number {
      const rows = as<{ id: number }[]>(sqlAll(db, 'SELECT id FROM folders WHERE library_id = ?', libraryId))
      let n = 0
      for (const r of rows) {
        const f = as<Folder | undefined>(sqlGet<Folder>(db, 'SELECT * FROM folders WHERE id = ?', r.id) ?? undefined)
        // 删除父目录时子目录被 ON DELETE CASCADE 连带删除，后续行 SELECT 可能为空，跳过即可
        if (!f || keepPaths.has(f.path)) continue
        sqlRun(db, 'DELETE FROM folders WHERE id = ?', r.id); n++
      }
      // 清理孤儿 tag_links（tag_links 无 target FK，须手动清理；末尾跑一次即可）
      if (n > 0) sqlRun(db, "DELETE FROM tag_links WHERE target_type = 'folder' AND target_id NOT IN (SELECT id FROM folders)")
      return n
    },

    markSeries(libraryId: number): number {
      // 语义（用户需求）：主文件夹 = 递归含视频 且（库根直接子目录 或 基础文件夹的直接子目录）。
      // 基础文件夹 = 库根直接子目录中名字精确等于 series/movies/tv/drama 等的分类目录
      // （如 01_Anime_Queue\Series、05_Live_Action\Movies）。
      // 「Fate Series」「Monogatari Series」这类名字含 Series 但非精确等于的目录 = 主文件夹（聚合容器），
      // 其下的各季（UBW/Zero 等）不再单独成为系列条目；CDs/Scans 等无视频目录自然排除。
      const candidates = as<{ id: number }[]>(sqlAll(db, `
        WITH RECURSIVE video_dirs(id) AS (
          SELECT folder_id FROM files WHERE library_id = ? AND path_missing = 0
          UNION
          SELECT f.parent_id FROM folders f JOIN video_dirs v ON f.id = v.id
          WHERE f.parent_id IS NOT NULL AND f.path_missing = 0
        ),
        base AS (
          SELECT id FROM folders
          WHERE library_id = ? AND parent_id = (SELECT id FROM folders WHERE library_id = ? AND parent_id IS NULL)
            AND LOWER(TRIM(name)) IN ('series', 'movies', 'movie', 'tv', 'drama', 'shows', 'films', 'anime')
        )
        SELECT id FROM folders
        WHERE library_id = ? AND path_missing = 0 AND id IN (SELECT id FROM video_dirs)
          AND (
            (parent_id = (SELECT id FROM folders WHERE library_id = ? AND parent_id IS NULL) AND id NOT IN (SELECT id FROM base))
            OR parent_id IN (SELECT id FROM base)
          )
      `, [libraryId, libraryId, libraryId, libraryId, libraryId]))
      const target = new Set(candidates.map(row => row.id))
      const rows = as<{ id: number; is_series: number }[]>(sqlAll(db, 'SELECT id, is_series FROM folders WHERE library_id = ? AND path_missing = 0', libraryId))
      let changed = 0
      for (const row of rows) {
        const next = target.has(row.id) ? 1 : 0
        if (row.is_series === next) continue
        sqlRun(db, "UPDATE folders SET is_series = ?, updated_at = datetime('now') WHERE id = ?", [next, row.id])
        changed++
      }
      return changed
    },

    getByLibrary(libraryId: number): Folder[] {
      return as<Folder[]>(sqlAll(db, 'SELECT * FROM folders WHERE library_id = ? ORDER BY path', libraryId))
    },
    getById(id: number): Folder | undefined {
      return as<Folder | undefined>(sqlGet<Folder>(db, 'SELECT * FROM folders WHERE id = ?', id) ?? undefined)
    },
    getChildren(folderId: number): Folder[] {
      return as<Folder[]>(sqlAll(db, 'SELECT * FROM folders WHERE parent_id = ? ORDER BY name', folderId))
    },
    // 写入绑定元数据（外部 id + 数据源 + 海报标记 + 评分/类型/简介/年份/集数，供海报墙与详情页展示）
    updateAnilist(id: number, meta: { source?: string; anilistId: number; hasPoster: boolean; rating?: number | null; genres?: string[] | null; synopsis?: string | null; year?: number | null; episodes?: number | null; tmdbMediaType?: 'movie' | 'tv' | null; domainEvidence?: MediaDomainEvidence[] }): Folder {
      const source = meta.source ?? 'anilist'
      sqlRun(db, `
        UPDATE folders SET
          anilist_id = ?, has_poster = ?, source = ?, tmdb_media_type = ?, rating = ?, genres = ?, synopsis = ?, year = ?, episodes = ?, media_domain_evidence = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [
        meta.anilistId,
        meta.hasPoster ? 1 : 0,
        source,
        source === 'tmdb' ? meta.tmdbMediaType ?? null : null,
        meta.rating ?? null,
        meta.genres && meta.genres.length > 0 ? JSON.stringify(meta.genres) : null,
        meta.synopsis ?? null,
        meta.year ?? null,
        meta.episodes ?? null,
        meta.domainEvidence ? JSON.stringify(meta.domainEvidence) : null,
        id,
      ])
      return as<Folder>(sqlGet<Folder>(db, 'SELECT * FROM folders WHERE id = ?', id))
    },
  }
}
