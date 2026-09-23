import fs from 'fs'
import { win32 as path } from 'path' // 旧库数据为 Windows 路径，固定 win32 语义（同 scanner/folders 惯例）
import { Database } from 'node-sqlite3-wasm'
import { as, ensureSystemTags } from './db/schema'
import { makeTagDb } from './db/tags'
import { POSTER_DIR } from './db/schema'

interface OldMedia { library_id: number; title: string; original_title: string | null; file_path: string; anilist_id: number | null; watch_status: string }
interface OldLib { id: number; name: string; path: string; type: string }

const STATUS_TAG: Record<string, string> = { unwatched: '状态:未看', watching: '状态:在看', completed: '状态:看完' }

export function migrateLegacy(oldDbPath: string, ndb: Database): { libraries: number; folders: number; files: number; tags: number } {
  const existing = as<{ c: number }>(ndb.prepare('SELECT COUNT(*) c FROM libraries').get())
  if (existing.c > 0) throw new Error('新库已有数据，跳过迁移')

  ensureSystemTags(ndb) // 幂等，保证状态标签存在（M-1）
  const old = new Database(oldDbPath)
  const tagDb = makeTagDb(ndb)

  const oldLibs = as<OldLib[]>(old.prepare('SELECT * FROM libraries').all())
  const oldItems = as<OldMedia[]>(old.prepare('SELECT * FROM media_items').all())

  const libIdMap = new Map<number, number>()
  for (const ol of oldLibs) {
    const r = ndb.prepare('INSERT INTO libraries (name, root_path, type) VALUES (?, ?, ?)')
      .run([ol.name, ol.path, ol.type ?? 'anime'])
    libIdMap.set(ol.id, r.lastInsertRowid as number)
  }

  // 重建目录树（所有旧库合并按 path 处理；同一 path 归属第一个出现的库）
  const folderOf = new Map<string, number>()
  const sorted = [...oldItems].sort((a, b) => a.file_path.length - b.file_path.length)
  for (const m of sorted) {
    const dir = path.dirname(m.file_path)
    const libId = libIdMap.get(m.library_id)!
    if (!folderOf.has(dir)) {
      // 逐级创建父目录；跳过盘符段（i=0），避免建成空名盘符根 folder（与 scanner 树结构一致）
      const parts = dir.split(path.sep)
      let cur = ''
      for (let i = 1; i < parts.length; i++) {
        cur = i === 1 ? `${parts[0]}${path.sep}${parts[1]}` : path.join(cur, parts[i])
        if (folderOf.has(cur)) continue
        const parent = folderOf.get(path.dirname(cur)) ?? null
        const r = ndb.prepare('INSERT INTO folders (library_id, parent_id, name, path) VALUES (?, ?, ?, ?)')
          .run([libId, parent, path.basename(cur), cur])
        folderOf.set(cur, r.lastInsertRowid as number)
      }
    }
    const folderId = folderOf.get(dir)!
    const ext = path.extname(m.file_path).slice(1).toLowerCase()
    ndb.prepare('INSERT INTO files (folder_id, library_id, name, path, ext) VALUES (?, ?, ?, ?, ?)')
      .run([folderId, libId, path.basename(m.file_path), m.file_path, ext])

    if (m.anilist_id) {
      const posterExists = fs.existsSync(path.join(POSTER_DIR, `al_${m.anilist_id}.jpg`)) ||
        fs.existsSync(path.join(POSTER_DIR, `al_${m.anilist_id}.png`))
      ndb.prepare('UPDATE folders SET anilist_id = ?, has_poster = ? WHERE id = ?')
        .run([m.anilist_id, posterExists ? 1 : 0, folderId])
    }
    const tagName = STATUS_TAG[m.watch_status]
    if (tagName) {
      const tag = as<{ id: number }>(ndb.prepare('SELECT id FROM tags WHERE name = ?').get(tagName))
      const fileRow = as<{ id: number }>(ndb.prepare('SELECT id FROM files WHERE path = ?').get(m.file_path))
      tagDb.link(tag.id, 'file', fileRow.id)
    }
  }

  // 系列标记（与 scanner 的 markSeries 同语义：主文件夹 = 递归含视频 且（库根直接子目录 或 基础文件夹的直接子目录）；作用全部库）
  ndb.prepare(`UPDATE folders SET is_series = 0`).run()
  ndb.prepare(`
    WITH RECURSIVE video_dirs(id) AS (
      SELECT folder_id FROM files
      UNION
      SELECT f.parent_id FROM folders f JOIN video_dirs v ON f.id = v.id WHERE f.parent_id IS NOT NULL
    ),
    base AS (
      SELECT id FROM folders
      WHERE parent_id = (SELECT id FROM folders WHERE parent_id IS NULL)
        AND LOWER(TRIM(name)) IN ('series', 'movies', 'movie', 'tv', 'drama', 'shows', 'films', 'anime')
    )
    UPDATE folders SET is_series = 1
    WHERE id IN (SELECT id FROM video_dirs)
      AND (
        (parent_id = (SELECT id FROM folders WHERE parent_id IS NULL) AND id NOT IN (SELECT id FROM base))
        OR parent_id IN (SELECT id FROM base)
      )
  `).run()

  old.close()
  return { libraries: oldLibs.length, folders: folderOf.size, files: oldItems.length, tags: oldItems.filter(m => STATUS_TAG[m.watch_status]).length }
}

// CLI 入口：tsx server/migrate-legacy.ts
// node-sqlite3-wasm 的 .lock 目录在连接关闭后可能残留，残留会阻塞后续一切打开（database is locked），
// 故打开任何文件库前先清理对应残留 lock
const cleanLock = (p: string): void => { try { fs.rmdirSync(`${p}.lock`) } catch { /* 不存在或非空，忽略 */ } }

async function main() {
  const { createDb, ensureSystemTags, DATA_DIR } = await import('./db/schema')
  // 旧库定位：legacy-* 备份优先（重写后旧库已改名为 animeshelf.db.legacy-<ts>），否则 animeshelf.db（原位旧库场景）
  const files = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []
  const legacy = files.filter(f => /^animeshelf\.db\.legacy-.+$/.test(f)).sort().at(-1)
  let oldPath = path.join(DATA_DIR, legacy ?? 'animeshelf.db')
  if (!fs.existsSync(oldPath)) { console.log('未找到旧库，跳过迁移'); return }

  const target = path.join(DATA_DIR, 'animeshelf.db')
  if (target !== oldPath && fs.existsSync(target)) {
    // 半成品检测：目标库存在但 libraries 空（上次迁移中途失败）→ 删除重建；有数据 → 跳过
    cleanLock(target)
    let hasData = true
    try {
      const probe = new Database(target, { readOnly: true })
      hasData = as<{ c: number }>(probe.prepare('SELECT COUNT(*) c FROM libraries').get()).c > 0
      probe.close()
      cleanLock(target)
    } catch { /* 打不开按有数据处理，提示用户手动处理 */ }
    if (hasData) { console.log('新库已有数据，跳过迁移'); return }
    fs.rmSync(target, { force: true })
  }
  if (target === oldPath) {
    // animeshelf.db 原位：仅当它仍是旧 schema（无 root_path 列）才迁移；新库则跳过
    cleanLock(target)
    const probe = new Database(target, { readOnly: true })
    const hasRoot = as<{ c: number }>(probe.prepare(
      "SELECT COUNT(*) c FROM pragma_table_info('libraries') WHERE name = 'root_path'").get()).c
    probe.close()
    if (hasRoot > 0) { console.log('新库已存在，跳过迁移'); return }
    // 旧库原位：先改名腾出目标路径，再建新库
    const renamed = `${oldPath}.legacy-${Date.now()}`
    fs.renameSync(oldPath, renamed)
    oldPath = renamed
  }

  cleanLock(oldPath)
  cleanLock(target)
  const ndb = createDb(target)
  ensureSystemTags(ndb)
  const r = migrateLegacy(oldPath, ndb)
  ndb.close()
  cleanLock(target) // .lock 目录在 close 后仍可能残留，清理以免阻塞后续打开
  console.log(`迁移完成：${r.libraries} 库 / ${r.folders} 目录 / ${r.files} 文件 / ${r.tags} 状态标签`)
}
if (process.argv[1]?.endsWith('migrate-legacy.ts')) main().catch(e => { console.error(e); process.exit(1) })
