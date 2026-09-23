import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const { waitReady } = require('../../../electron/backend-ready.cjs') as { waitReady: (port: number, timeoutMs?: number, signal?: AbortSignal) => Promise<boolean> }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('desktop module host startup', () => {
  it('bounds a health probe even when the backend accepts but never responds', async () => {
    const server = createServer(() => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const started = Date.now()
      expect(await waitReady(port, 100)).toBe(false)
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it.each(['bundle', 'readiness', 'quit-during-readiness'])('handles %s without opening a broken window', async kind => {
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve })
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>()
    const app = { whenReady: () => Promise.resolve(), on: vi.fn((event: string, handler: (event: { preventDefault: () => void }) => void) => listeners.set(event, handler)), quit: vi.fn(() => finished()), getPath: () => 'D:/fake/app.exe', isPackaged: false }
    const BrowserWindow = vi.fn()
    const showErrorBox = vi.fn()
    const backend = { shutdownServer: vi.fn(async () => {}), startServiceRegistration: vi.fn(async () => {}), updateServiceRegistration: vi.fn() }
    const mocks: Record<string, unknown> = {
      electron: { app, BrowserWindow, Menu: {}, dialog: { showErrorBox }, shell: { openExternal: vi.fn() } },
      fs: {},
      path: require('node:path'),
      net: { createServer: () => ({ once: vi.fn(), listen(_port: number, _host: string, callback: () => void) { callback() }, address: () => ({ port: 9999 }), close(callback: () => void) { callback() } }) },
      './backend-ready.cjs': { waitReady: async () => {
        if (kind === 'quit-during-readiness') listeners.get('before-quit')?.({ preventDefault: vi.fn() })
        return false
      } },
      './external-links.cjs': { installExternalLinks: vi.fn() },
    }
    vm.runInNewContext(readFileSync(resolve('electron/main.cjs'), 'utf8'), {
      require: (name: string) => {
        if (name.endsWith('server.cjs')) {
          if (kind === 'bundle') throw new Error('test bundle failed')
          return backend
        }
        return mocks[name]
      },
      __dirname: resolve('electron'),
      process: { env: {}, cwd: () => 'D:/fake/project' },
      console: { error: vi.fn() },
      setTimeout,
      AbortController,
    })
    await done
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(BrowserWindow).not.toHaveBeenCalled()
    if (kind === 'quit-during-readiness') expect(showErrorBox).not.toHaveBeenCalled()
    else expect(showErrorBox).toHaveBeenCalledWith('AnimeShelf 启动失败', expect.any(String))
    expect(app.quit).toHaveBeenCalledOnce()
  })
})

describe('direct web host signals', () => {
  function loadHost({ startup = Promise.resolve(), env = {}, registrationFactory }: {
    startup?: Promise<void>
    env?: Record<string, string>
    registrationFactory?: (registration: any) => Promise<any>
  } = {}) {
    const processMock = Object.assign(new EventEmitter(), { env, versions: {}, exitCode: 0, cwd: () => 'D:/fake/project' })
    const exports: Record<string, () => Promise<void>> = {}
    const createApplication = vi.fn()
    const start = vi.fn(() => startup)
    const shutdown = vi.fn(async () => {})
    const registration = { update: vi.fn(), fail: vi.fn(), close: vi.fn(async () => {}), status: vi.fn(() => ({ webUrl: null })) }
    const createServiceRuntime = vi.fn(() => registrationFactory?.(registration) ?? Promise.resolve(registration))
    let hostOptions!: { createApplication: unknown; port: number; host: string }
    const source = ts.transpileModule(readFileSync(resolve('server/index.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    vm.runInNewContext(source, {
      exports,
      require: (name: string) => name === './application'
        ? { createApplication }
        : name === 'path'
          ? { default: require('node:path') }
          : name.endsWith('service-runtime.cjs')
            ? { default: { createServiceRuntime } }
            : { createServiceHost: (options: typeof hostOptions) => { hostOptions = options; return { start, shutdown } } },
      process: processMock,
      console: { log: vi.fn(), error: vi.fn() },
    })
    return { processMock, exports, createApplication, start, shutdown, registration, createServiceRuntime, get hostOptions() { return hostOptions } }
  }

  it('passes the configured endpoint and restart-capable application factory to the managed host', async () => {
    const loaded = loadHost({ env: { PORT: '0', LISTEN_HOST: '127.0.0.1' } })
    await vi.waitFor(() => expect(loaded.start).toHaveBeenCalledOnce())
    expect(loaded.start).toHaveBeenCalledOnce()
    expect(loaded.hostOptions).toMatchObject({ createApplication: loaded.createApplication, port: 0, host: '127.0.0.1' })
  })

  it('defaults the direct web host to loopback', async () => {
    const loaded = loadHost({ env: { PORT: '0' } })
    await vi.waitFor(() => expect(loaded.start).toHaveBeenCalledOnce())
    expect(loaded.hostOptions.host).toBe('127.0.0.1')
  })

  it('shuts down without waiting for pending startup to settle', async () => {
    const { processMock, exports, shutdown } = loadHost({ startup: new Promise<void>(() => {}) })
    processMock.emit('SIGTERM')
    await exports.shutdownServer()
    expect(shutdown).toHaveBeenCalledOnce()
    expect(processMock.exitCode).toBe(0)
  })

  it('waits for an in-flight service registration before shutdown completes', async () => {
    let publish!: (value: any) => void
    const pending = new Promise(resolve => { publish = resolve })
    const loaded = loadHost({ registrationFactory: () => pending })
    await Promise.resolve()
    loaded.processMock.emit('SIGTERM')
    let stopped = false
    const shutdown = loaded.exports.shutdownServer().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    publish(loaded.registration)
    await shutdown
    expect(loaded.registration.close).toHaveBeenCalledOnce()
  })

  it('closes the managed host once for repeated signals', async () => {
    const { processMock, exports, shutdown } = loadHost()
    processMock.emit('SIGINT')
    processMock.emit('SIGTERM')
    await exports.shutdownServer()
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
