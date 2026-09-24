import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestLocalHttp } from '../../services/__tests__/http-test-client'

const routeMocks = vi.hoisted(() => ({ openRemoteMedia: vi.fn() }))

vi.mock('../../services/remote-media', () => ({
  openRemoteMedia: routeMocks.openRemoteMedia,
  RemoteMediaError: class RemoteMediaError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
      super(message)
      this.name = 'RemoteMediaError'
    }
  },
}))

describe('remote media request origin checks', () => {
  let server: any

  beforeAll(async () => {
    const { createRemoteMediaRouter } = await import('../remote-media')
    const app = express()
    app.use('/api/remote-media', createRemoteMediaRouter())
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  beforeEach(() => {
    routeMocks.openRemoteMedia.mockReset()
    routeMocks.openRemoteMedia.mockResolvedValue({
      status: 200,
      contentType: 'image/png',
      contentLength: 3,
      maxBytes: 32,
      dispose: vi.fn(),
    })
  })

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(resolve))
  })

  it('rejects a cross-site image request without an Origin header', async () => {
    const response = await requestLocalHttp(server, '/api/remote-media?url=https%3A%2F%2Fimages.example.org%2Fposter.png', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'ORIGIN_FORBIDDEN' })
    expect(routeMocks.openRemoteMedia).not.toHaveBeenCalled()
  })

  it('rejects a nonlocal Referer even when Origin is absent', async () => {
    const response = await requestLocalHttp(server, '/api/remote-media?url=https%3A%2F%2Fimages.example.org%2Fposter.png', {
      headers: { referer: 'https://attacker.example.org/page' },
    })

    expect(response.status).toBe(403)
    expect(response.headers['content-type']).toMatch(/application\/json/)
    expect(routeMocks.openRemoteMedia).not.toHaveBeenCalled()
  })

  it('allows a same-origin browser media request', async () => {
    const response = await requestLocalHttp(server, '/api/remote-media?url=https%3A%2F%2Fimages.example.org%2Fposter.png', {
      method: 'HEAD',
      headers: {
        origin: 'http://127.0.0.1',
        referer: 'http://127.0.0.1/app',
        'sec-fetch-site': 'same-origin',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('image/png')
    expect(routeMocks.openRemoteMedia).toHaveBeenCalledWith(
      'https://images.example.org/poster.png',
      expect.objectContaining({ method: 'HEAD' }),
      expect.any(AbortSignal),
    )
  })
})
