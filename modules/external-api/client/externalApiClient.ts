import type {
  ExternalApiConfig,
  ExternalApiStatus,
  ExternalApiTokenCreated,
  ExternalApiTokenInfo,
  ExternalApiTokenInput,
} from '../../../shared/external-api'

type ExternalApiTokenPatch = Partial<Pick<ExternalApiTokenInfo, 'name' | 'role' | 'expires_at'>>

async function ownerRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.delete('Authorization')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-AnimeShelf-Owner', '1')

  const response = await fetch(path, { ...init, method, headers })
  const payload = await response.json().catch(() => null) as { error?: string; code?: string } | T | null
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && payload.error
      ? payload.error
      : `请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return payload as T
}

export function getExternalApiStatus(signal?: AbortSignal): Promise<ExternalApiStatus> {
  return ownerRequest('/api/external-access', { signal })
}

export function updateExternalApiConfig(config: ExternalApiConfig, signal?: AbortSignal): Promise<ExternalApiStatus> {
  return ownerRequest('/api/external-access', { method: 'PUT', body: JSON.stringify(config), signal })
}

export function createExternalApiToken(input: ExternalApiTokenInput, signal?: AbortSignal): Promise<ExternalApiTokenCreated> {
  return ownerRequest('/api/external-access/tokens', { method: 'POST', body: JSON.stringify(input), signal })
}

export function updateExternalApiToken(id: string, patch: ExternalApiTokenPatch, signal?: AbortSignal): Promise<ExternalApiTokenInfo> {
  return ownerRequest(`/api/external-access/tokens/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch), signal })
}

export function revokeExternalApiToken(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return ownerRequest(`/api/external-access/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
}
