#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NetVault - Code Update Script
.DESCRIPTION
    Stops the service, pulls latest code from GitHub, rebuilds,
    copies static files, and restarts. Preserves .env file.
.PARAMETER InstallDir
    Root installation directory (default: C:\Apps\NetVault)
#>
param(
    [string]$InstallDir = "C:\Apps\NetVault",
    [string]$ServerIp = ""
)

$ErrorActionPreference = 'Stop'
Write-Host "=== Update starting in 5 seconds ==="
Start-Sleep -Seconds 5

$AppDir  = "$InstallDir\app"
$NssmExe = "$InstallDir\nssm\nssm-2.24\win64\nssm.exe"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }

function Set-EnvVar([string]$Path, [string]$Key, [string]$Value) {
    if (Test-Path $Path) {
        $lines = Get-Content $Path -ErrorAction SilentlyContinue
        $found = $false
        $updated = $lines | ForEach-Object {
            if ($_ -match "^$Key=") { $found = $true; "$Key=$Value" } else { $_ }
        }
        if (-not $found) { $updated = @($updated) + "$Key=$Value" }
        ($updated -join "`n") | Out-File -FilePath $Path -Encoding UTF8 -NoNewline
    } else {
        "$Key=$Value" | Out-File -FilePath $Path -Encoding UTF8 -NoNewline
    }
}

Write-Host ""
Write-Host "  NetVault - Update" -ForegroundColor White
Write-Host "  Install directory : $InstallDir" -ForegroundColor Gray
Write-Host ""

Write-Step "Stopping NetVault service"
$svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    & sc.exe stop NetVault | Out-Null
    Start-Sleep -Seconds 3
    Write-OK "Service stopped"
} else {
    Write-Warn "NetVault service was not running"
}
$node = Get-Process -Name node -ErrorAction SilentlyContinue
if ($node) {
    Stop-Process -Name node -Force
    Start-Sleep -Seconds 2
    Write-OK "Killed leftover node process"
}

# Backup .env before git reset
Write-Step "Backing up .env"
$envBackup = Get-Content "$AppDir\.env" -Raw -ErrorAction SilentlyContinue
if ($envBackup) {
    Write-OK ".env backed up"
} else {
    Write-Warn ".env not found - will need to recreate after pull"
}

Write-Step "Pulling latest code from GitHub"
Set-Location $AppDir
& git fetch origin 2>&1 | Out-Null
$gitResult = & git reset --hard origin/main 2>&1
Write-Host "    $gitResult" -ForegroundColor Gray
& git clean -fd --exclude=".env" --exclude=".env.local" --exclude="node_modules" 2>&1 | Out-Null
Write-OK "Git reset and clean done"

# Restore known-problematic files
& git checkout origin/main -- app/api/settings/route.ts 2>&1 | Out-Null
& git checkout origin/main -- app/api/settings/logo/route.ts 2>&1 | Out-Null

# Restore .env after git reset
Write-Step "Restoring .env"
if ($envBackup) {
    $envBackup | Out-File -FilePath "$AppDir\.env" -Encoding UTF8 -NoNewline
    Write-OK ".env restored"
    if ($ServerIp -and -not (Select-String -Path "$AppDir\.env" -Pattern "^SERVER_IP=" -Quiet -ErrorAction SilentlyContinue)) {
        Add-Content -Path "$AppDir\.env" -Value "`nSERVER_IP=$ServerIp"
        Write-OK "SERVER_IP added to .env"
    }
} else {
    Write-Warn ".env was not backed up - check credentials before starting service"
}

Write-Step "Rebuilding NetVault"
& npm install 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
& npm run build 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-build.log"
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Build failed - check $InstallDir\logs\npm-build.log"
    exit 1
}
Write-OK "Build complete"

Write-Step "Copying static files into standalone output"
$standaloneDir = "$AppDir\.next\standalone"
if (Test-Path $standaloneDir) {
    $publicDest = "$standaloneDir\public"
    if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
    Copy-Item -Path "$AppDir\public" -Destination $publicDest -Recurse -Force
    Write-OK "Copied public/"
    New-Item -ItemType Directory -Force -Path "$standaloneDir\.next" | Out-Null
    $staticDest = "$standaloneDir\.next\static"
    if (Test-Path $staticDest) { Remove-Item $staticDest -Recurse -Force }
    Copy-Item -Path "$AppDir\.next\static" -Destination $staticDest -Recurse -Force
    Write-OK "Copied .next/static/"
} else {
    Write-Warn "Standalone directory not found - check build output"
    exit 1
}

if (Test-Path "$standaloneDir\server.js") {
    Write-OK "server.js present"
} else {
    Write-Warn "server.js missing - service may not start correctly"
    exit 1
}

Write-Step "Writing env vars to standalone runtime"
$standaloneEnvPath = "$standaloneDir\.env.local"
$rootEnvPath = "$AppDir\.env"
if (Test-Path $rootEnvPath) {
    foreach ($key in @('DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'SERVER_IP')) {
        $line = Get-Content $rootEnvPath | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
        if ($line) {
            $val = $line.Substring($key.Length + 1)
            Set-EnvVar -Path $standaloneEnvPath -Key $key -Value $val
            Write-OK "$key -> .next/standalone/.env.local"
        }
    }
} else {
    Write-Warn "Root .env not found - standalone .env.local not updated"
}

Write-Step "Starting NetVault service"
$portProc = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($portProc) {
    $pid = $portProc.OwningProcess
    if ($pid -and $pid -gt 0) {
        Get-Process -Id $pid -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
        Write-OK "Cleared port 3000"
    }
}
& sc.exe start NetVault | Out-Null
Start-Sleep -Seconds 5
$svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-OK "NetVault service is running"
} else {
    Write-Warn "Service may still be starting - check logs at $InstallDir\logs"
}

Write-Host ""
Write-Host "  Update complete. Access NetVault at: http://localhost:3000" -ForegroundColor Green
Write-Host ""
