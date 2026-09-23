import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_API_PORT = 3002
const DEFAULT_CLIENT_PORT = 5173

export function probePort(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const selected = typeof address === 'object' && address ? address.port : null
      server.close(() => resolve(selected))
    })
  })
}

export async function checkFrontendHealth(origin, {
  fetchImpl = fetch,
  timeoutMs = 2_000,
  signal,
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(new URL('/api/health', origin).href, {
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    })
    if (!response.ok) return false

    const payload = JSON.parse(await response.text())
    return payload !== null
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && payload.ok === true
      && (Object.keys(payload).length === 1 || (
        Object.keys(payload).length === 3
        && typeof payload.instanceId === 'string'
        && payload.instanceId.length > 0
        && typeof payload.restartSupported === 'boolean'
      ))
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function waitForBackend(origin, {
  fetchImpl = fetch,
  timeoutMs = 30_000,
  intervalMs = 100,
  signal,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const ready = await checkFrontendHealth(origin, {
      fetchImpl,
      timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now())),
      signal,
    })
    signal?.throwIfAborted()
    if (ready) return
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(intervalMs, remaining), undefined, { signal })
  }
  throw new Error(`Backend at ${origin} did not become ready within ${timeoutMs}ms. Check the backend startup errors above.`)
}

function parsePort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

async function selectPort({ envName, defaultPort, env, strictPorts, probePortImpl, excluded }) {
  const rawValue = env[envName] ?? defaultPort
  const configured = parsePort(rawValue)

  if (strictPorts && configured === null) {
    throw new Error(`${envName} 必须是 1 到 65535 之间的整数，当前值为 ${String(rawValue)}`)
  }

  if (configured !== null && !excluded.has(configured)) {
    const available = await probePortImpl(configured)
    if (available !== null) return available
    if (strictPorts) {
      throw new Error(`端口 ${configured} 已被占用。请关闭占用进程，或设置 ${envName} 为其他可用端口。`)
    }
  } else if (strictPorts) {
    throw new Error(`端口 ${configured} 与另一个开发服务冲突。请设置 ${envName} 为其他可用端口。`)
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const fallback = await probePortImpl(0)
    if (fallback !== null && !excluded.has(fallback)) return fallback
  }
  throw new Error('无法为开发服务分配可用端口')
}

export async function selectDevPorts(env = process.env, {
  strictPorts = false,
  probePort: probePortImpl = probePort,
} = {}) {
  const apiPort = await selectPort({
    envName: 'ANIMESHELF_DEV_API_PORT',
    defaultPort: DEFAULT_API_PORT,
    env,
    strictPorts,
    probePortImpl,
    excluded: new Set(),
  })
  const clientPort = await selectPort({
    envName: 'ANIMESHELF_DEV_CLIENT_PORT',
    defaultPort: DEFAULT_CLIENT_PORT,
    env,
    strictPorts,
    probePortImpl,
    excluded: new Set([apiPort]),
  })
  return { apiPort, clientPort }
}

async function runCli() {
  const healthIndex = process.argv.indexOf('--check-health')
  if (healthIndex !== -1) {
    const origin = process.argv[healthIndex + 1]
    if (!origin) {
      console.error('--check-health 需要传入前端地址')
      process.exitCode = 1
      return
    }
    process.exitCode = await checkFrontendHealth(origin) ? 0 : 1
    return
  }

  if (process.argv.includes('--check-ports')) {
    try {
      await selectDevPorts(process.env, {
        strictPorts: process.argv.includes('--strict-ports'),
      })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }

  console.error('请使用 --check-health <地址> 或 --check-ports')
  process.exitCode = 1
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) await runCli()
