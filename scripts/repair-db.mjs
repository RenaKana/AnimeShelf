import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sqlite from 'node-sqlite3-wasm'
import leaseTools from './database-lease.cjs'

const { Database } = sqlite
const { acquireDatabaseLease, canonicalDatabasePath } = leaseTools
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`

export function verifyRepairDatabase(file) {
  let db
  try {
    db = new Database(file, { readOnly: true, fileMustExist: true })
    const integrity = db.all('PRAGMA integrity_check').map(row => String(Object.values(row)[0]))
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error('候选数据库完整性检查失败')
    if (db.all('PRAGMA foreign_key_check').length) throw new Error('候选数据库外键检查失败')
  } finally {
    try { db?.close() }
    catch (error) { throw Object.assign(new Error('校验连接未能关闭，数据库所有权将继续保留'), { cause: error, retainLease: true }) }
  }
}

// The hashes bind applying a candidate to its inspected preparation report.
export async function applyVerifiedCandidate({ dbPath, candidate, reportPath, acceptHistoryReset = false, verify = verifyRepairDatabase, verifyInstalled = (file, expected) => {
  if (sha256(file).toLowerCase() !== expected.toLowerCase()) throw new Error('替换后数据库内容不一致')
} }) {
  const sourcePath = path.resolve(dbPath)
  const candidatePath = path.resolve(candidate)
  if (canonicalDatabasePath(sourcePath) === canonicalDatabasePath(candidatePath)) throw new Error('候选库不能是正在替换的原数据库')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  if (report.candidateVerified !== true || report.readyToApply !== true || !/^[a-f\d]{64}$/i.test(report.sourceSha256 ?? '') || !/^[a-f\d]{64}$/i.test(report.candidateSha256 ?? '')) throw new Error('恢复报告尚未完成验证，不能替换原库')
  const historyResetRequired = report.lossless !== true || report.requiresGenerationReset || report.historyResetWasRequired
  if (historyResetRequired && report.generationResetCompleted !== true) throw new Error('候选库尚未完成新一代手机同步历史重建，不能应用')
  if ((historyResetRequired || report.generationResetCompleted) && !acceptHistoryReset) throw new Error('存在未完整恢复的同步历史；请先核对影响报告，确认后使用 --accept-history-reset')
  const lease = await acquireDatabaseLease(sourcePath)
  const unique = stamp()
  const temporary = `${sourcePath}.candidate-${unique}`
  const preserved = `${sourcePath}.pre-repair-${unique}`
  const rejected = `${sourcePath}.rejected-${unique}`
  let originalMoved = false
  let candidateInstalled = false
  let retainLease = false
  try {
    lease.holdFileLock()
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (fs.existsSync(`${sourcePath}${suffix}`)) throw new Error(`原数据库仍有日志侧文件 ${suffix}，请先离线检查，不能忽略日志覆盖数据库`)
    }
    if (sha256(sourcePath).toLowerCase() !== report.sourceSha256.toLowerCase()) throw new Error('原数据库已在预检后变化，请重新生成候选库')
    if (sha256(candidatePath).toLowerCase() !== report.candidateSha256.toLowerCase()) throw new Error('候选库与已验证的报告不一致')
    fs.copyFileSync(candidatePath, temporary, fs.constants.COPYFILE_EXCL)
    verify(temporary)
    if (sha256(temporary).toLowerCase() !== report.candidateSha256.toLowerCase()) throw new Error('候选副本校验后内容发生变化')
    if (sha256(sourcePath).toLowerCase() !== report.sourceSha256.toLowerCase()) throw new Error('原数据库发生变化，已取消替换')
    fs.renameSync(sourcePath, preserved)
    originalMoved = true
    fs.renameSync(temporary, sourcePath)
    candidateInstalled = true
    // The staged SQLite connection has already closed successfully. Verify the
    // installed bytes without opening another connection that could block rollback.
    verifyInstalled(sourcePath, report.candidateSha256)
    return { databasePath: sourcePath, preservedPath: preserved, reportPath: path.resolve(reportPath), lossless: report.lossless, generationReset: report.generationResetCompleted === true }
  } catch (error) {
    retainLease = Boolean(error?.retainLease)
    if (originalMoved && !retainLease) {
      try {
        if (candidateInstalled && fs.existsSync(sourcePath)) fs.renameSync(sourcePath, rejected)
        fs.renameSync(preserved, sourcePath)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `回退未完成；原数据库仍保存在 ${preserved}，请勿启动服务`)
      }
    }
    throw error
  } finally {
    if (!retainLease) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* Retain a failed staging file. */ }
      try { fs.rmdirSync(`${temporary}.lock`) } catch { /* Only this invocation's closed private copy. */ }
      await lease.release()
    }
  }
}

function argument(args, key) {
  const index = args.indexOf(key)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${key} 缺少参数`)
  return value
}

async function prepare(args, dbPath) {
  const dataDir = path.dirname(dbPath)
  const backup = argument(args, '--backup')
  if (!backup) throw new Error('预检需要 --backup <已保留的健康备份.db>；不会自动选择旧备份覆盖现库')
  const workDir = path.resolve(argument(args, '--work-dir') ?? path.join(dataDir, 'backups', 'recovery', stamp()))
  if (fs.existsSync(workDir)) throw new Error('恢复工作目录已存在，请指定一个新目录')
  const lease = await acquireDatabaseLease(dbPath)
  try {
    lease.holdFileLock()
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) throw new Error(`原数据库仍有日志侧文件 ${suffix}，必须先离线检查`)
    }
    fs.mkdirSync(workDir, { recursive: true })
    const sourceCopy = path.join(workDir, 'source.db'), backupCopy = path.join(workDir, 'backup.db')
    fs.copyFileSync(dbPath, sourceCopy, fs.constants.COPYFILE_EXCL)
    fs.copyFileSync(path.resolve(backup), backupCopy, fs.constants.COPYFILE_EXCL)
    const candidate = path.join(workDir, 'candidate.db'), report = path.join(workDir, 'report.json')
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.env.ANIMESHELF_PYTHON || 'python', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'recover-database.py'), '--source', sourceCopy, '--backup', backupCopy, '--output', candidate, '--report', report], { stdio: 'inherit', windowsHide: true })
      child.once('error', reject); child.once('exit', code => resolve(code))
    })
    if (result !== 0 && result !== 2) throw new Error(`候选库准备未通过，原库未修改。检查 ${report}`)
    console.log(JSON.stringify({ candidate, report, applied: false, requiresGenerationReset: result === 2 }))
  } finally { await lease.release() }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || !args.length) {
    console.log('先关闭全部 AnimeShelf 实例。预检：node scripts/repair-db.mjs --prepare --backup <健康备份.db> [--work-dir <新目录>]\n应用已验证候选库：node scripts/repair-db.mjs --candidate <candidate.db> --report <report.json> [--accept-history-reset]\n使用 ANIMESHELF_DATA_DIR 指定数据目录。未知 SQLite 锁必须先核对停机情况，程序不会擅自删除。')
    return
  }
  const dbPath = path.join(path.resolve(process.env.ANIMESHELF_DATA_DIR ?? path.join(process.cwd(), 'data')), 'animeshelf.db')
  if (args.includes('--prepare')) return prepare(args, dbPath)
  const candidate = argument(args, '--candidate'), reportPath = argument(args, '--report')
  if (!candidate || !reportPath) throw new Error('需要 --candidate 和 --report；使用 --help 查看说明')
  console.log(JSON.stringify(await applyVerifiedCandidate({ dbPath, candidate, reportPath, acceptHistoryReset: args.includes('--accept-history-reset') })))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
