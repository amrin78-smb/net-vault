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

# Resolve a path to its TRUE on-disk casing (walking each parent for the real component
# name). Get-Item().FullName only echoes the TYPED casing, which is not enough here.
function Get-TrueCasePath([string]$p) {
    try {
        $di = New-Object System.IO.DirectoryInfo([System.IO.Path]::GetFullPath($p))
        $parts = @()
        while ($null -ne $di.Parent) {
            $m = $di.Parent.GetFileSystemInfos($di.Name)
            if ($m.Count -eq 0) { return [System.IO.Path]::GetFullPath($p) }
            $parts = ,($m[0].Name) + $parts; $di = $di.Parent
        }
        $root = $di.Name; if (-not $root.EndsWith('\')) { $root += '\' }
        return $root + ($parts -join '\')
    } catch { return $p }
}
$AppDir  = "$InstallDir\app"
# Normalize the build directory to its true on-disk casing. `next build` caches absolute
# module paths in .next; if a later run's cwd casing differs (e.g. C:\Apps\NetVault vs
# ...\netvault, depending on how -InstallDir / the invocation path was typed), webpack
# treats the two casings as different modules and loads React twice -> the build crashes
# with "Cannot read properties of null (reading 'useContext')". Pin to on-disk casing.
$AppDir  = Get-TrueCasePath $AppDir
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

# Read a single value from a KEY=VALUE file (e.g. C:\ProgramData\NocVault\secrets.env).
function Get-EnvVal([string]$file, [string]$key) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=\s*(.+?)\s*$") { return $Matches[1].Trim() }
    }
    return $null
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
        # PRESERVE the existing RO password from the restored .env - it was set by the
        # suite installer (unique per-install) and must match the actual DB role. Never
        # clobber it with a literal. Only fall back on a legacy box where the key is
        # genuinely absent/empty: read the unique per-install password from the machine-level
        # secrets.env. If still unknown, leave it empty and warn (never write a bogus literal).
        $roPassLine = Get-Content "$AppDir\.env" -ErrorAction SilentlyContinue | Where-Object { $_ -match '^NOCVAULT_RO_PASS=' } | Select-Object -First 1
        $RoPass = if ($roPassLine) { $roPassLine.Substring('NOCVAULT_RO_PASS='.Length) } else { '' }
        if (-not $RoPass) { $RoPass = Get-EnvVal 'C:\ProgramData\NocVault\secrets.env' 'NOCVAULT_RO_PASS' }
        if (-not $RoPass) { Write-Warn "NOCVAULT_RO_PASS could not be determined (.env and secrets.env both missing it) - leaving read-only password empty" }
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_HOST' -Value 'localhost'
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_PORT' -Value '5432'
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_USER' -Value 'nocvault_readonly'
        Set-EnvVar -Path "$AppDir\.env" -Key 'NOCVAULT_RO_PASS' -Value $RoPass
        Write-OK "NOCVAULT_RO_* ensured in .env"
    } else {
        Write-Warn ".env was not backed up - check credentials before starting service"
    }

    # Re-apply schema.sql as the postgres superuser so existing installs pick up
    # schema changes that ship in code: new views (e.g. v_devices_flat), eol_*
    # device_id column-type fixes + their guarded retype migration, and the final
    # ownership/grant self-heal block. schema.sql is written to be idempotent, so
    # re-running it on every update is safe. Needs the postgres password, which the
    # suite installer provisions into .env as POSTGRES_PASSWORD; installs that
    # predate that key soft-skip with a warning (set POSTGRES_PASSWORD in .env to
    # enable). Non-fatal: never blocks an update.
    Write-Step "Re-applying database schema (idempotent)"
    $PgBin       = "C:\Program Files\PostgreSQL\16\bin"
    $PsqlExe     = "$PgBin\psql.exe"
    $SchemaPath  = "$AppDir\schema.sql"
    $pgLine      = Get-Content "$AppDir\.env" -ErrorAction SilentlyContinue | Where-Object { $_ -match '^POSTGRES_PASSWORD=' } | Select-Object -First 1
    $PgAdminPassword = if ($pgLine) { $pgLine.Substring('POSTGRES_PASSWORD='.Length) } else { '' }
    if (-not (Test-Path $PsqlExe)) {
        Write-Warn "psql not found at $PsqlExe - skipping schema re-apply"
    } elseif (-not (Test-Path $SchemaPath)) {
        Write-Warn "schema.sql not found at $SchemaPath - skipping schema re-apply"
    } elseif (-not $PgAdminPassword) {
        Write-Warn "POSTGRES_PASSWORD not in .env - skipping schema re-apply (add it to .env to enable on this pre-existing install)"
    } else {
        $env:PGPASSWORD = $PgAdminPassword
        Write-Host "    Running: psql -U postgres -d netvault -f schema.sql" -ForegroundColor Gray
        $ErrorActionPreference = 'Continue'
        & $PsqlExe -U postgres -h localhost -p 5432 -d netvault -f $SchemaPath 2>&1 | Tee-Object -FilePath "$InstallDir\logs\schema-apply.log" | Out-Null
        $schemaExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $env:PGPASSWORD = $null
        if ($schemaExit -eq 0) {
            Write-OK "schema.sql re-applied as postgres superuser"
        } else {
            Write-Warn "schema.sql re-apply exited $schemaExit - check $InstallDir\logs\schema-apply.log"
        }
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
        # `nssm get AppEnvironmentExtra` returns the entries as console lines with CRLF
        # endings (and can include blank lines). Feeding that value straight back to
        # `nssm set` fails with "Environment should comprise strings of the form KEY=VALUE"
        # because of the stray carriage returns / empty lines. Normalize to clean KEY=VALUE
        # lines first (strip CR, drop blanks and any line without '='), then rebuild as a
        # single LF-separated string — the exact format the suite installer uses and nssm
        # accepts.
        $curEnv   = & $NssmExe get NetVault AppEnvironmentExtra 2>$null
        $existing = @(($curEnv -join "`n") -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '=' })
        if (-not ($existing -match '^NOCVAULT_RO_USER=')) {
            # Preserve the RO password that's in .env (set above from the restored .env /
            # the per-install secrets.env) - never seed the service with a hardcoded literal.
            $roPassLine = Get-Content "$AppDir\.env" -ErrorAction SilentlyContinue | Where-Object { $_ -match '^NOCVAULT_RO_PASS=' } | Select-Object -First 1
            $RoPass = if ($roPassLine) { $roPassLine.Substring('NOCVAULT_RO_PASS='.Length) } else { Get-EnvVal 'C:\ProgramData\NocVault\secrets.env' 'NOCVAULT_RO_PASS' }
            if (-not $RoPass) { Write-Warn "NOCVAULT_RO_PASS could not be determined for service env - leaving read-only password empty" }
            # Drop any stale RO entries, then append fresh ones (idempotent, no duplicates).
            $kept    = @($existing | Where-Object { $_ -notmatch '^NOCVAULT_RO_(HOST|PORT|USER|PASS)=' })
            $roLines = @('NOCVAULT_RO_HOST=localhost', 'NOCVAULT_RO_PORT=5432', 'NOCVAULT_RO_USER=nocvault_readonly', "NOCVAULT_RO_PASS=$RoPass")
            $newEnv  = ($kept + $roLines) -join "`n"
            & $NssmExe set NetVault AppEnvironmentExtra $newEnv | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-OK "NOCVAULT_RO_* added to NetVault service env" }
            else { Write-Warn "nssm set AppEnvironmentExtra returned exit code $LASTEXITCODE (Hub RO env not written to the service config)" }
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
    # Poll /api/health instead of a fixed sleep: the app is usually serving within
    # 2-3s, so this returns as soon as it's actually up rather than always waiting 5s.
    # Falls back to the previous behaviour (warn + proceed) if it doesn't answer in
    # ~30s — same non-fatal outcome as before, never blocks the update.
    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if ($healthy) {
        Write-OK "NetVault service is running (health check passed)"
    } else {
        $svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-OK "NetVault service is running"
        } else {
            Write-Warn "Service may still be starting - check logs at $InstallDir\logs"
        }
    }

    Write-Step "Registering daily health-snapshot task"
    $cronLine = Get-Content "$AppDir\.env" | Where-Object { $_ -match '^CRON_SECRET=' } | Select-Object -First 1
    $CronSecret = if ($cronLine) { $cronLine.Substring('CRON_SECRET='.Length) } else { '' }
    if ($CronSecret) {
        $action = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
        $trigger = New-ScheduledTaskTrigger -Daily -At "00:00"
        Register-ScheduledTask -TaskName "NetVault-HealthSnapshot" -Action $action -Trigger $trigger -RunLevel Highest -Force | Out-Null
        Write-OK "Scheduled task 'NetVault-HealthSnapshot' registered (daily 00:00)"
        # No immediate baseline snapshot here - the daily scheduled task above takes
        # it tonight. Skipping it keeps the update from blocking on a post-deploy curl.
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping scheduled task registration"
    }

    Write-Step "Registering daily EOL enrichment task"
    if ($CronSecret) {
        $eolAction = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
        $eolTrigger = New-ScheduledTaskTrigger -Daily -At "01:00"
        Register-ScheduledTask -TaskName "NetVault-EnrichEol" -Action $eolAction -Trigger $eolTrigger -RunLevel Highest -Force | Out-Null
        Write-OK "Scheduled task 'NetVault-EnrichEol' registered (daily 01:00)"
        # No immediate enrichment run here - the daily scheduled task above runs it
        # tonight, and the EOL Intelligence page has a manual "Run enrichment now"
        # button for on-demand use. Skipping it shortens the update and avoids loading
        # the freshly-started server with a full ~2,500-device scan mid-deploy.
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping EOL enrichment task"
    }

    Write-Step "Registering weekly EOL feed-sync task"
    if ($CronSecret) {
        $syncAction = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/sync-eol -H `"Authorization: Bearer $CronSecret`""
        # Weekly, Sunday 00:15 - just ahead of the daily 01:00 enrichment, so Sunday's
        # enrichment applies the freshly-pulled seed. The endpoint writes ONLY eol_seed
        # (verifies the feed signature first); offline/air-gapped installs no-op safely
        # (it returns a soft skip and the bundled seed floor remains in place).
        $syncTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "00:15"
        Register-ScheduledTask -TaskName "NetVault-SyncEol" -Action $syncAction -Trigger $syncTrigger -RunLevel Highest -Force | Out-Null
        Write-OK "Scheduled task 'NetVault-SyncEol' registered (weekly Sun 00:15)"
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping EOL feed-sync task"
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
