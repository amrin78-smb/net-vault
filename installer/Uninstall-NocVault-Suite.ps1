#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NocVault Suite Uninstaller v1.1
.DESCRIPTION
    Cleanly removes NetVault, LogVault, DDIVault and SpanVault from a Windows
    Server: stops and deletes all NSSM services, removes scheduled tasks and
    firewall rules, drops databases and roles, clears git safe.directory entries,
    and deletes the application directories.

    By default it LEAVES the shared prerequisites installed (Node.js, Git,
    PostgreSQL, VC++ Redistributable) because other software may depend on them.
    Pass -RemoveDependencies to uninstall those too.
.PARAMETER InstallDir
    Root installation directory used by the installer (default: C:\Apps)
.PARAMETER PgAdminPassword
    PostgreSQL 'postgres' superuser password (prompted if omitted and databases
    are being removed)
.PARAMETER KeepDatabases
    Preserve the four databases and their roles (skip the DROP step)
.PARAMETER RemoveDependencies
    Also uninstall Node.js, Git, PostgreSQL and the VC++ Redistributable
.PARAMETER Force
    Skip the confirmation prompt (for unattended use)
.EXAMPLE
    .\Uninstall-NocVault-Suite.ps1
    .\Uninstall-NocVault-Suite.ps1 -KeepDatabases
    .\Uninstall-NocVault-Suite.ps1 -InstallDir "D:\Apps" -Force
    .\Uninstall-NocVault-Suite.ps1 -RemoveDependencies
#>
param(
    [string]$InstallDir      = "C:\Apps",
    [string]$PgAdminPassword = "",
    [switch]$KeepDatabases,
    [switch]$RemoveDependencies,
    [switch]$Force
)

# ── Helpers ───────────────────────────────────────────────────────
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    [--] $msg" -ForegroundColor Gray }

# ── Banner ────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  +============================================+" -ForegroundColor White
Write-Host "  |   NocVault Suite Uninstaller v1.1          |" -ForegroundColor White
Write-Host "  |   Removes NetVault / LogVault / DDIVault / |" -ForegroundColor White
Write-Host "  |   SpanVault                                |" -ForegroundColor White
Write-Host "  +============================================+" -ForegroundColor White
Write-Host ""

# ── Paths ─────────────────────────────────────────────────────────
$NVDir   = "$InstallDir\NetVault"
$LVDir   = "$InstallDir\LogVault"
$DDIDir  = "$InstallDir\DDIVault"
$SVDir   = "$InstallDir\SpanVault"
$AppDirs = @($NVDir, $LVDir, $DDIDir, $SVDir)
$PgBin   = "C:\Program Files\PostgreSQL\16\bin"

# Repo (clone) directories used for git safe.directory entries
$RepoDirs = @("$NVDir\app", "$LVDir\app", "$DDIDir\app", "$SVDir\app")

# ── Inventory (must match the installer) ──────────────────────────
$Services = @(
    "NetVault",
    "LogVault-Collector", "LogVault-API", "LogVault-App",
    "DDIVault-API", "DDIVault-App", "DDIVault-Collector",
    "SpanVault-API", "SpanVault-App", "SpanVault-Collector"
)

$Tasks = @("NetVault-HealthSnapshot", "LogVault Cleanup")

$FirewallRules = @(
    "NocVault NetVault 3000",
    "NocVault LogVault 3004",
    "NocVault Syslog UDP 514", "NocVault Syslog TCP 514",
    "NocVault Syslog UDP 1514", "NocVault Syslog TCP 1514",
    "NocVault DDIVault 3006",
    "NocVault SpanVault 3008"
)

# Databases (and their owning roles). Order matters: drop DBs before roles so
# cross-DB grants (ddivault_user/spanvault_user on netvault) disappear first.
$Databases = @("netvault", "logvault", "ddivault", "spanvault")
$Roles     = @("spanvault_user", "ddivault_user", "logvault_user", "netvault")

# ── Detect PostgreSQL service name ────────────────────────────────
$PgSvcName = (Get-Service | Where-Object {
    $_.Name -like "postgresql*" -or $_.DisplayName -like "*postgresql*"
} | Select-Object -First 1).Name
if (-not $PgSvcName) { $PgSvcName = "postgresql-x64-16" }

# ── Show plan ─────────────────────────────────────────────────────
Write-Host "  Install directory  : $InstallDir" -ForegroundColor Gray
Write-Host "  Remove databases   : $(-not $KeepDatabases)" -ForegroundColor Gray
Write-Host "  Remove deps        : $RemoveDependencies (Node/Git/PostgreSQL/VC++)" -ForegroundColor Gray
Write-Host ""
Write-Host "  This will STOP and DELETE all NocVault services, scheduled tasks," -ForegroundColor Yellow
Write-Host "  firewall rules and application files under $InstallDir." -ForegroundColor Yellow
if (-not $KeepDatabases) {
    Write-Host "  It will also DROP the databases (ALL DATA WILL BE LOST):" -ForegroundColor Red
    Write-Host "    $($Databases -join ', ')" -ForegroundColor Red
}
Write-Host ""

if (-not $Force) {
    $confirm = Read-Host "Type 'REMOVE' to proceed, anything else to cancel"
    if ($confirm -ne 'REMOVE') {
        Write-Host "`n  Cancelled. Nothing was changed.`n" -ForegroundColor Gray
        exit 0
    }
}

# ── PostgreSQL admin password (only if dropping databases) ────────
if (-not $KeepDatabases -and -not $PgAdminPassword) {
    $secPwd = Read-Host "PostgreSQL admin (postgres) password" -AsSecureString
    $PgAdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPwd))
}

# ================================================================
# STEP 1 — Stop & delete services
# ================================================================
Write-Step "Stopping and removing services"
foreach ($svc in $Services) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if (-not $s) { continue }
    if ($s.Status -ne 'Stopped') {
        & sc.exe stop $svc | Out-Null
        Start-Sleep -Seconds 2
    }
    & sc.exe delete $svc | Out-Null
    Write-OK "Removed service: $svc"
}

# Kill any leftover node processes still holding files in the app dirs
$leftover = Get-Process -Name node -ErrorAction SilentlyContinue
if ($leftover) {
    $leftover | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-OK "Stopped leftover node processes"
}

# ================================================================
# STEP 2 — Scheduled tasks
# ================================================================
Write-Step "Removing scheduled tasks"
foreach ($t in $Tasks) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
        Write-OK "Removed task: $t"
    }
}

# ================================================================
# STEP 3 — Firewall rules
# ================================================================
Write-Step "Removing firewall rules"
foreach ($r in $FirewallRules) {
    if (Get-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue
        Write-OK "Removed firewall rule: $r"
    }
}

# ================================================================
# STEP 4 — Databases and roles
# ================================================================
if (-not $KeepDatabases) {
    Write-Step "Dropping databases and roles"
    if (Test-Path "$PgBin\psql.exe") {
        $env:PGPASSWORD = $PgAdminPassword
        # Drop databases first (WITH FORCE terminates any stray connections).
        foreach ($db in $Databases) {
            & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" 2>$null
            Write-OK "Dropped database: $db"
        }
        # Then roles - cross-DB grants are gone once the databases are dropped.
        foreach ($role in $Roles) {
            & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "DROP ROLE IF EXISTS $role;" 2>$null
            Write-OK "Dropped role: $role"
        }
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        Write-Warn "psql not found at $PgBin - skipping database removal"
    }
} else {
    Write-Info "Keeping databases (per -KeepDatabases)"
}

# ================================================================
# STEP 5 — git safe.directory entries (machine-wide / SYSTEM)
# ================================================================
Write-Step "Clearing git safe.directory entries"
$env:PATH = @("C:\Program Files\Git\cmd", "C:\Program Files\Git\bin", $env:PATH) -join ";"
$gitOk = & git --version 2>$null
if ($gitOk) {
    foreach ($repo in $RepoDirs) {
        $repoFwd = ($repo -replace '\\','/')
        & git config --system --unset-all safe.directory $repoFwd 2>$null
    }
    Write-OK "Removed safe.directory entries for NocVault repos"
} else {
    Write-Warn "git not on PATH - skipping safe.directory cleanup"
}

# ================================================================
# STEP 6 — Application directories
# ================================================================
Write-Step "Removing application directories"
foreach ($dir in $AppDirs) {
    if (Test-Path $dir) {
        try {
            Remove-Item $dir -Recurse -Force -ErrorAction Stop
            Write-OK "Removed: $dir"
        } catch {
            Write-Warn "Could not fully remove $dir - $_"
            Write-Info "A file may still be locked; re-run after a reboot if needed."
        }
    }
}

# ================================================================
# STEP 7 — Dependencies (optional)
# ================================================================
if ($RemoveDependencies) {
    Write-Step "Removing shared dependencies"

    # PostgreSQL
    $pgUninstall = "C:\Program Files\PostgreSQL\16\uninstall-postgresql.exe"
    if (Test-Path $pgUninstall) {
        Write-Info "Uninstalling PostgreSQL 16..."
        Start-Process -Wait -FilePath $pgUninstall -ArgumentList "--mode unattended"
        Write-OK "PostgreSQL uninstalled"
    } else {
        Write-Warn "PostgreSQL uninstaller not found - skipping"
    }

    # Node.js (MSI)
    $nodeProduct = Get-CimInstance Win32_Product -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "Node.js*" } | Select-Object -First 1
    if ($nodeProduct) {
        Write-Info "Uninstalling Node.js..."
        Start-Process -Wait -FilePath "msiexec.exe" -ArgumentList "/x", $nodeProduct.IdentifyingNumber, "/quiet", "/norestart"
        Write-OK "Node.js uninstalled"
    } else {
        Write-Warn "Node.js MSI product not found - skipping"
    }

    # Git (silent uninstaller)
    $gitUninstall = Get-ChildItem "C:\Program Files\Git\unins*.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($gitUninstall) {
        Write-Info "Uninstalling Git..."
        Start-Process -Wait -FilePath $gitUninstall.FullName -ArgumentList "/VERYSILENT", "/NORESTART"
        Write-OK "Git uninstalled"
    } else {
        Write-Warn "Git uninstaller not found - skipping"
    }

    Write-Info "VC++ Redistributable left in place (commonly shared by other apps)."
} else {
    Write-Info "Leaving Node.js / Git / PostgreSQL / VC++ installed (use -RemoveDependencies to remove)."
}

# ================================================================
# DONE
# ================================================================
Write-Host ""
Write-Host "  +======================================================+" -ForegroundColor Green
Write-Host "  |   NocVault Suite - Uninstall Complete                |" -ForegroundColor Green
Write-Host "  +======================================================+" -ForegroundColor Green
Write-Host ""
if ($KeepDatabases) {
    Write-Host "  NOTE: Databases were preserved. To remove them later, re-run" -ForegroundColor Gray
    Write-Host "        without -KeepDatabases." -ForegroundColor Gray
    Write-Host ""
}
Write-Host "  If any directory could not be deleted (file lock), reboot and" -ForegroundColor Gray
Write-Host "  delete it manually under $InstallDir." -ForegroundColor Gray
Write-Host ""
