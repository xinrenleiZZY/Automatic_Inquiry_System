<#
  1688 message monitor - start / stop / status
  Used by Automatic_Inquiry_System/backend/app/monitorctl.py (the "monitor" step of
  the one-click start/stop on the Browser Monitor page).

  Why this exists instead of calling tools\qianniu\start-im.ps1:
    start-im.ps1 is FROZEN source and it contains Chinese string literals without a
    UTF-8 BOM. Windows PowerShell 5.1 (powershell.exe) reads .ps1 files using the
    system ANSI code page (936 here), so the Chinese literals get mangled and the
    script dies with a parse error -- "stop monitor" silently did nothing while the
    API reported success (reproduced 2026-10-15). Rather than touch frozen source,
    this file mirrors the same behaviour in pure ASCII.

  Behaviour parity with start-im.ps1's monitor part:
    * node <qianniu>\im.mjs monitor --interval <ms> [--refresh-min <min>]
    * CDP_BASE is exported to the child so it talks to the right debug port
    * pid -> logs\monitor.pid, stdout/stderr -> logs\monitor.{out,err}.log
    * stop only kills the process recorded in the pid file, and only if it is node
    * it does NOT launch Chrome (the Browser Monitor page handles that separately)

  NOTE: keep this file pure ASCII (same reason as above).
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'status')][string]$Action,
  [string]$QianniuDir = '',
  [int]$IntervalMs = 15000,
  [int]$RefreshMin = 0,
  [string]$CdpBase = 'http://127.0.0.1:6901'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $QianniuDir) { $QianniuDir = (Get-Location).Path }
$QianniuDir = [System.IO.Path]::GetFullPath($QianniuDir)
$logDir = Join-Path $QianniuDir 'logs'
$pidFile = Join-Path $logDir 'monitor.pid'
$outLog = Join-Path $logDir 'monitor.out.log'
$errLog = Join-Path $logDir 'monitor.err.log'
$imMjs = Join-Path $QianniuDir 'im.mjs'

function Get-MonitorProc {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $saved = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $saved) { return $null }
  $p = Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { return $p }
  return $null
}

function Get-Tail {
  if (-not (Test-Path -LiteralPath $outLog)) { return @() }
  try { return @(Get-Content $outLog -Tail 6 -ErrorAction SilentlyContinue) } catch { return @() }
}

$result = [ordered]@{
  ok         = $true
  action     = $Action
  at         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  qianniuDir = $QianniuDir
  pidFile    = $pidFile
  outLog     = $outLog
  intervalMs = $IntervalMs
  refreshMin = $RefreshMin
  cdpBase    = $CdpBase
  pid        = $null
  alive      = $false
  note       = $null
  error      = $null
  tail       = @()
}

$current = Get-MonitorProc
if ($current) { $result.pid = [int]$current.Id; $result.alive = $true }

if ($Action -eq 'status') {
  $result.tail = Get-Tail
  if (-not $result.alive) { $result.note = 'monitor is not running' }
}

if ($Action -eq 'stop') {
  if (-not $current) {
    $result.note = 'monitor is not running'
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  } else {
    try {
      Stop-Process -Id $current.Id -Force -ErrorAction Stop
      Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
      $result.alive = $false
      $result.note = 'monitor stopped'
    } catch {
      $result.ok = $false
      $result.alive = $true
      $result.error = "could not stop pid $($current.Id): $($_.Exception.Message)"
    }
  }
}

if ($Action -eq 'start') {
  if ($current) {
    $result.note = 'already running, start skipped'
  } elseif (-not (Test-Path -LiteralPath $imMjs)) {
    $result.ok = $false
    $result.error = "im.mjs not found: $imMjs"
  } else {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
      $result.ok = $false
      $result.error = 'node not found in PATH'
    } else {
      New-Item -ItemType Directory -Force -Path $logDir | Out-Null
      $env:CDP_BASE = $CdpBase
      $nodeArgs = @($imMjs, 'monitor', '--interval', "$IntervalMs")
      if ($RefreshMin -gt 0) { $nodeArgs += @('--refresh-min', "$RefreshMin") }
      try {
        $proc = Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $QianniuDir `
          -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        $proc.Id | Out-File -Encoding ascii $pidFile
        Start-Sleep -Seconds 4
        $after = Get-MonitorProc
        $result.pid = [int]$proc.Id
        $result.alive = [bool]$after
        if (-not $after) {
          $result.ok = $false
          $result.error = "monitor process exited within 4s, see $errLog"
        }
      } catch {
        $result.ok = $false
        $result.error = "could not start node: $($_.Exception.Message)"
      }
      $result.tail = Get-Tail
    }
  }
}

$result | ConvertTo-Json -Depth 6 -Compress
