// Process-level ownership around the wasm driver's directory locks. No SQLite
// file is opened until this OS-owned endpoint has been acquired.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')

function failure(code, message) { return Object.assign(new Error(message), { code }) }

function canonicalDatabasePath(file) {
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const resolved = fs.existsSync(absolute) ? fs.realpathSync.native(absolute)
    : path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if ($p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }`],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null
    }
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
  } catch { /* A missing permission is not proof that a process has exited. */ }
  return null
}

function ownerExited(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false
  if (owner.closed === true) return false
  try { process.kill(owner.pid, 0) } catch (error) { return error.code === 'ESRCH' }
  const currentBirth = processBirth(owner.pid)
  return Boolean(owner.birth && currentBirth && owner.birth !== currentBirth)
}

async function acquireDatabaseLease(file) {
  const canonicalPath = canonicalDatabasePath(file)
  const digest = createHash('sha256').update(canonicalPath).digest('hex')
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\AnimeShelf-db-${digest}`
    : path.join(os.tmpdir(), `animeshelf-db-${digest.slice(0, 32)}.sock`)
  const markerPath = `${canonicalPath}.owner.json`
  const sqliteLock = `${canonicalPath}.lock`
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(markerPath, 'utf8')) } catch { /* Unknown owners fail closed below. */ }
  if (previous?.databasePath !== canonicalPath) previous = null
  // Unix sockets survive crashes; Windows named pipes do not. Never unlink an
  // endpoint unless its recorded process is proven gone.
  if (process.platform !== 'win32' && fs.existsSync(endpoint) && ownerExited(previous)) fs.unlinkSync(endpoint)
  const server = net.createServer(socket => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(failure('DATABASE_IN_USE', `数据库正在被其他实例使用，或无法取得独占锁：${canonicalPath}（${error.code}）`)))
    server.listen(endpoint, resolve)
  })
  // Ownership lasts until close/process exit, but a failed startup must not be
  // kept alive solely by this otherwise idle endpoint.
  server.unref()
  const closeEndpoint = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const token = randomUUID()
  const owner = { version: 1, databasePath: canonicalPath, pid: process.pid, birth: processBirth(process.pid), token, closed: false }
  let ownsMarker = false
  let released = false
  let maintenanceLock = false
  const lockIdentity = () => {
    try {
      const stat = fs.statSync(sqliteLock, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
    } catch { return null }
  }
  try {
    if (fs.existsSync(sqliteLock)) {
      if (!ownerExited(previous) || !previous.lockIdentity || previous.lockIdentity !== lockIdentity()) throw failure('DATABASE_LOCK_UNVERIFIED', `数据库锁的原持有者无法确认：${sqliteLock}；请关闭所有 AnimeShelf 实例后离线核查，不能直接删除活动锁。`)
      fs.rmdirSync(sqliteLock) // Only an empty lock directory with a proven former owner.
    }
    fs.writeFileSync(markerPath, JSON.stringify(owner), { mode: 0o600 })
    ownsMarker = true
    return {
      path: canonicalPath,
      holdFileLock() {
        // Offline tools do not open the damaged main DB. Hold its VFS lock
        // across hashing/copying/renaming to also exclude older wasm writers
        // which have not adopted the process-level ownership endpoint.
        try { fs.mkdirSync(sqliteLock) }
        catch { throw failure('DATABASE_IN_USE', '离线维护期间发现其他 SQLite 使用者，已停止操作。') }
        maintenanceLock = true
        owner.lockIdentity = lockIdentity()
        fs.writeFileSync(markerPath, JSON.stringify(owner), { mode: 0o600 })
      },
      recordLock(database) {
        // The wasm VFS creates/removes .lock per transaction by default. Keep
        // one lock generation for this owned connection so crash cleanup can
        // distinguish it from a lock subsequently created by a legacy process.
        if (database) {
          // close_v2 alone reports success with live statements and defers the
          // actual file close. Track statements so ownership is not released
          // while a zombie SQLite connection can still retain its VFS lock.
          const statements = new Set()
          const prepare = database.prepare.bind(database)
          database.prepare = (...args) => {
            const statement = prepare(...args)
            statements.add(statement)
            const finalize = statement.finalize.bind(statement)
            statement.finalize = () => {
              try { return finalize() }
              finally { if (statement.isFinalized) statements.delete(statement) }
            }
            return statement
          }
          const close = database.close.bind(database)
          database.close = () => {
            for (const statement of statements) if (!statement.isFinalized) {
              try { statement.finalize() }
              catch (error) {
                // sqlite3_finalize may return the statement's previous query
                // error after successfully freeing it. Only retain live ones.
                if (!statement.isFinalized) throw error
              }
            }
            close()
            if (fs.existsSync(sqliteLock)) throw failure('DATABASE_CLOSE_FAILED', 'SQLite 文件锁尚未释放，数据库所有权继续保留。')
          }
          database.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT')
        }
        const identity = lockIdentity()
        if (!identity) throw failure('DATABASE_LOCK_UNVERIFIED', '数据库连接没有可验证的 SQLite 锁，已停止初始化。')
        owner.lockIdentity = identity
        fs.writeFileSync(markerPath, JSON.stringify(owner), { mode: 0o600 })
      },
      async release() {
        if (released) return
        const saved = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
        if (saved.token !== token) throw failure('DATABASE_OWNER_CHANGED', '数据库所有权记录发生变化，拒绝释放其他实例的锁。')
        if (maintenanceLock) {
          if (!owner.lockIdentity || lockIdentity() !== owner.lockIdentity) throw failure('DATABASE_OWNER_CHANGED', '离线文件锁的身份发生变化，拒绝清理。')
          fs.rmdirSync(sqliteLock)
          maintenanceLock = false
        }
        if (fs.existsSync(sqliteLock)) throw failure('DATABASE_CLOSE_FAILED', 'SQLite 文件锁尚未释放，数据库所有权继续保留。')
        fs.writeFileSync(markerPath, JSON.stringify({ ...owner, closed: true }), { mode: 0o600 })
        await closeEndpoint()
        released = true
      },
    }
  } catch (error) {
    if (ownsMarker) {
      try { fs.writeFileSync(markerPath, JSON.stringify({ ...owner, closed: true }), { mode: 0o600 }) } catch { /* Retain the original failure. */ }
    }
    await closeEndpoint().catch(() => {})
    throw error
  }
}

module.exports = { acquireDatabaseLease, canonicalDatabasePath, processBirth }
