<#
  1688 网页版旺旺监听 —— 一键启动/停止

  用法：
    .\start-im.ps1              启动（缺 Chrome 调试实例会自动拉起）并常驻监听
    .\start-im.ps1 -Rules rules.example.json            带回复规则启动（默认演练，不真发）
    .\start-im.ps1 -Rules rules.json -ReplyMode draft   命中后只填草稿，等人工点发送
    .\start-im.ps1 -Rules rules.json -ReplyMode send    命中后真实发送（慎用）
    .\start-im.ps1 -Stop        停止后台监听
    .\start-im.ps1 -Status      查看状态与最近日志

  说明：监听进程完全后台运行，日志写入 tools\qianniu\logs\
        关掉本窗口不影响监听；重启电脑后需再跑一次。
#>
param(
  [switch]$Stop,
  [switch]$Status,
  [int]$Interval = 15000,
  [double]$RefreshMin = 30,          # 每多少分钟刷新一次聊天网页（0=不刷新）
  [string]$Rules = '',
  [string]$ReplyMode = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pidFile = Join-Path $logDir 'monitor.pid'
$outLog  = Join-Path $logDir 'monitor.out.log'
$errLog  = Join-Path $logDir 'monitor.err.log'
$eventLog = Join-Path $logDir 'im-events.jsonl'

function Get-MonitorProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  $saved = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $saved) { return $null }
  $p = Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { return $p }
  return $null
}

if ($Status) {
  $p = Get-MonitorProcess
  if ($p) { "监听运行中：PID $($p.Id)" } else { "监听未运行" }
  "事件日志：$eventLog"
  if (Test-Path $eventLog) {
    "最近 5 条事件："
    Get-Content $eventLog -Tail 5
  } else { "（还没有事件）" }
  return
}

if ($Stop) {
  $p = Get-MonitorProcess
  if ($p) { Stop-Process -Id $p.Id -Force; "已停止监听（PID $($p.Id)）" }
  else { "监听未在运行" }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  return
}

# ---- 检查 Chrome 调试端口 ----
$cdpOk = $false
try {
  $v = Invoke-RestMethod 'http://127.0.0.1:9222/json/version' -TimeoutSec 3
  $cdpOk = $true
  "✅ CDP 已就绪：$($v.Browser)"
} catch { }

if (-not $cdpOk) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) { throw '找不到 Chrome，也不存在可用的 9222 调试端口。' }

  $profileDir = Join-Path $env:LOCALAPPDATA '1688-cdp-profile'
  "⚠️  CDP 端口未开，正在用独立 profile 拉起 Chrome：$profileDir"
  Start-Process -FilePath $chrome -ArgumentList @(
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    "--user-data-dir=$profileDir",
    '--no-first-run', '--no-default-browser-check', '--new-window',
    'https://work.1688.com/'
  ) | Out-Null
  Start-Sleep -Seconds 5
  "   请确认该窗口已登录 1688，并打开任意一个聊天窗口。"
}

# ---- 启动后台监听 ----
if (Get-MonitorProcess) {
  "监听已在运行，先执行 .\start-im.ps1 -Stop 再启动。"
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$args = @((Join-Path $here 'im.mjs'), 'monitor', '--interval', $Interval)
if ($RefreshMin -gt 0) { $args += @('--refresh-min', $RefreshMin) }
if ($Rules) {
  $resolved = Resolve-Path $Rules -ErrorAction SilentlyContinue
  $rulesPath = if ($resolved) { $resolved.Path } else { $Rules }
  $args += @('--rules', $rulesPath)
}
if ($ReplyMode) { $args += @('--reply-mode', $ReplyMode) }
$p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $here `
     -WindowStyle Hidden -PassThru `
     -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$p.Id | Out-File -Encoding ascii $pidFile
Start-Sleep -Seconds 4

"🚀 监听已启动（PID $($p.Id)）"
"   事件日志：$eventLog"
"   运行日志：$outLog"
"   停止命令：.\start-im.ps1 -Stop"
if (Test-Path $outLog) { "`n--- 启动输出 ---"; Get-Content $outLog -Tail 12 }
