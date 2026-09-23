import { AxiosHeaders } from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { ProviderRateLimitError, ProviderRateLimitGate } from '../provider-rate-limit'

type ResponseLike = { status?: number; headers?: unknown; data?: unknown; body?: { cancel(): Promise<void> } | null }

const BASE_NOW = 1_700_000_000_000

function response(status: number, headers: unknown = {}, data?: unknown): ResponseLike {
  return { status, headers, data }
}

function jsonResponse(data: unknown, status: number, headers: unknown): Pick<Response, 'json' | 'status' | 'headers'> {
  return {
    status,
    headers: headers as Headers,
    json: vi.fn(async () => data),
  }
}

async function rateLimitError(operation: Promise<unknown>): Promise<ProviderRateLimitError> {
  const error = await operation.catch(value => value)
  expect(error).toBeInstanceOf(ProviderRateLimitError)
  return error as ProviderRateLimitError
}

describe('ProviderRateLimitGate', () => {
  it('shares a fetch 429 cooldown and releases the unread response body', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    const cancel = vi.fn(async () => {})
    const request = vi.fn(async () => ({
      status: 429,
      headers: new Headers({ 'Retry-After': '5' }),
      body: { cancel },
    }))

    const error = await rateLimitError(gate.request('tmdb', undefined, request))
    expect(error).toMatchObject({
      provider: 'tmdb',
      code: 'SOURCE_RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 5,
      response: { status: 429, headers: { 'retry-after': '5' } },
    })
    expect(request).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()

    const blocked = vi.fn(async () => response(200))
    const blockedError = await rateLimitError(gate.request('tmdb', undefined, blocked))
    expect(blockedError.retryAfterSeconds).toBe(5)
    expect(blocked).not.toHaveBeenCalled()
    now += 5000
    await expect(gate.request('tmdb', undefined, blocked)).resolves.toEqual(response(200))
    expect(blocked).toHaveBeenCalledOnce()
  })

  it('blocks concurrent callers after a 429 before body cleanup resolves', async () => {
    const gate = new ProviderRateLimitGate(() => BASE_NOW)
    let releaseCancel!: () => void
    const cancelFinished = new Promise<void>(resolve => { releaseCancel = resolve })
    const cancel = vi.fn(() => cancelFinished)
    const first = gate.request('tmdb', undefined, async () => ({
      status: 429,
      headers: new Headers({ 'Retry-After': '6' }),
      body: { cancel },
    }))

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    const second = vi.fn(async () => response(200))
    const secondError = await rateLimitError(gate.request('tmdb', undefined, second))
    expect(secondError).toMatchObject({ provider: 'tmdb', code: 'SOURCE_RATE_LIMITED', status: 429, retryAfterSeconds: 6 })
    expect(second).not.toHaveBeenCalled()

    releaseCancel()
    const firstError = await rateLimitError(first)
    expect(firstError).toMatchObject({ provider: 'tmdb', code: 'SOURCE_RATE_LIMITED', status: 429, retryAfterSeconds: 6 })
  })

  it('does not wait or queue a call during cooldown and allows the exact expiry', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    await rateLimitError(gate.request('tmdb', undefined, async () => response(429, { 'retry-after': '2' })))

    const retry = vi.fn(async () => response(200))
    now += 1999
    const almostExpired = await rateLimitError(gate.request('tmdb', undefined, retry))
    expect(almostExpired.retryAfterSeconds).toBe(1)
    expect(retry).not.toHaveBeenCalled()

    now += 1
    await expect(gate.request('tmdb', undefined, retry)).resolves.toEqual(response(200))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('isolates cooldowns by provider', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    await rateLimitError(gate.request('anilist', undefined, async () => response(429, { 'retry-after': '30' })))

    const tmdb = vi.fn(async () => response(200, {}, { provider: 'tmdb' }))
    await expect(gate.request('tmdb', undefined, tmdb)).resolves.toMatchObject({ data: { provider: 'tmdb' } })
    expect(tmdb).toHaveBeenCalledOnce()

    const anilist = vi.fn(async () => response(200))
    await expect(gate.request('anilist', undefined, anilist)).rejects.toMatchObject({ provider: 'anilist' })
    expect(anilist).not.toHaveBeenCalled()
  })

  it('parses Headers, AxiosHeaders, and plain objects through readJson', async () => {
    const headerSets: Array<[string, unknown]> = [
      ['Headers', new Headers({ 'x-ratelimit-remaining': '0', 'retry-after': '4' })],
      ['AxiosHeaders', new AxiosHeaders({ 'x-ratelimit-remaining': '0', 'retry-after': '4' })],
      ['plain object', { 'X-RateLimit-Remaining': '0', 'Retry-After': '4' }],
    ]
    for (const [label, headers] of headerSets) {
      let now = BASE_NOW
      const gate = new ProviderRateLimitGate(() => now)
      const data = { label, ok: true }
      await expect(gate.readJson('tmdb', jsonResponse(data, 200, headers))).resolves.toEqual(data)

      const blocked = vi.fn(async () => response(200))
      await expect(gate.request('tmdb', undefined, blocked)).rejects.toMatchObject({ retryAfterSeconds: 4 })
      expect(blocked).not.toHaveBeenCalled()
      now += 4000
      await expect(gate.request('tmdb', undefined, blocked)).resolves.toEqual(response(200))
    }
  })

  it('uses an HTTP-date Retry-After relative to the provider Date header', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    const date = new Date(now).toUTCString()
    const retryAt = new Date(now + 12_000).toUTCString()

    const error = await rateLimitError(gate.request('tmdb', undefined, async () => response(429, new Headers({
      Date: date,
      'Retry-After': retryAt,
    }))))
    expect(error.retryAfterSeconds).toBe(12)
  })

  it('honors a long epoch X-RateLimit-Reset without retrying early', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    const resetAt = Math.floor(now / 1000) + 3600
    await rateLimitError(gate.request('tmdb', undefined, async () => response(429, {
      'X-RateLimit-Reset': String(resetAt),
    })))

    const retry = vi.fn(async () => response(200))
    now += 3_599_000
    const stillLimited = await rateLimitError(gate.request('tmdb', undefined, retry))
    expect(stillLimited.retryAfterSeconds).toBe(1)
    expect(retry).not.toHaveBeenCalled()

    now += 1000
    await expect(gate.request('tmdb', undefined, retry)).resolves.toEqual(response(200))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('falls back to 60 seconds for missing or malformed limit headers', async () => {
    const headerSets: Array<[string, unknown]> = [
      ['missing headers', {}],
      ['invalid Retry-After', { 'Retry-After': 'later' }],
      ['invalid X-RateLimit-Reset', { 'X-RateLimit-Reset': 'not-an-epoch' }],
    ]
    for (const [label, headers] of headerSets) {
      const gate = new ProviderRateLimitGate(() => BASE_NOW)
      const error = await rateLimitError(gate.request('tmdb', undefined, async () => response(429, headers)))
      expect(error.retryAfterSeconds, label).toBe(60)
    }
  })

  it('registers a cooldown from a successful response whose remaining quota is zero', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    const first = response(200, new Headers({
      'X-RateLimit-Remaining': '0',
      'Retry-After': '3',
    }), { accepted: true })
    await expect(gate.request('tmdb', undefined, async () => first)).resolves.toBe(first)

    const blocked = vi.fn(async () => response(200))
    await expect(gate.request('tmdb', undefined, blocked)).rejects.toMatchObject({ retryAfterSeconds: 3 })
    expect(blocked).not.toHaveBeenCalled()
    now += 3000
    await expect(gate.request('tmdb', undefined, blocked)).resolves.toEqual(response(200))
  })

  it('registers AniList GraphQL errors with status 429 even when HTTP status is 200', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    const error = await rateLimitError(gate.readJson('anilist', jsonResponse({
      errors: [{ status: 429, message: 'upstream detail' }],
    }, 200, new Headers({ 'Retry-After': '9' }))))
    expect(error).toMatchObject({ provider: 'anilist', retryAfterSeconds: 9 })
    expect(error.message).not.toContain('upstream detail')

    const blocked = vi.fn(async () => response(200))
    await expect(gate.request('anilist', undefined, blocked)).rejects.toMatchObject({ retryAfterSeconds: 9 })
    expect(blocked).not.toHaveBeenCalled()
  })

  it('does not invoke a request for an already-aborted signal', async () => {
    const gate = new ProviderRateLimitGate(() => BASE_NOW)
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn(async () => response(200))

    await expect(gate.request('tmdb', controller.signal, request)).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps an active cooldown when an older in-flight request succeeds late', async () => {
    let now = BASE_NOW
    const gate = new ProviderRateLimitGate(() => now)
    let resolveLate!: (value: ResponseLike) => void
    const lateResult = new Promise<ResponseLike>(resolve => { resolveLate = resolve })
    const late = gate.request('tmdb', undefined, async () => lateResult)
    await rateLimitError(gate.request('tmdb', undefined, async () => response(429, { 'retry-after': '20' })))

    resolveLate(response(200))
    await expect(late).resolves.toEqual(response(200))
    const blocked = vi.fn(async () => response(200))
    await expect(gate.request('tmdb', undefined, blocked)).rejects.toMatchObject({ retryAfterSeconds: 20 })
    expect(blocked).not.toHaveBeenCalled()
  })

  it('converts an Axios-style rejected 429 into a safe error without upstream request details', async () => {
    const gate = new ProviderRateLimitGate(() => BASE_NOW)
    const upstream = {
      response: {
        status: 429,
        headers: new AxiosHeaders({ 'Retry-After': '7' }),
      },
      config: {
        url: 'https://user:password@example.invalid/private?token=secret',
        headers: { Authorization: 'Bearer secret' },
      },
    }

    const error = await rateLimitError(gate.request('tmdb', undefined, async () => { throw upstream }))
    expect(error).toMatchObject({ provider: 'tmdb', code: 'SOURCE_RATE_LIMITED', status: 429, retryAfterSeconds: 7 })
    expect(error.response).toEqual({ status: 429, headers: { 'retry-after': '7' } })
    expect(JSON.stringify(error)).not.toContain('example.invalid')
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(error.message).not.toContain('example.invalid')
  })

  it('clears provider cooldowns only when reset is explicitly called', async () => {
    const gate = new ProviderRateLimitGate(() => BASE_NOW)
    await rateLimitError(gate.request('tmdb', undefined, async () => response(429, { 'retry-after': '60' })))
    gate.reset()

    const request = vi.fn(async () => response(200, {}, { reset: true }))
    await expect(gate.request('tmdb', undefined, request)).resolves.toMatchObject({ data: { reset: true } })
    expect(request).toHaveBeenCalledOnce()
  })
})
