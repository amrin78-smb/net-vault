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

# The scheduled task runs as SYSTEM, which has a minimal PATH that does not
# include git/node/npm. Without this, "git fetch/reset" silently exits 0 with
# no binary found and the update "succeeds" with old code. Prepend the standard
# install locations so the toolchain resolves under SYSTEM.
$env:PATH = @(
    "C:\Program Files\Git\cmd",
    "C:\Program Files\Git\bin",
    "C:\Program Files\nodejs",
    "C:\Program Files\npm",
    $env:PATH
) -join ";"

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

try {

    Write-Step "Stopping NetVault service"
    Write-Host "    Running: sc.exe stop NetVault" -ForegroundColor Gray
    $svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        $null = & sc.exe stop NetVault 2>&1
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
    Write-Host "    Reading: $AppDir\.env" -ForegroundColor Gray
    $envBackup = Get-Content "$AppDir\.env" -Raw -ErrorAction SilentlyContinue
    if ($envBackup) {
        Write-OK ".env backed up"
    } else {
        Write-Warn ".env not found - will need to recreate after pull"
    }

    Write-Step "Pulling latest code from GitHub"
    Set-Location $AppDir

    # git writes informational messages (e.g. "From https://github.com/...") to
    # stderr. Under $ErrorActionPreference = 'Stop', merging stderr via 2>&1 turns
    # those lines into ErrorRecords that Stop mode treats as terminating - even
    # when git exits 0. Relax the preference around each git call, capture the real
    # exit code, then restore Stop and check the exit code explicitly.

    Write-Host "    Running: git fetch origin main" -ForegroundColor Gray
    $ErrorActionPreference = 'Continue'
    $null = & git fetch origin main 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "git fetch failed (exit $exitCode)" }

    Write-Host "    Running: git reset --hard origin/main" -ForegroundColor Gray
    $ErrorActionPreference = 'Continue'
    $gitResult = & git reset --hard origin/main 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "git reset --hard failed (exit $exitCode)" }
    Write-Host "    $gitResult" -ForegroundColor Gray

    $ErrorActionPreference = 'Continue'
    $null = & git clean -fd --exclude=".env" --exclude=".env.local" --exclude="node_modules" 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "git clean failed (exit $exitCode)" }

    $ErrorActionPreference = 'Continue'
    $headRef = & git rev-parse --short HEAD 2>&1
    $ErrorActionPreference = 'Stop'
    Write-Host "==> HEAD now: $headRef" -ForegroundColor Cyan
    Write-OK "Git reset and clean done"

    # Restore known-problematic files (best-effort, informational stderr ignored)
    $ErrorActionPreference = 'Continue'
    $null = & git checkout origin/main -- app/api/settings/route.ts 2>&1
    $null = & git checkout origin/main -- app/api/settings/logo/route.ts 2>&1
    $ErrorActionPreference = 'Stop'

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
    Write-Host "    Running: npm install" -ForegroundColor Gray
    $null = & npm install 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE) - check $InstallDir\logs\npm-install.log" }
    Write-Host "    Running: npm run build" -ForegroundColor Gray
    $null = & npm run build 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-build.log"
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE) - check $InstallDir\logs\npm-build.log" }
    Write-OK "Build complete"

    Write-Step "Copying static files into standalone output"
    $standaloneDir = "$AppDir\.next\standalone"
    Write-Host "    Standalone dir: $standaloneDir" -ForegroundColor Gray
    if (-not (Test-Path $standaloneDir)) {
        throw "Standalone directory not found after build - check $InstallDir\logs\npm-build.log"
    }
    $publicDest = "$standaloneDir\public"
    if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
    Copy-Item -Path "$AppDir\public" -Destination $publicDest -Recurse -Force
    Write-OK "Copied public/"
    New-Item -ItemType Directory -Force -Path "$standaloneDir\.next" | Out-Null
    $staticDest = "$standaloneDir\.next\static"
    if (Test-Path $staticDest) { Remove-Item $staticDest -Recurse -Force }
    Copy-Item -Path "$AppDir\.next\static" -Destination $staticDest -Recurse -Force
    Write-OK "Copied .next/static/"
    if (-not (Test-Path "$standaloneDir\server.js")) {
        throw "server.js missing from standalone output - build may have failed"
    }
    Write-OK "server.js present"

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
    Write-Host "    Running: sc.exe start NetVault" -ForegroundColor Gray
    $portProc = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    if ($portProc) {
        $procPid = $portProc.OwningProcess
        if ($procPid -and $procPid -gt 0) {
            Get-Process -Id $procPid -ErrorAction SilentlyContinue | Stop-Process -Force
            Start-Sleep -Seconds 2
            Write-OK "Cleared port 3000"
        }
    }
    $null = & sc.exe start NetVault 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sc.exe start NetVault failed (exit $LASTEXITCODE)" }
    Start-Sleep -Seconds 5
    $svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        Write-OK "NetVault service is running"
    } else {
        Write-Warn "Service may still be starting - check logs at $InstallDir\logs"
    }

} catch {
    Write-Host ""
    Write-Host "=== Update failed: $_ ===" -ForegroundColor Red
    Write-Host "    Attempting to restart NetVault service..." -ForegroundColor Yellow
    $null = & sc.exe start NetVault 2>&1
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "  Update complete. Access NetVault at: http://localhost:3000" -ForegroundColor Green
Write-Host ""
