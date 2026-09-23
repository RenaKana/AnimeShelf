import { spawn } from 'node:child_process'
import path from 'node:path'
import serviceRuntime from './service-runtime.cjs'
import { probePort, selectDevPorts, waitForBackend } from './dev-launcher.mjs'

const { createServiceRuntime } = serviceRuntime
let stopping = false
let stopPromise
let service
const children = []
const startupController = new AbortController()
const configuredChildShutdownTimeout = Number(process.env.ANIMESHELF_DEV_CHILD_SHUTDOWN_TIMEOUT_MS)
const childShutdownTimeoutMs = Number.isFinite(configuredChildShutdownTimeout) && configuredChildShutdownTimeout > 0
  ? configuredChildShutdownTimeout : 25_000

function timeoutLabel(timeoutMs) {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs}ms`
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
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

function reportShutdownDelay(error) {
  console.error(`[launcher] Graceful shutdown delayed: ${error instanceof Error ? error.message : String(error)}`)
  service?.fail(error)
}

async function shutdownChild(entry) {
  const { child, label } = entry
  if (hasExited(child)) return
  if (child.connected) {
    try { child.send({ type: 'shutdown' }) }
    catch (error) { reportShutdownDelay(error) }
  } else {
    reportShutdownDelay(new Error(`${label} has no graceful shutdown channel`))
  }
  if (!await waitForExit(child, childShutdownTimeoutMs)) {
    reportShutdownDelay(new Error(`${label} did not finish graceful shutdown within ${timeoutLabel(childShutdownTimeoutMs)}`))
    await waitForExit(child)
  }
  if (child.signalCode) throw new Error(`${label} exited due to signal ${child.signalCode} during shutdown`)
  if (child.exitCode && child.exitCode !== 0) throw new Error(`${label} exited with code ${child.exitCode} during shutdown`)
}

function stop(exitCode = 0, { preserveRecord = false } = {}) {
  if (stopPromise) return stopPromise
  if (!stopping) {
    stopping = true
    startupController.abort(new Error('AnimeShelf development service is stopping'))
    // A failed launch still needs graceful cleanup. Retain its terminal state
    // and original cause so the manager never interprets cleanup as readiness.
    if (!preserveRecord) service?.update({ state: 'stopping', error: null })
  }

  const operation = (async () => {
    const entries = children.filter(entry => !hasExited(entry.child))
    const results = await Promise.allSettled(entries.map(shutdownChild))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) {
      const error = failures.length === 1 ? failures[0] : new AggregateError(failures, 'Multiple development children failed during shutdown')
      console.error(`[launcher] Graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      service?.fail(error)
      await service?.close({ remove: false })
      process.exit(1)
      return
    }
    await service?.close({ remove: !preserveRecord })
    process.exit(exitCode)
  })()
  stopPromise = operation.catch(error => {
    console.error(`[launcher] Graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    service?.fail(error)
    stopPromise = undefined
  })
  return stopPromise
}

function start(label, args, env) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  })
  children.push({ label, child })

  child.on('message', message => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'service-status') {
      if (stopping) return
      const patch = {}
      if (message.apiPort) patch.apiPort = Number(message.apiPort)
      if (message.clientPort) patch.webUrl = `http://127.0.0.1:${Number(message.clientPort)}`
      if (label === 'client') patch.state = 'running'
      service?.update(patch)
    } else if (message.type === 'startup-failed') {
      if (stopping) return
      const error = new Error(message.error || `${label} startup failed`)
      console.error(`[${label}] ${error.message}`)
      service?.fail(error)
      void stop(1, { preserveRecord: true })
    } else if (message.type === 'shutdown-failed') {
      service?.fail(message.error || `${label} shutdown failed`)
    }
  })
  child.once('error', error => {
    if (stopping) return
    console.error(`[${label}] Failed to start: ${error.message}`)
    service?.fail(error)
    void stop(1, { preserveRecord: true })
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`
    const error = new Error(`${label} exited unexpectedly (${reason})`)
    console.error(`[${label}] ${error.message}`)
    service?.fail(error)
    void stop(code && code > 0 ? code : 1, { preserveRecord: true })
  })
  return child
}

async function main() {
  service = await createServiceRuntime({
    kind: 'dev',
    projectDir: process.env.ANIMESHELF_PROJECT_DIR ?? process.cwd(),
    dataDir: process.env.ANIMESHELF_DATA_DIR ?? path.resolve('data'),
    logPath: process.env.ANIMESHELF_SERVICE_LOG ?? null,
    onStop: () => stop(0),
  })

  const strictPorts = process.argv.includes('--strict-ports')
  let ports
  try {
    ports = await selectDevPorts(process.env, { strictPorts, probePort })
  } catch (error) {
    console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`)
    service.fail(error)
    await service.close({ remove: false })
    process.exitCode = 1
    return
  }

  const { apiPort, clientPort } = ports
  const childEnv = {
    ...process.env,
    ANIMESHELF_DEV_API_PORT: String(apiPort),
    ANIMESHELF_DEV_CLIENT_PORT: String(clientPort),
    ANIMESHELF_SERVICE_CHILD: '1',
  }
  service.update({ apiPort, webUrl: `http://127.0.0.1:${clientPort}` })
  console.log('Starting AnimeShelf development services...')
  console.log(`Development API port: ${apiPort}`)
  process.once('SIGINT', () => { void stop(0) })
  process.once('SIGTERM', () => { void stop(0) })

  start('server', ['scripts/dev-server.mjs'], childEnv)
  try {
    await waitForBackend(`http://127.0.0.1:${apiPort}`, { signal: startupController.signal })
  } catch (error) {
    if (!stopping) {
      console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`)
      service.fail(error)
      await stop(1, { preserveRecord: true })
    }
    return
  }
  if (stopping) return
  service.update({ apiPort })
  start('client', ['scripts/dev-server-worker.mjs', '--vite'], childEnv)
  console.log(`Development URL: http://127.0.0.1:${clientPort}`)
}

try { await main() }
catch (error) {
  console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`)
  if (service) {
    service.fail(error)
    await service.close({ remove: false })
  }
  process.exitCode = 1
}
