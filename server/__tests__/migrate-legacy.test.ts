import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Database } from 'node-sqlite3-wasm'
import { createDb, ensureSystemTags } from '../db/schema'
import { migrateLegacy } from '../migrate-legacy'

describe('migrateLegacy', () => {
  it('rebuilds folders/files and maps watch status tags', () => {
    const oldPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leg-')), 'old.db')
    const old = new Database(oldPath)
    old.exec(`
      CREATE TABLE libraries (id INTEGER PRIMARY KEY, name TEXT, path TEXT, type TEXT);
      CREATE TABLE media_items (id INTEGER PRIMARY KEY, library_id INTEGER, title TEXT, original_title TEXT,
        poster_path TEXT, backdrop_path TEXT, year INTEGER, rating REAL, type TEXT, genres TEXT, synopsis TEXT,
        episodes INTEGER, file_path TEXT, anilist_id INTEGER, tmdb_id INTEGER, watch_status TEXT);
      INSERT INTO libraries VALUES (1, '动漫', 'D:\\Anime', 'anime');
      INSERT INTO media_items (library_id, title, original_title, file_path, anilist_id, watch_status) VALUES
        (1, '进击的巨人', '進撃の巨人', 'D:\\Anime\\进击的巨人\\S01E01.mkv', 1, 'watching'),
        (1, '千与千寻', '千と千尋の神隠し', 'D:\\Anime\\千与千寻 (2001).mkv', 2, 'completed');
    `)
    old.close()

    const ndb = createDb(':memory:')
    ensureSystemTags(ndb)
    const r = migrateLegacy(oldPath, ndb)

    expect(r.files).toBe(2)
    const folders = ndb.prepare('SELECT * FROM folders').all()
    expect(folders).toHaveLength(2) // 库根 D:\Anime + 进击的巨人（不建盘符根）
    const g = folders.find((f: any) => f.name === '进击的巨人')!
    expect(g.anilist_id).toBe(1)
    expect(g.is_series).toBe(1)
    const root = folders.find((f: any) => f.path === 'D:\\Anime')!
    expect(root).toBeDefined()
    expect(root.name).toBe('Anime')

    const watching = ndb.prepare(`SELECT COUNT(*) c FROM tag_links l JOIN tags t ON t.id = l.tag_id WHERE t.name = '状态:在看'`).get()!
    expect(watching.c).toBe(1)
    const completed = ndb.prepare(`SELECT COUNT(*) c FROM tag_links l JOIN tags t ON t.id = l.tag_id WHERE t.name = '状态:看完'`).get()!
    expect(completed.c).toBe(1)
  })
})
