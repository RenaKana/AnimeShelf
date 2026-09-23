export type MetadataProvider = 'anilist' | 'tmdb'

type ProviderResponse = { status?: number; headers?: unknown; data?: unknown; body?: { cancel(): Promise<void> } | null }
const FALLBACK_COOLDOWN_MS = 60_000
const providerNames: Record<MetadataProvider, string> = { anilist: 'AniList', tmdb: 'TMDB' }

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const getter = (headers as { get?: (name: string) => unknown }).get
  const value = typeof getter === 'function'
    ? getter.call(headers, name)
    : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' || typeof first === 'number' ? String(first).trim() : undefined
}

function numericHeader(headers: unknown, name: string): number | undefined {
  const value = headerValue(headers, name)
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function cooldownUntil(headers: unknown, now: number): number {
  const serverDate = Date.parse(headerValue(headers, 'date') ?? '')
  const clock = Number.isFinite(serverDate) ? serverDate : now
  const retryAfter = headerValue(headers, 'retry-after')
  const seconds = numericHeader(headers, 'retry-after')
  const retryDate = seconds === undefined && retryAfter && !/^[+-]?\d/.test(retryAfter) ? Date.parse(retryAfter) : NaN
  const resetSeconds = numericHeader(headers, 'x-ratelimit-reset')
  const waits = [
    seconds === undefined ? NaN : seconds * 1000,
    Number.isFinite(retryDate) ? Number(retryDate) - clock : NaN,
    resetSeconds === undefined ? NaN : resetSeconds * 1000 - clock,
  ].filter(wait => Number.isFinite(wait) && wait >= 0)
  // Headerless/malformed limits are a local policy, not a claimed provider quota.
  const wait = waits.length ? Math.max(1000, ...waits) : FALLBACK_COOLDOWN_MS
  return Math.min(Number.MAX_SAFE_INTEGER, now + wait)
}

export class ProviderRateLimitError extends Error {
  readonly code = 'SOURCE_RATE_LIMITED'
  readonly status = 429
  readonly retryAfterSeconds: number
  readonly response: { status: 429; headers: { 'retry-after': string } }

  constructor(readonly provider: MetadataProvider, until: number, now: number) {
    const seconds = Math.max(1, Math.ceil((until - now) / 1000))
    super(`${providerNames[provider]} 请求过于频繁，请在 ${seconds} 秒后重试`)
    this.name = 'ProviderRateLimitError'
    this.retryAfterSeconds = seconds
    // Never retain the upstream error, URL, request config, body or credentials.
    this.response = { status: 429, headers: { 'retry-after': String(seconds) } }
  }
}

export function isProviderRateLimitError(error: unknown): error is ProviderRateLimitError {
  return error instanceof ProviderRateLimitError
}

/** Process-local cooldown shared across API entry points and transport choices. */
export class ProviderRateLimitGate {
  private readonly cooldowns = new Map<MetadataProvider, number>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  reset(): void { this.cooldowns.clear() }

  private check(provider: MetadataProvider, response: ProviderResponse): void {
    const errors = (response.data as { errors?: Array<{ status?: unknown }> } | undefined)?.errors
    const limited = response.status === 429 || (provider === 'anilist' && Array.isArray(errors) && errors.some(error => Number(error?.status) === 429))
    if (!limited && numericHeader(response.headers, 'x-ratelimit-remaining') !== 0) return
    const now = this.now()
    const until = Math.max(this.cooldowns.get(provider) ?? 0, cooldownUntil(response.headers, now))
    this.cooldowns.set(provider, until)
    if (limited) throw new ProviderRateLimitError(provider, until, now)
  }

  async request<T>(provider: MetadataProvider, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    const now = this.now()
    const until = this.cooldowns.get(provider) ?? 0
    if (until > now) throw new ProviderRateLimitError(provider, until, now)
    try {
      const result = await request()
      const response = result as ProviderResponse | undefined
      if (response) {
        try { this.check(provider, response) } catch (error) {
          // Register the cooldown before awaiting cleanup so concurrent callers
          // cannot slip through while an unread fetch body is being released.
          try { await response.body?.cancel() } catch { /* keep the rate-limit result */ }
          throw error
        }
      }
      return result
    } catch (error) {
      if (isProviderRateLimitError(error)) throw error
      const response = (error as { response?: ProviderResponse } | undefined)?.response
      if (response) this.check(provider, response)
      throw error
    }
  }

  async readJson(provider: MetadataProvider, response: Pick<Response, 'json' | 'status' | 'headers'>): Promise<any> {
    const data = await response.json()
    // AniList can report status 429 in GraphQL errors even with HTTP 200.
    this.check(provider, { status: response.status, headers: response.headers, data })
    return data
  }
}

export const providerRateLimitGate = new ProviderRateLimitGate()
export const providerRequest = <T>(provider: MetadataProvider, signal: AbortSignal | undefined, request: () => Promise<T>) => providerRateLimitGate.request(provider, signal, request)
export const readProviderJson = (provider: MetadataProvider, response: Pick<Response, 'json' | 'status' | 'headers'>) => providerRateLimitGate.readJson(provider, response)
