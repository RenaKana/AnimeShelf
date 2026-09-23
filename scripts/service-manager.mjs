import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const runtime = require('./service-runtime.cjs')
const windows = require('./windows-processes.cjs')

function valueAfter(args, name, required = false) {
  const index = args.indexOf(name)
  const value = index === -1 ? null : args[index + 1]
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} is required`)
  return value
}

function samePath(left, right) {
  return runtime.normalizePath(left) === runtime.normalizePath(right)
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

function safeControl(record) {
  const control = record?.control
  const port = validPort(control?.port)
  return control?.host === '127.0.0.1' && port && typeof control.token === 'string' && control.token.length >= 32
    ? { port, token: control.token }
    : null
}

export function requestControl(record, method, route, { timeoutMs = 1500 } = {}) {
  const control = safeControl(record)
  if (!control) return Promise.reject(new Error('Managed control endpoint is unavailable'))
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: control.port,
      path: route,
      method,
      headers: {
        Host: `127.0.0.1:${control.port}`,
        Accept: 'application/json',
        [runtime.CONTROL_HEADER]: control.token,
      },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size <= 64 * 1024) chunks.push(chunk)
        else request.destroy(new Error('Control response is too large'))
      })
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if ((response.statusCode ?? 500) >= 400) throw new Error(payload?.error || `Control request failed (${response.statusCode})`)
          resolve(payload)
        } catch (error) { reject(error) }
      })
    })
    request.once('timeout', () => request.destroy(new Error('Control request timed out')))
    request.once('error', reject)
    request.end()
  })
}

// A failed identity query can mean access denied. Only ESRCH proves absence.
function processPresence(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null
  try { process.kill(Number(pid), 0); return true }
  catch (error) { return error?.code === 'ESRCH' ? false : null }
}

function processEvidence(record, getIdentity, getPresence) {
  const pid = Number(record?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return 'unverified'
  const actual = getIdentity(pid)
  const expected = typeof record.identity === 'string' && record.identity ? record.identity : null
  if (actual && expected) return actual === expected ? 'alive' : 'reused'
  if (!actual && getPresence(pid) === false) return 'exited'
  return 'unverified'
}

function unknownManaged(record, message, processState = 'unverified') {
  const recentReservation = record.state === 'starting'
    && !record.pid
    && Number.isFinite(Date.parse(record.startedAt))
    && Date.now() - Date.parse(record.startedAt) < 30_000
  return {
    ...runtime.publicRecord(record),
    state: record.state === 'failed' ? 'failed' : (recentReservation ? 'starting' : 'unknown'),
    webUrl: null,
    apiPort: null,
    processState,
    identityVerified: processState === 'alive',
    canStop: false,
    canForce: processState === 'alive',
    canRemove: processState === 'exited' || processState === 'reused',
    error: record.state === 'failed' && record.error ? String(record.error) : message,
  }
}

export async function validateManagedRecord(record, {
  getIdentity = runtime.getProcessIdentity,
  getPresence = processPresence,
  controlRequest = requestControl,
} = {}) {
  const pid = Number(record?.pid)
  const expectedIdentity = typeof record?.identity === 'string' ? record.identity : null
  const processState = processEvidence(record, getIdentity, getPresence)
  if (processState !== 'alive') {
    const message = processState === 'reused' ? 'Process identity changed'
      : processState === 'exited' ? '实例进程已退出；可以移除记录，日志会保留。'
        : '无法核实进程身份，请刷新或检查进程查询权限。'
    return unknownManaged(record, message, processState)
  }
  if (!safeControl(record)) return unknownManaged(record, 'Managed control endpoint is not ready', processState)
  let status
  try { status = await controlRequest(record, 'GET', '/status') }
  catch (error) { return unknownManaged(record, error instanceof Error ? error.message : String(error), processState) }
  if (status?.id !== record.id || status?.pid !== pid || status?.identity !== expectedIdentity) {
    return unknownManaged(record, 'Authenticated control identity did not match the registry', processState)
  }
  if (!runtime.isLoopbackUrl(status.webUrl)) return unknownManaged(record, 'Managed service reported a non-loopback URL', processState)
  return {
    ...runtime.publicRecord({ ...record, ...status }),
    managed: true,
    canStop: true,
    processState,
    identityVerified: true,
    canForce: status.state === 'failed',
    canRemove: false,
  }
}

function processMap(snapshot) {
  return new Map(snapshot.processes.map(item => [Number(item.pid), item]))
}

function hasAncestor(pid, ancestorPid, byPid) {
  const seen = new Set()
  let current = byPid.get(Number(pid))
  while (current && !seen.has(current.pid)) {
    if (Number(current.pid) === Number(ancestorPid)) return true
    seen.add(current.pid)
    current = byPid.get(Number(current.parentPid))
  }
  return false
}

function legacyKind(info, projectKey) {
  const command = String(info.commandLine || '').replaceAll('/', '\\').toLowerCase()
  const executable = String(info.executablePath || '').replaceAll('/', '\\').toLowerCase()
  const project = String(projectKey || '').replaceAll('/', '\\').toLowerCase()
  const name = String(info.name || '').toLowerCase()
  if (name === 'animeshelf.exe') return 'electron'
  if (!project || (!command.includes(project) && !executable.startsWith(`${project}\\`) && executable !== project)) return null
  if (command.includes(`${project}\\scripts\\dev.mjs`)) return 'dev'
  if (!command.includes('dev-server-worker.mjs') && (
    command.includes(`${project}\\dist-electron\\server.cjs`)
    || command.includes(`${project}\\server\\index.ts`)
  )) return 'standalone'
  if (name === 'electron.exe' && executable.includes(`${project}\\node_modules\\electron\\`)) return 'electron'
  return null
}

function extractDataDir(commandLine) {
  const match = String(commandLine || '').match(/(?:--data-dir(?:=|\s+)|ANIMESHELF_DATA_DIR=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i)
  return match ? path.resolve(match[1] || match[2] || match[3]) : null
}

async function probeHealth(port, { timeoutMs = 500 } = {}) {
  if (!validPort(port)) return false
  return new Promise(resolve => {
    const request = http.get({
      host: '127.0.0.1', port, path: '/api/health',
      headers: { Host: `127.0.0.1:${port}`, Accept: 'application/json' },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(response.statusCode === 200 && payload?.ok === true)
        } catch { resolve(false) }
      })
    })
    request.once('timeout', () => { request.destroy(); resolve(false) })
    request.once('error', () => resolve(false))
  })
}

export async function discoverLegacyInstances(projectDir, snapshot = windows.snapshotWindowsProcesses()) {
  const projectKey = runtime.normalizePath(projectDir)
  const byPid = processMap(snapshot)
  const roots = snapshot.processes
    .map(info => ({ info, kind: legacyKind(info, projectKey) }))
    .filter(item => item.kind)
  const instances = []
  for (const { info, kind } of roots) {
    const listeners = snapshot.listeners.filter(listener => runtime.isLoopbackAddress(listener.address)
      && hasAncestor(listener.pid, info.pid, byPid))
    const healthy = []
    for (const listener of listeners) {
      if (await probeHealth(listener.port)) healthy.push(listener)
    }
    const descendantInfo = healthy.map(listener => ({ listener, process: byPid.get(Number(listener.pid)) }))
    const frontend = descendantInfo.find(item => /(?:^|[\\/])vite(?:\.js)?(?:\s|$)/i.test(item.process?.commandLine || ''))
    const backend = descendantInfo.find(item => item !== frontend) ?? descendantInfo[0]
    const apiPort = backend?.listener.port ?? null
    const webPort = frontend?.listener.port ?? (kind === 'standalone' || kind === 'electron' ? apiPort : null)
    const identity = String(info.identity || '') || runtime.getProcessIdentity(Number(info.pid))
    const digest = crypto.createHash('sha256').update(identity || String(info.pid)).digest('hex').slice(0, 12)
    instances.push({
      id: `legacy-${info.pid}-${digest}`,
      kind,
      state: healthy.length ? 'running' : 'unknown',
      webUrl: webPort ? `http://127.0.0.1:${webPort}` : null,
      apiPort,
      pid: Number(info.pid),
      dataDir: extractDataDir(info.commandLine),
      projectDir: runtime.canonicalPath(projectDir),
      logPath: null,
      managed: false,
      canStop: kind === 'electron',
      processState: identity ? 'alive' : 'unverified',
      identityVerified: Boolean(identity),
      canForce: Boolean(identity) && kind !== 'electron',
      canRemove: false,
      error: healthy.length ? null : 'Legacy process has no authenticated control channel',
      identity,
    })
  }
  return instances
}

export async function listInstances(projectDir, {
  records = runtime.readRegistryRecords(),
  snapshot,
  getIdentity,
  getPresence,
  controlRequest,
} = {}) {
  const managed = []
  for (const record of records) managed.push(await validateManagedRecord(record, { getIdentity, getPresence, controlRequest }))
  const processSnapshot = snapshot ?? (process.platform === 'win32'
    ? windows.snapshotWindowsProcesses()
    : { processes: [], listeners: [], ancestryAvailable: false })
  let discovered = []
  try { discovered = await discoverLegacyInstances(projectDir, processSnapshot) } catch { /* Registry results remain useful without CIM access. */ }
  const liveManagedRoots = managed.filter(item => item.identityVerified).map(item => item.pid)
  const byPid = processMap(processSnapshot)
  const legacy = discovered.filter(item => !liveManagedRoots.some(pid => hasAncestor(item.pid, pid, byPid)))
  return { instances: [...managed, ...legacy] }
}

async function withDataLock(dataDir, task, { env = process.env, timeoutMs = 10_000 } = {}) {
  const dir = runtime.ensureRuntimeDir(env)
  const key = crypto.createHash('sha256').update(runtime.normalizePath(dataDir)).digest('hex')
  const lockPath = path.join(dir, `start-${key}.lock`)
  const deadline = Date.now() + timeoutMs
  const ownerIdentity = runtime.getProcessIdentity(process.pid)
  if (!ownerIdentity) throw new Error('Unable to determine start-lock owner identity')
  const ownerToken = crypto.randomBytes(16).toString('hex')
  const owner = JSON.stringify({ pid: process.pid, identity: ownerIdentity, token: ownerToken })
  let handle
  while (!handle) {
    let candidate
    try {
      candidate = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(candidate, owner, 'utf8')
      fs.fsyncSync(candidate)
      handle = candidate
    }
    catch (error) {
      if (candidate !== undefined) {
        try { fs.closeSync(candidate) } catch {}
        try { fs.unlinkSync(lockPath) } catch {}
      }
      if (!error || error.code !== 'EEXIST') throw error
      try {
        const observed = fs.readFileSync(lockPath, 'utf8')
        const lockOwner = JSON.parse(observed)
        const liveIdentity = runtime.getProcessIdentity(Number(lockOwner.pid))
        if (typeof lockOwner.identity === 'string' && liveIdentity !== lockOwner.identity
          && (liveIdentity || processPresence(lockOwner.pid) === false)
          && fs.readFileSync(lockPath, 'utf8') === observed) {
          fs.unlinkSync(lockPath)
          continue
        }
      } catch { /* An unreadable lock cannot be declared stale safely. */ }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for another AnimeShelf start request')
      await delay(100)
    }
  }
  try { return await task() }
  finally {
    fs.closeSync(handle)
    try {
      if (fs.readFileSync(lockPath, 'utf8') === owner) fs.unlinkSync(lockPath)
    } catch { /* A completed lock does not affect service truth. */ }
  }
}

function createStartReservation({ id, token, projectDir, dataDir, logPath, env }) {
  const now = new Date().toISOString()
  return runtime.writeRegistryRecord({
    version: 1,
    id,
    kind: 'dev',
    state: 'starting',
    pid: null,
    identity: null,
    parentPid: process.pid,
    projectDir: path.resolve(projectDir),
    projectKey: runtime.normalizePath(projectDir),
    dataDir: path.resolve(dataDir),
    dataKey: runtime.normalizePath(dataDir),
    webUrl: null,
    apiPort: null,
    logPath,
    error: null,
    startedAt: now,
    updatedAt: now,
    control: { host: '127.0.0.1', port: null, token },
  }, env)
}

export async function startInstance(projectDir, dataDir, {
  env = process.env,
  list = listInstances,
  spawnImpl = spawn,
} = {}) {
  const project = runtime.canonicalPath(projectDir)
  const data = runtime.canonicalPath(dataDir)
  return withDataLock(data, async () => {
    const current = await list(project)
    const sameData = current.instances.find(item => item.dataDir && samePath(item.dataDir, data)
      && (['running', 'starting', 'stopping'].includes(item.state)
        || (item.managed && item.processState === 'unverified')
        || (item.managed && ['failed', 'unknown'].includes(item.state)
          && item.pid && runtime.getProcessIdentity(item.pid) === item.identity)))
    if (sameData) return { instanceId: sameData.id, existing: true }
    const unknownLegacy = current.instances.find(item => !item.managed && !item.dataDir
      && item.pid && runtime.getProcessIdentity(item.pid) === item.identity)
    if (unknownLegacy) {
      throw new Error(`AnimeShelf ${unknownLegacy.kind} process ${unknownLegacy.pid} is already running with an unknown data directory`)
    }

    const entry = path.join(project, 'scripts', 'dev.mjs')
    if (!fs.existsSync(entry)) throw new Error(`AnimeShelf development launcher was not found: ${entry}`)
    const id = crypto.randomUUID()
    const token = crypto.randomBytes(32).toString('base64url')
    const logsDir = path.join(runtime.ensureRuntimeDir(env), 'logs')
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 })
    const logPath = path.join(logsDir, `${id}.log`)
    createStartReservation({ id, token, projectDir: project, dataDir: data, logPath, env })
    let logFd
    let child
    try {
      logFd = fs.openSync(logPath, 'a', 0o600)
      child = spawnImpl(process.execPath, [entry, '--managed-service'], {
        cwd: project,
        env: {
          ...env,
          ANIMESHELF_RUNTIME_DIR: runtime.runtimeDir(env),
          ANIMESHELF_INSTANCE_ID: id,
          ANIMESHELF_CONTROL_TOKEN: token,
          ANIMESHELF_PROJECT_DIR: project,
          ANIMESHELF_DATA_DIR: data,
          ANIMESHELF_SERVICE_LOG: logPath,
        },
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
      })
    } catch (error) {
      const reserved = runtime.readRegistryRecords(env).find(item => item.id === id)
      if (reserved) runtime.writeRegistryRecord({
        ...reserved,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }, env)
      throw error
    } finally { if (logFd !== undefined) fs.closeSync(logFd) }
    child.unref()

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const record = runtime.readRegistryRecords(env).find(item => item.id === id)
      if (record?.control?.port || record?.state === 'failed') break
      if (!runtime.processExists(child.pid)) {
        const failed = { ...record, state: 'failed', error: 'AnimeShelf development process exited during startup', updatedAt: new Date().toISOString() }
        runtime.writeRegistryRecord(failed, env)
        break
      }
      await delay(50)
    }
    return { instanceId: id, existing: false }
  }, { env })
}

function recordForId(id, env = process.env) {
  return runtime.readRegistryRecords(env).find(item => item.id === id) ?? null
}

export async function archiveInstance(id, {
  env = process.env,
  getIdentity = runtime.getProcessIdentity,
  getPresence = processPresence,
} = {}) {
  const source = runtime.registryPath(id, env)
  const observed = fs.readFileSync(source, 'utf8')
  const record = JSON.parse(observed)
  if (record.id !== id) throw new Error('Instance registration identity changed')
  const evidence = processEvidence(record, getIdentity, getPresence)
  if (evidence !== 'exited' && evidence !== 'reused') {
    throw new Error('实例仍在运行或无法核实是否退出，不能移除记录。')
  }
  const archiveDir = path.join(runtime.ensureRuntimeDir(env), 'archive')
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  const archivePath = path.join(archiveDir, `${id}-${crypto.randomUUID()}.json`)
  if (fs.readFileSync(source, 'utf8') !== observed) throw new Error('Instance registration changed before archive')
  fs.renameSync(source, archivePath)
  return { status: 'archived', archivePath, logPath: record.logPath ?? null }
}

export async function stopInstance(id, projectDir, {
  env = process.env,
  getIdentity = runtime.getProcessIdentity,
  getPresence = processPresence,
  controlRequest = requestControl,
  timeoutMs = 30_000,
  pollMs = 250,
} = {}) {
  const record = recordForId(id, env)
  if (record) {
    const validated = await validateManagedRecord(record, { getIdentity, getPresence, controlRequest })
    if (validated.canRemove) return { status: 'exited', canRemove: true }
    if (!validated.canStop) throw new Error(validated.error || 'Managed service identity could not be validated')
    const response = await controlRequest(record, 'POST', '/stop')
    if (response?.status !== 'stopping') throw new Error('Managed service did not acknowledge graceful shutdown')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await delay(pollMs)
      const current = recordForId(id, env)
      const evidence = processEvidence(record, getIdentity, getPresence)
      if (evidence === 'exited' || evidence === 'reused') return { status: 'stopped' }
      if (current?.state === 'failed') return {
        status: 'failed',
        requiresForce: true,
        error: current.error || 'Graceful shutdown failed while the process remained alive',
      }
    }
    return {
      status: 'stopping',
      requiresForce: true,
      error: 'Graceful shutdown did not finish within 30 seconds',
    }
  }

  const legacy = (await discoverLegacyInstances(projectDir)).find(item => item.id === id)
  if (!legacy) throw new Error(`AnimeShelf instance was not found: ${id}`)
  if (runtime.getProcessIdentity(legacy.pid) !== legacy.identity) throw new Error('Legacy process identity changed')
  if (legacy.kind !== 'electron') return { status: 'requiresForce' }
  return { status: windows.closeMainWindow(legacy.pid) ? 'stopping' : 'requiresForce' }
}

function descendants(rootPid, snapshot) {
  const byPid = processMap(snapshot)
  const selected = snapshot.processes.filter(item => hasAncestor(item.pid, rootPid, byPid))
  const depth = item => {
    let value = 0
    let current = item
    const seen = new Set()
    while (current && current.pid !== rootPid && !seen.has(current.pid)) {
      seen.add(current.pid); value++; current = byPid.get(Number(current.parentPid))
    }
    return value
  }
  return selected.sort((left, right) => depth(right) - depth(left))
}

function forceOrder(targets, rootPid) {
  const watchers = targets.filter(item => Number(item.pid) !== Number(rootPid)
    && /(?:^|[\\/])dev-server\.mjs(?:\s|$|\")/i.test(String(item.commandLine || '')))
  const watcherPids = new Set(watchers.map(item => Number(item.pid)))
  const workers = targets.filter(item => Number(item.pid) !== Number(rootPid) && !watcherPids.has(Number(item.pid)))
  const root = targets.find(item => Number(item.pid) === Number(rootPid))
  return [...watchers, ...workers, ...(root ? [root] : [])]
}

export async function forceInstance(id, expectedIdentity, projectDir, {
  env = process.env,
  snapshotProcesses = windows.snapshotWindowsProcesses,
  stopProcess = windows.stopExactProcess,
  getIdentity = runtime.getProcessIdentity,
} = {}) {
  const record = recordForId(id, env)
  let pid
  let identity
  if (record) {
    pid = Number(record.pid); identity = record.identity
  } else {
    const legacy = (await discoverLegacyInstances(projectDir)).find(item => item.id === id)
    if (!legacy) throw new Error(`AnimeShelf instance was not found: ${id}`)
    pid = legacy.pid; identity = legacy.identity
  }
  if (!expectedIdentity || identity !== expectedIdentity) throw new Error('Explicit process identity does not match the selected instance')
  if (getIdentity(pid) !== expectedIdentity) throw new Error('Process creation identity changed before force stop')

  if (process.platform !== 'win32') {
    if (!stopProcess(pid)) throw new Error(`Unable to stop process ${pid}`)
    return { status: 'stopped' }
  }
  const original = snapshotProcesses()
  if (record?.kind === 'dev' && original.ancestryAvailable === false) {
    throw new Error('Windows process ancestry is unavailable; refusing to force stop a partial development group')
  }
  const targets = descendants(pid, original)
  const originalByPid = processMap(original)
  const root = originalByPid.get(pid)
  if (!root || root.identity !== expectedIdentity) throw new Error('Process creation identity changed before group discovery')
  const preflight = snapshotProcesses()
  const preflightByPid = processMap(preflight)
  for (const target of targets) {
    const current = preflightByPid.get(Number(target.pid))
    if (!current) continue
    if (current.identity !== target.identity || !hasAncestor(current.pid, pid, preflightByPid)) {
      throw new Error(`Process ${target.pid} changed identity or ancestry before force stop`)
    }
  }
  for (const target of forceOrder(targets, pid)) {
    const fresh = snapshotProcesses()
    const freshByPid = processMap(fresh)
    const current = freshByPid.get(Number(target.pid))
    if (!current) continue
    // Parent processes may already have been stopped by this exact operation.
    // The same creation identity plus unchanged parent id preserves the
    // preflight ancestry proof without trusting a reused PID.
    if (current.identity !== target.identity || Number(current.parentPid) !== Number(target.parentPid)) {
      throw new Error(`Process ${target.pid} changed identity or ancestry before force stop`)
    }
    if (!stopProcess(current.pid)) throw new Error(`Unable to stop process ${current.pid}`)
  }
  return { status: 'stopped' }
}

async function runCli(args = process.argv.slice(2)) {
  const command = args[0]
  const project = valueAfter(args, '--project', true)
  if (command === 'list') return listInstances(project)
  if (command === 'start') return startInstance(project, valueAfter(args, '--data-dir', true))
  if (command === 'stop') return stopInstance(valueAfter(args, '--id', true), project)
  if (command === 'force') return forceInstance(valueAfter(args, '--id', true), valueAfter(args, '--identity', true), project)
  if (command === 'archive') return archiveInstance(valueAfter(args, '--id', true))
  throw new Error('Usage: service-manager.mjs <list|start|stop|force|archive> --project <root>')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  try { process.stdout.write(`${JSON.stringify(await runCli())}\n`) }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`)
    process.exitCode = 1
  }
}
