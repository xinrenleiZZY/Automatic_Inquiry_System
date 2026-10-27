<#
  自动询价系统 · 原生 Windows 一键启动

  用法：
    .\deploy\start-native.ps1              # 起 API（前端已构建）
    .\deploy\start-native.ps1 -Build       # 先构建前端再起
    .\deploy\start-native.ps1 -WithMonitor # 顺便拉起 1688 常驻监听
    .\deploy\start-native.ps1 -Stop        # 停止 API
    .\deploy\start-native.ps1 -Stop -Force # 有作业在跑也强制停止（作业会被判中断）
    .\deploy\start-native.ps1 -Status      # 看状态

  说明：本脚本不改动 tools/qianniu 里的任何源码，只是调用它们。
#>
param(
  [switch]$Build,
  [switch]$WithMonitor,
  [switch]$Stop,
  [switch]$Force,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$sysDir  = Split-Path -Parent $PSScriptRoot
$root    = Split-Path -Parent $sysDir
$backend = Join-Path $sysDir 'backend'
$logs    = Join-Path $sysDir 'data\logs'
$pidFile = Join-Path $logs 'api.pid'
$port    = 6900

# 端口只认 .env 里的 APP_PORT，改一行就换端口，避免多处硬编码漏改
$envFile = Join-Path $sysDir '.env'
if (Test-Path $envFile) {
  $hit = Select-String -Path $envFile -Pattern '^\s*APP_PORT\s*=' | Select-Object -First 1
  if ($hit) { $port = [int](($hit.Line -split '=', 2)[1].Trim()) }
}

New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Get-ApiProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  $saved = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $saved) { return $null }
  $p = Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -match 'python') { return $p }
  return $null
}

function Get-Python {
  $cands = @(
    (Join-Path $sysDir '.venv\Scripts\python.exe'),
    (Get-Command python -ErrorAction SilentlyContinue).Source,
    'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  )
  foreach ($c in $cands) {
    if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }
    & $c -c 'import fastapi, uvicorn, httpx, jwt' 2>$null
    if ($LASTEXITCODE -eq 0) { return $c }
  }
  throw '找不到已安装依赖的 Python；请执行：python -m pip install -r backend\requirements.txt'
}

function Get-BusyJob {
  # 队列里正在执行的作业；服务没起来 / 接口超时则返回 $null
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 3
    if ($h.busy) { return $h.job }
  } catch { }
  return $null
}

if ($Status) {
  $p = Get-ApiProcess
  if ($p) { "API 运行中：PID $($p.Id)" } else { "API 未运行" }
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 3
    "健康检查：$($h.status)"
    $busy = Get-BusyJob
    if ($busy) { "正在执行：$($busy.id)（$($busy.type)）" } else { "队列：空闲" }
  } catch { "健康检查失败：$_" }
  "日志目录：$logs"
  return
}

if ($Stop) {
  $p = Get-ApiProcess
  if ($p) {
    $busy = Get-BusyJob
    if ($busy -and -not $Force) {
      "拒绝停止：作业 $($busy.id)（$($busy.type)）正在执行。"
      "等它跑完再停；确需立即重启请加 -Force（作业会被标记为中断，可在日志中心续跑）。"
      exit 1
    }
    Stop-Process -Id $p.Id -Force
    "已停止 API（PID $($p.Id)）"
  } else { "API 未在运行" }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  return
}

$dist = Join-Path $sysDir 'frontend\dist\index.html'
if ($Build -or -not (Test-Path $dist)) {
  if (-not (Test-Path $dist)) { "前端还没构建，正在构建…" }
  Push-Location (Join-Path $sysDir 'frontend')
  try {
    if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund }
    npm run build
  } finally { Pop-Location }
}

if (Get-ApiProcess) {
  "API 已在运行（先执行 -Stop 再启动）。"
} else {
  $py = Get-Python
  $p = Start-Process -FilePath $py `
    -ArgumentList '-m','uvicorn','main:app','--host','0.0.0.0','--port',"$port",'--log-level','info' `
    -WorkingDirectory $backend -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs 'api.out.log') `
    -RedirectStandardError  (Join-Path $logs 'api.err.log')
  $p.Id | Out-File -Encoding ascii $pidFile
  Start-Sleep -Seconds 5
  "API 已启动（PID $($p.Id)）"
}

if ($WithMonitor) {
  $script = Join-Path $root 'tools\qianniu\start-im.ps1'
  "正在拉起 1688 常驻监听（关掉自刷新，刷新交给队列）…"
  & $script -Interval 15000 -RefreshMin 0
}

""
"访问地址： http://127.0.0.1:$port"
"接口文档： http://127.0.0.1:$port/docs"
"停止命令： .\deploy\start-native.ps1 -Stop"
