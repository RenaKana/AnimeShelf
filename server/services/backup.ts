// 数据备份：
// 1) autoBackup()：每次后端启动时调用 → 自动备份目录（默认 data/backups/auto，settings 键 backup_dir_auto 可改）保留最近 10 份
// 2) manualBackup()：设置页手动触发 → 手动备份目录（默认桌面，settings 键 backup_dir_manual 可改）
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { Database } from 'node-sqlite3-wasm'
import { db, settingsDb } from '../db/instance'
import { createDatabaseSnapshot } from '../db/maintenance'
import { restoreDatabaseTables } from '../db/restore-tables'
import { DATA_DIR } from '../db/schema'
import { sqlGet, sqlRun } from '../db/sql'
import { assertDesktopEdition } from '../db/desktop-edition'
import { posterCacheKey } from '../../shared/poster-cache-key'
import { withLibraryMaintenance } from './library-maintenance'
import { inspectRestore, validatedRestore } from './restore-preview'

const DB_FILE = path.join(DATA_DIR, 'animeshelf.db')
const DEFAULT_AUTO_DIR = path.join(DATA_DIR, 'backups', 'auto')
const KEEP_AUTO = 10
// 共享海报库：所有备份共用一份海报（增量复制，避免每份备份重复 50MB）
const POSTERS_LIB = path.join(DATA_DIR, 'backups', 'posters')
const POSTERS_SRC = path.join(DATA_DIR, 'posters')

// 是否备份海报（settings 键 backup_include_posters，默认开）
function includePosters(): boolean {
  return settingsDb.get('backup_include_posters') !== '0'
}

// 增量同步海报到共享海报库（只复制新文件，已存在跳过）
export function syncPostersToLibrary(): number {
  if (!fs.existsSync(POSTERS_SRC)) return 0
  fs.mkdirSync(POSTERS_LIB, { recursive: true })
  let n = 0
  for (const f of fs.readdirSync(POSTERS_SRC)) {
    const dest = path.join(POSTERS_LIB, f)
    if (!fs.existsSync(dest)) {
      try { fs.copyFileSync(path.join(POSTERS_SRC, f), dest); n++ } catch { /* 跳过损坏文件 */ }
    }
  }
  return n
}

// 读取配置的备份目录（空/无效回退默认）
function autoDir(): string {
  const v = settingsDb.get('backup_dir_auto')?.trim()
  return v && fs.existsSync(v) ? v : DEFAULT_AUTO_DIR
}
function manualDir(): string {
  const v = settingsDb.get('backup_dir_manual')?.trim()
  if (v) return v
  let desk = path.join(process.env.USERPROFILE ?? '', 'Desktop')
  try {
    const out = execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Desktop\')"', { encoding: 'utf8' }).trim()
    if (out && fs.existsSync(out)) desk = out
  } catch { /* 探测失败用默认 */ }
  return desk
}

function copyDb(dest: string) {
  createDatabaseSnapshot(db, DB_FILE, dest)
}

// 启动自动备份：不阻塞启动；只保留最近 KEEP_AUTO 份；海报增量同步到共享海报库
export function autoBackup(): string | null {
  try {
    if (!fs.existsSync(DB_FILE)) return null
    if (includePosters()) syncPostersToLibrary()
    const dir = autoDir()
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const dest = path.join(dir, `animeshelf-${ts}.db`)
    copyDb(dest)
    // 清理旧备份（按文件名排序保留最近 10 份）
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_AUTO))) {
      fs.rmSync(path.join(dir, f), { force: true })
    }
    return dest
  } catch (error) {
    console.error('自动备份失败:', error)
    return null
  }
}

// 手动备份到配置目录（默认桌面；与自动备份目录分离）
export function manualBackup(): string {
  if (includePosters()) syncPostersToLibrary()
  const dir = manualDir()
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const dest = path.join(dir, `animeshelf-backup-${ts}.db`)
  copyDb(dest)
  return dest
}

// 列出可用备份（自动 + 手动目录），按时间倒序
export interface BackupInfo { name: string; dir: 'auto' | 'manual'; path: string; mtime: number; size: number }
export function listBackups(): BackupInfo[] {
  const out: BackupInfo[] = []
  for (const [dir, kind] of [[autoDir(), 'auto'], [manualDir(), 'manual']] as const) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.db')) continue
      const p = path.join(dir, f)
      try {
        const st = fs.statSync(p)
        out.push({ name: f, dir: kind, path: p, mtime: st.mtimeMs, size: st.size })
      } catch { /* 跳过损坏条目 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

interface RestoreResult {
  tables: number
  rows: number
  postersRestored: number | null
  missingPosters: number | null
  warning?: string
}

// 恢复备份：从独立只读连接按列交集导入，事务回滚保护，不重启服务立即生效；
// 恢复前必须创建唯一的安全备份。只接受 listBackups 返回的文件名（防路径穿越）。
export async function restoreBackup(fileName: string): Promise<RestoreResult> {
  const hit = listBackups().find(b => b.name === fileName)
  if (!hit) throw new Error('备份文件不存在')
  return restoreFromPath(hit.path)
}

// 从任意备份文件路径恢复（上传的临时文件/列表内备份共用核心逻辑）
// 恢复完成后：从共享海报库补回 db 引用的海报文件（本地复制，快），返回仍缺失数量（>0 时由调用方触发网络补抓）
// 与扫描、磁盘操作和海报任务共用维护锁，应用前重新校验预览。
export async function restoreFromPath(filePath: string, previewId?: string): Promise<RestoreResult> {
  return withLibraryMaintenance(db, '备份恢复', () => {
    const id = previewId ?? inspectRestore(db, filePath).previewId
    const inspected = validatedRestore(db, id)
    const result = restoreFromPathSync(inspected.file, inspected.applyPaths)
    inspected.complete()
    return result
  })
}

export async function applyRestorePreview(previewId: string) {
  return restoreFromPath('', previewId)
}

function restoreFromPathSync(filePath: string, applyPaths: () => void): RestoreResult {
  // A required, unique safety snapshot must succeed; never overwrite the selected backup.
  const safetyBackup = path.join(DATA_DIR, 'backups', 'auto', `before-restore-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  createDatabaseSnapshot(db, DB_FILE, safetyBackup)
  // 使用唯一临时副本读取备份，避免复用 Windows 下可能残留锁目录的路径。
  const tmpBackup = path.join(DATA_DIR, 'backups', 'uploads', `restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
  fs.mkdirSync(path.dirname(tmpBackup), { recursive: true })
  fs.copyFileSync(filePath, tmpBackup)
  // Keep the source on an independent read-only connection. A live UI can hold
  // prepared readers; ATTACH/DETACH then remains locked and deleting its source
  // would poison the next write transaction with SQLITE_IOERR.
  const source = new Database(tmpBackup, { readOnly: true, fileMustExist: true })
  let sourceClosed = false
  // 事务控制语句同样 prepare+finalize（node-sqlite3-wasm 的 exec 不保证释放语句）
  const runStmt = (sql: string) => { const st = db.prepare(sql); try { st.run() } finally { st.finalize() } }
  try {
    assertDesktopEdition(source)
    const restored = (() => {
      runStmt('BEGIN')
      try {
        runStmt('PRAGMA defer_foreign_keys = ON')
        const result = restoreDatabaseTables(db, source)
        applyPaths()
        const foreignKeyCheck = db.prepare('PRAGMA foreign_key_check')
        let foreignKeyViolations: unknown[]
        try { foreignKeyViolations = foreignKeyCheck.all() as unknown[] } finally { foreignKeyCheck.finalize() }
        if (foreignKeyViolations.length > 0) {
          throw new Error(`备份数据违反外键约束（${foreignKeyViolations.length} 处）`)
        }
        // Fail before committing if the private reader cannot be closed. This
        // keeps a failed preview retry from applying the same restore twice.
        source.close()
        sourceClosed = true
        runStmt('COMMIT')
        return result
      } catch (e) {
        try { runStmt('ROLLBACK') } catch { /* 无事务时忽略 */ }
        throw e
      }
    })()
    // 恢复后：从共享海报库补回 db 引用的海报文件（本地复制，不覆盖现有）
    let posterResult: Pick<RestoreResult, 'postersRestored' | 'missingPosters' | 'warning'>
    try {
      const pr = restorePostersFromLibrary()
      posterResult = { postersRestored: pr.restored, missingPosters: pr.missing }
    } catch (error) {
      console.error('Post-restore poster recovery failed:', error)
      posterResult = { postersRestored: null, missingPosters: null, warning: '数据库已恢复，但海报缓存补回失败；请检查海报目录后使用“补齐缺失海报”。' }
    }
    return { ...restored, ...posterResult }
  } finally {
    if (!sourceClosed) source.close()
    // 清理临时副本及其 .lock（rmdir 失败无碍：下次恢复使用新临时名，不会冲突）
    try { fs.rmSync(tmpBackup, { force: true }) } catch { /* 忽略 */ }
    try { fs.rmdirSync(`${tmpBackup}.lock`) } catch { /* 忽略 */ }
  }
}

// 从共享海报库补回 db 引用的缺失海报（不覆盖现有文件），返回恢复数 + 仍缺失数
// 注意：不依赖 has_poster 列——旧备份无该列时恢复后全为默认 0，但 anilist_id 有效；
// 此处按 anilist_id + 实际文件存在性重建海报状态（文件在→has_poster=1，缺→交网络补抓）
// 除媒体库 folders（al_/bg_/tm_<kind>_）外，也补回心愿单 season_favorites 的本地 fav_ 海报文件
export function restorePostersFromLibrary(): { restored: number; missing: number } {
  const libExists = fs.existsSync(POSTERS_LIB)
  const libFiles = libExists ? fs.readdirSync(POSTERS_LIB) : []
  const mkSet = () => new Set(libFiles)
  const libSet = mkSet()
  const st = db.prepare('SELECT id, anilist_id, source, tmdb_media_type FROM folders WHERE anilist_id IS NOT NULL')
  let rows: { id: number; anilist_id: number; source: string; tmdb_media_type: 'movie' | 'tv' | null }[]
  try { rows = st.all() as { id: number; anilist_id: number; source: string; tmdb_media_type: 'movie' | 'tv' | null }[] } finally { st.finalize() }
  const upd = db.prepare('UPDATE folders SET has_poster = ? WHERE id = ?')
  let restored = 0
  let missing = 0
  try {
    for (const r of rows) {
      const base = posterCacheKey(
        r.source === 'tmdb' ? 'tmdb' : r.source === 'bangumi' ? 'bangumi' : 'anilist',
        r.anilist_id,
        r.tmdb_media_type,
      )
      if (!base) continue
      // 现有海报已存在（任意常见扩展名）则只确保状态标记
      const exists = ['.jpg', '.png', '.webp', '.jpeg'].some(ext => fs.existsSync(path.join(POSTERS_SRC, `${base}${ext}`)))
      if (exists) { upd.run([1, r.id]); continue }
      // 从海报库找同名文件（任意扩展名）复制回来
      const hit = libFiles.find(f => f.startsWith(`${base}.`))
      if (hit) {
        try { fs.copyFileSync(path.join(POSTERS_LIB, hit), path.join(POSTERS_SRC, hit)); upd.run([1, r.id]); restored++ } catch { missing++ }
      } else {
        missing++
      }
    }
  } finally {
    upd.finalize()
  }
  // —— 心愿单 fav_ 海报：image 指向本地 /posters/fav_* 且文件缺失 → 从海报库补回 ——
  const favTableSt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'season_favorites'")
  let hasFavoriteTable: boolean
  try { hasFavoriteTable = Boolean(favTableSt.get()) } finally { favTableSt.finalize() }
  if (!hasFavoriteTable) return { restored, missing }
  const favSt = db.prepare('SELECT item_id, image FROM season_favorites WHERE image LIKE \'/posters/%\'')
  let favs: { item_id: string; image: string }[]
  try { favs = favSt.all() as { item_id: string; image: string }[] } finally { favSt.finalize() }
  for (const f of favs) {
    const file = f.image.slice('/posters/'.length)
    if (fs.existsSync(path.join(POSTERS_SRC, file))) continue // 本地已有
    if (libSet.has(file)) {
      try { fs.copyFileSync(path.join(POSTERS_LIB, file), path.join(POSTERS_SRC, file)); restored++ } catch { missing++ }
    } else {
      missing++ // 海报库也没有 → 计入缺失，交给网络补抓阶段重建 image
    }
  }
  return { restored, missing }
}
