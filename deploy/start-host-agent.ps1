<#
  Automatic Inquiry System - Windows host control agent

  Usage:
    .\deploy\start-host-agent.ps1
    .\deploy\start-host-agent.ps1 -Status
    .\deploy\start-host-agent.ps1 -Stop

  The agent owns the Node bridge, Chrome/monitor process control and the
  im.db snapshot. The Docker application calls it through host.docker.internal.
#>
param(
  [switch]$Stop,
  [switch]$Status,
  [string]$Bind = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$systemDir = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $systemDir "backend"
$logs = Join-Path $systemDir "data\logs"
$pidFile = Join-Path $logs "host-agent.pid"
$envFile = Join-Path $systemDir ".env"
$outLog = Join-Path $logs "host-agent.out.log"
$errLog = Join-Path $logs "host-agent.err.log"

New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Get-EnvValue([string]$Name, [string]$Default = "") {
  if (-not (Test-Path -LiteralPath $envFile)) { return $Default }
  $hit = Select-String -Path $envFile -Pattern "^\s*$([regex]::Escape($Name))\s*=" |
    Select-Object -First 1
  if (-not $hit) { return $Default }
  return (($hit.Line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Set-EnvValue([string]$Name, [string]$Value) {
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw ".env not found: $envFile"
  }
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $envFile)
  $pattern = "^\s*$([regex]::Escape($Name))\s*="
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pattern) { $idx = $i; break }
  }
  if ($idx -ge 0) {
    $lines[$idx] = "$Name=$Value"
  } else {
    $lines.Add("")
    $lines.Add("# Windows host control agent")
    $lines.Add("$Name=$Value")
  }
  $tmp = "$envFile.tmp"
  $lines | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $envFile -Force
}

function Ensure-Token {
  $token = Get-EnvValue "HOST_AGENT_TOKEN"
  if ($token) { return $token }
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  Set-EnvValue "HOST_AGENT_TOKEN" $token
  Write-Host "Generated HOST_AGENT_TOKEN in .env"
  return $token
}

function Get-AgentProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $saved = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $saved) { return $null }
  $p = Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -match "python") { return $p }
  return $null
}

function Get-Python {
  $candidates = @(
    (Join-Path $systemDir ".venv\Scripts\python.exe"),
    (Get-Command python -ErrorAction SilentlyContinue).Source,
    "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      & $candidate -c "import fastapi, uvicorn, httpx" 2>$null
      if ($LASTEXITCODE -eq 0) { return $candidate }
    }
  }
  throw "Python with fastapi/uvicorn/httpx not found. Run: python -m pip install -r backend\requirements.txt"
}

$port = [int](Get-EnvValue "HOST_AGENT_PORT" "7400")
if (-not $Bind) { $Bind = Get-EnvValue "HOST_AGENT_BIND" "0.0.0.0" }
$token = Ensure-Token
$headers = @{ "X-AIS-Agent-Token" = $token }
$healthUrl = "http://127.0.0.1:$port/health"

if ($Status) {
  $p = Get-AgentProcess
  if ($p) { "Host agent running: PID $($p.Id)" } else { "Host agent not running" }
  try {
    $h = Invoke-RestMethod $healthUrl -Headers $headers -TimeoutSec 4
    "Health: $($h.ok) | platform=$($h.platform) | PID=$($h.pid)"
  } catch {
    "Health check failed: $($_.Exception.Message)"
  }
  "Bind: $Bind | port: $port"
  "Logs: $logs"
  return
}

if ($Stop) {
  $p = Get-AgentProcess
  if ($p) {
    Stop-Process -Id $p.Id -Force
    "Stopped host agent (PID $($p.Id))"
  } else {
    "Host agent not running"
  }
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  return
}

if (Get-AgentProcess) {
  "Host agent is already running."
  "URL: http://127.0.0.1:$port"
  return
}

$env:HOST_AGENT_SERVER_MODE = "true"
$env:HOST_AGENT_TOKEN = $token
$env:HOST_AGENT_BIND = $Bind
$env:HOST_AGENT_PORT = "$port"

$python = Get-Python
$proc = Start-Process -FilePath $python `
  -ArgumentList @("-m", "app.host_agent") `
  -WorkingDirectory $backend `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog
$proc.Id | Out-File -Encoding ascii -LiteralPath $pidFile

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod $healthUrl -Headers $headers -TimeoutSec 2
    if ($h.ok) { $ready = $true; break }
  } catch { }
  if ($proc.HasExited) { break }
}

if (-not $ready) {
  if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 20 }
  throw "Host agent did not become ready. See $errLog"
}

"Host agent started (PID $($proc.Id))"
"Health: http://127.0.0.1:$port/health"
"Container URL: http://host.docker.internal:$port"
"Stop: .\deploy\start-host-agent.ps1 -Stop"
