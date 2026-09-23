const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CONTROL_HEADER = 'x-animeshelf-control-token'
const STATES = new Set(['running', 'starting', 'stopping', 'failed', 'unknown'])
const hardenedDirectories = new Map()
let cachedUserSid

function runtimeDir(env = process.env) {
  if (env.ANIMESHELF_RUNTIME_DIR) return path.resolve(env.ANIMESHELF_RUNTIME_DIR)
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) throw new Error('LOCALAPPDATA is required for the AnimeShelf service registry')
  return path.join(localAppData, 'AnimeShelf', 'run')
}

function currentUserSid() {
  if (cachedUserSid !== undefined) return cachedUserSid
  const command = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const sid = result.status === 0 ? result.stdout.trim() : ''
  cachedUserSid = /^S-1-/.test(sid) ? sid : null
  return cachedUserSid
}

function hardenWindowsAcl(target, directory) {
  if (process.platform !== 'win32') return
  const sid = currentUserSid()
  if (!sid) throw new Error('Unable to determine the current Windows user SID')
  const script = directory
    ? [
        '$acl=New-Object System.Security.AccessControl.DirectorySecurity',
        '$acl.SetAccessRuleProtection($true,$false)',
        '$inherit=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit',
        `@('${sid}','S-1-5-18','S-1-5-32-544') | ForEach-Object { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($_)), 'FullControl', $inherit, 'None', 'Allow'))) }`,
        '[System.IO.Directory]::SetAccessControl($env:ANIMESHELF_ACL_TARGET,$acl)',
      ].join('; ')
    : [
        '$acl=New-Object System.Security.AccessControl.FileSecurity',
        '$acl.SetAccessRuleProtection($true,$false)',
        `@('${sid}','S-1-5-18','S-1-5-32-544') | ForEach-Object { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($_)), 'FullControl', 'Allow'))) }`,
        '[System.IO.File]::SetAccessControl($env:ANIMESHELF_ACL_TARGET,$acl)',
      ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ANIMESHELF_ACL_TARGET: target },
  })
  if (result.status !== 0) {
    throw new Error(`Unable to secure AnimeShelf runtime registry ACL: ${(result.stderr || result.stdout).trim()}`)
  }
}

function ensureRuntimeDir(env = process.env) {
  const target = runtimeDir(env)
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(target, 0o700) } catch { /* Windows ACL is authoritative. */ }
  const key = normalizePath(target)
  const stat = fs.statSync(target)
  const marker = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
  if (hardenedDirectories.get(key) !== marker) {
    hardenWindowsAcl(target, true)
    const secured = fs.statSync(target)
    hardenedDirectories.set(key, `${secured.dev}:${secured.ino}:${secured.birthtimeMs}`)
  }
  return target
}

function registryPath(id, env = process.env) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid AnimeShelf instance id')
  return path.join(runtimeDir(env), `${id}.json`)
}

function writeRegistryRecord(record, env = process.env) {
  const dir = ensureRuntimeDir(env)
  const target = registryPath(record.id, env)
  const temporary = path.join(dir, `.${record.id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try { fs.chmodSync(temporary, 0o600) } catch { /* Windows ACL is authoritative. */ }
  fs.renameSync(temporary, target)
  return target
}

function readRegistryRecords(env = process.env) {
  const dir = runtimeDir(env)
  let names
  try { names = fs.readdirSync(dir) } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]{8,128}\.json$/.test(name)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.id === name.slice(0, -5)) records.push(parsed)
    } catch { /* A partial or obsolete record is reported only after it parses safely. */ }
  }
  return records
}

function removeRegistryRecord(id, env = process.env) {
  try { fs.unlinkSync(registryPath(id, env)) } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

function canonicalPath(value) {
  if (!value) return null
  let resolved = path.resolve(value)
  try { resolved = fs.realpathSync.native(resolved) } catch { /* The requested data directory may not exist yet. */ }
  return path.normalize(resolved)
}

function normalizePath(value) {
  const resolved = canonicalPath(value)
  return process.platform === 'win32' ? resolved?.toLowerCase() ?? null : resolved
}

function getProcessIdentity(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null
  const numericPid = Number(pid)
  if (process.platform === 'win32') {
    for (const command of [
      `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${numericPid}\" -ErrorAction SilentlyContinue; if($p){$p.CreationDate.ToUniversalTime().Ticks}`,
      `$p=Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue; if($p){$p.StartTime.ToUniversalTime().Ticks}`,
    ]) {
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const created = result.status === 0 ? result.stdout.trim() : ''
      if (/^\d+$/.test(created)) return `${numericPid}:${created}`
    }
    return null
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${numericPid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      return `${numericPid}:${fields[19]}`
    } catch { return null }
  }
  try {
    process.kill(numericPid, 0)
    return numericPid === process.pid
      ? `${numericPid}:${Math.floor(Date.now() - process.uptime() * 1000)}`
      : null
  } catch { return null }
}

function processExists(pid) {
  return getProcessIdentity(Number(pid)) !== null
}

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase()
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLoopbackHost(value, expectedPort) {
  if (!value || /[\s/@]/.test(value)) return false
  try {
    const parsed = new URL(`http://${value}`)
    const port = parsed.port ? Number(parsed.port) : 80
    return isLoopbackAddress(parsed.hostname) && port === expectedPort
  } catch { return false }
}

function isLoopbackUrl(value) {
  if (value == null) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && isLoopbackAddress(parsed.hostname)
  } catch { return false }
}

function constantTimeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest()
  const rightHash = crypto.createHash('sha256').update(String(right)).digest()
  return crypto.timingSafeEqual(leftHash, rightHash)
}

function cleanPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

function publicRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    state: STATES.has(record.state) ? record.state : 'unknown',
    webUrl: isLoopbackUrl(record.webUrl) ? (record.webUrl ?? null) : null,
    apiPort: cleanPort(record.apiPort),
    pid: Number.isInteger(record.pid) ? record.pid : null,
    dataDir: record.dataDir ?? null,
    projectDir: record.projectDir ?? null,
    logPath: record.logPath ?? null,
    managed: true,
    canStop: true,
    error: typeof record.error === 'string' ? record.error : null,
    identity: typeof record.identity === 'string' ? record.identity : null,
  }
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

async function createServiceRuntime(options = {}) {
  const env = options.env ?? process.env
  const id = options.id ?? env.ANIMESHELF_INSTANCE_ID ?? crypto.randomUUID()
  const token = options.token ?? env.ANIMESHELF_CONTROL_TOKEN ?? crypto.randomBytes(32).toString('base64url')
  const identity = options.identity ?? getProcessIdentity(process.pid)
  if (!identity) throw new Error('Unable to determine the AnimeShelf process creation identity')
  const projectDir = canonicalPath(options.projectDir ?? env.ANIMESHELF_PROJECT_DIR ?? process.cwd())
  const dataDir = canonicalPath(options.dataDir ?? env.ANIMESHELF_DATA_DIR ?? path.join(projectDir, 'data'))
  const startedAt = new Date().toISOString()
  let closed = false
  let stopRequested = false
  let record

  const server = http.createServer((req, res) => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host, port)) {
      jsonResponse(res, 403, { error: 'Loopback control only' })
      return
    }
    if (Object.prototype.hasOwnProperty.call(req.headers, 'origin')) {
      jsonResponse(res, 403, { error: 'Browser origins are not accepted' })
      return
    }
    const supplied = req.headers[CONTROL_HEADER]
    if (typeof supplied !== 'string' || !constantTimeEqual(supplied, token)) {
      jsonResponse(res, 401, { error: 'Unauthorized' })
      return
    }
    if (req.method === 'GET' && req.url === '/status') {
      jsonResponse(res, 200, publicRecord(record))
      return
    }
    if (req.method === 'POST' && req.url === '/stop') {
      if (!stopRequested) {
        stopRequested = true
        update({ state: 'stopping', error: null })
        setImmediate(() => Promise.resolve(options.onStop?.()).catch(error => {
          fail(error)
        }))
      }
      jsonResponse(res, 202, { status: 'stopping' })
      return
    }
    jsonResponse(res, 404, { error: 'Not found' })
  })

  await new Promise((resolve, reject) => {
    const failed = error => { server.removeListener('listening', ready); reject(error) }
    const ready = () => { server.removeListener('error', failed); resolve() }
    server.once('error', failed)
    server.once('listening', ready)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  const controlPort = typeof address === 'object' && address ? address.port : null
  if (!controlPort) throw new Error('AnimeShelf control listener did not expose a TCP port')

  record = {
    version: 1,
    id,
    kind: options.kind ?? 'standalone',
    state: options.state ?? 'starting',
    pid: process.pid,
    identity,
    parentPid: process.ppid,
    projectDir,
    projectKey: normalizePath(projectDir),
    dataDir,
    dataKey: normalizePath(dataDir),
    webUrl: options.webUrl ?? null,
    apiPort: cleanPort(options.apiPort),
    logPath: options.logPath ? canonicalPath(options.logPath) : null,
    error: options.error ?? null,
    startedAt,
    updatedAt: startedAt,
    control: { host: '127.0.0.1', port: controlPort, token },
  }

  function update(patch = {}) {
    if (closed) return publicRecord(record)
    if (patch.webUrl !== undefined && !isLoopbackUrl(patch.webUrl)) throw new Error('AnimeShelf service URL must use a loopback host')
    const next = { ...record, ...patch, id, pid: process.pid, identity, updatedAt: new Date().toISOString(), control: record.control }
    if (!STATES.has(next.state)) throw new Error(`Invalid AnimeShelf service state: ${next.state}`)
    next.apiPort = cleanPort(next.apiPort)
    record = next
    writeRegistryRecord(record, env)
    return publicRecord(record)
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error)
    return update({ state: 'failed', error: message.slice(0, 2000) })
  }

  async function close({ remove = true } = {}) {
    if (closed) return
    closed = true
    await new Promise(resolve => server.close(() => resolve()))
    if (remove) removeRegistryRecord(id, env)
  }

  try { writeRegistryRecord(record, env) }
  catch (error) {
    await new Promise(resolve => server.close(() => resolve()))
    throw error
  }

  return {
    id,
    identity,
    controlPort,
    update,
    fail,
    close,
    status: () => publicRecord(record),
    registryPath: registryPath(id, env),
  }
}

module.exports = {
  CONTROL_HEADER,
  canonicalPath,
  createServiceRuntime,
  ensureRuntimeDir,
  getProcessIdentity,
  isLoopbackAddress,
  isLoopbackHost,
  isLoopbackUrl,
  normalizePath,
  processExists,
  publicRecord,
  readRegistryRecords,
  registryPath,
  removeRegistryRecord,
  runtimeDir,
  writeRegistryRecord,
}
