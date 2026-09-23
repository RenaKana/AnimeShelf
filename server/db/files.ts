import type { Database } from 'node-sqlite3-wasm'
import { as } from './schema'
import { sqlAll, sqlGet, sqlRun } from './sql'
import type { FileItem } from '../types'

export interface FileUpsert {
  path: string; folder_id: number; name: string; size: number | null; date_modified: number | null; ext: string
  filesystem_identity?: string | null
}

export function makeFileDb(db: Database) {
  return {
    upsertMany(libraryId: number, items: FileUpsert[]): { added: number; updated: number } {
      let added = 0, updated = 0
      const findByPath = db.prepare('SELECT * FROM files WHERE path = ?')
      let upsert: ReturnType<typeof db.prepare> | undefined
      try {
        upsert = db.prepare(`
          INSERT INTO files (folder_id, library_id, name, path, size, date_modified, ext, filesystem_identity, path_missing, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
          ON CONFLICT(path) DO UPDATE SET
            folder_id = excluded.folder_id, library_id = excluded.library_id, name = excluded.name,
            size = excluded.size, date_modified = excluded.date_modified, ext = excluded.ext,
            filesystem_identity = COALESCE(excluded.filesystem_identity, files.filesystem_identity),
            path_missing = 0,
            updated_at = CASE WHEN
              files.folder_id IS NOT excluded.folder_id OR files.library_id IS NOT excluded.library_id
              OR files.name IS NOT excluded.name OR files.size IS NOT excluded.size
              OR files.date_modified IS NOT excluded.date_modified OR files.ext IS NOT excluded.ext
              OR files.path_missing <> 0
              OR (files.filesystem_identity IS NOT NULL AND excluded.filesystem_identity IS NOT NULL
                AND files.filesystem_identity IS NOT excluded.filesystem_identity)
            THEN datetime('now') ELSE files.updated_at END
          WHERE files.folder_id IS NOT excluded.folder_id OR files.library_id IS NOT excluded.library_id
             OR files.name IS NOT excluded.name OR files.size IS NOT excluded.size
             OR files.date_modified IS NOT excluded.date_modified OR files.ext IS NOT excluded.ext
             OR (excluded.filesystem_identity IS NOT NULL AND files.filesystem_identity IS NOT excluded.filesystem_identity)
             OR files.path_missing <> 0
        `)
        for (const it of items) {
          // 可靠计数：node-sqlite3-wasm 在 ON CONFLICT 命中时 changes=1 且 lastInsertRowid 保持旧值，
          // 无法用 run() 返回值区分新增/更新，故先按 path 判存在性
          const exists = as<FileItem | undefined>(findByPath.get(it.path) ?? undefined)
          const identity = it.filesystem_identity ?? null
          const changed = !!exists && (exists.folder_id !== it.folder_id || exists.library_id !== libraryId || exists.name !== it.name
            || exists.size !== it.size || exists.date_modified !== it.date_modified || exists.ext !== it.ext
            || (identity !== null && exists.filesystem_identity != null && exists.filesystem_identity !== identity) || exists.path_missing !== 0)
          upsert.run([it.folder_id, libraryId, it.name, it.path, it.size, it.date_modified, it.ext, identity])
          if (!exists) added++; else if (changed) updated++
        }
      } finally {
        try { upsert?.finalize() } finally { findByPath.finalize() }
      }
      return { added, updated }
    },
    deleteMissing(libraryId: number, keepPaths: Set<string>): number {
      const rows = as<{ id: number; path: string }[]>(sqlAll(db, 'SELECT id, path FROM files WHERE library_id = ?', libraryId))
      let n = 0
      for (const r of rows) {
        if (!keepPaths.has(r.path)) { sqlRun(db, 'DELETE FROM files WHERE id = ?', r.id); n++ }
      }
      // 清理孤儿 tag_links（tag_links 无 target FK，须手动清理；末尾跑一次即可）
      if (n > 0) sqlRun(db, "DELETE FROM tag_links WHERE target_type = 'file' AND target_id NOT IN (SELECT id FROM files)")
      return n
    },
    getByFolder(folderId: number): FileItem[] {
      return as<FileItem[]>(sqlAll(db, 'SELECT * FROM files WHERE folder_id = ? ORDER BY name', folderId))
    },
    getById(id: number): FileItem | undefined {
      return as<FileItem | undefined>(sqlGet<FileItem>(db, 'SELECT * FROM files WHERE id = ?', id) ?? undefined)
    },
  }
}
