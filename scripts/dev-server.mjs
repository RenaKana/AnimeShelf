import { spawn } from 'node:child_process'
import { context } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { generateModules, watchModules } from './modules.mjs'

generateModules()

const outdir = path.join(process.env.ANIMESHELF_DATA_DIR ?? 'data', '.dev')
const outfile = path.resolve(outdir, 'server.cjs')
let serverProcess
let restartQueue = Promise.resolve()
let stopping = false
let stopPromise
let moduleWatcherStopped = false
const configuredBackendShutdownTimeout = Number(process.env.ANIMESHELF_BACKEND_SHUTDOWN_TIMEOUT_MS)
const backendShutdownTimeoutMs = Number.isFinite(configuredBackendShutdownTimeout) && configuredBackendShutdownTimeout > 0
  ? configuredBackendShutdownTimeout : 15_000

fs.mkdirSync(outdir, { recursive: true })

function timeoutLabel(timeoutMs) {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs}ms`
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise(resolve => {
    let timeout
    const exited = () => {
      if (timeout) clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', exited)
    if (timeoutMs !== undefined) timeout = setTimeout(() => {
      child.removeListener('exit', exited)
      resolve(false)
    }, timeoutMs)
  })
}

async function stopServerProcess({ waitAfterTimeout = false, onTimeout } = {}) {
  const child = serverProcess
  if (hasExited(child)) return
  if (child.connected) {
    try { child.send({ type: 'shutdown' }) } catch { /* 已退出则交给后续检查 */ }
  }
  if (!await waitForExit(child, backendShutdownTimeoutMs)) {
    const error = new Error(`Backend did not finish graceful shutdown within ${timeoutLabel(backendShutdownTimeoutMs)}`)
    if (!waitAfterTimeout) throw error
    onTimeout?.(error)
    await waitForExit(child)
  }
  if (child.signalCode) throw new Error(`Backend exited due to signal ${child.signalCode} during shutdown`)
  if (child.exitCode && child.exitCode !== 0) throw new Error(`Backend exited with code ${child.exitCode} during shutdown`)
}

async function restartServer() {
  if (stopping) return

  if (!hasExited(serverProcess)) {
    await stopServerProcess()
  }

  if (stopping) return

  serverProcess = spawn(process.execPath, ['scripts/dev-server-worker.mjs', outfile], {
    // 端口由 dev.mjs 探测后同时传给 Vite 和后端，避免端口占用时两端失联。
    env: {
      ...process.env,
      PORT: process.env.ANIMESHELF_DEV_API_PORT ?? '3002',
      LISTEN_HOST: '127.0.0.1',
      ANIMESHELF_SERVICE_CHILD: '1',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })

  serverProcess.once('exit', (code, signal) => {
    if (stopping || (!signal && (!code || code === 0))) return
    const reason = signal ? `signal ${signal}` : `code ${code}`
    console.error(`Backend exited with ${reason}; waiting for the next file change.`)
    process.send?.({ type: 'startup-failed', error: `后端进程异常退出（${reason}），请查看启动日志。` })
  })
  serverProcess.on('message', message => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'service-status' || message.type === 'shutdown-failed' || message.type === 'startup-failed') process.send?.(message)
  })
}

const restartPlugin = {
  name: 'restart-backend',
  setup(build) {
    build.onStart(() => { generateModules() })
    build.onEnd(result => {
      if (result.errors.length > 0) return
      restartQueue = restartQueue.then(restartServer).catch(error => {
        if (!stopping) console.error(`Backend replacement failed: ${error instanceof Error ? error.message : String(error)}; waiting for the next source change.`)
      })
    })
  },
}

const buildContext = await context({
  entryPoints: [path.resolve('server/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  packages: 'external',
  logLevel: 'info',
  plugins: [restartPlugin],
})

await buildContext.watch()
// Generated registries are already esbuild inputs. Let its dependency watcher
// rebuild them once instead of also scheduling a second manual rebuild.
const stopModuleWatcher = watchModules()
console.log('Watching backend source files...')

function reportShutdownDelay(error) {
  console.error('Backend watcher shutdown delayed:', error)
  process.send?.({ type: 'shutdown-failed', error: error instanceof Error ? error.message : String(error) })
}

function stop() {
  if (stopPromise) return stopPromise
  stopping = true
  const operation = (async () => {
    if (!moduleWatcherStopped) {
      stopModuleWatcher()
      moduleWatcherStopped = true
    }
    let failure
    if (!hasExited(serverProcess)) {
      try { await stopServerProcess({ waitAfterTimeout: true, onTimeout: reportShutdownDelay }) }
      catch (error) { failure = error }
    }
    try { await buildContext.dispose() }
    catch (error) { failure ??= error }
    if (failure) throw failure
  })()
  stopPromise = operation.catch(error => {
    stopPromise = undefined
    throw error
  })
  return stopPromise
}

function stopForExit() {
  void stop().then(() => process.exit(0)).catch(error => {
    console.error('Backend watcher shutdown failed:', error)
    process.send?.({ type: 'shutdown-failed', error: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
}

process.once('disconnect', stopForExit)
process.once('SIGINT', stopForExit)
process.once('SIGTERM', stopForExit)
process.on('message', message => {
  if (message && message.type === 'shutdown') stopForExit()
})
