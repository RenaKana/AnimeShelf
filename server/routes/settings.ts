import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { db, settingsDb } from '../db/instance'
import { DATA_DIR } from '../db/schema'
import { databaseIntegrity } from '../db/maintenance'
import { manualBackup, listBackups, applyRestorePreview } from '../services/backup'
import { inspectRestore, resolveRestorePreview, RestorePreviewError } from '../services/restore-preview'
import { withLibraryMaintenance } from '../services/library-maintenance'
import { isOwnerRequest } from '../core/owner-request'
import { afterDataRestore, invalidateLibraryMatches } from '../core/extensions'
import { refreshLibraryScanning } from '../services/library-scan-coordinator'


const router = Router()

const SENSITIVE_SETTINGS = {
  tmdb_key: 'tmdb_key_configured',
  bangumi_token: 'bangumi_token_configured',
} as const
type SensitiveSettingKey = keyof typeof SENSITIVE_SETTINGS
const SENSITIVE_CLEAR_KEYS: Record<SensitiveSettingKey, string> = {
  tmdb_key: 'clear_tmdb_key',
  bangumi_token: 'clear_bangumi_token',
}
const REDACTED_SECRET_VALUES = new Set(['******', '********', '••••••••', '[hidden]'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isClearRequested(value: unknown): boolean {
  return value === true || value === '1'
}

function publicSettings(): Record<string, string> {
  const settings = settingsDb.getAll()
  for (const [key, configuredKey] of Object.entries(SENSITIVE_SETTINGS) as Array<[SensitiveSettingKey, string]>) {
    const saved = settings[key]
    delete settings[key]
    settings[configuredKey] = saved?.trim() ? '1' : '0'
  }
  // Legacy unpublished settings stay in storage, but never in public configuration responses.
  for (const key of Object.keys(settings)) {
    if (key.startsWith('find_anime_') || key.startsWith('ai_') || key.startsWith('download_sources')) delete settings[key]
  }
  return settings
}


// 当前运行实例实际使用的数据文件；用于区分开发版与 portable 的不同目录。
router.get('/system-info', (_req, res) => {
  try {
    const databasePath = path.join(DATA_DIR, 'animeshelf.db')
    const integrity = databaseIntegrity(db)
    const schema = db.get('PRAGMA schema_version') as { schema_version?: number } | null
    const stat = fs.statSync(databasePath)
    res.json({
      dataDir: DATA_DIR,
      databasePath,
      databaseSize: stat.size,
      schemaVersion: Number(schema?.schema_version ?? 0),
      healthy: integrity.length === 1 && integrity[0] === 'ok',
      integrity,
    })
  } catch (e: any) {
    res.status(500).json({ error: `数据库状态读取失败：${e.message}` })
  }
})


// 手动备份：生成一致性数据库快照到桌面（与自动备份目录 data/backups/auto 分离）
router.post('/backup', (_req, res) => {
  try {
    const p = manualBackup()
    res.json({ ok: true, path: p })
  } catch (e: any) {
    res.status(500).json({ error: `备份失败：${e.message}`, code: e.code })
  }
})


// GET /api/settings/backups — 列出可用备份（自动 + 手动目录，按时间倒序）
router.get('/backups', (_req, res) => {
  try {
    res.json({ backups: listBackups() })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/settings/backups/restore { previewId } — 校验已确认预览后事务恢复。
router.post('/backups/restore', async (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面恢复备份', code: 'OWNER_REQUIRED' })
    const previewId = String(req.body?.previewId ?? '')
    if (!previewId) return res.status(409).json({ error: '请先预检备份并确认路径', code: 'RESTORE_INSPECTION_REQUIRED' })
    const r = await applyRestorePreview(previewId)
    // 海报库补回后仍有缺失 → 后台自动补抓（fire-and-forget，串行限速）
    let warning = r.warning
    try { await afterDataRestore(db); invalidateLibraryMatches(db); refreshLibraryScanning(db, true) }
    catch (error) { console.error('Post-restore refresh failed:', error); warning = [warning, '数据库已恢复，但附加数据刷新失败，请重启服务后检查。'].filter(Boolean).join(' ') }
    res.json({ ok: true, ...r, warning })
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: `恢复失败：${e.message}`, code: e.code })
  }
})

// 列表备份和上传备份共用预检；上传临时文件由预览持有，应用或过期后清理。
router.post('/backups/inspect', async (req, res) => {
  let tmp: string | null = null
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面预检备份', code: 'OWNER_REQUIRED' })
    if (req.body?.previewId) {
      const preview = await withLibraryMaintenance(db, '恢复预检', () => resolveRestorePreview(db, String(req.body.previewId), req.body.resolutions))
      return res.json(preview)
    }
    if (req.body?.file) {
      const hit = listBackups().find(backup => backup.name === req.body.file && (!req.body.dir || backup.dir === req.body.dir))
      if (!hit) throw new RestorePreviewError('备份文件不存在', 'BACKUP_NOT_FOUND', 404)
      return res.json(await withLibraryMaintenance(db, '恢复预检', () => inspectRestore(db, hit.path)))
    }
    const name = String(req.body?.name ?? 'backup.db')
    const data = String(req.body?.data ?? '')
    if (!data) return res.status(400).json({ error: '文件内容为空' })
    const buf = Buffer.from(data, 'base64')
    if (buf.length < 1024 || buf.length > 200 * 1024 * 1024) return res.status(400).json({ error: '文件大小异常' })
    const uploadDir = path.join(DATA_DIR, 'backups', 'uploads')
    fs.mkdirSync(uploadDir, { recursive: true })
    tmp = path.join(uploadDir, `upload-${Date.now()}-${name.replace(/[\\/:*?"<>|]/g, '_')}`)
    fs.writeFileSync(tmp, buf)
    const preview = await withLibraryMaintenance(db, '恢复预检', () => inspectRestore(db, tmp!, true))
    tmp = null // Preview owns the upload until applied or expired.
    res.json(preview)
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: `预检失败：${e.message}`, code: e.code })
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ } }
  }
})

router.post('/backups/upload', (_req, res) => res.status(409).json({ error: '请先上传到恢复预检，再确认应用', code: 'RESTORE_INSPECTION_REQUIRED' }))

// Explicit root routes prevent disabled feature URLs falling through to generic settings.
router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(publicSettings())
})
router.put('/', (req, res) => {
  if (!isRecord(req.body)) return res.status(400).json({ error: '设置格式无效', code: 'SETTINGS_INVALID' })
  const body = req.body
  if (Object.keys(body).some(key => key.startsWith('download_sources'))) {
    return res.status(400).json({ error: '下载来源使用内置规则，不支持修改站点地址', code: 'SETTINGS_INVALID' })
  }
  for (const key of Object.values(SENSITIVE_CLEAR_KEYS)) {
    const value = body[key]
    if (value !== undefined && value !== true && value !== false && value !== '1' && value !== '0') {
      return res.status(400).json({ error: '密钥清除选项格式无效', code: 'SETTINGS_INVALID' })
    }
  }
  for (const [key, clearKey] of Object.entries(SENSITIVE_CLEAR_KEYS) as Array<[SensitiveSettingKey, string]>) {
    const value = body[key]
    const clear = isClearRequested(body[clearKey])
    if (clear) {
      settingsDb.set(key, '')
      continue
    }
    if (value === undefined) continue
    if (typeof value !== 'string') return res.status(400).json({ error: '密钥格式无效', code: 'SETTINGS_INVALID' })
    const trimmed = value.trim()
    // Older clients may submit a display placeholder after a redacted read.
    // Preserve the stored value instead of treating the placeholder as a key.
    if (trimmed && !REDACTED_SECRET_VALUES.has(trimmed)) settingsDb.set(key, trimmed)
  }
  for (const [key, value] of Object.entries(body)) {
    if (key in SENSITIVE_SETTINGS || Object.values(SENSITIVE_CLEAR_KEYS).includes(key)) continue
    if (key.startsWith('ai_') || key.startsWith('find_anime_') || key.startsWith('module_')) continue
    settingsDb.set(key, String(value))
  }
  if (['everything_url', 'auto_scan', 'scan_on_startup'].some(key => Object.prototype.hasOwnProperty.call(body, key))) refreshLibraryScanning(db)
  res.json({ ok: true })
})

export default router
