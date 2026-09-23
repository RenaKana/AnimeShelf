export interface WindowsProcessInfo {
  pid: number
  parentPid: number
  identity: string
  name: string
  executablePath: string
  commandLine: string
}

export interface WindowsListenerInfo { pid: number; address: string; port: number }

export function snapshotWindowsProcesses(): {
  processes: WindowsProcessInfo[]
  listeners: WindowsListenerInfo[]
  ancestryAvailable?: boolean
}
export function closeMainWindow(pid: number): boolean
export function stopExactProcess(pid: number): boolean
