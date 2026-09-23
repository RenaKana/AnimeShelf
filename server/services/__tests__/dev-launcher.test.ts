import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

async function loadLauncher(): Promise<any> {
  return import(pathToFileURL(path.resolve('scripts/dev-launcher.mjs')).href)
}

describe('AnimeShelf launcher health check', () => {
  it.each([
    ['HTML 200', new Response('<html>frontend only</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['HTTP 500', new Response(JSON.stringify({ ok: true, instanceId: 'backend-1', restartSupported: true }), { status: 500, headers: { 'content-type': 'application/json' } })],
    ['invalid JSON', new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['not ok', new Response(JSON.stringify({ ok: false, instanceId: 'backend-1', restartSupported: true }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['missing identity', new Response(JSON.stringify({ ok: true, restartSupported: true }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['invalid restart support', new Response(JSON.stringify({ ok: true, instanceId: 'backend-1', restartSupported: 'yes' }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['extra fields', new Response(JSON.stringify({ ok: true, instanceId: 'backend-1', restartSupported: true, extra: true }), { status: 200, headers: { 'content-type': 'application/json' } })],
  ])('rejects %s as not ready', async (_label, response) => {
    const { checkFrontendHealth } = await loadLauncher()
    const fetchImpl = vi.fn(async () => response.clone())

    await expect(checkFrontendHealth('http://127.0.0.1:5173', { fetchImpl })).resolves.toBe(false)
  })

  it('accepts only exact typed 2xx JSON health through the configured frontend port', async () => {
    const { checkFrontendHealth } = await loadLauncher()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, instanceId: 'backend-1', restartSupported: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(checkFrontendHealth('http://127.0.0.1:4321', { fetchImpl })).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4321/api/health', expect.objectContaining({
      redirect: 'error',
      headers: { Accept: 'application/json' },
    }))
  })

  it('accepts exact legacy health while an older backend is already running', async () => {
    const { checkFrontendHealth } = await loadLauncher()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(checkFrontendHealth('http://127.0.0.1:4321', { fetchImpl })).resolves.toBe(true)
  })
})

describe('development API readiness', () => {
  it('waits through connection failures and restarting responses until the API is healthy', async () => {
    const { waitForBackend } = await loadLauncher()
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, instanceId: 'ready', restartSupported: true })))
    await expect(waitForBackend('http://127.0.0.1:3002', { fetchImpl, intervalMs: 1 })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls.every(([url]) => url === 'http://127.0.0.1:3002/api/health')).toBe(true)
  })

  it('fails with an actionable error when the readiness deadline expires', async () => {
    const { waitForBackend } = await loadLauncher()
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }))
    await expect(waitForBackend('http://127.0.0.1:3002', { fetchImpl, timeoutMs: 30, intervalMs: 5 }))
      .rejects.toThrow(/3002.*30ms/)
  })

  it('cancels an in-flight readiness probe when startup is stopped', async () => {
    const { waitForBackend } = await loadLauncher()
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    }))
    const waiting = waitForBackend('http://127.0.0.1:3002', { fetchImpl, signal: controller.signal })
    const cancelled = expect(waiting).rejects.toThrow('Startup cancelled')
    controller.abort(new Error('Startup cancelled'))
    await cancelled
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('AnimeShelf launcher port selection', () => {
  it('keeps configured ports when both are available', async () => {
    const { selectDevPorts } = await loadLauncher()
    const probePort = vi.fn(async (port: number) => port)

    await expect(selectDevPorts({
      ANIMESHELF_DEV_API_PORT: '3102',
      ANIMESHELF_DEV_CLIENT_PORT: '4173',
    }, { strictPorts: true, probePort })).resolves.toEqual({ apiPort: 3102, clientPort: 4173 })
    expect(probePort.mock.calls.map(call => call[0])).toEqual([3102, 4173])
  })

  it('fails actionably on a launcher port conflict without selecting a random pair', async () => {
    const { selectDevPorts } = await loadLauncher()
    const probePort = vi.fn(async (port: number) => port === 5173 ? null : port)

    await expect(selectDevPorts({}, { strictPorts: true, probePort })).rejects.toThrow(/5173.*占用.*ANIMESHELF_DEV_CLIENT_PORT/)
    expect(probePort.mock.calls.map(call => call[0])).toEqual([3002, 5173])
    expect(probePort).not.toHaveBeenCalledWith(0)
  })

  it('preserves normal development fallback behavior outside strict launcher mode', async () => {
    const { selectDevPorts } = await loadLauncher()
    const probePort = vi.fn(async (port: number) => port === 5173 ? null : port === 0 ? 62000 : port)

    await expect(selectDevPorts({}, { strictPorts: false, probePort })).resolves.toEqual({ apiPort: 3002, clientPort: 62000 })
    expect(probePort.mock.calls.map(call => call[0])).toEqual([3002, 5173, 0])
  })
})

describe('Windows AnimeShelf launcher script', () => {
  it('delegates to the repository service manager GUI and preserves explicit force identity', () => {
    const batch = readFileSync('启动AnimeShelf.bat', 'utf8')
    const launcher = readFileSync('scripts/launcher.ps1', 'utf8')

    expect(batch).toContain('%~dp0scripts\\launcher.ps1')
    expect(batch).toContain('-WindowStyle Hidden')
    expect(launcher).toContain("'service-manager.mjs'")
    expect(launcher).toContain("@('list', '--project'")
    expect(launcher).toContain("@('start', '--project'")
    expect(launcher).toContain("@('stop', '--id'")
    expect(launcher).toContain("@('force', '--id', $instanceId, '--identity', $identity")
    expect(launcher).toContain('ANIMESHELF_NODE')
    expect(launcher).not.toMatch(/taskkill[^\r\n]*\/IM\s+node/i)
  })
})
