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

# The in-app updater's scheduled task (see the comment below) is created with a
# bare `schtasks /create`, which leaves the task at Task Scheduler's DEFAULT
# priority level (7), mapping to the BelowNormal process priority class - unlike
# a manually-run script from an interactive PowerShell window, which gets the
# normal Normal priority class. This starves the CPU-bound `npm run build` step
# (full TypeScript type-check + Turbopack compile) under any contention from the
# rest of the suite (Postgres, the other 3 apps, their collectors) running at
# Normal-or-higher, making an in-app-triggered update look "stuck" at that step
# even though it's just being continuously preempted. Windows child processes
# inherit their parent's priority class by default, so resetting THIS process
# (however it was invoked) to Normal here, before git/npm/build run, fixes it
# for both invocation paths - a no-op when already Normal (the manual-run case).
try {
    $proc = Get-Process -Id $PID
    $originalPriority = $proc.PriorityClass
    if ($originalPriority -ne 'Normal') {
        $proc.PriorityClass = 'Normal'
        Write-Host "Adjusted process priority to Normal (was $originalPriority)"
    }
} catch { Write-Warning "Could not adjust process priority: $($_.Exception.Message)" }

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

# Self-locate -InstallDir too, the same way $AppDir already self-locates - the
# in-app "Update Now" trigger (app/api/system/update/route.ts) never passes
# -InstallDir, so it always fell back to this parameter's hardcoded default
# regardless of the REAL install location. That silently broke the transcript,
# last-update-status.json, and $NssmExe paths (all still built from $InstallDir
# below) on any install whose real path differs from the default - the failure
# banner would never appear even after a genuinely failed/rolled-back update,
# since app/api/system/last-update-status/route.ts finds the real $AppDir just
# fine but looks for the status file relative to IT, not this now-wrong
# $InstallDir. A suite install's app root ends in "...\<App>\app" (this
# script's own doc comment above); a standalone install's app root has no such
# "app" leaf. Detect which by checking $AppDir's own leaf folder name, and
# derive InstallDir from that instead of trusting the (possibly-stale-default)
# parameter - mirrors $AppDir's own self-location, not a partial fix.
if ((Split-Path -Leaf $AppDir) -ieq 'app') {
    $InstallDir = Split-Path -Parent $AppDir
} else {
    $InstallDir = $AppDir
}
$NssmExe = "$InstallDir\nssm\nssm-2.24\win64\nssm.exe"

# --- Concurrency guard (item 6, 2026-07-24 resilience review) --------------
# Nothing before this stopped two overlapping runs (a manual console run
# racing the in-app "Update Now" trigger, or a double-click on either) - both
# would mutate the SAME on-disk git checkout and .next\standalone build
# concurrently, which is exactly the kind of corruption this script's rollback
# machinery exists to recover FROM, not something it can safely run DURING.
# Check for a lock left by another still-running instance before doing
# anything else - not even the service stop below - so a genuinely overlapping
# run is a true no-op (no service touched, no file touched).
$LockPath = "$InstallDir\logs\update.lock"
$lockAcquired = $false
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
if (Test-Path $LockPath) {
    $lockPidRaw = (Get-Content -LiteralPath $LockPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    $lockPid = 0
    if ($lockPidRaw -and [int]::TryParse($lockPidRaw.Trim(), [ref]$lockPid) -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
        Write-Warning "Another update is already running (PID $lockPid, lock file $LockPath) - exiting without making any changes."
        exit 1
    }
    # Lock file exists but its PID is gone/unreadable - a prior run crashed or
    # was killed before cleaning up. Safe to reclaim.
    Write-Warning "Found a stale lock file (owning process is no longer running) - removing it and proceeding: $LockPath"
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}
try {
    [System.IO.File]::WriteAllText($LockPath, "$PID", (New-Object System.Text.UTF8Encoding $false))
    $lockAcquired = $true
} catch {
    Write-Warning "Could not write lock file $LockPath - continuing without a concurrency guard for this run: $($_.Exception.Message)"
}

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

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }

# Best-effort cleanup for a stale/leftover backup directory (item 8 of the
# 2026-07-24 resilience review): try a full delete, and if that fails (e.g. a
# locked file), rename it aside instead so it can never collide with - or be
# silently mistaken for - a future run's own snapshot of the same name. A
# rename only touches the directory entry itself, not every file inside it, so
# it can succeed even when a full delete can't.
# -ThrowOnFailure: the PRE-FLIGHT snapshot step must abort the update rather
# than risk colliding with (or shadowing) this run's own backup if a leftover
# truly cannot be cleared - pass this there. The SUCCESS-PATH final cleanup
# (running after the update has already succeeded) must never escalate a
# leftover-directory issue into rolling back an otherwise-working update, so it
# omits this switch and only warns loudly on repeated failure instead.
function Clear-StaleBackup([string]$Path, [switch]$ThrowOnFailure) {
    if (-not (Test-Path $Path)) { return $true }
    Remove-Item $Path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $Path)) { return $true }
    $staleName = "$(Split-Path -Leaf $Path).stale-$(Get-Date -Format 'yyyyMMddHHmmss')"
    try {
        Rename-Item -Path $Path -NewName $staleName -ErrorAction Stop
        Write-Warn "Could not delete $Path - moved aside as $staleName for manual cleanup"
        return $true
    } catch {
        $msg = "Stale backup at $Path could not be removed or moved aside - manual cleanup required: $($_.Exception.Message)"
        if ($ThrowOnFailure) { throw $msg }
        Write-Warn $msg
        return $false
    }
}

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
$prevVersion     = $null   # package.json version before this update touched anything
$attemptedVersion = $null  # package.json version this update tried to move to
$currentStage    = 'init'
$schemaWarning   = $null
$schemaApplied   = $false  # did schema.sql actually succeed THIS run (item 4)
$standaloneSwapped = $false # did the pre-flight snapshot actually swap .next\standalone out (item 3)
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
        [bool]$HealthCheckPassed = $false,
        [bool]$SchemaAppliedButRolledBack = $false
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
        schemaAppliedButRolledBack = $SchemaAppliedButRolledBack
    }
    try {
        # Windows PowerShell 5.1's `Out-File -Encoding UTF8` writes a UTF-8 BOM,
        # which Node's `fs.readFileSync(path, 'utf8')` (used by the API route
        # that reads this file) does NOT strip - a leading BOM breaks JSON.parse
        # on every single write. Write via .NET directly with a BOM-less UTF8Encoding
        # instead of the Out-File cmdlet to avoid this (there is no utf8NoBOM
        # option for Out-File in Windows PowerShell 5.1, only in PS 6+/Core).
        #
        # Write to a temp file in the SAME directory, then Move-Item -Force onto
        # the real path (item 9) - an atomic rename on the same NTFS volume, so
        # a crash/kill mid-write can never leave the reader (the API route) with
        # a truncated/corrupt JSON file to silently swallow.
        $json = $status | ConvertTo-Json
        $tmpPath = "$StatusPath.tmp-$PID"
        [System.IO.File]::WriteAllText($tmpPath, $json, (New-Object System.Text.UTF8Encoding $false))
        Move-Item -Path $tmpPath -Destination $StatusPath -Force
    } catch {
        Write-Warn "Could not write status file $StatusPath - $($_.Exception.Message)"
        try { if (Test-Path $tmpPath) { Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue } } catch {}
    }
}

# Poll /api/health until it answers 200 or $TimeoutSec elapses. Shared by the
# main flow's mandatory final health check and the rollback recovery path.
function Wait-Healthy([int]$TimeoutSec = 60, [string]$ExpectedVersion = $null) {
    Write-Host "    Waiting for NetVault to respond on :3000 " -ForegroundColor Gray -NoNewline
    $healthy = $false
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        try {
            # 127.0.0.1, not localhost - see the comment on the original health poll below.
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                if ($ExpectedVersion) {
                    # A 200/status:ok alone is not proof the CORRECT build is
                    # serving (item 5) - NSSM can briefly relaunch the OLD build
                    # right after this script kills the prior process (see the
                    # "already running" note below), which would otherwise pass
                    # a bare status check while still running stale code. Only
                    # declare healthy once /api/health's own version matches.
                    $body = $null
                    try { $body = $resp.Content | ConvertFrom-Json } catch { $body = $null }
                    if ($body -and $body.version -eq $ExpectedVersion) { $healthy = $true; break }
                } else {
                    $healthy = $true; break
                }
            }
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
        # Stop/kill the service BEFORE touching .next\standalone below. A failure
        # at the 'service-start' or 'health-check' stage means sc.exe start
        # NetVault already ran earlier in the main flow, so without this the
        # restore's Remove-Item/Rename-Item would be mutating a directory tree
        # while the live NetVault process is still running against it - a real
        # race that corrupted node_modules in production for the identical
        # LogVault/DDIVault/SpanVault rollback code (Collector crash-looped on a
        # missing module even though the restore itself reported success).
        # Mirrors the safe order the main update flow already uses (the service
        # is stopped before the build/standalone snapshot is ever touched).
        Write-Step "Stopping NetVault before restoring last known-good version"
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe stop NetVault 2>&1
        $ErrorActionPreference = 'Stop'
        $portProc = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
        if ($portProc) {
            $procPid = $portProc.OwningProcess
            if ($procPid -and $procPid -gt 0) {
                Get-Process -Id $procPid -ErrorAction SilentlyContinue | Stop-Process -Force
            }
        }
        Start-Sleep -Seconds 2

        Set-Location $AppDir
        if ($prevCommit) {
            Write-Host "    Reverting source to $prevCommit" -ForegroundColor Gray
            $ErrorActionPreference = 'Continue'
            $null = & git reset --hard $prevCommit 2>&1
            $rbExit = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            if ($rbExit -eq 0) { Write-OK "Source reverted" } else { Write-Warn "git reset during rollback failed (exit $rbExit)"; $ok = $false }
        } else {
            # No commit to revert to means source can't be confirmed reverted -
            # this run must not be able to report an overall success (item 2).
            Write-Warn "No pre-update commit recorded - skipping source revert"
            $ok = $false
        }

        $standaloneDir    = "$AppDir\.next\standalone"
        $standaloneBackup = "$AppDir\.next\standalone.lastgood"
        if (-not $standaloneSwapped) {
            # The pre-flight snapshot step never got as far as swapping the live
            # build out (it failed/threw earlier - e.g. a stale leftover backup
            # from a prior run could not be cleared even by Clear-StaleBackup,
            # see the pre-flight step below). NetVault's original build sitting
            # in $standaloneDir right now was NEVER touched by this run, so
            # there is nothing to restore, and restarting the service further
            # down brings back that same untouched, still-fully-functional
            # build. Do NOT treat this as a failure - doing so produces a false
            # "rollback also failed, may be DOWN" alarm for a run that never
            # actually broke anything in the first place (item 3).
            #
            # Checked BEFORE Test-Path $standaloneBackup below and NOT merely as
            # an "else" of it: in exactly this scenario, $standaloneBackup can
            # still be occupied by an UNRELATED stale leftover from a past run
            # that this run's own Clear-StaleBackup failed to clear (that is
            # why it threw) - Test-Path on that path alone would read as
            # true and, without this check taking priority, would wrongly fall
            # into the restore branch below: deleting the still-good, untouched
            # live build and overwriting it with that old stale leftover.
            Write-OK "Build output was never touched by this update (it failed before the pre-flight snapshot completed) - nothing to restore"
        } elseif (Test-Path $standaloneBackup) {
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
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe start NetVault 2>&1
        $startExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($startExit -ne 0 -and $startExit -ne 1056) {
            Write-Warn "sc.exe start NetVault failed during rollback (exit $startExit)"
            $ok = $false
        }

        # Gate on the PREVIOUS version too (item 5), not just a bare 200 - the
        # same NSSM-relaunch race that motivates the version check in the main
        # flow's health check applies here as well.
        $healthy = Wait-Healthy -TimeoutSec 30 -ExpectedVersion $prevVersion
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

# Outer try/finally (item 6): guarantees the lock file acquired near the top of
# this script is released on EVERY exit path from here down - normal success,
# the handled-failure/rollback path below (whose inner catch calls `exit 1`),
# or any other terminating error. PowerShell's `finally` still runs even when
# `exit` fires from inside a try block it wraps.
try {
try {

    Write-Step "Stopping NetVault service"
    Write-Host "    Running: sc.exe stop NetVault" -ForegroundColor Gray
    $svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
    if ($svc) {
        # Always issue the stop, regardless of the sampled status (item 1) - a
        # service that isn't currently "Running" is NOT necessarily durably
        # stopped: StartPending/StopPending, or a crash-loop sampled between
        # restarts, all leave NSSM's own auto-restart armed. A crash-looping
        # service is itself a very plausible reason someone triggers an update
        # in the first place, so skipping the stop specifically in that case
        # was exactly backwards - it left auto-restart armed for the whole
        # update window while this script rewrote the build output underneath
        # it. sc.exe stop on an already-stopped service is a harmless no-op.
        # (Mirrors the identical fix already applied to DDIVault/LogVault's own
        # MAIN update flow - see Update-DDIVault.ps1/Update-LogVault.ps1.)
        #
        # sc.exe writes informational output that can end up on stderr; under
        # $ErrorActionPreference = 'Stop', merging it via 2>&1 turns that into a
        # terminating ErrorRecord even on a clean stop. Same class of bug fixed
        # below for git/npm/psql — relax Stop around this call too.
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe stop NetVault 2>&1
        $ErrorActionPreference = 'Stop'
        Start-Sleep -Seconds 3
        Write-OK "Service stop issued (was $($svc.Status))"
    } else {
        Write-Warn "NetVault service not found - skipping stop"
    }
    # Scope this to node.exe processes running FROM THIS install ($AppDir) only.
    # `Stop-Process -Name node -Force` matches by process NAME alone - on the
    # shared suite server every one of LogVault/DDIVault/SpanVault ALSO runs as
    # a plain "node.exe", so an unscoped kill here force-kills their processes
    # too as collateral damage during a NetVault-only update, triggering an
    # unplanned NSSM auto-restart cycle in apps nobody asked to touch. Filter by
    # command line instead so only THIS app's leftover process is killed.
    $node = Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($AppDir.ToLower()) }
    if ($node) {
        foreach ($p in $node) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
        Write-OK "Killed leftover node process(es) for this install"
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

    # Capture the pre-update package.json version too (item 5) - Invoke-Rollback's
    # post-rollback health check needs to know what version SHOULD be running
    # again once source is reverted. Best-effort: a missing/unreadable
    # package.json just disables the version gate for the rollback path, it
    # never blocks the update.
    try {
        $prevVersion = (Get-Content "$AppDir\package.json" -Raw -ErrorAction Stop | ConvertFrom-Json).version
    } catch { $prevVersion = $null }
    if ($prevVersion) { Write-OK "Current version: $prevVersion" }

    # NSSM serves the app straight out of .next\standalone (self-contained, own
    # node_modules copy) - `npm run build` wipes and regenerates this directory
    # from scratch, so it must be snapshotted before the build touches it. The
    # service was already stopped above, so nothing still holds a file handle
    # into it. Clear any stale backup from a prior interrupted run first so we
    # always snapshot the CURRENTLY-serving build, not an older leftover one.
    $standaloneDir    = "$AppDir\.next\standalone"
    $standaloneBackup = "$AppDir\.next\standalone.lastgood"
    # A stale backup here means a PRIOR run's cleanup failed to fully remove or
    # move it aside. If it can't be cleared now either, we must NOT proceed to
    # rename today's live (good) build onto this same name - it would collide,
    # and worse, could leave the stale one in place for Invoke-Rollback to
    # mistake for THIS run's own snapshot later (silently restoring an old,
    # wrong version while still reporting a "successful" rollback).
    # -ThrowOnFailure aborts the update in that case, before the live build
    # below has been touched at all (see Clear-StaleBackup near the top).
    Clear-StaleBackup -Path $standaloneBackup -ThrowOnFailure | Out-Null
    if (Test-Path $standaloneDir) {
        Rename-Item -Path $standaloneDir -NewName 'standalone.lastgood' -ErrorAction Stop
        # Only from this point on has the live build actually been swapped out -
        # Invoke-Rollback (item 3) uses this flag to tell "genuinely can't
        # recover" apart from "this run failed before ever touching the working
        # build", so a pre-flight abort above doesn't produce a false "rollback
        # also failed, may be DOWN" alarm later.
        $standaloneSwapped = $true
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

    # ── Agent bundle byte-integrity (self-heal) ────────────────────────────────
    # The hub serves agent/ verbatim to remote agents, and each file's sha256 is
    # Ed25519-signed into agent/update-manifest.json. If the working tree differs
    # from those bytes by even one line ending, every agent verifies the signature,
    # downloads, fails the per-file sha256 check and discards the update — forever,
    # with the only evidence in the AGENT's log. That is exactly what happened
    # before .gitattributes pinned agent/ to LF (production, 2026-08-03).
    #
    # `git reset --hard` does NOT fix an existing checkout when only the ATTRIBUTES
    # changed: the blobs are identical, so git considers the files up to date and
    # leaves the converted bytes in place. Dropping them from the index and
    # resetting forces a re-checkout under the current attributes. Idempotent and
    # cheap (~26 files), and it only runs when a mismatch is actually detected.
    try {
        $manifestPath = Join-Path $AppDir 'agent\update-manifest.json'
        if (Test-Path $manifestPath) {
            $mf = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $sha = [System.Security.Cryptography.SHA256]::Create()
            $mismatch = $false
            foreach ($f in $mf.files) {
                $fp = Join-Path (Join-Path $AppDir 'agent') ($f.path -replace '/', '\')
                if (-not (Test-Path -LiteralPath $fp)) { $mismatch = $true; break }
                $hex = ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($fp))) -replace '-', '').ToLower()
                if ($hex -ne $f.sha256.ToLower()) { $mismatch = $true; break }
            }
            if ($mismatch) {
                Write-Warn "Agent bundle bytes differ from the signed manifest - renormalizing the checkout"
                $null = & git rm --cached -r --quiet agent 2>&1
                $null = & git reset --hard HEAD 2>&1
                # Re-verify so a REAL corruption is reported instead of assumed fixed.
                $still = $false
                foreach ($f in $mf.files) {
                    $fp = Join-Path (Join-Path $AppDir 'agent') ($f.path -replace '/', '\')
                    if (-not (Test-Path -LiteralPath $fp)) { $still = $true; break }
                    $hex = ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($fp))) -replace '-', '').ToLower()
                    if ($hex -ne $f.sha256.ToLower()) { $still = $true; break }
                }
                if ($still) { Write-Warn "Agent bundle STILL differs from the signed manifest - remote agents will not self-update" }
                else { Write-OK "Agent bundle now matches the signed manifest" }
            } else {
                Write-OK "Agent bundle matches the signed manifest"
            }
        }
    } catch {
        # Never fatal: a failure here only affects remote-agent self-update, and the
        # hub itself must still come up.
        Write-Warn "Could not verify the agent bundle against its manifest: $($_.Exception.Message)"
    }

    # Capture the version we're now attempting to move to (item 5) - the main
    # flow's post-build health check compares against THIS, so a health check
    # that merely gets a 200 from a stale/relaunched OLD build (see the NSSM
    # "already running" race noted further below) can no longer be mistaken
    # for a successful update.
    try {
        $attemptedVersion = (Get-Content "$AppDir\package.json" -Raw -ErrorAction Stop | ConvertFrom-Json).version
    } catch { $attemptedVersion = $null }

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
            # CSPRNG, not Get-Random (System.Random, time-seeded) - this value is a
            # Bearer token authorising NetVault system endpoints.
            $csBytes = New-Object byte[] 32
            $csRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $csRng.GetBytes($csBytes) } finally { $csRng.Dispose() }
            $CronSecret = -join ($csBytes | ForEach-Object { '{0:x2}' -f $_ })
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
            # schema.sql runs BEFORE the stages that can still trigger a
            # rollback (npm install/build/etc) - if one of those later fails,
            # the code gets reverted but this schema apply does NOT (item 4).
            # Record that it genuinely succeeded THIS run so the catch block
            # can flag the mismatch instead of leaving it silent.
            $schemaApplied = $true
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

    # ── Agent-ingest TLS: the HUB half of the switch ───────────────────────────
    # SpanVault's/DDIVault's own updater mints the wss:// certificate and points
    # SV_WS_TLS_CERT / DDI_WS_TLS_CERT at it. That flips the LISTENER only, and
    # exclusively: ws-server.js swaps in https.createServer and then speaks wss://
    # and nothing else. Which URL each agent is TOLD to dial is decided here, on
    # the hub (lib/agentIdentity.ts deriveIngest), and because the hub is served
    # over plain HTTP the request-derived scheme is always ws://. So if only the
    # app-side updater ever ran, the hub would keep handing out ws:// to a
    # TLS-only listener and the whole agent fleet would fail the handshake.
    #
    # Deriving the flags from the certificate ON DISK (rather than a parameter)
    # makes this self-healing and idempotent: whichever order the per-app
    # updaters ran in, the next NetVault update reconciles the hub to whatever
    # TLS state the satellites are actually in. No cert => nothing written =>
    # request-derived ws://, exactly the pre-TLS behaviour.
    # PROBE the live listener rather than inferring from a certificate file.
    # "A cert exists on disk" is only a proxy for "the listener speaks TLS", and
    # the two genuinely diverge: the app-side updater writes SV_WS_TLS_CERT with
    # Set-EnvFileVars, which SILENTLY does nothing if that .env file is missing,
    # so a valid cert can sit on disk while the listener is still plaintext. Had
    # we trusted the file, the hub would then advertise wss:// at a ws:// socket
    # and take the whole fleet down. The socket itself cannot be wrong.
    #
    # Pinning what the endpoint ACTUALLY presents also removes a second failure
    # mode: a cert regenerated without the app being restarted would otherwise
    # publish a pin the running server does not match.
    Write-Step "Reconciling agent-ingest TLS flags"
    $rootEnvPath = "$AppDir\.env"
    foreach ($m in @(
        @{ App = 'spanvault'; Port = 3010; Tls = 'SPANVAULT_WS_TLS'; Fp = 'SPANVAULT_WS_FINGERPRINT' },
        @{ App = 'ddivault';  Port = 3011; Tls = 'DDIVAULT_WS_TLS';  Fp = 'DDIVAULT_WS_FINGERPRINT'  }
    )) {
        $fp = $null; $reachable = $false
        $client = $null; $ssl = $null
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect('127.0.0.1', $m.Port, $null, $null)
            # EndConnect BEFORE testing .Connected — the property is still false
            # while the connect is pending, so gating on it here silently reports
            # every port as unreachable (which would freeze the flags forever).
            # EndConnect throws on a refused/failed connect, which the catch takes.
            if ($iar.AsyncWaitHandle.WaitOne(3000)) {
                $client.EndConnect($iar)
                $reachable = $client.Connected
                # Accept ANY certificate: this is identification, not validation —
                # the cert is self-signed by design and we only want its fingerprint.
                $ssl = New-Object System.Net.Security.SslStream($client.GetStream(), $false, ({ $true } -as [System.Net.Security.RemoteCertificateValidationCallback]))
                $ssl.AuthenticateAsClient('127.0.0.1')
                $raw = $ssl.RemoteCertificate.GetRawCertData()
                $sha = [System.Security.Cryptography.SHA256]::Create()
                $fp = (($sha.ComputeHash($raw) | ForEach-Object { $_.ToString('X2') }) -join ':')
            }
        } catch { $fp = $null }
        finally {
            if ($ssl) { try { $ssl.Dispose() } catch {} }
            if ($client) { try { $client.Close() } catch {} }
        }

        if ($fp) {
            Set-EnvVar -Path $rootEnvPath -Key $m.Tls -Value '1'
            Set-EnvVar -Path $rootEnvPath -Key $m.Fp  -Value $fp
            Write-OK "$($m.App): ingest wss:// + pin $($fp.Substring(0,17))..."
        } elseif ($reachable) {
            # Port answered but would not negotiate TLS => a plaintext listener.
            # Clearing is as important as setting: a stale =1 here points every
            # agent at wss:// on a socket that only speaks ws://.
            Set-EnvVar -Path $rootEnvPath -Key $m.Tls -Value '0'
            Write-OK "$($m.App): listener is plaintext - ingest stays ws://"
        } else {
            # Nothing listening (app stopped, or not installed). Leave whatever is
            # configured ALONE — flipping the hub off because a service happened to
            # be down mid-update would disconnect a fleet that is working fine.
            Write-Host "    $($m.App): port $($m.Port) not answering - ingest flags left unchanged" -ForegroundColor Gray
        }
    }

    Write-Step "Writing env vars to standalone runtime"
    $standaloneEnvPath = "$standaloneDir\.env.local"
    # Restore the pre-build standalone .env.local first, so any keys we don't
    # explicitly propagate (manual edits) survive the rebuild. The whitelist
    # below then refreshes the managed keys on top.
    if ($standaloneEnvBackup) {
        $standaloneEnvBackup | Out-File -FilePath $standaloneEnvPath -Encoding UTF8 -NoNewline
        Write-OK "standalone .env.local restored (manual keys preserved)"
    }
    if (Test-Path $rootEnvPath) {
        foreach ($key in @('DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'SERVER_IP', 'CRON_SECRET', 'NOCVAULT_RO_HOST', 'NOCVAULT_RO_PORT', 'NOCVAULT_RO_USER', 'NOCVAULT_RO_PASS',
                           # Written by the reconcile step just above. deriveIngest reads
                           # these from the RUNNING process env, so they must reach the
                           # standalone runtime file, not just $AppDir\.env.
                           'SPANVAULT_WS_TLS', 'SPANVAULT_WS_FINGERPRINT', 'DDIVAULT_WS_TLS', 'DDIVAULT_WS_FINGERPRINT')) {
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
    $healthy = Wait-Healthy -TimeoutSec 60 -ExpectedVersion $attemptedVersion
    if (-not $healthy) {
        $verMsg = if ($attemptedVersion) { " (or never reported version $attemptedVersion - may still be serving a stale relaunched build)" } else { "" }
        throw "NetVault did not answer /api/health within 60s of starting$verMsg - service may be crash-looping or stuck"
    }
    Write-OK "NetVault service is running (health check passed)"

    # Register a recurring maintenance task robustly. The bare `-RunLevel Highest`
    # form (no explicit principal) baked the AMBIENT account name into the task
    # XML's <UserId>, and Windows had to resolve that name -> SID at registration.
    # Under the in-app updater's SYSTEM context on some boxes (edition/locale/
    # fresh-install state) that resolution failed with "No mapping between account
    # names and security IDs was done" (ERROR_NONE_MAPPED) - and because this runs
    # AFTER the health check passed, it escalated an already-healthy update into a
    # CRITICAL failure + rollback. Pinning the well-known SID S-1-5-18 (Local
    # SYSTEM) needs no name lookup, so it works in ANY context/locale, and
    # ServiceAccount means the task runs unattended. NON-FATAL: the update is
    # already up and healthy here, so a task-registration hiccup only warns - it
    # must never fail the update or trigger a rollback.
    function Register-MaintenanceTask([string]$Name, $Action, $Trigger, [string]$When) {
        try {
            $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
            Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Principal $principal -Force | Out-Null
            Write-OK "Scheduled task '$Name' registered ($When)"
        } catch {
            Write-Warn "Could not register scheduled task '$Name' ($When) - non-fatal, the update is healthy: $($_.Exception.Message)"
        }
    }

    Write-Step "Registering daily health-snapshot task"
    $cronLine = Get-Content "$AppDir\.env" | Where-Object { $_ -match '^CRON_SECRET=' } | Select-Object -First 1
    $CronSecret = if ($cronLine) { $cronLine.Substring('CRON_SECRET='.Length) } else { '' }
    if ($CronSecret) {
        $action = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
        $trigger = New-ScheduledTaskTrigger -Daily -At "00:00"
        Register-MaintenanceTask "NetVault-HealthSnapshot" $action $trigger "daily 00:00"
        # No immediate baseline snapshot here - the daily scheduled task above takes
        # it tonight. Skipping it keeps the update from blocking on a post-deploy curl.
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping scheduled task registration"
    }

    Write-Step "Registering daily EOL enrichment task"
    if ($CronSecret) {
        $eolAction = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
        $eolTrigger = New-ScheduledTaskTrigger -Daily -At "01:00"
        Register-MaintenanceTask "NetVault-EnrichEol" $eolAction $eolTrigger "daily 01:00"
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
        Register-MaintenanceTask "NetVault-SyncEol" $syncAction $syncTrigger "weekly Sun 00:15"
    } else {
        Write-Warn "CRON_SECRET not found in .env - skipping EOL feed-sync task"
    }

    # Update succeeded and is confirmed healthy - the pre-update snapshot is no
    # longer needed. Remove it so it doesn't accumulate across updates or get
    # mistaken for a stale rollback target on the next run.
    $standaloneBackup = "$AppDir\.next\standalone.lastgood"
    # Same careful handling as the pre-flight snapshot above (item 8) - retries,
    # renames aside, and warns loudly on repeated failure - instead of a bare
    # best-effort delete with no record if it silently fails. Never throws
    # here: the update already succeeded, so a leftover backup directory must
    # not escalate into rolling back an otherwise-working update.
    Clear-StaleBackup -Path $standaloneBackup | Out-Null

    Write-StatusJson -Success $true -Stage $null -ErrorCode 0 -RolledBack $false -HealthCheckPassed $true

} catch {
    $failureMessage = $_.Exception.Message
    Write-Host ""
    Write-Host "=== Update failed at stage '$currentStage': $failureMessage ===" -ForegroundColor Red
    $code = if ($StageCodes.ContainsKey($currentStage)) { $StageCodes[$currentStage] } else { 99 }

    # Item 4: schema.sql runs BEFORE the stages that can trigger a rollback
    # (npm install/build/etc) - if it already succeeded in THIS run, reverting
    # the code below does NOT revert the schema, and nothing else surfaces that
    # mismatch. Record it now, before Invoke-Rollback runs, so it lands in the
    # status file no matter how the rollback itself goes.
    $schemaAppliedButRolledBack = $schemaApplied

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

    Write-StatusJson -Success $false -Stage $currentStage -ErrorCode $code -ErrorMessage $failureMessage -RolledBack $rollbackOk -HealthCheckPassed $rollbackOk -SchemaAppliedButRolledBack $schemaAppliedButRolledBack

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
} finally {
    # Item 6: release the concurrency lock on every path out of the outer try
    # above - success, failure-then-rollback (exit 1), or anything else.
    if ($lockAcquired) {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    }
}
