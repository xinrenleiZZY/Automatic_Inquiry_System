<#
  Register the Windows host agent to start after this user logs on and to
  recover automatically every five minutes if it has exited.

  Usage:
    .\deploy\install-host-agent-autostart.ps1
    .\deploy\install-host-agent-autostart.ps1 -Remove
#>
param(
  [switch]$Remove,
  [string]$TaskName = "AIS-WindowsHostAgent"
)

$ErrorActionPreference = "Stop"
$systemDir = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-host-agent.ps1"
$envFile = Join-Path $systemDir ".env"

if ($Remove) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "Removed scheduled task: $TaskName"
  } else {
    "Scheduled task not found: $TaskName"
  }
  return
}

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Host agent start script not found: $startScript"
}
if (-not (Select-String -Path $envFile -Pattern '^HOST_AGENT_TOKEN=\S+' -Quiet)) {
  throw "HOST_AGENT_TOKEN is missing from .env. Run start-host-agent.ps1 once first."
}

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$escapedScript = '"' + $startScript + '"'
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File $escapedScript" `
  -WorkingDirectory $systemDir
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$recoveryTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal `
  -UserId $user `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($logonTrigger, $recoveryTrigger) `
  -Principal $principal `
  -Settings $settings `
  -Description "Start and recover the Automatic Inquiry System Windows host agent." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
$task = Get-ScheduledTask -TaskName $TaskName
"Registered scheduled task: $TaskName"
"Trigger: user logon + every 5 minutes"
"State: $($task.State)"
