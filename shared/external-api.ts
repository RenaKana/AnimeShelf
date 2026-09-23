/** Shared contract for the local owner UI and the separately authenticated API. */
export type ExternalApiRole = 'files' | 'edit' | 'read' | 'disabled'

export interface ExternalApiTokenInfo {
  id: string
  name: string
  prefix: string
  role: ExternalApiRole
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
}

export interface ExternalApiConfig {
  enabled: boolean
  port: number
}

export interface ExternalApiStatus extends ExternalApiConfig {
  status: 'running' | 'stopped' | 'error'
  base_url: string
  error: string | null
  tokens: ExternalApiTokenInfo[]
}

export interface ExternalApiTokenInput {
  name: string
  role?: ExternalApiRole
  expires_at?: string | null
}

export interface ExternalApiTokenCreated {
  token: string
  token_info: ExternalApiTokenInfo
}
