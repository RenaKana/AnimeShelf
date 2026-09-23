import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RequestListener, Server } from 'node:http'
import { createServiceHost, type HostedApplication } from '../../core/service-host'
import { requestLocalHttp } from './http-test-client'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

function fakeServer(autoListen = true) {
  const raw = Object.assign(new EventEmitter(), {
    listening: false,
    address: () => ({ port: 43210 }),
    closeAllConnections: vi.fn(),
  }) as EventEmitter & { listening: boolean; address: () => { port: number }; closeAllConnections: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  let bind = () => {}
  raw.listen = vi.fn(() => {
    bind = () => { raw.listening = true; raw.emit('listening') }
    if (autoListen) queueMicrotask(bind)
    return raw
  })
  raw.close = vi.fn((callback: () => void) => {
    raw.listening = false
    queueMicrotask(callback)
    return raw
  })
  return { raw, server: raw as unknown as Server, bind: () => bind() }
}

function application(instanceId: string, dispose: () => Promise<void> = async () => {}): HostedApplication {
  const app: RequestListener = (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, instanceId }))
  }
  return { app, stop: vi.fn(async () => {}), dispose: vi.fn(dispose) }
}

describe('service host lifecycle', () => {
  it('keeps one listener and serves 503 until the old application fully disposes', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const applications = [application('before', () => blocked), application('after')]
    const factory = vi.fn(async () => applications.shift()!)
    const host = createServiceHost({ createApplication: factory, port: 0, host: '127.0.0.1' })
    cleanup.push(() => host.shutdown())
    await host.start()
    const port = (host.server.address() as { port: number }).port
    expect(await (await requestLocalHttp(host.server, '/api/health')).json()).toMatchObject({ instanceId: 'before' })

    const firstRestart = host.restart()
    const secondRestart = host.restart()
    expect(secondRestart).toBe(firstRestart)
    await Promise.resolve()
    expect((await requestLocalHttp(host.server, '/api/health')).status).toBe(503)
    expect(factory).toHaveBeenCalledOnce()

    release()
    await firstRestart
    expect((host.server.address() as { port: number }).port).toBe(port)
    expect(await (await requestLocalHttp(host.server, '/api/health')).json()).toMatchObject({ instanceId: 'after' })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('lets final shutdown prevent a replacement but waits for blocked disposal', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const first = application('before', () => blocked)
    const factory = vi.fn(async () => first)
    const host = createServiceHost({ createApplication: factory, port: 0, host: '127.0.0.1' })
    await host.start()
    const restart = host.restart()
    await Promise.resolve()
    let shutdownFinished = false
    const shutdown = host.shutdown().then(() => { shutdownFinished = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(shutdownFinished).toBe(false)
    expect(first.stop).toHaveBeenCalledOnce()
    release()
    await shutdown
    await restart
    expect(shutdownFinished).toBe(true)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('closes stalled request sockets after the two-second restart drain deadline', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const first = application('before')
    first.stop = vi.fn(() => blocked)
    const factory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(application('after'))
    const fake = fakeServer()
    fake.raw.closeAllConnections.mockImplementation(release)
    const host = createServiceHost({ createApplication: factory, createServer: () => fake.server, port: 0, host: '127.0.0.1' })
    cleanup.push(() => host.shutdown())
    await host.start()
    const restart = host.restart()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fake.raw.closeAllConnections).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await restart
    expect(fake.raw.closeAllConnections).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('waits for application startup cancellation cleanup before shutdown completes', async () => {
    let signal!: AbortSignal
    let release!: () => void
    const cleanupPending = new Promise<void>(resolve => { release = resolve })
    const factory = vi.fn(({ signal: current }: { signal: AbortSignal }) => {
      signal = current
      return new Promise<HostedApplication>((_resolve, reject) => {
        current.addEventListener('abort', () => {
          void cleanupPending.then(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
        }, { once: true })
      })
    })
    const host = createServiceHost({ createApplication: factory, port: 0, host: '127.0.0.1' })
    const startup = host.start().catch(() => {})
    await Promise.resolve()
    let stopped = false
    const shutdown = host.shutdown().then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(signal.aborted).toBe(true)
    expect(stopped).toBe(false)
    release()
    await shutdown
    await startup
  })

  it('disposes an application that finishes creation after shutdown begins', async () => {
    let resolveCreation!: (value: HostedApplication) => void
    let releaseDisposal!: () => void
    const late = application('late', () => new Promise<void>(resolve => { releaseDisposal = resolve }))
    const factory = vi.fn(() => new Promise<HostedApplication>(resolve => { resolveCreation = resolve }))
    const host = createServiceHost({ createApplication: factory, port: 0, host: '127.0.0.1' })
    const startup = host.start()
    await Promise.resolve()

    let stopped = false
    const shutdown = host.shutdown().then(() => { stopped = true })
    resolveCreation(late)
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce())
    expect(late.stop).toHaveBeenCalledOnce()
    expect(stopped).toBe(false)

    releaseDisposal()
    await shutdown
    await startup
    expect(stopped).toBe(true)
  })

  it('closes a listener that finishes binding after shutdown begins', async () => {
    const fake = fakeServer(false)
    const host = createServiceHost({
      createApplication: async () => application('before'),
      createServer: () => fake.server,
      port: 0,
      host: 'delayed.test',
    })
    expect(host.server).toBe(fake.server)
    const startup = host.start()
    while (!fake.raw.listen.mock.calls.length) await Promise.resolve()
    let stopped = false
    const shutdown = host.shutdown().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    fake.bind()
    await startup
    await shutdown
    expect(fake.raw.close).toHaveBeenCalledOnce()
    expect(fake.raw.listening).toBe(false)
  })

  it('waits for cleanup when shutdown lands between replacement creation and activation', async () => {
    let resolveCreation!: (value: HostedApplication) => void
    let releaseCleanup!: () => void
    const replacement = application('after')
    replacement.stop = vi.fn(() => new Promise<void>(resolve => { releaseCleanup = resolve }))
    const factory = vi.fn().mockResolvedValueOnce(application('before'))
      .mockImplementationOnce(() => new Promise<HostedApplication>(resolve => { resolveCreation = resolve }))
    const host = createServiceHost({ createApplication: factory, port: 0, host: '127.0.0.1' })
    await host.start()
    const restarting = host.restart()
    await new Promise(resolve => setImmediate(resolve))
    let finished = false
    let shutdown!: Promise<void>
    resolveCreation(replacement)
    queueMicrotask(() => { shutdown = host.shutdown().then(() => { finished = true }) })
    await new Promise(resolve => setImmediate(resolve))
    expect(replacement.stop).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    releaseCleanup()
    await shutdown
    await restarting
    expect(host.server.listening).toBe(false)
  })

  it('releases the listener and reports a terminal failure when replacement startup fails', async () => {
    const failure = new Error('replacement database could not open')
    const onRestartFailure = vi.fn()
    const factory = vi.fn().mockResolvedValueOnce(application('before')).mockRejectedValueOnce(failure)
    const host = createServiceHost({ createApplication: factory, onRestartFailure, port: 0, host: '127.0.0.1' })
    cleanup.push(() => host.shutdown())
    await host.start()
    await expect(host.restart()).rejects.toBe(failure)
    expect(host.server.listening).toBe(false)
    expect(onRestartFailure).toHaveBeenCalledWith(failure)
    await host.restart()
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
