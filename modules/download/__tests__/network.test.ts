import { EventEmitter } from 'node:events'
import https from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPublicAddress, pinnedAgent, resolvePublic, sendPinned } from '../server/network'
import { createTransport } from '../server/transport'

afterEach(() => vi.restoreAllMocks())
describe('pinned download connections', () => {
  it('rejects private, mapped, multicast, documentation and reserved address ranges', () => {
    for (const address of ['0.0.0.0', '10.3.2.1', '100.64.0.1', '127.0.0.2', '169.254.169.254', '172.31.4.1',
      '192.0.0.1', '192.0.2.2', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1', '2002:0808:0808::1', '3fff::1']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })
  it('uses the resolved IP without a new DNS lookup, with original-hostname TLS validation and actual-peer checks', () => {
    const signal = new AbortController()
    const socket = Object.assign(new EventEmitter(), { remoteAddress: '8.8.8.8', authorized: true,
      setTimeout: vi.fn(), destroy: vi.fn() })
    const connect = vi.fn(() => socket)
    const agent = pinnedAgent('acg.rip', { address: '8.8.8.8', family: 4 }, signal.signal, connect as never)
    const callback = vi.fn()
    agent.createConnection({}, callback)
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: '8.8.8.8', port: 443,
      servername: 'acg.rip', rejectUnauthorized: true, checkServerIdentity: expect.any(Function) }))
    expect(callback).not.toHaveBeenCalled()
    socket.emit('secureConnect')
    expect(callback).toHaveBeenCalledWith(null, socket)
    signal.abort()
    expect(socket.destroy).toHaveBeenCalled()
    agent.destroy()
  })
  it.each([['127.0.0.1', true], ['1.1.1.1', true], ['8.8.8.8', false]])('rejects actual peer %s, authorized=%s', (remoteAddress, authorized) => {
    const socket = Object.assign(new EventEmitter(), { remoteAddress, authorized, setTimeout: vi.fn(), destroy: vi.fn() })
    const agent = pinnedAgent('acg.rip', { address: '8.8.8.8', family: 4 }, new AbortController().signal, (() => socket) as never)
    const callback = vi.fn()
    agent.createConnection({}, callback)
    socket.emit('secureConnect')
    expect(callback.mock.calls[0][0]).toMatchObject({ code: 'unsafe_target' })
    expect(socket.destroy).toHaveBeenCalled()
    agent.destroy()
  })
  it('fails a DNS rebinding attempt on an otherwise valid same-origin redirect', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const send = vi.fn().mockResolvedValue({ status: 302, body: '', location: '/1' })
    const transport = createTransport({ proxy: () => null, resolve: (host, signal) => resolvePublic(host, signal, lookup), send })
    await expect(transport({ source: 'acgrip', url: 'https://acg.rip/1', baseUrl: 'https://acg.rip/', method: 'GET' }, new AbortController().signal)).rejects.toMatchObject({ code: 'unsafe_target' })
    expect(send).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledTimes(2)
  })
  it.each([{'content-length': '2097153'}, {'content-encoding': 'gzip'}, {}])('bounds native response headers and streamed bytes: %j', async headers => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers })
    const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn(), destroy: vi.fn() })
    request.destroy.mockImplementation(error => request.emit('error', error))
    vi.spyOn(https, 'request').mockImplementation(((url: URL, options: unknown, ready: (response: unknown) => void) => {
      queueMicrotask(() => {
        ready(response)
        if (!Object.keys(headers).length) response.emit('data', Buffer.alloc(2097153))
      })
      return request
    }) as never)
    await expect(sendPinned(new URL('https://acg.rip/1'), { source: 'acgrip', baseUrl: 'https://acg.rip/', url: 'https://acg.rip/1', method: 'GET' }, { address: '8.8.8.8', family: 4 }, new AbortController().signal)).rejects.toThrow()
    expect(request.destroy).toHaveBeenCalled()
    const options = vi.mocked(https.request).mock.calls[0][1] as any
    expect(options.maxHeaderSize).toBe(16384)
    expect(options.headers).not.toHaveProperty('Cookie')
    expect(options.headers).not.toHaveProperty('Authorization')
  })
})
