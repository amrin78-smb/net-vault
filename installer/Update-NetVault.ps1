#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NetVault - Code Update Script
.DESCRIPTION
    Run this whenever you pull a new build.
    Stops the service, rebuilds, copies static files, and restarts.

    Usage:
        .\Update-NetVault.ps1
#>

$AppDir     = "C:\NetVault\app"
$InstallDir = "C:\NetVault"
$NssmExe    = "$InstallDir\nssm\nssm-2.24\win64\nssm.exe"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  NetVault - Update" -ForegroundColor White
Write-Host ""

# Stop service
Write-Step "Stopping NetVault service"
$svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Stop-Service -Name NetVault -Force
    Start-Sleep -Seconds 3
    Write-OK "Service stopped"
} else {
    Write-Warn "NetVault service was not running"
}

# Kill any leftover node processes
$node = Get-Process -Name node -ErrorAction SilentlyContinue
if ($node) {
    Stop-Process -Name node -Force
    Start-Sleep -Seconds 2
    Write-OK "Killed leftover node process"
}

# Pull latest code from GitHub
Write-Step "Pulling latest code from GitHub"
Set-Location $AppDir
$gitResult = & git pull origin main 2>&1
Write-Host "    $gitResult" -ForegroundColor Gray
Write-OK "Git pull done"

# Rebuild
Write-Step "Rebuilding NetVault"
& npm install --production=false 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
& npm run build 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-build.log"
Write-OK "Build complete"

# Copy static files into standalone output
Write-Step "Copying static files into standalone output"
$standaloneDir = "$AppDir\.next\standalone"

if (Test-Path $standaloneDir) {
    # Copy public/
    $publicDest = "$standaloneDir\public"
    if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
    Copy-Item -Path "$AppDir\public" -Destination $publicDest -Recurse -Force
    Write-OK "Copied public/"

    # Copy .next/static/
    $staticDest = "$standaloneDir\.next\static"
    New-Item -ItemType Directory -Force -Path "$standaloneDir\.next" | Out-Null
    if (Test-Path $staticDest) { Remove-Item $staticDest -Recurse -Force }
    Copy-Item -Path "$AppDir\.next\static" -Destination $staticDest -Recurse -Force
    Write-OK "Copied .next/static/"
} else {
    Write-Warn "Standalone directory not found - check build output"
}

# Verify server.js
if (Test-Path "$standaloneDir\server.js") {
    Write-OK "server.js present"
} else {
    Write-Warn "server.js missing - service may not start correctly"
}

# Start service
Write-Step "Starting NetVault service"
Start-Service -Name NetVault
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