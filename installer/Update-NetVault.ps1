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

    # Also back up the standalone .env.local. `npm run build` regenerates
    # .next\standalone from scratch and wipes it, so without this any keys placed
    # there (including manual edits) are lost on every update. We restore it
    # verbatim after the build, then refresh the managed keys on top.
    $standaloneEnvBackup = Get-Content "$AppDir\.next\standalone\.env.local" -Raw -ErrorAction SilentlyContinue
    if ($standaloneEnvBackup) { Write-OK "standalone .env.local backed up" }

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
        # Existing installs predate CRON_SECRET - generate one if missing
        if (-not (Select-String -Path "$AppDir\.env" -Pattern "^CRON_SECRET=" -Quiet -ErrorAction SilentlyContinue)) {
            $CronSecret = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
            Set-EnvVar -Path "$AppDir\.env" -Key 'CRON_SECRET' -Value $CronSecret
            Write-OK "CRON_SECRET generated and added to .env"
        }
        # NocVault Hub cross-DB read role (added for existing installs that predate the Hub).
        # nocvault_readonly is SELECT-only across all suite DBs; the Hub reads via it.
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_HOST' -Value 'localhost'
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_PORT' -Value '5432'
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_USER' -Value 'nocvault_readonly'
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_PASS' -Value 'NVReadOnly@2026!'
        Write-OK "NOCVAULT_RO_* ensured in .env"
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
    # Restore the pre-build standalone .env.local first, so any keys we don't
    # explicitly propagate (manual edits) survive the rebuild. The whitelist
    # below then refreshes the managed keys on top.
    if ($standaloneEnvBackup) {
        $standaloneEnvBackup | Out-File -FilePath $standaloneEnvPath -Encoding UTF8 -NoNewline
        Write-OK "standalone .env.local restored (manual keys preserved)"
    }
    if (Test-Path $rootEnvPath) {
        foreach ($key in @('DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'SERVER_IP', 'CRON_SECRET', 'NOCVAULT_RO_HOST', 'NOCVAULT_RO_PORT', 'NOCVAULT_RO_USER', 'NOCVAULT_RO_PASS')) {
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

    # Ensure the NocVault Hub read-role env is also in the NSSM service config
    # (idempotent — existing services predate it). Same vars as .env / standalone.
    Write-Step "Ensuring NocVault Hub env in service config"
    if (Test-Path $NssmExe) {
        $curEnv = & $NssmExe get NetVault AppEnvironmentExtra 2>$null
        $curStr = ($curEnv | Out-String).Trim()
        if ($curStr -notmatch 'NOCVAULT_RO_USER=') {
            $roLines = "NOCVAULT_RO_HOST=localhost`nNOCVAULT_RO_PORT=5432`nNOCVAULT_RO_USER=nocvault_readonly`nNOCVAULT_RO_PASS=NVReadOnly@2026!"
            $newEnv = if ($curStr) { "$curStr`n$roLines" } else { $roLines }
            & $NssmExe set NetVault AppEnvironmentExtra $newEnv | Out-Null
            Write-OK "NOCVAULT_RO_* added to NetVault service env"
        } else {
            Write-OK "NOCVAULT_RO_* already present in service env"
        }
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

    Write-Step "Registering daily health-snapshot task"
    $cronLine = Get-Content "$AppDir\.env" | Where-Object { $_ -match '^CRON_SECRET=' } | Select-Object -First 1
    $CronSecret = if ($cronLine) { $cronLine.Substring('CRON_SECRET='.Length) } else { '' }
    if ($CronSecret) {
        $action = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
        $trigger = New-ScheduledTaskTrigger -Daily -At "00:00"
        Register-ScheduledTask -TaskName "NetVault-HealthSnapshot" -Action $action -Trigger $trigger -RunLevel Highest -Force | Out-Null
        Write-OK "Scheduled task 'NetVault-HealthSnapshot' registered (daily 00:00)"
        # Immediate baseline snapshot so the trend has a starting point
        Write-Step "Taking baseline health snapshot"
        try {
            Start-Sleep -Seconds 3
            & curl.exe -s -X POST "http://localhost:3000/api/system/health-snapshot" -H "Authorization: Bearer $CronSecret" | Out-Null
            Write-OK "Baseline health snapshot recorded"
        } catch { Write-Warn "Baseline snapshot call failed (will be taken by the scheduler tonight)" }
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping scheduled task registration"
    }

    Write-Step "Registering daily EOL enrichment task"
    if ($CronSecret) {
        $eolAction = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
        $eolTrigger = New-ScheduledTaskTrigger -Daily -At "01:00"
        Register-ScheduledTask -TaskName "NetVault-EnrichEol" -Action $eolAction -Trigger $eolTrigger -RunLevel Highest -Force | Out-Null
        Write-OK "Scheduled task 'NetVault-EnrichEol' registered (daily 01:00)"
        # Run once now so EOL dates populate immediately from the curated seed
        Write-Step "Running EOL enrichment"
        try {
            Start-Sleep -Seconds 2
            & curl.exe -s -X POST "http://localhost:3000/api/system/enrich-eol" -H "Authorization: Bearer $CronSecret" | Out-Null
            Write-OK "EOL enrichment run complete"
        } catch { Write-Warn "EOL enrichment call failed (will run by the scheduler tonight)" }
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping EOL enrichment task"
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
