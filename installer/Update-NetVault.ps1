#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NetVault - Code Update Script
.DESCRIPTION
    Stops the service, pulls latest code from GitHub, rebuilds,
    copies static files, and restarts. Preserves .env file.
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
Write-Step "Stopping NetVault service"
$svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Stop-Service -Name NetVault -Force
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
# Reset hard to match GitHub exactly
$gitResult = & git reset --hard origin/main 2>&1
Write-Host "    $gitResult" -ForegroundColor Gray
# Clean any untracked or modified files that survived the reset
# But preserve .env and .env.local
& git clean -fd --exclude=".env" --exclude=".env.local" --exclude="node_modules" 2>&1 | Out-Null
Write-OK "Git reset and clean done"
# Explicitly restore known-problematic files to prevent BOM/CRLF issues
& git checkout origin/main -- app/api/settings/route.ts 2>&1 | Out-Null
& git checkout origin/main -- app/api/settings/logo/route.ts 2>&1 | Out-Null
# Restore .env after git reset
Write-Step "Restoring .env"
if ($envBackup) {
    $envBackup | Out-File -FilePath "$AppDir\.env" -Encoding UTF8 -NoNewline
    Write-OK ".env restored"
} else {
    Write-Warn ".env was not backed up - check credentials before starting service"
}
Write-Step "Rebuilding NetVault"
& npm install --production=false 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
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
Write-Step "Starting NetVault service"
# Kill any process still holding port 3000
$portProc = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($portProc) {
    Get-Process -Id $portProc.OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-OK "Cleared port 3000"
}
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
