type ServiceState = 'running' | 'starting' | 'stopping' | 'failed' | 'unknown'
type ProcessState = 'alive' | 'exited' | 'reused' | 'unverified'

type ControlRecord = {
  host: string
  port: number | null
  token: string
}

type ServiceRecord = {
  id: string
  kind?: string
  state?: string
  pid?: number | null
  identity?: string | null
  parentPid?: number | null
  projectDir?: string | null
  projectKey?: string | null
  dataDir?: string | null
  dataKey?: string | null
  webUrl?: string | null
  apiPort?: number | null
  logPath?: string | null
  error?: string | null
  startedAt?: string
  updatedAt?: string
  control?: ControlRecord | null
  [key: string]: unknown
}

type ServiceInstance = {
  id: string
  kind?: string
  state: ServiceState
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
  processState: ProcessState
  identityVerified: boolean
  canForce: boolean
  canRemove: boolean
}

type ControlResponse = {
  id?: string
  pid?: number | null
  identity?: string | null
  state?: ServiceState
  webUrl?: string | null
  apiPort?: number | null
  status?: string
  [key: string]: unknown
}

type ProcessInfo = {
  pid: number
  parentPid?: number | null
  identity?: string | null
  commandLine?: string
  executablePath?: string
  name?: string
  [key: string]: unknown
}

type ProcessListener = {
  pid: number
  port: number
  address?: string
  [key: string]: unknown
}

type ProcessSnapshot = {
  processes: ProcessInfo[]
  listeners: ProcessListener[]
  ancestryAvailable?: boolean
}

type GetIdentity = (pid: number) => string | null
type GetPresence = (pid: number) => boolean | null
type ControlRequest = (record: ServiceRecord, method: string, route: string) => ControlResponse | Promise<ControlResponse>

type ValidationOptions = {
  getIdentity?: GetIdentity
  getPresence?: GetPresence
  controlRequest?: ControlRequest
}

type ListOptions = ValidationOptions & {
  records?: ServiceRecord[]
  snapshot?: ProcessSnapshot
}

type StartResult = {
  instanceId: string
  existing: boolean
}

type StartOptions = {
  env?: NodeJS.ProcessEnv
  list?: (projectDir: string) => Promise<{ instances: ServiceInstance[] }>
  spawnImpl?: (file: string, args: readonly string[], options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    detached?: boolean
    windowsHide?: boolean
    stdio?: unknown
  }) => { pid?: number; unref(): void }
}

type ArchiveResult = {
  status: 'archived'
  archivePath: string
  logPath: string | null
}

type ArchiveOptions = {
  env?: NodeJS.ProcessEnv
  getIdentity?: GetIdentity
  getPresence?: GetPresence
}

type StopResult =
  | { status: 'exited'; canRemove: true }
  | { status: 'stopped' }
  | { status: 'failed'; requiresForce: true; error: string }
  | { status: 'stopping'; requiresForce?: true; error?: string }
  | { status: 'requiresForce' }

type StopOptions = ValidationOptions & {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  pollMs?: number
}

type ForceOptions = {
  env?: NodeJS.ProcessEnv
  snapshotProcesses?: () => ProcessSnapshot
  stopProcess?: (pid: number) => boolean
  getIdentity?: GetIdentity
}

export function requestControl(record: ServiceRecord, method: string, route: string, options?: { timeoutMs?: number }): Promise<ControlResponse>
export function validateManagedRecord(record: ServiceRecord, options?: ValidationOptions): Promise<ServiceInstance>
export function discoverLegacyInstances(projectDir: string, snapshot?: ProcessSnapshot): Promise<ServiceInstance[]>
export function listInstances(projectDir: string, options?: ListOptions): Promise<{ instances: ServiceInstance[] }>
export function startInstance(projectDir: string, dataDir: string, options?: StartOptions): Promise<StartResult>
export function archiveInstance(id: string, options?: ArchiveOptions): Promise<ArchiveResult>
export function stopInstance(id: string, projectDir: string, options?: StopOptions): Promise<StopResult>
export function forceInstance(id: string, expectedIdentity: string, projectDir: string, options?: ForceOptions): Promise<{ status: 'stopped' }>
