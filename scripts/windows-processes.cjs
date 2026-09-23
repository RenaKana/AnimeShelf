const { spawnSync } = require('node:child_process')

function parseJsonOutput(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim()}`)
  const text = result.stdout.trim()
  return text ? JSON.parse(text) : null
}

function snapshotWindowsProcesses() {
  if (process.platform !== 'win32') return { processes: [], listeners: [] }
  const script = [
    "$processes=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; identity=([string]$_.ProcessId)+':'+$_.CreationDate.ToUniversalTime().Ticks; name=[string]$_.Name; executablePath=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine } })",
    "$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid=[int]$_.OwningProcess; address=[string]$_.LocalAddress; port=[int]$_.LocalPort } })",
    "[pscustomobject]@{ processes=$processes; listeners=$listeners } | ConvertTo-Json -Compress -Depth 4",
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const fallbackScript = [
      "$processes=@(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $start=$null; $exe=$null; try{$start=$_.StartTime.ToUniversalTime().Ticks}catch{}; try{$exe=$_.Path}catch{}; [pscustomobject]@{ pid=[int]$_.Id; parentPid=0; identity=if($start){([string]$_.Id)+':'+$start}else{''}; name=[string]$_.Name; executablePath=[string]$exe; commandLine='' } })",
      "$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid=[int]$_.OwningProcess; address=[string]$_.LocalAddress; port=[int]$_.LocalPort } })",
      "[pscustomobject]@{ processes=$processes; listeners=$listeners } | ConvertTo-Json -Compress -Depth 4",
    ].join('; ')
    const fallback = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fallbackScript], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    })
    const parsedFallback = parseJsonOutput(fallback, 'Windows process fallback discovery')
    return {
      processes: Array.isArray(parsedFallback?.processes) ? parsedFallback.processes : (parsedFallback?.processes ? [parsedFallback.processes] : []),
      listeners: Array.isArray(parsedFallback?.listeners) ? parsedFallback.listeners : (parsedFallback?.listeners ? [parsedFallback.listeners] : []),
      ancestryAvailable: false,
    }
  }
  const parsed = parseJsonOutput(result, 'Windows process discovery')
  return {
    processes: Array.isArray(parsed?.processes) ? parsed.processes : (parsed?.processes ? [parsed.processes] : []),
    listeners: Array.isArray(parsed?.listeners) ? parsed.listeners : (parsed?.listeners ? [parsed.listeners] : []),
    ancestryAvailable: true,
  }
}

function closeMainWindow(pid) {
  const numericPid = Number(pid)
  if (process.platform !== 'win32' || !Number.isInteger(numericPid) || numericPid <= 0) return false
  const script = `$p=Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue; if($p -and $p.CloseMainWindow()){exit 0}; exit 1`
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  }).status === 0
}

function stopExactProcess(pid) {
  const numericPid = Number(pid)
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false
  if (process.platform === 'win32') {
    const script = `Stop-Process -Id ${numericPid} -Force -ErrorAction Stop`
    return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    }).status === 0
  }
  try { process.kill(numericPid, 'SIGKILL'); return true } catch { return false }
}

module.exports = { closeMainWindow, snapshotWindowsProcesses, stopExactProcess }
