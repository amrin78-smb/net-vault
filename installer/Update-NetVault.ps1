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

# The in-app updater (Settings -> Updates) is fire-and-forget: it schedules this
# script as a SYSTEM task (schtasks /create ... /ru SYSTEM, then schtasks /run)
# and immediately returns { started: true } to the browser, with no live output
# stream. Without a transcript, a run triggered that way leaves NO durable
# record of what happened - every Write-Host/Write-Step/Write-OK/Write-Warn line
# below is otherwise lost the moment the scheduled task's process exits, which
# is exactly the case that most needs diagnosing. Start it as early as possible
# (before pre-flight / git / build) so even an early failure is captured.
# Best-effort: a transcript that fails to start must never block the actual
# update. (Mirrors Update-SpanVault.ps1's fix for this same gap.)
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
$transcriptPath = Join-Path "$InstallDir\logs" "update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
try { Start-Transcript -Path $transcriptPath -Append | Out-Null } catch { Write-Warning "Could not start transcript: $($_.Exception.Message)" }

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
# Self-locate the app root. This script lives at <appRoot>\installer\Update-NetVault.ps1,
# so the real app root is the PARENT of the script's own folder. This is correct on BOTH
# the suite install (C:\Apps\NetVault\app) and a standalone install (C:\Apps\netvault),
# regardless of what -InstallDir is (or isn't) passed. The -InstallDir param is kept for
# backward-compat but NO LONGER drives any path - self-location always wins, so the updater
# can never Set-Location to a non-repo parent dir and leave services down. (Mirrors
# LogVault/DDIVault's fix for this exact class of bug — see their installer/Update-*.ps1.)
$AppDir  = Split-Path -Parent $PSScriptRoot
# Normalize the build directory to its true on-disk casing. `next build` caches absolute
# module paths in .next; if a later run's cwd casing differs (e.g. C:\Apps\NetVault vs
# ...\netvault, depending on how the invocation path was typed), webpack
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

# --- Resilience: rollback + structured status reporting -------------------
# NetVault is the suite hub (SSO, licensing) - a failed update must never leave
# it sitting on broken/partial code with no working service. The mechanism:
# snapshot the current commit + build output BEFORE any mutation, and if any
# stage from here fails, revert to that snapshot, restart, and re-verify health
# before giving up. Every run (success or failure) writes a structured status
# file the app itself reads (GET /api/system/last-update-status) to surface a
# banner - so "the updater silently left it broken" is no longer possible.
$StatusPath      = "$InstallDir\logs\last-update-status.json"
$prevCommit      = $null   # full HEAD sha before this update touched anything
$attemptedCommit = $null   # full HEAD sha this update tried to move to
$currentStage    = 'init'
$schemaWarning   = $null
$envBackup       = $null
$standaloneEnvBackup = $null

$StageCodes = @{
    'init'            = 5
    'pre-flight'      = 10
    'git-pull'        = 20
    'npm-install'     = 30
    'npm-build'       = 40
    'static-copy'     = 45
    'service-start'   = 50
    'health-check'    = 60
    'rollback-failed' = 70
}

function Write-StatusJson {
    param(
        [bool]$Success,
        [string]$Stage,
        [int]$ErrorCode = 0,
        [string]$ErrorMessage = $null,
        [bool]$RolledBack = $false,
        [bool]$HealthCheckPassed = $false
    )
    $status = [ordered]@{
        timestamp         = (Get-Date).ToString('o')
        success           = $Success
        stage             = $Stage
        errorCode         = $ErrorCode
        errorMessage      = $ErrorMessage
        previousCommit    = $prevCommit
        attemptedCommit   = $attemptedCommit
        finalCommit       = if ($RolledBack) { $prevCommit } else { $attemptedCommit }
        rolledBack        = $RolledBack
        healthCheckPassed = $HealthCheckPassed
        schemaWarning     = $schemaWarning
    }
    try {
        $status | ConvertTo-Json | Out-File -FilePath $StatusPath -Encoding UTF8
    } catch {
        Write-Warn "Could not write status file $StatusPath - $($_.Exception.Message)"
    }
}

# Poll /api/health until it answers 200 or $TimeoutSec elapses. Shared by the
# main flow's mandatory final health check and the rollback recovery path.
function Wait-Healthy([int]$TimeoutSec = 60) {
    Write-Host "    Waiting for NetVault to respond on :3000 " -ForegroundColor Gray -NoNewline
    $healthy = $false
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        try {
            # 127.0.0.1, not localhost - see the comment on the original health poll below.
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        } catch {}
        Write-Host "." -ForegroundColor DarkGray -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    return $healthy
}

# Revert to the pre-update commit + build output, restart the service, and
# confirm the OLD version actually answers /api/health before declaring the
# rollback itself successful. NSSM serves the app from .next\standalone\
# server.js, which bundles its own self-contained node_modules - restoring
# that folder alone is enough to bring back a fully working prior version,
# independent of whatever state the root node_modules/build cache was left in
# by the failed npm install/build. Returns $true only if the OLD version is
# confirmed back up and healthy.
function Invoke-Rollback([string]$Reason) {
    Write-Host ""
    Write-Step "ROLLING BACK - reason: $Reason"
    $ok = $true
    try {
        Set-Location $AppDir
        if ($prevCommit) {
            Write-Host "    Reverting source to $prevCommit" -ForegroundColor Gray
            $ErrorActionPreference = 'Continue'
            $null = & git reset --hard $prevCommit 2>&1
            $rbExit = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            if ($rbExit -eq 0) { Write-OK "Source reverted" } else { Write-Warn "git reset during rollback failed (exit $rbExit)"; $ok = $false }
        } else {
            Write-Warn "No pre-update commit recorded - skipping source revert"
        }

        $standaloneDir    = "$AppDir\.next\standalone"
        $standaloneBackup = "$AppDir\.next\standalone.lastgood"
        if (Test-Path $standaloneBackup) {
            if (Test-Path $standaloneDir) { Remove-Item $standaloneDir -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $standaloneBackup -NewName 'standalone' -ErrorAction Stop
            Write-OK "Restored last known-good build output"
        } else {
            Write-Warn "No last known-good build snapshot found - cannot restore a working standalone build"
            $ok = $false
        }

        if ($envBackup) { $envBackup | Out-File -FilePath "$AppDir\.env" -Encoding UTF8 -NoNewline }
        if ($standaloneEnvBackup -and (Test-Path $standaloneDir)) {
            $standaloneEnvBackup | Out-File -FilePath "$standaloneDir\.env.local" -Encoding UTF8 -NoNewline
        }

        Write-Step "Restarting NetVault on last known-good version"
        $portProc = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
        if ($portProc) {
            $procPid = $portProc.OwningProcess
            if ($procPid -and $procPid -gt 0) {
                Get-Process -Id $procPid -ErrorAction SilentlyContinue | Stop-Process -Force
                Start-Sleep -Seconds 2
            }
        }
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe start NetVault 2>&1
        $startExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($startExit -ne 0 -and $startExit -ne 1056) {
            Write-Warn "sc.exe start NetVault failed during rollback (exit $startExit)"
            $ok = $false
        }

        $healthy = Wait-Healthy -TimeoutSec 30
        if ($healthy) { Write-OK "Rollback verified - last known-good version is up and healthy" }
        else { Write-Warn "Rollback restart did not pass the health check"; $ok = $false }
        return ($ok -and $healthy)
    } catch {
        Write-Warn "Rollback itself failed: $($_.Exception.Message)"
        return $false
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
        # sc.exe writes informational output that can end up on stderr; under
        # $ErrorActionPreference = 'Stop', merging it via 2>&1 turns that into a
        # terminating ErrorRecord even on a clean stop. Same class of bug fixed
        # below for git/npm/psql — relax Stop around this call too.
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe stop NetVault 2>&1
        $ErrorActionPreference = 'Stop'
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

    $currentStage = 'pre-flight'
    Write-Step "Snapshotting current version for rollback"
    Set-Location $AppDir
    try {
        $ErrorActionPreference = 'Continue'
        $rp = & git rev-parse HEAD 2>&1
        $ErrorActionPreference = 'Stop'
        if ($rp -match '^[0-9a-f]{40}$') { $prevCommit = $rp }
    } catch { $prevCommit = $null }
    if ($prevCommit) { Write-OK "Current commit: $prevCommit" }
    else { Write-Warn "Could not determine current commit - rollback will not be able to revert source" }

    # NSSM serves the app straight out of .next\standalone (self-contained, own
    # node_modules copy) - `npm run build` wipes and regenerates this directory
    # from scratch, so it must be snapshotted before the build touches it. The
    # service was already stopped above, so nothing still holds a file handle
    # into it. Clear any stale backup from a prior interrupted run first so we
    # always snapshot the CURRENTLY-serving build, not an older leftover one.
    $standaloneDir    = "$AppDir\.next\standalone"
    $standaloneBackup = "$AppDir\.next\standalone.lastgood"
    if (Test-Path $standaloneBackup) { Remove-Item $standaloneBackup -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $standaloneDir) {
        Rename-Item -Path $standaloneDir -NewName 'standalone.lastgood' -ErrorAction Stop
        Write-OK "Snapshotted current build output for rollback"
    } else {
        Write-Warn "No existing build output to snapshot (first run?) - a failure below could not be rolled back to a working build"
    }

    Write-Step "Pulling latest code from GitHub"
    $currentStage = 'git-pull'
    Set-Location $AppDir

    # SYSTEM has never run git in this repo before (only whichever interactive
    # account originally cloned it has), and Git >= 2.35.2 (CVE-2022-24765)
    # refuses to operate in a repo it doesn't consider "owned" by the current
    # account: "fatal: detected dubious ownership in repository at '...'". A
    # failure here was previously only surfaced as a thrown "git fetch failed"
    # below, aborting the update - but worse, if a future edit ever loosened
    # that into a tolerated warning (as SpanVault's script does), this could
    # silently keep redeploying the OLD checkout while reporting success.
    # Register this repo as safe for whichever account is running right now
    # (idempotent - safe to add the same path twice) so this class of failure
    # can't happen at all. (Mirrors Update-SpanVault.ps1's fix for this same gap.)
    try { $null = & git config --global --add safe.directory $AppDir 2>&1 } catch {}

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
    $rp = & git rev-parse HEAD 2>&1
    $ErrorActionPreference = 'Stop'
    if ($rp -match '^[0-9a-f]{40}$') { $attemptedCommit = $rp }
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
        # -v ON_ERROR_STOP=1 (added 2026-07-23): without it, psql prints a SQL
        # error (e.g. a CREATE VIEW referencing a nonexistent column) and just
        # keeps going, exiting 0 at the end as if nothing failed — which is
        # exactly how a broken security fix (revoking readonly-role access to
        # users.password_hash/app_settings.license_key) shipped silently
        # un-applied for a full release. With this flag, the FIRST real SQL
        # error aborts psql with a nonzero exit, so $schemaExit below is now
        # trustworthy. Statements schema.sql relies on for idempotency
        # (IF NOT EXISTS / IF EXISTS / OR REPLACE / ON CONFLICT) are not
        # errors when the object already exists, so re-runs stay silent and
        # successful as before - only a genuine SQL error now stops the script.
        Write-Host "    Running: psql -U postgres -d netvault -f schema.sql" -ForegroundColor Gray
        $ErrorActionPreference = 'Continue'
        & $PsqlExe -U postgres -h localhost -p 5432 -d netvault -v ON_ERROR_STOP=1 -f $SchemaPath 2>&1 | Tee-Object -FilePath "$InstallDir\logs\schema-apply.log" | Out-Null
        $schemaExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $env:PGPASSWORD = $null
        if ($schemaExit -eq 0) {
            Write-OK "schema.sql re-applied as postgres superuser"
        } else {
            # Non-fatal by design (a pre-existing install may be mid-migration and
            # this step is a best-effort self-heal) - but this is now a REAL SQL
            # error, not noise, and may mean a security-relevant grant/view (e.g.
            # users_public/app_settings_public) did not apply. Surfaced loudly via
            # Write-Warn plus the full psql output already in schema-apply.log, AND
            # recorded on the status file (schemaWarning) so it surfaces in the
            # in-app banner even on an otherwise-successful update - a schema error
            # doesn't take the hub down, but it still needs a human to look at it.
            $schemaWarning = "schema.sql re-apply failed (exit $schemaExit) - check $InstallDir\logs\schema-apply.log"
            Write-Warn "schema.sql re-apply FAILED (exit $schemaExit) - a SQL statement errored and the schema may be partially applied (possibly including security-relevant grants/views). Check $InstallDir\logs\schema-apply.log and re-run manually."
        }
    }

    Write-Step "Rebuilding NetVault"
    $currentStage = 'npm-install'
    Write-Host "    Running: npm install" -ForegroundColor Gray
    # npm writes deprecation/audit notices to stderr (e.g. "This endpoint is being
    # retired..."). Under $ErrorActionPreference = 'Stop', merging that via 2>&1
    # turns a benign notice into a terminating ErrorRecord even though npm exits 0
    # — same class of bug already fixed above for git/psql. Relax Stop around the
    # call, capture the real exit code, then restore Stop and check that instead.
    $ErrorActionPreference = 'Continue'
    $null = & npm install 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "npm install failed (exit $exitCode) - check $InstallDir\logs\npm-install.log" }
    $currentStage = 'npm-build'
    Write-Host "    Running: npm run build" -ForegroundColor Gray
    $ErrorActionPreference = 'Continue'
    $null = & npm run build 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-build.log"
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "npm run build failed (exit $exitCode) - check $InstallDir\logs\npm-build.log" }
    Write-OK "Build complete"

    Write-Step "Copying static files into standalone output"
    $currentStage = 'static-copy'
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

    # NocVault Hub read-only DB credentials (NOCVAULT_RO_*) reach the running app via the
    # standalone runtime env file .next/standalone/.env.local (written just above), which the
    # Next standalone server loads at startup — that is the mechanism NetVault actually reads,
    # and it is verified working (Hub cross-DB reads succeed).
    #
    # We intentionally do NOT also push them into the NSSM AppEnvironmentExtra. nssm's
    # multi-value AppEnvironmentExtra set (a single argument with several KEY=VALUE lines)
    # rejects the value from a read-modify-write with "Environment should comprise strings of
    # the form KEY=VALUE" (exit 6), and it is redundant here — so it only produced a confusing
    # error on every update while the app worked fine off .env.local. Removed to keep the
    # update output clean.
    Write-Step "NocVault Hub read-only env"
    Write-OK "Provided via standalone .env.local (NOCVAULT_RO_* written above)"

    Write-Step "Starting NetVault service"
    $currentStage = 'service-start'
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
    # Relax Stop around sc.exe too — same stderr-as-terminating-error risk as the
    # git/npm/psql calls above.
    $ErrorActionPreference = 'Continue'
    $null = & sc.exe start NetVault 2>&1
    $ErrorActionPreference = 'Stop'
    # Exit 1056 = ERROR_SERVICE_ALREADY_RUNNING, and that's expected here, not a
    # failure: NSSM's own AppRestartDelay (3s) auto-relaunches its child the
    # moment the process this script just killed (above, or the port-3000 clear
    # right before this call) exits unexpectedly — the "NetVault" service itself
    # (the NSSM wrapper) never actually stopped from SCM's point of view, it just
    # lost and regrew its child. By the time this sc.exe start runs, SCM correctly
    # reports "already running". Treat that as success and let the health poll
    # below be the real source of truth, instead of throwing on a technically-true
    # but misleading exit code (this previously reported "Update failed" for
    # updates that had actually succeeded).
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1056) { throw "sc.exe start NetVault failed (exit $LASTEXITCODE)" }

    # Mandatory final health check (item 4 of the resilience plan): exit code 0
    # from sc.exe/npm is NOT sufficient proof the update succeeded - a service
    # that "started" per SCM but is stuck crash-looping or never opens its port
    # must not be reported as a successful update. If this fails, treat it the
    # same as any other stage failure below (triggers the rollback path).
    $currentStage = 'health-check'
    $healthy = Wait-Healthy -TimeoutSec 60
    if (-not $healthy) {
        throw "NetVault did not answer /api/health within 60s of starting - service may be crash-looping or stuck"
    }
    Write-OK "NetVault service is running (health check passed)"

    Write-Step "Registering daily health-snapshot task"
    $cronLine = Get-Content "$AppDir\.env" | Where-Object { $_ -match '^CRON_SECRET=' } | Select-Object -First 1
    $CronSecret = if ($cronLine) { $cronLine.Substring('CRON_SECRET='.Length) } else { '' }
    if ($CronSecret) {
        $action = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
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
        $eolAction = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
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
        $syncAction = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/sync-eol -H `"Authorization: Bearer $CronSecret`""
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

    # Update succeeded and is confirmed healthy - the pre-update snapshot is no
    # longer needed. Remove it so it doesn't accumulate across updates or get
    # mistaken for a stale rollback target on the next run.
    $standaloneBackup = "$AppDir\.next\standalone.lastgood"
    if (Test-Path $standaloneBackup) { Remove-Item $standaloneBackup -Recurse -Force -ErrorAction SilentlyContinue }

    Write-StatusJson -Success $true -Stage $null -ErrorCode 0 -RolledBack $false -HealthCheckPassed $true

} catch {
    $failureMessage = $_.Exception.Message
    Write-Host ""
    Write-Host "=== Update failed at stage '$currentStage': $failureMessage ===" -ForegroundColor Red
    $code = if ($StageCodes.ContainsKey($currentStage)) { $StageCodes[$currentStage] } else { 99 }

    # This is the "make it foolproof" step: don't just attempt a blind restart of
    # whatever code is currently on disk (which may be the broken half-updated
    # version) - revert to the last known-good commit + build output first, THEN
    # restart, THEN re-verify /api/health before calling it recovered.
    $rollbackOk = Invoke-Rollback -Reason $failureMessage
    if (-not $rollbackOk) {
        Write-Host ""
        Write-Host "    !!! ROLLBACK ALSO FAILED - NetVault may be DOWN. Manual intervention required. !!!" -ForegroundColor Red
        $code = $StageCodes['rollback-failed']
    }

    Write-StatusJson -Success $false -Stage $currentStage -ErrorCode $code -ErrorMessage $failureMessage -RolledBack $rollbackOk -HealthCheckPassed $rollbackOk

    Write-Host ""
    # Best-effort - flush the transcript before exiting so a failed run started
    # by the fire-and-forget SYSTEM task still leaves a durable record.
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}

Write-Host ""
Write-Host "  Update complete. Access NetVault at: http://localhost:3000" -ForegroundColor Green
Write-Host ""

# Best-effort - if Start-Transcript never succeeded (see top of script), this
# throws harmlessly; never let it mask the update's own success/failure.
try { Stop-Transcript | Out-Null } catch {}
