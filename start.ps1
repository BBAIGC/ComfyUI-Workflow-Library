﻿param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$libraryRoot = $PSScriptRoot
$libraryUrl = 'http://127.0.0.1:8190'
$libraryData = Join-Path $libraryRoot 'data'
$libraryScript = Join-Path $libraryRoot 'server.py'
$libraryBase = if ((Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)) -eq 'custom_nodes') { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) } else { Split-Path -Parent $PSScriptRoot }
$pythonCandidates = @(
    $env:COMFYUI_PYTHON,
    (Join-Path $libraryBase '.venv/Scripts/python.exe'),
    (Join-Path $libraryBase 'python_embeded/python.exe'),
    (Join-Path (Split-Path -Parent $libraryBase) 'python_embeded/python.exe')
)
$libraryData = if ($env:WORKFLOW_LIBRARY_DATA_DIR) { $env:WORKFLOW_LIBRARY_DATA_DIR } else { Join-Path $libraryBase 'user/workflow-library' }
$libraryWorkflows = if ($env:COMFYUI_WORKFLOWS_DIR) { $env:COMFYUI_WORKFLOWS_DIR } else { Join-Path $libraryBase 'user/default/workflows' }

function Get-LibraryStatus {
    try {
        $status = Invoke-RestMethod -Uri ($libraryUrl + '/api/status') -TimeoutSec 4
        if ($status.service -ne 'comfy-workflow-library') {
            throw '8190 端口已被其他服务占用。'
        }
        if ([string]$status.version -ne '1.5.1') {
            throw ('工作流库服务版本不匹配：' + $status.version + '。请先退出原服务再启动。')
        }
        return $status
    }
    catch {
        if ($_.Exception.Message -like '*端口已被*' -or $_.Exception.Message -like '*版本不匹配*') { throw }
        return $null
    }
}

try {
    Set-Location -LiteralPath $libraryRoot
    if (-not (Test-Path -LiteralPath $libraryScript -PathType Leaf)) { throw '未找到工作流库 server.py。' }
    $ready = Get-LibraryStatus
    $serviceProcess = $null
    if (-not $ready) {
        # An occupied port without the expected service identity must not be reused.
        $tcp = [System.Net.Sockets.TcpClient]::new()
        try {
            $connect = $tcp.ConnectAsync('127.0.0.1', 8190)
            if ($connect.Wait(400) -and $tcp.Connected) { throw '8190 端口已被其他服务占用；请检查该服务。' }
        }
        catch [System.AggregateException] { }
        finally { $tcp.Dispose() }

        $python = $pythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
        if (-not $python) { throw '未找到可运行的 Python，请检查 ComfyUI 环境。' }
        New-Item -ItemType Directory -Path $libraryData -Force | Out-Null
        $runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $outLog = Join-Path $libraryData ('server-' + $runStamp + '.log')
        $errorLog = Join-Path $libraryData ('server-' + $runStamp + '.error.log')
        # ArgumentList quotes belong to the child command line; no cmd.exe wrapper is used.
        $serviceProcess = Start-Process -FilePath $python -ArgumentList @('-u', '-X', 'utf8', ('"' + $libraryScript + '"'), '--workflows', ('"' + $libraryWorkflows + '"'), '--data-dir', ('"' + $libraryData + '"')) -WorkingDirectory $libraryRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errorLog -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(12)
        do {
            Start-Sleep -Milliseconds 250
            $ready = Get-LibraryStatus
            if ($serviceProcess.HasExited -and -not $ready) { throw ('工作流库服务启动失败，日志：' + $errorLog) }
        } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw ('工作流库服务启动超时，日志：' + $errorLog) }
    }
    if ($serviceProcess) { Write-Output ('工作流库已启动 PID=' + $serviceProcess.Id + ' ' + $libraryUrl) }
    else { Write-Output ('已复用工作流库服务 ' + $libraryUrl) }
    if (-not $NoBrowser) { Start-Process $libraryUrl }
}
catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
