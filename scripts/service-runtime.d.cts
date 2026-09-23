export interface ServiceStatus {
  id: string
  kind: string
  state: 'running' | 'starting' | 'stopping' | 'failed' | 'unknown'
  webUrl: string | null
  apiPort: number | null
  pid: number | null
  dataDir: string | null
  projectDir: string | null
  logPath: string | null
  managed: boolean
  canStop: boolean
  error: string | null
  identity: string | null
}

export interface ServiceRuntime {
  id: string
  identity: string
  controlPort: number
  update(patch: Partial<ServiceStatus>): ServiceStatus
  fail(error: unknown): ServiceStatus
  close(options?: { remove?: boolean }): Promise<void>
  status(): ServiceStatus
  registryPath: string
}

export function createServiceRuntime(options?: {
  id?: string
  token?: string
  identity?: string
  env?: NodeJS.ProcessEnv
  kind?: string
  state?: ServiceStatus['state']
  projectDir?: string
  dataDir?: string
  webUrl?: string | null
  apiPort?: number | null
  logPath?: string | null
  error?: string | null
  onStop?: () => void | Promise<void>
}): Promise<ServiceRuntime>
