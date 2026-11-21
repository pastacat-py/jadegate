# JadeGate server-PC setup.
# Run ONCE on the spare PC, in PowerShell opened with "Run as administrator", from the Proxy folder:
#
#   powershell -ExecutionPolicy Bypass -File .\setup-server-pc.ps1 -Password "pick-a-password"
#
# Optional: add -TunnelToken "<token from Cloudflare>" to also connect your domain (see README).
#
# What it does:
#   1. Starts JadeGate automatically when the PC boots (no login needed) and restarts it if it crashes.
#   2. Stops the PC from sleeping, turns the screen off after 5 minutes to save power.
#   3. (Optional) Installs the Cloudflare Tunnel service so your domain reaches this PC.

param(
  [string]$Password = "",
  [string]$TunnelToken = "",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Please run PowerShell as Administrator and try again." -ForegroundColor Red; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "Node.js is not installed. Get it from https://nodejs.org first." -ForegroundColor Red; exit 1 }
$dir = $PSScriptRoot

# --- 1. Settings the server reads at startup ---
[Environment]::SetEnvironmentVariable("PORT", "$Port", "Machine")
if ($Password) {
  [Environment]::SetEnvironmentVariable("JADEGATE_PASSWORD", $Password, "Machine")
  Write-Host "Password lock set."
} else {
  Write-Host "No -Password given: anyone who finds your site can use it." -ForegroundColor Yellow
}

# --- 2. Auto-start at boot, restart on crash ---
$action = New-ScheduledTaskAction -Execute $node `
  -Argument "--max-http-header-size=262144 `"$dir\server.js`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable
Register-ScheduledTask -TaskName "JadeGate" -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "JadeGate"
Write-Host "JadeGate will now start automatically with Windows (task name: JadeGate)."

# --- 3. Power: never sleep, screen off after 5 minutes ---
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 5
Write-Host "Sleep disabled; screen turns off after 5 minutes."

# --- 4. Optional Cloudflare Tunnel ---
if ($TunnelToken) {
  if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "Installing cloudflared..."
    winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine")
  }
  cloudflared service install $TunnelToken
  Write-Host "Cloudflare Tunnel installed as a Windows service."
}

Start-Sleep -Seconds 2
try {
  Invoke-WebRequest "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 5 | Out-Null
  Write-Host "`nDone! JadeGate is running at http://localhost:$Port" -ForegroundColor Green
} catch {
  Write-Host "`nSetup finished, but JadeGate didn't answer yet. Check Task Scheduler > JadeGate." -ForegroundColor Yellow
}
