<#
  1688 debug Chrome instance - start / stop / status
  Used by the "Browser Monitor" page (Automatic_Inquiry_System/backend/app/api/browser.py).

  Usage (prints exactly one JSON line on stdout):
    .\browser-control.ps1 -Action status   # is the CDP port up, is the debug instance alive
    .\browser-control.ps1 -Action start    # launch the debug instance when CDP is down
    .\browser-control.ps1 -Action stop     # kill ONLY the debug profile instance

  Safety boundary (important):
    A chrome.exe process counts as "ours" only when its command line contains
    --user-data-dir=<ProfileDir>. The user's everyday Chrome is never touched.
    ProfileDir must keep matching tools\qianniu\start-im.ps1 (%LOCALAPPDATA%\1688-cdp-profile),
    otherwise the instance we launch is not the instance we can stop.

  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 files using the
  system ANSI code page (936 here); a UTF-8 Chinese literal can swallow the closing
  quote and break the whole script. Chinese labels live in the Python layer instead.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'start', 'stop', 'checkpath')][string]$Action,
  [int]$CdpPort = 6901,
  [string]$ProfileDir = '',
  [string]$Url = 'https://work.1688.com/',
  [string]$ChromePath = '',
  [switch]$Force,
  [int]$WaitSec = 20
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ProfileDir) { $ProfileDir = Join-Path $env:LOCALAPPDATA '1688-cdp-profile' }
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
$cdpBase = "http://127.0.0.1:$CdpPort"

function Get-CdpVersion {
  try { return Invoke-RestMethod "$cdpBase/json/version" -TimeoutSec 3 } catch { return $null }
}

# Every place Chrome normally lives. The first one that exists wins.
function Get-ChromeCandidates {
  $cands = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome Beta\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome Beta\Application\chrome.exe"
  )
  return @($cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
}

# Explicit path (from the settings page / CHROME_EXE) wins; otherwise auto-detect.
function Resolve-Chrome([string]$Explicit) {
  if ($Explicit) {
    try {
      if (Test-Path -LiteralPath $Explicit -PathType Leaf) {
        return ([System.IO.Path]::GetFullPath($Explicit))
      }
    } catch { }
    return $null
  }
  $found = Get-ChromeCandidates
  if ($found.Count) { return [string]$found[0] }
  return $null
}

function Get-ProcStart([object]$p) {
  try {
    if ($p.CreationDate) {
      return ([Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate)).ToString('yyyy-MM-dd HH:mm:ss')
    }
  } catch { }
  return ''
}

# Who is listening on the CDP port: this is the debug instance by definition.
# netstat is the fallback because Get-NetTCPConnection / WMI can be blocked by policy.
function Get-CdpOwnerPid([int]$Port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch { }
  $lines = @()
  try { $lines = @(& netstat.exe -ano 2>$null) } catch { $lines = @() }
  foreach ($l in $lines) {
    if ($l -match "[:.]$Port\s+\S+\s+LISTENING\s+(\d+)") { return [int]$Matches[1] }
  }
  return $null
}

function Get-ProcInfo([int]$ProcId) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  $started = ''
  try { $started = $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch { $started = '' }
  return [pscustomobject]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; startedAt = $started }
}

# Only processes whose command line carries our profile dir are considered ours.
function Get-DebugChromeProcs {
  $found = @()
  $list = @()
  try { $list = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop) } catch { $list = @() }
  foreach ($p in $list) {
    $cl = $null
    try { $cl = [string]$p.CommandLine } catch { $cl = $null }
    if (-not $cl) { continue }
    if ($cl.IndexOf($ProfileDir, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $kind = 'main'
    if ($cl -match '--type=') { $kind = 'child' }
    $found += [pscustomobject]@{
      pid       = [int]$p.ProcessId
      kind      = $kind
      startedAt = (Get-ProcStart $p)
    }
  }
  return $found
}

$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$chromeCandidates = @(Get-ChromeCandidates)
$resolvedChrome = Resolve-Chrome $ChromePath

$result = [ordered]@{
  ok         = $true
  action     = $Action
  at         = $nowMs
  cdpPort    = $CdpPort
  cdpBase    = $cdpBase
  profileDir = $ProfileDir
  startUrl   = $Url
  launched   = $false
  force      = [bool]$Force
  killed     = @()
  warnings   = @()
  error      = $null
  note       = $null
  chromePathInput    = $ChromePath
  chromePath         = $resolvedChrome
  chromePathExists   = [bool]$resolvedChrome
  chromePathIsCustom = [bool]$ChromePath
  chromeCandidates   = $chromeCandidates
}

# checkpath: answer only "is this chrome path usable", without touching CDP or processes.
# Used to validate a path before saving, so that "saves fine" == "launches fine".
if ($Action -eq 'checkpath') {
  $result.ok = [bool]$resolvedChrome
  if (-not $resolvedChrome) {
    if ($ChromePath) { $result.error = "not found: $ChromePath" }
    else { $result.error = 'no chrome.exe found in the usual locations' }
  }
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

$cdp = Get-CdpVersion
$procs = @(Get-DebugChromeProcs)
$mainProcs = @($procs | Where-Object { $_.kind -eq 'main' })
$cdpOwnerPid = Get-CdpOwnerPid $CdpPort

if ($Action -eq 'start') {
  # Start policy (changed 2026-10-15: "clear the port first, then start"):
  #   port free                     -> just start
  #   port held + CDP not responding-> stale instance (or a foreign program grabbed it):
  #                                    kill it if it is chrome, otherwise fail loudly
  #   port held + CDP healthy       -> already running, skip (unless -Force = clean restart)
  #   Also kill leftover chrome on this profile: otherwise the new process hands off to the
  #   old instance and the port never opens ("launched=true but 6901 never comes up").
  $result.force = [bool]$Force
  $healthy = [bool]$cdp
  $ownerPid = $cdpOwnerPid
  $ownerProc = $null
  if ($ownerPid) { $ownerProc = Get-ProcInfo ([int]$ownerPid) }

  $blocked = $false
  if ($ownerPid -and -not $healthy) {
    if (-not ($ownerProc -and $ownerProc.name -like 'chrome*')) {
      $blocked = $true
      $result.ok = $false
      $who = 'unknown'
      if ($ownerProc) { $who = "$($ownerProc.name) pid $ownerPid" } else { $who = "pid $ownerPid" }
      $result.error = "port $CdpPort is held by $who, which is not Chrome; free it or point CDP_BASE elsewhere"
    }
  }

  if (-not $blocked) {
    if ($healthy -and -not $Force) {
      $result.note = 'cdp already reachable, launch skipped'
    } else {
      $victims = @()
      if ($ownerPid) { $victims += [int]$ownerPid }
      $victims += @($procs | ForEach-Object { [int]$_.pid })
      $victims = @($victims | Select-Object -Unique | Where-Object { $_ -gt 0 -and $_ -ne $PID })
      foreach ($vp in $victims) {
        try {
          Stop-Process -Id $vp -Force -ErrorAction Stop
          $result.killed += $vp
  } catch {
        # usually a child that exited on its own between listing and killing: warn, not fail
        $result.warnings += "pid $vp was already gone"
      }
      }
      if ($victims.Count) {
        $deadline = (Get-Date).AddSeconds(6)
        while ((Get-Date) -lt $deadline) {
          if (-not (Get-CdpVersion)) { break }
          Start-Sleep -Milliseconds 400
        }
        if (Get-CdpVersion) {
          $result.ok = $false
          $result.error = "CDP port $CdpPort still responds after killing $($victims.Count) process(es)"
        }
      }

      if ($result.ok) {
        $exe = Resolve-Chrome $ChromePath
        if (-not $exe) {
          $result.ok = $false
          if ($ChromePath) {
            $result.error = "configured chrome path does not exist: $ChromePath"
          } else {
            $result.error = 'chrome.exe not found in Program Files / Program Files(x86) / LOCALAPPDATA'
          }
        } else {
          $result.chromePath = $exe
          Start-Process -FilePath $exe -ArgumentList @(
            "--remote-debugging-port=$CdpPort",
            '--remote-allow-origins=*',
            "--user-data-dir=$ProfileDir",
            '--no-first-run', '--no-default-browser-check',
            '--new-window', $Url
          ) | Out-Null
          $result.launched = $true
          $deadline = (Get-Date).AddSeconds($WaitSec)
          while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 700
            $cdp = Get-CdpVersion
            if ($cdp) { break }
          }
          if (-not $cdp) {
            $result.ok = $false
            $result.error = "chrome launched but CDP port $CdpPort was not ready within $WaitSec s"
          }
        }
      }
    }
  }
  $procs = @(Get-DebugChromeProcs)
  $mainProcs = @($procs | Where-Object { $_.kind -eq 'main' })
  $cdpOwnerPid = Get-CdpOwnerPid $CdpPort
}

if ($Action -eq 'stop') {
  # Two ways to find the target, both are "the debug instance", never the user's everyday Chrome:
  #   a) the process listening on the CDP port (works even when WMI is blocked);
  #   b) chrome.exe whose command line carries our profile dir.
  $targets = @()
  if ($cdpOwnerPid) { $targets += [int]$cdpOwnerPid }
  $targets += @($procs | Where-Object { $_.kind -eq 'main' } | ForEach-Object { $_.pid })
  $targets += @($procs | Where-Object { $_.kind -ne 'main' } | ForEach-Object { $_.pid })
  $targets = @($targets | Select-Object -Unique)

  if (-not $targets.Count) {
    $result.note = 'nothing listening on the CDP port and no chrome process with this profile dir'
  } else {
    foreach ($targetPid in $targets) {
      try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        $result.killed += $targetPid
      } catch {
        $result.note = "pid $targetPid could not be stopped: $($_.Exception.Message)"
      }
    }
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-CdpVersion)) { break }
      Start-Sleep -Milliseconds 500
    }
    if (Get-CdpVersion) {
      $result.ok = $false
      $result.error = "kill was sent but CDP port $CdpPort still responds"
    }
  }
  $procs = @(Get-DebugChromeProcs)
  $mainProcs = @($procs | Where-Object { $_.kind -eq 'main' })
  $cdpOwnerPid = Get-CdpOwnerPid $CdpPort
}

$cdpBrowser = $null
$cdpProtocol = $null
if ($cdp) {
  $cdpBrowser = [string]$cdp.Browser
  $cdpProtocol = [string]$cdp.'Protocol-Version'
}
$mainPid = $null
$mainStartedAt = $null
if ($mainProcs.Count) {
  $mainPid = [int]$mainProcs[0].pid
  $mainStartedAt = [string]$mainProcs[0].startedAt
}
$ownerInfo = $null
if ($cdpOwnerPid) { $ownerInfo = Get-ProcInfo ([int]$cdpOwnerPid) }
$allPids = @($procs | ForEach-Object { $_.pid })
if ($cdpOwnerPid -and ($allPids -notcontains [int]$cdpOwnerPid)) { $allPids += [int]$cdpOwnerPid }

$result.cdp = [ordered]@{
  reachable      = [bool]$cdp
  browser        = $cdpBrowser
  protocol       = $cdpProtocol
  ownerPid       = $cdpOwnerPid
  ownerName      = if ($ownerInfo) { $ownerInfo.name } else { $null }
  ownerStartedAt = if ($ownerInfo) { $ownerInfo.startedAt } else { $null }
}
$result.debugChrome = [ordered]@{
  count     = $procs.Count
  mainPid   = $mainPid
  pids      = $allPids
  startedAt = $mainStartedAt
}

$result | ConvertTo-Json -Depth 6 -Compress
