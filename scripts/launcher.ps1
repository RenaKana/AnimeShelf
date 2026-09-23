[CmdletBinding()]
param(
    [switch]$SmokeTest,
    [string]$FixturePath,
    [string]$ScreenshotPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('AnimeShelf.Launcher.NativeMethods' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

namespace AnimeShelf.Launcher {
    public static class NativeMethods {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
    }
}
'@
}

try {
    [void][AnimeShelf.Launcher.NativeMethods]::SetProcessDPIAware()
} catch {
    # AutoScaleMode still provides usable scaling when the legacy DPI call is unavailable.
}

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$script:ManagerPath = Join-Path $PSScriptRoot 'service-manager.mjs'
$script:DataDir = if ([string]::IsNullOrWhiteSpace($env:ANIMESHELF_DATA_DIR)) {
    Join-Path $script:ProjectRoot 'data'
} elseif ([System.IO.Path]::IsPathRooted($env:ANIMESHELF_DATA_DIR)) {
    [System.IO.Path]::GetFullPath($env:ANIMESHELF_DATA_DIR)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $script:ProjectRoot $env:ANIMESHELF_DATA_DIR))
}
$script:NodePath = $null
$script:NodeError = $null
$script:CurrentWorker = $null
$script:Instances = @()
$script:PreferredSelectionId = $null
$script:PendingOpenId = $null
$script:PendingOpenDeadline = [DateTime]::MinValue
$script:NextPendingPoll = [DateTime]::MinValue
$script:ForceEligible = New-Object 'System.Collections.Generic.HashSet[string]'
$script:LauncherMutex = $null
$script:MutexOwned = $false
$script:Closing = $false
$script:SmokeMode = [bool]$SmokeTest
$script:FixtureResponses = @{}
$script:FixtureConfirmForce = $false
$script:FixtureCommandLog = New-Object 'System.Collections.Generic.List[object]'
$script:SmokeActionResults = New-Object 'System.Collections.Generic.List[object]'
$script:FixtureBrowserUrls = New-Object 'System.Collections.Generic.List[string]'
$script:FixtureLogPaths = New-Object 'System.Collections.Generic.List[string]'
$script:FixtureForceConfirmations = New-Object 'System.Collections.Generic.List[string]'

function Get-ObjectProperty {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-ProcessArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Join-ProcessArguments {
    param([string[]]$Values)
    return (($Values | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' ')
}

function Resolve-NodePath {
    if (-not [string]::IsNullOrWhiteSpace($env:ANIMESHELF_NODE)) {
        $configured = $env:ANIMESHELF_NODE.Trim()
        if (Test-Path -LiteralPath $configured -PathType Leaf) { return (Get-Item -LiteralPath $configured).FullName }
        $configuredCommand = Get-Command $configured -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $configuredCommand) { return $configuredCommand.Source }
        throw "ANIMESHELF_NODE 指向的 Node.js 不存在：$configured"
    }

    $pathCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pathCommand) { return $pathCommand.Source }

    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return (Get-Item -LiteralPath $bundled).FullName }
    throw '未找到 Node.js。请配置 ANIMESHELF_NODE，或将 node.exe 加入 PATH。'
}

function Get-MutexName {
    $normalized = $script:ProjectRoot.ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))
    } finally {
        $sha.Dispose()
    }
    return "Local\AnimeShelf.Launcher.$(([System.BitConverter]::ToString($hash)).Replace('-', ''))"
}

function Test-LoopbackWebUrl {
    param([AllowNull()][string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) { return $false }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $false }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) { return $false }

    $hostName = $uri.DnsSafeHost.ToLowerInvariant()
    if ($hostName -eq 'localhost' -or $hostName -eq '::1') { return $true }
    $address = $null
    if (-not [System.Net.IPAddress]::TryParse($hostName, [ref]$address)) { return $false }
    if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $address.GetAddressBytes()[0] -eq 127
    }
    return $address.Equals([System.Net.IPAddress]::IPv6Loopback)
}

function Format-CellValue {
    param([object]$Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return ([string][char]0x2014) }
    return [string]$Value
}

function Format-State {
    param([AllowNull()][string]$State)
    switch ($State) {
        'running' { return '运行中' }
        'starting' { return '正在启动' }
        'stopping' { return '正在关闭' }
        'failed' { return '失败' }
        'unknown' { return '未知' }
        default { return (Format-CellValue $State) }
    }
}

function Format-Kind {
    param([AllowNull()][string]$Kind)
    switch ($Kind) {
        'dev' { return '开发服务' }
        'standalone' { return '独立服务' }
        'electron' { return '桌面应用' }
        default { return (Format-CellValue $Kind) }
    }
}

function Set-InlineStatus {
    param(
        [string]$Text,
        [ValidateSet('normal', 'progress', 'success', 'error', 'warning')]
        [string]$Kind = 'normal'
    )
    $statusLabel.Text = $Text
    $toolTip.SetToolTip($statusLabel, $Text)
    switch ($Kind) {
        'progress' { $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(38, 92, 150) }
        'success' { $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(31, 111, 69) }
        'error' { $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(184, 47, 47) }
        'warning' { $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(153, 91, 12) }
        default { $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(74, 79, 87) }
    }
}

function Get-SelectedInstance {
    if ($instancesList.SelectedItems.Count -eq 0) { return $null }
    return $instancesList.SelectedItems[0].Tag
}

function Test-ForceAllowed {
    param([object]$Instance)
    if ($null -eq $Instance) { return $false }
    $id = [string](Get-ObjectProperty $Instance 'id')
    $identity = [string](Get-ObjectProperty $Instance 'identity')
    if ([string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($identity)) { return $false }
    if ((Get-ObjectProperty $Instance 'identityVerified') -ne $true -or (Get-ObjectProperty $Instance 'processState') -ne 'alive') { return $false }
    if ($script:ForceEligible.Contains($id)) { return $true }
    return (Get-ObjectProperty $Instance 'canForce') -eq $true
}

function Update-ActionButtons {
    $busy = $null -ne $script:CurrentWorker
    $selected = Get-SelectedInstance
    $startButton.Enabled = -not $busy
    $refreshButton.Enabled = -not $busy
    $openButton.Enabled = $false
    $stopButton.Enabled = $false
    $stopButton.Text = '关闭所选实例'
    $logButton.Enabled = $false
    $forceButton.Enabled = $false

    if (-not $busy -and $null -ne $selected) {
        $state = [string](Get-ObjectProperty $selected 'state')
        $webUrl = [string](Get-ObjectProperty $selected 'webUrl')
        $canStop = Get-ObjectProperty $selected 'canStop'
        $canRemove = (Get-ObjectProperty $selected 'canRemove') -eq $true
        $logPath = [string](Get-ObjectProperty $selected 'logPath')
        $openButton.Enabled = ($state -eq 'running' -and (Test-LoopbackWebUrl $webUrl))
        $stopButton.Enabled = ($canRemove -or ($canStop -eq $true -and $state -ne 'stopping'))
        if ($canRemove) { $stopButton.Text = '移除记录' }
        $logButton.Enabled = -not [string]::IsNullOrWhiteSpace($logPath)
        $forceButton.Enabled = Test-ForceAllowed $selected
    }
}

function Resize-InstanceColumns {
    if ($instancesList.Columns.Count -ne 7) { return }
    $fixedWidth = 0
    for ($index = 0; $index -lt 5; $index++) { $fixedWidth += $instancesList.Columns[$index].Width }
    $instancesList.Columns[5].Width = [Math]::Max(180, $instancesList.ClientSize.Width - $fixedWidth - 6)
}

function Set-Instances {
    param([object[]]$NewInstances)
    $selectedBefore = $script:PreferredSelectionId
    $selectedNow = Get-SelectedInstance
    if ($null -ne $selectedNow) { $selectedBefore = [string](Get-ObjectProperty $selectedNow 'id') }

    $script:Instances = @($NewInstances)
    $instancesList.BeginUpdate()
    try {
        $instancesList.Items.Clear()
        $instancesList.Groups.Clear()
        $animeShelfGroup = New-Object System.Windows.Forms.ListViewGroup('AnimeShelf')
        [void]$instancesList.Groups.Add($animeShelfGroup)

        foreach ($instance in $script:Instances) {
            $state = [string](Get-ObjectProperty $instance 'state')
            $canRemove = (Get-ObjectProperty $instance 'canRemove') -eq $true
            $stateText = if ($canRemove) { '已退出' } else { Format-State $state }
            $item = New-Object System.Windows.Forms.ListViewItem((Format-Kind ([string](Get-ObjectProperty $instance 'kind'))))
            [void]$item.SubItems.Add($stateText)
            [void]$item.SubItems.Add((Format-CellValue (Get-ObjectProperty $instance 'webUrl')))
            [void]$item.SubItems.Add((Format-CellValue (Get-ObjectProperty $instance 'apiPort')))
            $displayPid = if ($canRemove) { $null } else { Get-ObjectProperty $instance 'pid' }
            [void]$item.SubItems.Add((Format-CellValue $displayPid))
            [void]$item.SubItems.Add((Format-CellValue (Get-ObjectProperty $instance 'dataDir')))
            $item.Tag = $instance
            $item.Group = $animeShelfGroup
            switch ($state) {
                'running' { $item.ForeColor = [System.Drawing.Color]::FromArgb(31, 111, 69) }
                'starting' { $item.ForeColor = [System.Drawing.Color]::FromArgb(38, 92, 150) }
                'stopping' { $item.ForeColor = [System.Drawing.Color]::FromArgb(153, 91, 12) }
                'failed' { $item.ForeColor = [System.Drawing.Color]::FromArgb(184, 47, 47) }
                default { $item.ForeColor = [System.Drawing.Color]::FromArgb(74, 79, 87) }
            }

            $details = New-Object 'System.Collections.Generic.List[string]'
            $details.Add("实例 ID：$(Format-CellValue (Get-ObjectProperty $instance 'id'))")
            $details.Add("项目目录：$(Format-CellValue (Get-ObjectProperty $instance 'projectDir'))")
            $details.Add("日志：$(Format-CellValue (Get-ObjectProperty $instance 'logPath'))")
            if ($canRemove) { $details.Add("原 PID：$(Get-ObjectProperty $instance 'pid')；进程已退出，移除记录会保留日志。") }
            $instanceError = [string](Get-ObjectProperty $instance 'error')
            if (-not [string]::IsNullOrWhiteSpace($instanceError)) { $details.Add("错误：$instanceError") }
            $item.ToolTipText = $details -join [Environment]::NewLine
            [void]$instancesList.Items.Add($item)
        }

        $itemToSelect = $null
        if (-not [string]::IsNullOrWhiteSpace($selectedBefore)) {
            foreach ($item in $instancesList.Items) {
                if ([string](Get-ObjectProperty $item.Tag 'id') -eq $selectedBefore) {
                    $itemToSelect = $item
                    break
                }
            }
        }
        if ($null -eq $itemToSelect -and $instancesList.Items.Count -gt 0) { $itemToSelect = $instancesList.Items[0] }
        if ($null -ne $itemToSelect) {
            $itemToSelect.Selected = $true
            $itemToSelect.Focused = $true
            $itemToSelect.EnsureVisible()
            $script:PreferredSelectionId = [string](Get-ObjectProperty $itemToSelect.Tag 'id')
        } else {
            $script:PreferredSelectionId = $null
        }
    } finally {
        $instancesList.EndUpdate()
    }
    Update-ActionButtons
}

function Get-FixtureResponse {
    param([string]$Command)
    $queue = $script:FixtureResponses[$Command]
    if ($null -ne $queue -and $queue.Count -gt 0) { return $queue.Dequeue() }
    if ($Command -eq 'list') {
        return [pscustomobject]@{ result = [pscustomobject]@{ instances = @($script:Instances) } }
    }
    return [pscustomobject]@{ error = "Fixture 未配置 $Command 响应。" }
}

function Start-FixtureCommand {
    param(
        [string[]]$Arguments,
        [string]$Description,
        [scriptblock]$OnSuccess,
        [scriptblock]$OnError,
        [object]$Context
    )
    $command = if ($Arguments.Count) { [string]$Arguments[0] } else { '' }
    $response = Get-FixtureResponse $command
    $delayValue = Get-ObjectProperty $response 'delayMs'
    $delayMs = if ($null -eq $delayValue) { 35 } else { [Math]::Max(1, [Math]::Min(2000, [int]$delayValue)) }
    $script:FixtureCommandLog.Add([pscustomobject]@{ command = $command; arguments = @($Arguments); description = $Description })
    $script:CurrentWorker = [pscustomobject]@{
        Fixture = $true
        CompleteAt = [DateTime]::UtcNow.AddMilliseconds($delayMs)
        Response = $response
        Description = $Description
        OnSuccess = $OnSuccess
        OnError = $OnError
        Context = $Context
    }
    Set-InlineStatus $Description 'progress'
    Update-ActionButtons
    return $true
}

function Start-ManagerCommand {
    param(
        [string[]]$Arguments,
        [string]$Description,
        [scriptblock]$OnSuccess,
        [scriptblock]$OnError,
        [object]$Context,
        [int]$TimeoutSeconds = 45
    )
    if ($null -ne $script:CurrentWorker) { return $false }
    if ($script:SmokeMode) {
        return Start-FixtureCommand -Arguments $Arguments -Description $Description -OnSuccess $OnSuccess -OnError $OnError -Context $Context
    }
    if ([string]::IsNullOrWhiteSpace($script:NodePath)) {
        Set-InlineStatus $script:NodeError 'error'
        return $false
    }
    if (-not (Test-Path -LiteralPath $script:ManagerPath -PathType Leaf)) {
        Set-InlineStatus "缺少服务管理器：$script:ManagerPath" 'error'
        return $false
    }

    $process = New-Object System.Diagnostics.Process
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:NodePath
    $startInfo.Arguments = Join-ProcessArguments (@($script:ManagerPath) + @($Arguments))
    $startInfo.WorkingDirectory = $script:ProjectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $process.StartInfo = $startInfo

    try {
        if (-not $process.Start()) { throw '无法启动服务管理器进程。' }
        $script:CurrentWorker = [pscustomobject]@{
            Process = $process
            StdoutTask = $process.StandardOutput.ReadToEndAsync()
            StderrTask = $process.StandardError.ReadToEndAsync()
            StartedAt = [DateTime]::UtcNow
            TimeoutSeconds = $TimeoutSeconds
            Description = $Description
            OnSuccess = $OnSuccess
            OnError = $OnError
            Context = $Context
        }
        Set-InlineStatus $Description 'progress'
        Update-ActionButtons
        return $true
    } catch {
        $message = $_.Exception.Message
        try { $process.Dispose() } catch {}
        Set-InlineStatus $message 'error'
        if ($null -ne $OnError) { & $OnError $message $Context }
        Update-ActionButtons
        return $false
    }
}

function Complete-FixtureWorker {
    $completed = $script:CurrentWorker
    if ($null -eq $completed) { return }
    $script:CurrentWorker = $null
    Update-ActionButtons
    $response = $completed.Response
    $errorValue = [string](Get-ObjectProperty $response 'error')
    if (-not [string]::IsNullOrWhiteSpace($errorValue)) {
        Set-InlineStatus $errorValue 'error'
        if ($null -ne $completed.OnError) { & $completed.OnError $errorValue $completed.Context }
        return
    }
    try {
        $result = Get-ObjectProperty $response 'result'
        if ($null -eq $result) { throw 'Fixture 响应缺少 result。' }
        & $completed.OnSuccess $result $completed.Context
    } catch {
        $message = "Fixture 回调失败：$($_.Exception.Message)"
        Set-InlineStatus $message 'error'
        if ($null -ne $completed.OnError) { & $completed.OnError $message $completed.Context }
    }
}

function Complete-CurrentWorker {
    param([bool]$TimedOut)
    $completed = $script:CurrentWorker
    if ($null -eq $completed) { return }
    $script:CurrentWorker = $null
    $stdout = ''
    $stderr = ''
    $exitCode = -1
    try {
        if ($TimedOut -and -not $completed.Process.HasExited) {
            $completed.Process.Kill()
            [void]$completed.Process.WaitForExit(2000)
        }
        if ($completed.StdoutTask.IsCompleted) { $stdout = $completed.StdoutTask.Result }
        if ($completed.StderrTask.IsCompleted) { $stderr = $completed.StderrTask.Result }
        if ($completed.Process.HasExited) { $exitCode = $completed.Process.ExitCode }
    } catch {
        $stderr = $_.Exception.Message
    } finally {
        try { $completed.Process.Dispose() } catch {}
    }

    Update-ActionButtons
    if ($TimedOut) {
        $message = "操作超时：$($completed.Description)"
        Set-InlineStatus $message 'error'
        if ($null -ne $completed.OnError) { & $completed.OnError $message $completed.Context }
        return
    }
    if ($exitCode -ne 0) {
        $message = $stderr.Trim()
        if ([string]::IsNullOrWhiteSpace($message)) { $message = "服务管理器退出，代码 $exitCode。" }
        if ($message.Length -gt 500) { $message = $message.Substring(0, 500) + [char]0x2026 }
        Set-InlineStatus $message 'error'
        if ($null -ne $completed.OnError) { & $completed.OnError $message $completed.Context }
        return
    }
    try {
        if ([string]::IsNullOrWhiteSpace($stdout)) { throw '服务管理器没有返回 JSON。' }
        $result = $stdout | ConvertFrom-Json
        & $completed.OnSuccess $result $completed.Context
    } catch {
        $message = "无法读取服务管理器结果：$($_.Exception.Message)"
        Set-InlineStatus $message 'error'
        if ($null -ne $completed.OnError) { & $completed.OnError $message $completed.Context }
    }
}

function Find-InstanceById {
    param([string]$Id)
    foreach ($instance in $script:Instances) {
        if ([string](Get-ObjectProperty $instance 'id') -eq $Id) { return $instance }
    }
    return $null
}

function Open-InstanceWebUrl {
    param([object]$Instance)
    $url = [string](Get-ObjectProperty $Instance 'webUrl')
    if (-not (Test-LoopbackWebUrl $url)) {
        Set-InlineStatus '服务返回的网页地址不是本机 http(s) 地址，已拒绝打开。' 'error'
        return $false
    }
    if ($script:SmokeMode) {
        $script:FixtureBrowserUrls.Add($url)
        Set-InlineStatus "Fixture 已记录打开 $url" 'success'
        return $true
    }
    try {
        Start-Process -FilePath $url -ErrorAction Stop
        Set-InlineStatus "已打开 $url" 'success'
        return $true
    } catch {
        Set-InlineStatus "无法打开网页：$($_.Exception.Message)" 'error'
        return $false
    }
}

function Update-PendingOpen {
    if ([string]::IsNullOrWhiteSpace($script:PendingOpenId)) { return }
    $instance = Find-InstanceById $script:PendingOpenId
    if ($null -ne $instance) {
        $state = [string](Get-ObjectProperty $instance 'state')
        if ($state -eq 'running') {
            $script:PreferredSelectionId = $script:PendingOpenId
            [void](Open-InstanceWebUrl $instance)
            $script:PendingOpenId = $null
            return
        }
        if ($state -eq 'failed' -or $state -eq 'unknown' -or $state -eq 'stopping') {
            $instanceError = [string](Get-ObjectProperty $instance 'error')
            if ($state -eq 'stopping') { $instanceError = '实例正在关闭，已停止等待网页就绪。' }
            elseif ($instanceError -eq 'Registered process is not running') { $instanceError = '实例进程已退出，启动未完成，请查看日志。' }
            elseif ([string]::IsNullOrWhiteSpace($instanceError)) {
                $instanceError = if ($state -eq 'unknown') { '无法确认实例状态，已停止等待，请刷新或查看日志。' } else { '实例启动失败。' }
            }
            Set-InlineStatus $instanceError 'error'
            $script:PendingOpenId = $null
            return
        }
    } else {
        Set-InlineStatus '启动实例记录已消失，已停止等待，请刷新服务列表。' 'error'
        $script:PendingOpenId = $null
        return
    }
    if ([DateTime]::UtcNow -ge $script:PendingOpenDeadline) {
        Set-InlineStatus '等待实例进入运行状态超时，请查看日志。' 'error'
        $script:PendingOpenId = $null
        return
    }
    $script:NextPendingPoll = [DateTime]::UtcNow.AddMilliseconds(800)
    Set-InlineStatus '实例正在启动，等待网页就绪…' 'progress'
}

function Request-InstancesRefresh {
    param([string]$Description = '正在刷新服务列表…')
    $onSuccess = {
        param($result, $context)
        $instancesProperty = $result.PSObject.Properties['instances']
        if ($null -eq $instancesProperty) { throw '服务列表结果缺少 instances。' }
        Set-Instances @($instancesProperty.Value)
        if (-not [string]::IsNullOrWhiteSpace($script:PendingOpenId)) {
            Update-PendingOpen
        } else {
            $exitedCount = @($script:Instances | Where-Object { (Get-ObjectProperty $_ 'canRemove') -eq $true }).Count
            Set-InlineStatus "已刷新，共 $($script:Instances.Count) 条记录，其中 $exitedCount 条已退出。" 'success'
        }
    }
    $onError = {
        param($message, $context)
        if (-not [string]::IsNullOrWhiteSpace($script:PendingOpenId)) {
            if ([DateTime]::UtcNow -ge $script:PendingOpenDeadline) { $script:PendingOpenId = $null }
            else { $script:NextPendingPoll = [DateTime]::UtcNow.AddMilliseconds(1200) }
        }
    }
    [void](Start-ManagerCommand -Arguments @('list', '--project', $script:ProjectRoot) -Description $Description -OnSuccess $onSuccess -OnError $onError -TimeoutSeconds 20)
}

function Open-SelectedLog {
    $instance = Get-SelectedInstance
    if ($null -eq $instance) { return }
    $logPath = [string](Get-ObjectProperty $instance 'logPath')
    if ([string]::IsNullOrWhiteSpace($logPath)) {
        Set-InlineStatus '所选实例没有日志路径。' 'warning'
        return
    }
    if ($script:SmokeMode) {
        $script:FixtureLogPaths.Add($logPath)
        Set-InlineStatus 'Fixture 已记录日志路径。' 'success'
        return
    }
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = Join-Path $env:WINDIR 'System32\notepad.exe'
        $startInfo.Arguments = ConvertTo-ProcessArgument $logPath
        $startInfo.UseShellExecute = $false
        $startInfo.WorkingDirectory = $script:ProjectRoot
        $process = [System.Diagnostics.Process]::Start($startInfo)
        if ($null -eq $process) { throw '无法启动记事本。' }
        $process.Dispose()
        Set-InlineStatus '已在记事本中打开日志。' 'success'
    } catch {
        Set-InlineStatus "无法打开日志：$($_.Exception.Message)" 'error'
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AnimeShelf 服务管理器'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.ClientSize = New-Object System.Drawing.Size(860, 480)
$form.MinimumSize = New-Object System.Drawing.Size(760, 400)
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 247, 249)

$headerPanel = New-Object System.Windows.Forms.Panel
$headerPanel.Dock = [System.Windows.Forms.DockStyle]::Top
$headerPanel.Height = 88
$headerPanel.Padding = New-Object System.Windows.Forms.Padding(14, 8, 14, 7)
$headerPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($headerPanel)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = '服务实例'
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(15, 10)
$titleLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(31, 35, 41)
$headerPanel.Controls.Add($titleLabel)

$dataLabel = New-Object System.Windows.Forms.Label
$dataLabel.Text = "默认数据：$script:DataDir"
$dataLabel.AutoEllipsis = $true
$dataLabel.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
$dataLabel.Location = New-Object System.Drawing.Point(132, 13)
$dataLabel.Size = New-Object System.Drawing.Size(710, 21)
$dataLabel.ForeColor = [System.Drawing.Color]::FromArgb(104, 111, 120)
$headerPanel.Controls.Add($dataLabel)

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Location = New-Object System.Drawing.Point(11, 45)
$buttonPanel.Anchor = [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right -bor [System.Windows.Forms.AnchorStyles]::Top
$buttonPanel.Size = New-Object System.Drawing.Size(835, 36)
$buttonPanel.WrapContents = $false
$buttonPanel.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
$headerPanel.Controls.Add($buttonPanel)

function New-LauncherButton {
    param([string]$Text, [int]$Width, [bool]$Primary = $false)
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Size = New-Object System.Drawing.Size($Width, 30)
    $button.Margin = New-Object System.Windows.Forms.Padding(3, 1, 3, 2)
    $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $button.FlatAppearance.BorderSize = 1
    if ($Primary) {
        $button.BackColor = [System.Drawing.Color]::FromArgb(43, 104, 176)
        $button.ForeColor = [System.Drawing.Color]::White
        $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(43, 104, 176)
    } else {
        $button.BackColor = [System.Drawing.Color]::White
        $button.ForeColor = [System.Drawing.Color]::FromArgb(40, 45, 52)
        $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(193, 198, 205)
    }
    return $button
}

$startButton = New-LauncherButton '启动并打开默认实例' 190 $true
$openButton = New-LauncherButton '打开网页' 100
$stopButton = New-LauncherButton '关闭所选实例' 132
$refreshButton = New-LauncherButton '刷新' 72
$logButton = New-LauncherButton '查看日志' 100
$forceButton = New-LauncherButton '强制结束' 100
$forceButton.ForeColor = [System.Drawing.Color]::FromArgb(176, 45, 45)
$forceButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(210, 145, 145)
$forceButton.Enabled = $false
@($startButton, $openButton, $stopButton, $refreshButton, $logButton, $forceButton) | ForEach-Object { [void]$buttonPanel.Controls.Add($_) }

$toolTip = New-Object System.Windows.Forms.ToolTip
$toolTip.SetToolTip($forceButton, '仅对身份已核实且无法正常关闭的存活进程启用')
$toolTip.SetToolTip($stopButton, '关闭存活实例；已退出实例仅归档记录并保留日志')
$toolTip.SetToolTip($dataLabel, $script:DataDir)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Dock = [System.Windows.Forms.DockStyle]::Bottom
$statusPanel.Height = 31
$statusPanel.Padding = New-Object System.Windows.Forms.Padding(15, 5, 15, 5)
$statusPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($statusPanel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Dock = [System.Windows.Forms.DockStyle]::Fill
$statusLabel.AutoEllipsis = $true
$statusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$statusPanel.Controls.Add($statusLabel)

$contentPanel = New-Object System.Windows.Forms.Panel
$contentPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$contentPanel.Padding = New-Object System.Windows.Forms.Padding(14, 12, 14, 10)
$contentPanel.BackColor = $form.BackColor
$form.Controls.Add($contentPanel)
$contentPanel.BringToFront()

$instancesList = New-Object System.Windows.Forms.ListView
$instancesList.Dock = [System.Windows.Forms.DockStyle]::Fill
$instancesList.View = [System.Windows.Forms.View]::Details
$instancesList.FullRowSelect = $true
$instancesList.MultiSelect = $false
$instancesList.HideSelection = $false
$instancesList.GridLines = $true
$instancesList.ShowItemToolTips = $true
$instancesList.UseCompatibleStateImageBehavior = $false
$instancesList.BackColor = [System.Drawing.Color]::White
$instancesList.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
[void]$instancesList.Columns.Add('类型', 90)
[void]$instancesList.Columns.Add('状态', 86)
[void]$instancesList.Columns.Add('网页地址', 225)
[void]$instancesList.Columns.Add('API', 62)
[void]$instancesList.Columns.Add('PID', 72)
[void]$instancesList.Columns.Add('数据目录', 250)
$contentPanel.Controls.Add($instancesList)
Set-InlineStatus '正在读取服务列表…' 'progress'

$workerTimer = New-Object System.Windows.Forms.Timer
$workerTimer.Interval = 120
$workerTimer.Add_Tick({
    if ($script:Closing) { return }
    $worker = $script:CurrentWorker
    if ($null -ne $worker) {
        if ((Get-ObjectProperty $worker 'Fixture') -eq $true) {
            if ([DateTime]::UtcNow -ge $worker.CompleteAt) { Complete-FixtureWorker }
        } elseif ($worker.Process.HasExited -and $worker.StdoutTask.IsCompleted -and $worker.StderrTask.IsCompleted) { Complete-CurrentWorker $false }
        elseif ([DateTime]::UtcNow.Subtract($worker.StartedAt).TotalSeconds -ge $worker.TimeoutSeconds) { Complete-CurrentWorker $true }
        return
    }
    if (-not [string]::IsNullOrWhiteSpace($script:PendingOpenId) -and [DateTime]::UtcNow -ge $script:NextPendingPoll) {
        $script:NextPendingPoll = [DateTime]::UtcNow.AddDays(1)
        Request-InstancesRefresh '正在等待实例就绪…'
    }
})

$instancesList.Add_SelectedIndexChanged({
    $selected = Get-SelectedInstance
    if ($null -ne $selected) { $script:PreferredSelectionId = [string](Get-ObjectProperty $selected 'id') }
    Update-ActionButtons
})
$form.Add_Resize({ Resize-InstanceColumns })
$refreshButton.Add_Click({ Request-InstancesRefresh })

$startButton.Add_Click({
    $onSuccess = {
        param($result, $context)
        $instanceId = [string](Get-ObjectProperty $result 'instanceId')
        if ([string]::IsNullOrWhiteSpace($instanceId)) { throw '启动结果缺少 instanceId。' }
        $script:PendingOpenId = $instanceId
        $script:PreferredSelectionId = $instanceId
        $script:PendingOpenDeadline = [DateTime]::UtcNow.AddSeconds(90)
        $script:NextPendingPoll = [DateTime]::UtcNow
        if ((Get-ObjectProperty $result 'existing') -eq $true) { Set-InlineStatus '已找到现有实例，正在确认网页状态…' 'progress' }
        else { Set-InlineStatus '启动请求已提交，正在等待网页就绪…' 'progress' }
        Request-InstancesRefresh '正在确认实例状态…'
    }
    $onError = { param($message, $context) }
    [void](Start-ManagerCommand -Arguments @('start', '--project', $script:ProjectRoot, '--data-dir', $script:DataDir) -Description '正在启动默认实例…' -OnSuccess $onSuccess -OnError $onError -TimeoutSeconds 45)
})

$openButton.Add_Click({
    $instance = Get-SelectedInstance
    if ($null -ne $instance) { [void](Open-InstanceWebUrl $instance) }
})

$stopButton.Add_Click({
    $instance = Get-SelectedInstance
    if ($null -eq $instance) { return }
    $instanceId = [string](Get-ObjectProperty $instance 'id')
    if ([string]::IsNullOrWhiteSpace($instanceId)) { return }
    if ($script:PendingOpenId -eq $instanceId) { $script:PendingOpenId = $null }
    if ((Get-ObjectProperty $instance 'canRemove') -eq $true) {
        $onArchived = {
            param($result, $context)
            [void]$script:ForceEligible.Remove([string](Get-ObjectProperty $context 'id'))
            Request-InstancesRefresh '记录已归档，日志已保留；正在刷新…'
        }
        $onArchiveError = { param($message, $context) }
        [void](Start-ManagerCommand -Arguments @('archive', '--id', $instanceId, '--project', $script:ProjectRoot) -Description '正在核实退出状态并归档记录…' -OnSuccess $onArchived -OnError $onArchiveError -Context $instance)
        return
    }
    $onSuccess = {
        param($result, $context)
        $id = [string](Get-ObjectProperty $context 'id')
        $status = [string](Get-ObjectProperty $result 'status')
        if ((Get-ObjectProperty $result 'requiresForce') -eq $true -or $status -eq 'requiresForce') {
            [void]$script:ForceEligible.Add($id)
            Set-InlineStatus '实例无法正常关闭，可核对身份后使用“强制结束”。' 'warning'
            Update-ActionButtons
            return
        }
        [void]$script:ForceEligible.Remove($id)
        Set-InlineStatus '关闭请求已完成。' 'success'
        Request-InstancesRefresh '正在更新服务列表…'
    }
    $onError = {
        param($message, $context)
        $id = [string](Get-ObjectProperty $context 'id')
        if (-not [string]::IsNullOrWhiteSpace($id)) { [void]$script:ForceEligible.Add($id) }
        Update-ActionButtons
    }
    [void](Start-ManagerCommand -Arguments @('stop', '--id', $instanceId, '--project', $script:ProjectRoot) -Description '正在关闭所选实例…' -OnSuccess $onSuccess -OnError $onError -Context $instance -TimeoutSeconds 45)
})

$logButton.Add_Click({ Open-SelectedLog })

$forceButton.Add_Click({
    $instance = Get-SelectedInstance
    if ($null -eq $instance -or -not (Test-ForceAllowed $instance)) { return }
    $instanceId = [string](Get-ObjectProperty $instance 'id')
    $identity = [string](Get-ObjectProperty $instance 'identity')
    $pidValue = Format-CellValue (Get-ObjectProperty $instance 'pid')
    $dataDirValue = Format-CellValue (Get-ObjectProperty $instance 'dataDir')
    $message = "强制结束仅用于无法正常关闭的实例。`r`n`r`n实例 ID：$instanceId`r`nPID：$pidValue`r`n数据目录：$dataDirValue`r`n`r`n确认强制结束这个实例吗？"
    $answer = if ($script:SmokeMode) {
        $script:FixtureForceConfirmations.Add($instanceId)
        if ($script:FixtureConfirmForce) { [System.Windows.Forms.DialogResult]::Yes } else { [System.Windows.Forms.DialogResult]::No }
    } else {
        [System.Windows.Forms.MessageBox]::Show($form, $message, '确认强制结束', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
    }
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    $onSuccess = {
        param($result, $context)
        [void]$script:ForceEligible.Remove([string](Get-ObjectProperty $context 'id'))
        Set-InlineStatus '强制结束请求已完成。' 'success'
        Request-InstancesRefresh '正在更新服务列表…'
    }
    $onError = { param($message, $context) }
    [void](Start-ManagerCommand -Arguments @('force', '--id', $instanceId, '--identity', $identity, '--project', $script:ProjectRoot) -Description '正在强制结束所选实例…' -OnSuccess $onSuccess -OnError $onError -Context $instance -TimeoutSeconds 45)
})

$form.Add_FormClosing({
    $script:Closing = $true
    $workerTimer.Stop()
})
$form.Add_FormClosed({
    if ($script:MutexOwned -and $null -ne $script:LauncherMutex) { try { $script:LauncherMutex.ReleaseMutex() } catch {} }
    if ($null -ne $script:LauncherMutex) { $script:LauncherMutex.Dispose() }
})

if ($SmokeTest) {
    if ([string]::IsNullOrWhiteSpace($FixturePath)) { throw 'SmokeTest 必须提供隔离的 FixturePath。' }
    $fixture = Get-Content -Raw -Encoding UTF8 -LiteralPath (Resolve-Path -LiteralPath $FixturePath).Path | ConvertFrom-Json
    $instancesProperty = $fixture.PSObject.Properties['instances']
    if ($null -eq $instancesProperty) { throw 'Fixture 缺少 instances。' }
    $fixtureInstances = @($instancesProperty.Value)
    $responses = Get-ObjectProperty $fixture 'responses'
    if ($null -ne $responses) {
        foreach ($property in $responses.PSObject.Properties) {
            $queue = New-Object 'System.Collections.Generic.Queue[object]'
            foreach ($response in @($property.Value)) { $queue.Enqueue($response) }
            $script:FixtureResponses[$property.Name] = $queue
        }
    }
    $script:FixtureConfirmForce = (Get-ObjectProperty $fixture 'confirmForce') -eq $true
    $fixtureSelectedId = [string](Get-ObjectProperty $fixture 'selectedId')
    if (-not [string]::IsNullOrWhiteSpace($fixtureSelectedId)) { $script:PreferredSelectionId = $fixtureSelectedId }
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Set-Instances @($fixtureInstances)
    Set-InlineStatus "隔离预览，共 $($script:Instances.Count) 个实例。" 'success'
    $workerTimer.Start()
    [System.Windows.Forms.Application]::DoEvents()

    $actions = Get-ObjectProperty $fixture 'actions'
    foreach ($action in @($actions)) {
        if ($null -eq $action) { continue }
        $selectId = [string](Get-ObjectProperty $action 'selectId')
        if (-not [string]::IsNullOrWhiteSpace($selectId)) {
            $selection = $null
            foreach ($item in $instancesList.Items) {
                $item.Selected = $false
                if ([string](Get-ObjectProperty $item.Tag 'id') -eq $selectId) { $selection = $item }
            }
            if ($null -eq $selection) { throw "Fixture 找不到要选择的实例：$selectId" }
            $selection.Selected = $true
            $selection.Focused = $true
            $selection.EnsureVisible()
            [System.Windows.Forms.Application]::DoEvents()
        }

        $click = [string](Get-ObjectProperty $action 'click')
        if ([string]::IsNullOrWhiteSpace($click)) { continue }
        $button = switch ($click) {
            'start' { $startButton }
            'open' { $openButton }
            'stop' { $stopButton }
            'refresh' { $refreshButton }
            'log' { $logButton }
            'force' { $forceButton }
            default { throw "未知 Fixture 按钮：$click" }
        }
        $enabledBefore = $button.Enabled
        if (-not $enabledBefore) { throw "Fixture 按钮当前不可用：$click" }
        $button.PerformClick()
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        while ($null -ne $script:CurrentWorker -or -not [string]::IsNullOrWhiteSpace($script:PendingOpenId)) {
            [System.Windows.Forms.Application]::DoEvents()
            [System.Threading.Thread]::Sleep(15)
            if ([DateTime]::UtcNow -ge $deadline) { throw "Fixture 操作超时：$click" }
        }
        [System.Windows.Forms.Application]::DoEvents()
        $selectedAfter = Get-SelectedInstance
        $script:SmokeActionResults.Add([pscustomobject]@{
            click = $click
            enabledBefore = $enabledBefore
            selectedIdAfter = if ($null -eq $selectedAfter) { $null } else { [string](Get-ObjectProperty $selectedAfter 'id') }
            statusAfter = $statusLabel.Text
        })
    }

    Resize-InstanceColumns
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()

    if (-not [string]::IsNullOrWhiteSpace($ScreenshotPath)) {
        $fullScreenshotPath = [System.IO.Path]::GetFullPath($ScreenshotPath)
        $screenshotDirectory = Split-Path -Parent $fullScreenshotPath
        if (-not [string]::IsNullOrWhiteSpace($screenshotDirectory)) { [System.IO.Directory]::CreateDirectory($screenshotDirectory) | Out-Null }
        $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
        try {
            $bounds = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
            $form.DrawToBitmap($bitmap, $bounds)
            $bitmap.Save($fullScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $bitmap.Dispose()
        }
    }

    $stateSummary = New-Object 'System.Collections.Generic.List[object]'
    foreach ($instance in $script:Instances) {
        $stateSummary.Add([pscustomobject]@{ id = [string](Get-ObjectProperty $instance 'id'); state = [string](Get-ObjectProperty $instance 'state') })
    }
    $summary = [pscustomobject]@{
        smokeTest = $true
        rowCount = $instancesList.Items.Count
        selectedId = $script:PreferredSelectionId
        startEnabled = $startButton.Enabled
        openEnabled = $openButton.Enabled
        stopEnabled = $stopButton.Enabled
        stopText = $stopButton.Text
        refreshEnabled = $refreshButton.Enabled
        logEnabled = $logButton.Enabled
        forceEnabled = $forceButton.Enabled
        statusText = $statusLabel.Text
        states = $stateSummary.ToArray()
        actions = $script:SmokeActionResults.ToArray()
        commands = $script:FixtureCommandLog.ToArray()
        browserUrls = $script:FixtureBrowserUrls.ToArray()
        logPaths = $script:FixtureLogPaths.ToArray()
        forceConfirmations = $script:FixtureForceConfirmations.ToArray()
        screenshot = if ([string]::IsNullOrWhiteSpace($ScreenshotPath)) { $null } else { [System.IO.Path]::GetFullPath($ScreenshotPath) }
    }
    $workerTimer.Stop()
    $form.Close()
    $form.Dispose()
    $summary | ConvertTo-Json -Depth 8 -Compress
    return
}

$createdNew = $false
$script:LauncherMutex = New-Object System.Threading.Mutex($true, (Get-MutexName), [ref]$createdNew)
if (-not $createdNew) {
    [void][System.Windows.Forms.MessageBox]::Show('AnimeShelf 服务管理器已经打开。', 'AnimeShelf', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    $script:LauncherMutex.Dispose()
    $form.Dispose()
    return
}
$script:MutexOwned = $true

try { $script:NodePath = Resolve-NodePath }
catch { $script:NodeError = $_.Exception.Message }

$form.Add_Shown({
    Resize-InstanceColumns
    if ([string]::IsNullOrWhiteSpace($script:NodePath)) {
        Set-InlineStatus $script:NodeError 'error'
        Update-ActionButtons
        return
    }
    $workerTimer.Start()
    Request-InstancesRefresh '正在读取服务列表…'
})

[System.Windows.Forms.Application]::Run($form)
$form.Dispose()
