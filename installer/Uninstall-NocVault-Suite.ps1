#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NocVault Suite Uninstaller v1.5
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
.PARAMETER KeepCertificates
    Preserve C:\ProgramData\NocVault\certs (the TLS terminator's certificate and
    PRIVATE KEY, plus the agent-ingest WebSocket pins). By default these are
    DELETED - leaving a private key on a decommissioned server is the whole
    reason this step exists. Pass this only when you are re-installing onto the
    same machine and want the same certificate and the same agent pins back.
.PARAMETER RemoveDependencies
    Also uninstall Node.js, Git and PostgreSQL. The VC++ Redistributable is
    always left in place (commonly shared).

    Each of the three is removed ONLY if nothing else on the server appears to
    need it. PostgreSQL is kept if the cluster holds any database that is not
    one of the four suite databases. Node.js and Git are kept if the installer
    recorded that they were already present before NocVault
    (C:\ProgramData\NocVault\install-state.env), or if any service, scheduled
    task or running process outside this suite references them. Anything that
    cannot be determined - no psql, a failed query, an unreadable service list
    - also keeps the dependency. Refusing costs one manual uninstall; guessing
    wrong takes down software that was here first.
    PostgreSQL removal is REFUSED if this cluster still hosts a database that is
    not one of the four suite databases (another product is likely running on
    it), if -KeepDatabases was also passed, or if the check cannot be run.
.PARAMETER RemoveSecrets
    Also delete C:\ProgramData\NocVault\secrets.env - the machine-level file
    holding POSTGRES_PASSWORD, NEXTAUTH_SECRET, NOCVAULT_RO_PASS and the four
    per-app database passwords in CLEARTEXT. NOT the default: a re-install is
    meant to reuse this file so the new install still matches a PostgreSQL that
    was retained. Pass it when the machine is being decommissioned. It is
    REFUSED while any suite database or login role is still on the cluster,
    because by then this file is the last copy of their passwords.
.PARAMETER Force
    Skip the confirmation prompt (for unattended use)
.EXAMPLE
    .\Uninstall-NocVault-Suite.ps1
    .\Uninstall-NocVault-Suite.ps1 -KeepDatabases
    .\Uninstall-NocVault-Suite.ps1 -KeepDatabases -KeepCertificates
    .\Uninstall-NocVault-Suite.ps1 -InstallDir "D:\Apps" -Force
    .\Uninstall-NocVault-Suite.ps1 -RemoveDependencies
    .\Uninstall-NocVault-Suite.ps1 -RemoveDependencies -RemoveSecrets -Force
#>
param(
    [string]$InstallDir      = "C:\Apps",
    [string]$PgAdminPassword = "",
    [switch]$KeepDatabases,
    [switch]$KeepCertificates,
    [switch]$RemoveDependencies,
    [switch]$RemoveSecrets,
    [switch]$Force
)

# ── Helpers ───────────────────────────────────────────────────────
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    [--] $msg" -ForegroundColor Gray }

# ── PostgreSQL password auto-discovery ────────────────────────────
function Get-EnvVal([string]$file, [string]$key) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=\s*(.+?)\s*$") { return $Matches[1].Trim() }
    }
    return $null
}
# Key NAMES only. Everything this script says about secrets.env is said by name,
# never by line and never by value - a transcript, a GUI log pane or a scrollback
# is exactly where a cleartext password must not end up, and printing the line
# "to show what is in there" is how that happens.
function Get-SecretKeyNames([string]$file) {
    $names = @()
    if (-not (Test-Path -LiteralPath $file)) { return $names }
    foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $names += $Matches[1] }
    }
    return $names
}
# Does this password actually authenticate as the postgres superuser? Nothing
# else in this script can tell a right password from a wrong one, and a wrong one
# makes every DROP in STEP 4 fail.
function Test-PgSuperuserPassword([string]$pw) {
    if (-not $pw) { return $false }
    if (-not (Test-Path "$PgBin\psql.exe")) { return $false }
    $had  = Test-Path Env:\PGPASSWORD
    $prev = if ($had) { $env:PGPASSWORD } else { $null }
    $env:PGPASSWORD = $pw
    try {
        & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -tAc "SELECT 1" 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        if ($had) { $env:PGPASSWORD = $prev } else { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    }
}

# ⛔ EVERY CANDIDATE IS TESTED. This used to return the first file that merely
# CONTAINED a POSTGRES_PASSWORD line, and secrets.env is first - but secrets.env
# does not necessarily hold the password the cluster actually has. The installer
# GENERATES a POSTGRES_PASSWORD and writes it there unconditionally; when it is
# run against a PostgreSQL that already existed, the operator supplies the real
# one with -PgAdminPassword and only THAT value reaches the cluster and the app
# .env files. secrets.env keeps the generated value, which authenticates against
# nothing. Measured on a staging box installed exactly that way: every DROP
# DATABASE and DROP ROLE failed with 'password authentication failed for user
# "postgres"', while the correct password was sitting in NetVault\app\.env two
# candidates further down the list.
#
# Returns a PSCustomObject so the caller can name the SOURCE without ever
# printing the value.
function Resolve-PgPassword([string]$installDir) {
    $candidates = @(
        'C:\ProgramData\NocVault\secrets.env',
        (Join-Path $installDir 'NetVault\app\.env'),
        (Join-Path $installDir 'LogVault\app\.env.local'),
        (Join-Path $installDir 'DDIVault\app\.env.local'),
        (Join-Path $installDir 'SpanVault\app\.env.local'),
        # Installs whose repo root IS the install root (no 'app' subfolder) -
        # LogVault and DDIVault are deployed that way on at least one server.
        (Join-Path $installDir 'LogVault\.env.local'),
        (Join-Path $installDir 'DDIVault\.env.local'),
        (Join-Path $installDir 'SpanVault\.env.local')
    )
    $found = 0
    foreach ($f in $candidates) {
        $v = Get-EnvVal $f 'POSTGRES_PASSWORD'
        if (-not $v) { continue }
        $found++
        if (Test-PgSuperuserPassword $v) {
            return [pscustomobject]@{ Password = $v; Source = $f; Verified = $true }
        }
    }
    return [pscustomobject]@{ Password = $null; Source = $null; Verified = $false; Found = $found }
}

# ── Banner ────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  +============================================+" -ForegroundColor White
Write-Host "  |   NocVault Suite Uninstaller v1.5          |" -ForegroundColor White
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
# Outside $InstallDir on purpose (the terminator and the agent listeners both
# read it as a machine-level location), which is exactly why STEP 6 misses it.
$CertDir = "C:\ProgramData\NocVault\certs"
# One directory up from $CertDir and outside $InstallDir for the same reason, so
# STEP 6 misses it too. Written by Install-NocVault-Suite.ps1 ($SecretsFile
# there); handled in STEP 8.
$SecretsFile = "C:\ProgramData\NocVault\secrets.env"

# Repo (clone) directories used for git safe.directory entries
$RepoDirs = @("$NVDir\app", "$LVDir\app", "$DDIDir\app", "$SVDir\app")

# ── Inventory (must match the installer) ──────────────────────────
# ⛔ NocVault-Tls IS FIRST, AND THE ORDER IS LOAD-BEARING. Its
# DependOnService names all four console services, and Windows REFUSES
# `sc stop` on a service that has a running dependent (1051,
# ERROR_DEPENDENT_SERVICES_RUNNING). With the terminator anywhere later in this
# list, stopping NetVault/LogVault-App/DDIVault-App/SpanVault-App would fail,
# `sc delete` would mark them for deletion while still running, and STEP 6 would
# then fail to remove the directories their live processes are holding open.
# A suite that never had a terminator skips it harmlessly - the loop already
# `continue`s on a service that does not exist.
$Services = @(
    "NocVault-Tls",
    "NetVault",
    "LogVault-Collector", "LogVault-API", "LogVault-App",
    "DDIVault-API", "DDIVault-App", "DDIVault-Collector",
    "SpanVault-API", "SpanVault-App", "SpanVault-Collector"
)

# ⛔ THE RUNTIME-CREATED TASKS BELONG HERE TOO, AND WERE MISSING. Only the three
# maintenance tasks are registered by an installer; the rest are created by the
# APPS THEMSELVES while running, which is exactly why a list maintained
# alongside the installer never knew about them:
#
#   <App>Update            written by each app's in-app "Update Now" button
#                          (netvault: app/api/system/update/route.ts, and the
#                          same shape in the three satellites' own repos)
#   NocVault-TlsTransport  written by Settings -> HTTPS. It deletes itself at
#                          the end of a run, so it is normally absent - but a
#                          run killed before its cleanup leaves it behind.
#   LogVault-Cleanup       runs <install>\logvault\scripts\cleanup.js. Observed
#                          on a production install and registered by NOTHING in
#                          any current repo, so it predates them or was made by
#                          hand; either way it points into a directory this
#                          script is about to delete.
#
# Measured on production 2026-11-06: five tasks survived an uninstall, every one
# of them scheduled to run a script in a deleted directory. A scheduled task
# pointing at nothing fails silently for ever, which is the quiet kind of mess.
# The loop below skips a task that does not exist, so listing one that was never
# created costs nothing.
$Tasks = @(
    "NetVault-HealthSnapshot", "NetVault-EnrichEol", "NetVault-SyncEol",
    "NetVaultUpdate", "LogVaultUpdate", "DDIVaultUpdate", "SpanVaultUpdate",
    "NocVault-TlsTransport",
    "LogVault-Cleanup"
)

$FirewallRules = @(
    "NocVault NetVault 3000",
    "NocVault LogVault 3004",
    "NocVault Syslog UDP 514", "NocVault Syslog TCP 514",
    "NocVault Syslog UDP 1514", "NocVault Syslog TCP 1514",
    "NocVault DDIVault 3006",
    # DDIVault's agent-ingest WebSocket listener (Install-NocVault-Suite.ps1 opens
    # it alongside 3006). It was missing from this list, so it survived a full
    # uninstall - verified on staging, where two copies of it were still present
    # after everything else had gone.
    "NocVault DDIVault WS 3011",
    "NocVault SpanVault 3008",
    "NocVault SpanVault 3010",
    # The shared TLS terminator's optional dedicated redirect ports
    # (-OpenHttpRedirectPorts at install time). The TLS ports themselves are
    # 3000/3004/3006/3008 and are already listed above - the terminator took
    # over the consoles' existing ports rather than adding new ones, which is
    # also why there is nothing here for 13000/13004/13006/13008: those were
    # never opened.
    "NocVault TLS redirect 3080",
    "NocVault TLS redirect 3084",
    "NocVault TLS redirect 3086",
    "NocVault TLS redirect 3088"
)

# Databases (and their owning roles). Order matters: drop DBs before roles so
# cross-DB grants (ddivault_user/spanvault_user on netvault) disappear first.
$Databases = @("netvault", "logvault", "ddivault", "spanvault")
# nocvault_readonly is the installer's cross-DB read-only LOGIN role (created at
# Install-NocVault-Suite.ps1's "CREATE USER nocvault_readonly", password
# NOCVAULT_RO_PASS in secrets.env). It was missing from this list, so a full
# uninstall left a role behind that can still log in to the cluster with a known
# password - and a brand-new database grants CONNECT to PUBLIC by default, so the
# leftover was not inert: it reaches whatever anyone creates on this server next.
# It is dropped LAST: its grants and default ACLs live inside the four databases
# above, and DROP ROLE refuses a role that still holds privileges anywhere.
$Roles     = @("spanvault_user", "ddivault_user", "logvault_user", "netvault", "nocvault_readonly")

# ── Detect PostgreSQL service name ────────────────────────────────
$PgSvcName = (Get-Service | Where-Object {
    $_.Name -like "postgresql*" -or $_.DisplayName -like "*postgresql*"
} | Select-Object -First 1).Name
if (-not $PgSvcName) { $PgSvcName = "postgresql-x64-16" }

# ── Show plan ─────────────────────────────────────────────────────
Write-Host "  Install directory  : $InstallDir" -ForegroundColor Gray
Write-Host "  Remove databases   : $(-not $KeepDatabases)" -ForegroundColor Gray
Write-Host "  Remove certs+keys  : $(-not $KeepCertificates) (C:\ProgramData\NocVault\certs)" -ForegroundColor Gray
Write-Host "  Remove deps        : $RemoveDependencies (Node/Git/PostgreSQL/VC++)" -ForegroundColor Gray
Write-Host "  Remove secrets.env : $RemoveSecrets ($SecretsFile)" -ForegroundColor Gray
Write-Host ""
Write-Host "  This will STOP and DELETE all NocVault services, scheduled tasks," -ForegroundColor Yellow
Write-Host "  firewall rules and application files under $InstallDir." -ForegroundColor Yellow
if (-not $KeepDatabases) {
    Write-Host "  It will also DROP the databases (ALL DATA WILL BE LOST):" -ForegroundColor Red
    Write-Host "    $($Databases -join ', ')" -ForegroundColor Red
}
if ($RemoveSecrets) {
    # Stated up front because this is the one removal the operator cannot undo
    # from anything left on the machine: STEP 6 deletes every app .env that held
    # a copy of these values.
    Write-Host "  It will also DELETE the machine-level secrets file:" -ForegroundColor Red
    Write-Host "    $SecretsFile" -ForegroundColor Red
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
# $script:PgAuthOk gates STEP 4 and the closing banner: without a password that
# really authenticates, the databases and the login roles stay on the cluster and
# the operator has to be TOLD that, not reassured by a row of [OK] lines.
$script:PgAuthOk     = $false
$script:DbLeftBehind = $false
# Set only when PostgreSQL really went (STEP 7). STEP 8 uses it to decide how
# loud to be about secrets.env: with the cluster gone, every credential in that
# file is worthless on this machine and nothing but a liability.
$script:PgRemoved          = $false
$script:SecretsLeftBehind  = $false
if ($KeepDatabases) {
    $script:PgAuthOk = $false
} elseif ($PgAdminPassword) {
    # An explicitly supplied password is still checked - a typo here otherwise
    # costs the operator the entire database step.
    $script:PgAuthOk = Test-PgSuperuserPassword $PgAdminPassword
    if ($script:PgAuthOk) { Write-Info "Using the supplied PostgreSQL password." }
    else { Write-Warn "The -PgAdminPassword supplied does not authenticate as the postgres superuser." }
} else {
    $r = Resolve-PgPassword $InstallDir
    if ($r.Verified) {
        $PgAdminPassword = $r.Password
        $script:PgAuthOk = $true
        Write-Info "Using the PostgreSQL password from $($r.Source)."
    } elseif ($Force) {
        # ⛔ NO PROMPT UNDER -Force. The GUI uninstaller drives this engine with
        # -Force and a hidden window: a Read-Host here does not fail, it HANGS
        # forever behind a progress bar with no way to answer it.
        Write-Warn "No stored PostgreSQL password authenticates as the postgres superuser ($($r.Found) candidate(s) tried)."
    } else {
        $secPwd = Read-Host "PostgreSQL admin (postgres) password" -AsSecureString
        $PgAdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPwd))
        $script:PgAuthOk = Test-PgSuperuserPassword $PgAdminPassword
        if (-not $script:PgAuthOk) { Write-Warn "That password does not authenticate as the postgres superuser." }
    }
}

# ================================================================
# STEP 1 — Stop & delete services
# ================================================================
Write-Step "Stopping and removing services"
# Collect the PIDs belonging to THIS suite BEFORE deleting each service. Once
# sc.exe delete runs, the service -> PID association is gone and there is no way
# left to tell our node processes from anyone else's. Each NSSM service hosts a
# child node.exe, so record both the service process and its children.
$NocPids = New-Object System.Collections.Generic.List[int]
foreach ($svc in $Services) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if (-not $s) { continue }
    try {
        $wmiSvc = Get-CimInstance Win32_Service -Filter "Name='$svc'" -ErrorAction SilentlyContinue
        if ($wmiSvc -and $wmiSvc.ProcessId -gt 0) {
            $NocPids.Add([int]$wmiSvc.ProcessId)
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($wmiSvc.ProcessId)" -ErrorAction SilentlyContinue |
                ForEach-Object { $NocPids.Add([int]$_.ProcessId) }
        }
    } catch {}
    if ($s.Status -ne 'Stopped') {
        & sc.exe stop $svc | Out-Null
        Start-Sleep -Seconds 2
    }
    & sc.exe delete $svc | Out-Null
    Write-OK "Removed service: $svc"
}

# Kill leftover node processes still holding files under the install dir, so
# STEP 6 can remove those directories.
#
# This used to be a bare `Get-Process -Name node | Stop-Process -Force`, which
# killed EVERY node process on the machine - any unrelated Node application on a
# shared server went down with the uninstall, silently, and the
# -ErrorAction SilentlyContinue swallowed every failure including attempts to kill
# other users' processes. Two narrowing signals are used instead, and a process is
# only killed if it matches one of them:
#   1. a PID captured from one of OUR services above (exact - no guessing), or
#   2. a node.exe whose command line points inside one of NOCVAULT'S OWN four app
#      directories (catches anything orphaned from an earlier run whose service
#      was already gone).
#
# ⛔ SIGNAL 2 MATCHES $AppDirs, NOT $InstallDir. It used to match "*$InstallDir*"
# - the shared PARENT, C:\Apps by default - which is not a NocVault-specific path
# at all. MEASURED on a staging box: a NocVault uninstall killed CertVault's
# server.js and engine-worker.js, both launched as
# "C:\Apps\CertVault\runtime\node\node.exe", and reported them as "2 leftover
# NocVault node process(es)". NSSM restarted them 4 seconds later so the damage
# was brief, but nothing about that was by design, and a product without a
# service wrapper would simply have stayed down. Note also what made it survivable
# for the OTHER product on the same box: SecVaultTest is launched with a RELATIVE
# path, so the substring never matched it. Escaping this was luck, not narrowing.
# Matching is done with IndexOf, not -like, because -like would read a [ or ] in an
# install path as a character class.
$targets = @{}
foreach ($procId in ($NocPids | Sort-Object -Unique)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { $targets[$procId] = $p }
}
$OurRoots = @($AppDirs | ForEach-Object { $_.TrimEnd('\') + '\' })
try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $cl = $_.CommandLine
            if (-not $cl) { return $false }
            foreach ($r in $OurRoots) {
                if ($cl.IndexOf($r, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
            }
            return $false
        } |
        ForEach-Object {
            $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($p) { $targets[[int]$_.ProcessId] = $p }
        }
} catch {}
if ($targets.Count -gt 0) {
    $targets.Values | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-OK "Stopped $($targets.Count) leftover NocVault node process(es)"
} else {
    Write-OK "No leftover NocVault node processes"
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
if (-not $KeepDatabases -and -not $script:PgAuthOk) {
    Write-Step "Dropping databases and roles"
    Write-Warn "SKIPPED - no working postgres superuser password, so nothing was dropped."
    Write-Info "Still on this cluster: databases $($Databases -join ', ') and login roles $($Roles -join ', ')."
    Write-Info "Re-run with -PgAdminPassword '<the postgres password>' to finish, or drop them by hand. $($Roles -join ', ') can still log in until you do."
    $script:DbLeftBehind = $true
} elseif (-not $KeepDatabases) {
    Write-Step "Dropping databases and roles"
    if (Test-Path "$PgBin\psql.exe") {
        $env:PGPASSWORD = $PgAdminPassword
        # ⛔ READ THE EXIT CODE. These used to print "[OK] Dropped ..." whether the
        # statement succeeded or not: psql's stderr went to $null and nothing
        # looked at $LASTEXITCODE, so a refused DROP ROLE (the role still owns an
        # object, or the admin password was wrong) was reported as a success and
        # the leftover credential stayed on the cluster unnoticed. An uninstaller
        # that lies about what it removed is worse than one that fails loudly.
        $dbFailed = @()
        foreach ($db in $Databases) {
            $out = & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -v ON_ERROR_STOP=1 `
                       -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-OK "Dropped database: $db"
            } else {
                $dbFailed += $db
                $script:DbLeftBehind = $true
                Write-Warn "Could NOT drop database '$db' (exit $LASTEXITCODE): $(($out | Out-String).Trim())"
            }
        }
        # Then roles - cross-DB grants are gone once the databases are dropped.
        foreach ($role in $Roles) {
            $out = & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -v ON_ERROR_STOP=1 `
                       -c "DROP ROLE IF EXISTS $role;" 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-OK "Dropped role: $role"
            } else {
                $script:DbLeftBehind = $true
                $text = ($out | Out-String).Trim()
                Write-Warn "Could NOT drop role '$role' (exit $LASTEXITCODE): $text"
                if ($text -match 'cannot be dropped because some objects depend on it') {
                    # PostgreSQL refusing here is the SAFE outcome, not a bug: the
                    # role still holds privileges or owns objects in a database
                    # this uninstaller has no business touching. Measured on a
                    # staging box shared with another product, where
                    # nocvault_readonly held privileges on 23 objects in a
                    # 'certvault' database - forcing the drop would have revoked
                    # grants that product is still using.
                    Write-Info "The DETAIL above names the database that still depends on it. That database is not NocVault's, so this role was deliberately NOT forced out."
                    Write-Info "If NocVault is being removed for good: connect to that database and run REASSIGN OWNED BY $role TO postgres; DROP OWNED BY $role; then DROP ROLE $role."
                    Write-Warn "Until then '$role' keeps its login and its password is still in C:\ProgramData\NocVault\secrets.env."
                } else {
                    if ($dbFailed.Count -gt 0) {
                        Write-Info "A role cannot be dropped while it still holds privileges in a database - the failed drop(s) above ($($dbFailed -join ', ')) are the likely cause."
                    }
                    Write-Warn "This role can still LOG IN to this PostgreSQL cluster. Drop it by hand before the server leaves your control."
                }
            }
        }
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        Write-Warn "psql not found at $PgBin - skipping database removal"
        $script:DbLeftBehind = $true
    }
} else {
    Write-Info "Keeping databases (per -KeepDatabases)"
}

# ================================================================
# STEP 5 — git safe.directory entries (machine-wide / SYSTEM)
# ================================================================
Write-Step "Clearing git safe.directory entries"
$env:PATH = @("C:\Program Files\Git\cmd", "C:\Program Files\Git\bin", $env:PATH) -join ";"
# `& git ...` throws a terminating "term not recognized" error when git isn't on
# PATH at all - `2>$null` doesn't catch that (it's PowerShell's own command
# resolution failing, not the native command's stderr) - wrap in try/catch so this
# falls through to the "skip cleanup" branch below instead of crashing the uninstall.
$gitOk = try { & git --version 2>$null } catch { $null }
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
# STEP 6b — TLS material under C:\ProgramData\NocVault
# ================================================================
# This directory is NOT under $InstallDir, so STEP 6 never reached it, and until
# this step existed a full uninstall left THREE PRIVATE KEYS on the disk of a
# decommissioned server:
#
#   nocvault.key      the shared TLS terminator's key. On a customer install
#                     this is whatever they uploaded through Settings - for the
#                     first such customer, their organisation's *.<domain>
#                     WILDCARD key, valid for every host in the domain and
#                     useful to an attacker long after NocVault is gone.
#   spanvault-ws.key  the agent-ingest WebSocket listener keys. An agent pins
#   ddivault-ws.key   their fingerprints, so these two are also the credential
#                     that lets something impersonate the ingest endpoint.
#
# secrets.env is deliberately NOT touched here - it is documented as surviving an
# uninstall so that a re-install still matches a retained PostgreSQL, and it is
# already ACL'd to administrators. A key is different: nothing about a re-install
# needs the OLD key, because the installer mints a fresh self-signed pair when it
# finds none and the operator re-uploads a real certificate from their own copy.
#
# Files are reported by NAME ONLY. Never echo a key.
if ($KeepCertificates) {
    Write-Step "TLS certificates and keys"
    Write-Info "Keeping $CertDir (per -KeepCertificates)"
    if (-not $KeepDatabases) {
        Write-Warn "The databases were dropped but the certificates were kept - a re-install will reuse this certificate for a suite with no enrolled agents left to pin it."
    }
} elseif (Test-Path -LiteralPath $CertDir) {
    Write-Step "Removing TLS certificates and keys"
    # Enumerated before the delete so the report survives it, and so a partial
    # failure below can be compared against what was actually there.
    $certFiles = @(Get-ChildItem -LiteralPath $CertDir -File -Recurse -ErrorAction SilentlyContinue)
    foreach ($f in $certFiles) { Write-Info "removing $($f.Name)" }
    try {
        Remove-Item -LiteralPath $CertDir -Recurse -Force -ErrorAction Stop
        Write-OK "Removed $CertDir ($($certFiles.Count) file(s), including the TLS private key)"
    } catch {
        # A key that could not be deleted is the one outcome an operator MUST act
        # on, so this is louder than the directory failures in STEP 6.
        Write-Warn "COULD NOT REMOVE $CertDir - $_"
        Write-Warn "A TLS PRIVATE KEY IS STILL ON THIS DISK. Delete $CertDir by hand before the machine leaves your control."
    }
    if ($KeepDatabases) {
        Write-Warn "Databases were kept but the agent-ingest keys were not: any enrolled agent pins spanvault-ws / ddivault-ws by fingerprint and will refuse the new listener after a re-install. Re-distribute the new pins, or re-run with -KeepCertificates next time."
    }
} else {
    Write-Step "TLS certificates and keys"
    Write-Info "$CertDir not present - nothing to remove"
}

# ================================================================
# STEP 7 — Dependencies (optional)
# ================================================================
if ($RemoveDependencies) {
    Write-Step "Removing shared dependencies"

    # PostgreSQL
    #
    # ⛔ NEVER UNINSTALL A CLUSTER SOMEONE ELSE IS ON. This used to run
    # unconditionally, with no look at what the cluster actually holds - even
    # though this switch's own help text admits "other software may depend on
    # them", and even though STEP 4 above already proves the script can SEE
    # another tenant: its DROP ROLE refusal branch exists because a measured
    # staging box had nocvault_readonly holding privileges on 23 objects in a
    # database belonging to a different product. On exactly that box, this line
    # removed the engine that product runs on.
    #
    # "We installed it, so we remove it" was never true either: the documented
    # way to install onto a PostgreSQL that already exists is to pass
    # -PgAdminPassword, and then the installer only creates databases inside a
    # cluster it found.
    #
    # The check is deliberately GENERIC - any database that is not one of the
    # four suite databases, not 'postgres' and not a template counts as someone
    # else's. No other product is named here on purpose: the uninstaller cannot
    # know what a given customer also runs on this server, so it must not try to
    # keep a list. The suite names come from $Databases so there is only ever one
    # such list in this script.
    #
    # Every uncertain outcome REFUSES: no password, no psql, a failed query, a
    # kept-databases contradiction. Refusing costs the operator one manual
    # uninstall. Guessing wrong takes another product's data with it, and an
    # uninstalled PostgreSQL cannot be put back from here.
    $pgUninstall = "C:\Program Files\PostgreSQL\16\uninstall-postgresql.exe"
    $pgRefuse    = $null
    if ($KeepDatabases) {
        $pgRefuse = "-KeepDatabases was passed, so the four suite databases are still on this cluster - uninstalling PostgreSQL would delete the data you asked to keep."
    } elseif (-not $script:PgAuthOk) {
        $pgRefuse = "there is no working postgres superuser password, so this script cannot check whether another product's database is on this cluster."
    } elseif (-not (Test-Path "$PgBin\psql.exe")) {
        $pgRefuse = "psql was not found at $PgBin, so this script cannot check whether another product's database is on this cluster."
    } else {
        # Same superuser connection STEP 4 used moments ago; $PgAdminPassword was
        # verified by Test-PgSuperuserPassword before STEP 1.
        $env:PGPASSWORD = $PgAdminPassword
        $suiteList = ($Databases | ForEach-Object { "'" + $_ + "'" }) -join ','
        $pgQuery   = "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' AND datname NOT IN ($suiteList) ORDER BY datname;"
        # -w (never prompt) belongs on THIS call above all others: it is the one
        # that decides whether a PostgreSQL cluster gets destroyed, and the GUI
        # uninstaller drives this engine with -Force behind a hidden window where
        # a psql password prompt does not fail, it hangs for ever. PGPASSWORD is
        # set above and verified, so a prompt here could only mean something has
        # gone wrong - and then refusing (below) is the right answer anyway.
        $pgOut = & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -w -tA -v ON_ERROR_STOP=1 -c $pgQuery 2>&1
        $pgRc  = $LASTEXITCODE
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
        if ($pgRc -ne 0) {
            $pgRefuse = "the pg_database check failed (exit $pgRc): $(($pgOut | Out-String).Trim())"
        } else {
            $pgForeign = @($pgOut | ForEach-Object { "$_".Trim() } | Where-Object { $_ -ne '' })
            if ($pgForeign.Count -gt 0) {
                $pgRefuse = "this cluster still hosts $($pgForeign.Count) database(s) that are not NocVault's: $($pgForeign -join ', ')."
            }
        }
    }
    if ($pgRefuse) {
        Write-Warn "REFUSING to uninstall PostgreSQL - $pgRefuse"
        Write-Info "PostgreSQL was left installed and running. Everything else in this step still ran."
        Write-Info "If it really should go, confirm by hand that nothing else uses this cluster, then run: `"$pgUninstall`" --mode unattended"
    } elseif (Test-Path $pgUninstall) {
        Write-Info "Uninstalling PostgreSQL 16 (no non-NocVault database found on this cluster)..."
        Start-Process -Wait -FilePath $pgUninstall -ArgumentList "--mode unattended"
        # Judged by the uninstaller binary being gone, not by an exit code: this
        # flag decides how loud STEP 8 is about secrets.env, so it must only be
        # set when the cluster really went.
        if (-not (Test-Path $pgUninstall)) {
            $script:PgRemoved = $true
            Write-OK "PostgreSQL uninstalled"
        } else {
            Write-Warn "PostgreSQL may NOT have been uninstalled - $pgUninstall is still present. Check it by hand."
        }
    } else {
        Write-Warn "PostgreSQL uninstaller not found - skipping"
    }

    # ── Is anyone else on Node.js / Git? ──────────────────────────
    # ⛔ THESE TWO USED TO BE REMOVED UNCONDITIONALLY, WHICH IS THE SAME BUG THE
    # POSTGRESQL STEP ABOVE EXISTS TO FIX - just with a shared runtime instead of a
    # shared cluster. The PostgreSQL comment already says it: "we installed it, so
    # we remove it" was never true. It is not true here either, and provably so -
    # the installer's STEP 3 and STEP 4 both DETECT a pre-existing Node/Git and skip
    # installing it, so on a build agent, a developer box, or any server already
    # running something else on Node, this switch uninstalled software that was here
    # first and that nothing in this suite ever owned.
    #
    # Two independent signals, and BOTH must clear:
    #
    #   1. OWNERSHIP - install-state.env, written by the installer at the moment it
    #      decided whether to install each tool. '0' means it was already present
    #      (including the case where we only upgraded someone else's Node in place),
    #      and that is a hard stop. Installs that predate this record have no key;
    #      that is "unknown", not "ours", so signal 2 has to carry it.
    #
    #   2. FOREIGN USE - any Windows service, scheduled task or running process that
    #      is not part of this suite and references the tool. Services and tasks are
    #      durable, machine-level declarations of a dependency, which is exactly the
    #      kind of evidence worth refusing on. Our own names are excluded from both
    #      lists ($Services/$Tasks) so a half-finished uninstall cannot block itself.
    #
    # Every uncertain outcome LEAVES THE TOOL INSTALLED, matching the PostgreSQL
    # step: refusing costs the operator one manual uninstall, and getting it wrong
    # costs somebody else their runtime. Note this can only ever ADD a refusal -
    # a genuinely clean box with no record still removes both, as before.
    $InstallStateFile = 'C:\ProgramData\NocVault\install-state.env'

    # ⛔ RETURNS A HASHTABLE, NOT AN ARRAY, AND THAT IS NOT STYLE. A PowerShell
    # function that returns an EMPTY array hands the caller $null - measured on
    # staging PS 5.1.26100: `function f { return @() }; $null -eq (f)` is True. So
    # the obvious shape here (return the list of foreign users, $null if we could
    # not look) makes "clean box" and "could not look" the SAME value, and since
    # this guard refuses on "could not look", -RemoveDependencies would have
    # silently stopped removing Node and Git on every machine, for ever, with the
    # reason printed being an enumeration failure that never happened.
    # { Looked = $false } is the only "we could not look"; Items may be empty.
    function Get-ForeignToolUsers([string]$exeName) {
        $found = New-Object System.Collections.ArrayList
        try {
            foreach ($s in @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop)) {
                if ($Services -contains $s.Name) { continue }
                if ([string]$s.PathName -match [regex]::Escape($exeName)) {
                    $null = $found.Add("service '" + $s.Name + "'")
                }
            }
        } catch { return @{ Looked = $false; Items = @() } }
        try {
            foreach ($t in @(Get-ScheduledTask -ErrorAction Stop)) {
                if ($Tasks -contains $t.TaskName) { continue }
                $act = ''
                try { $act = (@($t.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ') } catch { $act = '' }
                if ($act -match [regex]::Escape($exeName)) {
                    $null = $found.Add("scheduled task '" + $t.TaskName + "'")
                }
            }
        } catch { return @{ Looked = $false; Items = @() } }
        # A running process is the weakest of the three, so it is matched on its
        # COMMAND LINE rather than its image path: the suite's own consoles run the
        # shared C:\Program Files\nodejs\node.exe, so an image-path test would call
        # our own leftovers foreign and block the removal on every single run.
        try {
            foreach ($pr in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
                              Where-Object { [string]$_.Name -eq $exeName })) {
                $cl = [string]$pr.CommandLine
                if ($cl -and ($cl -like "*$InstallDir*")) { continue }
                $null = $found.Add("running process " + $pr.Name + " (pid " + $pr.ProcessId + ")")
            }
        } catch { }
        return @{ Looked = $true; Items = @($found | Select-Object -Unique) }
    }

    function Test-RemoveSharedTool([string]$label, [string]$exeName, [string]$ownKey) {
        $owned = Get-EnvVal $InstallStateFile $ownKey
        if ($owned -eq '0') {
            Write-Warn "$label was ALREADY INSTALLED on this server before NocVault (recorded in $InstallStateFile) - LEAVING it installed."
            return $false
        }
        $scan = Get-ForeignToolUsers $exeName
        if (-not $scan.Looked) {
            Write-Warn "Could not enumerate this server's services and scheduled tasks, so whether anything else needs $label is UNKNOWN - LEAVING it installed. Remove it by hand once you are sure."
            return $false
        }
        $foreign = @($scan.Items)
        if ($foreign.Count -gt 0) {
            Write-Warn "LEAVING $label installed - something outside this suite uses it:"
            foreach ($f in $foreign) { Write-Warn "    $f" }
            Write-Info "Uninstall $label by hand if those are being retired too."
            return $false
        }
        if ($owned -eq '1') {
            Write-Info "$label was installed by NocVault and nothing else references it - removing."
        } else {
            Write-Info "No record of who installed $label (this install predates that record) and nothing else references it - removing."
        }
        return $true
    }

    # Node.js (MSI)
    #
    # Read the uninstall registry rather than querying Win32_Product. Enumerating
    # that WMI class makes the installer service VALIDATE and reconfigure every
    # installed MSI on the machine - it is slow (minutes on a server with many
    # products), it writes an MsiInstaller 1035 "reconfigured" event per product,
    # and on a badly-behaved package it can genuinely change state. Microsoft has
    # advised against Win32_Product for exactly this reason for years. The registry
    # holds the same ProductCode with none of that: for an MSI-installed product
    # the Uninstall subkey name IS the ProductCode GUID msiexec /x needs.
    #
    # Both registry views are checked because a 64-bit host can carry a 32-bit MSI.
    $nodeProduct = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    ) | ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayName -like 'Node.js*' -and $_.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$' } |
        Select-Object -First 1
    if (-not (Test-RemoveSharedTool 'Node.js' 'node.exe' 'NODE_OWNED_BY_NOCVAULT')) {
        # left installed on purpose - Test-RemoveSharedTool already said why
    } elseif ($nodeProduct) {
        Write-Info "Uninstalling Node.js ($($nodeProduct.DisplayName))..."
        Start-Process -Wait -FilePath "msiexec.exe" -ArgumentList "/x", $nodeProduct.PSChildName, "/quiet", "/norestart"
        Write-OK "Node.js uninstalled"
    } else {
        Write-Warn "Node.js MSI product not found - skipping"
    }

    # Git (silent uninstaller)
    $gitUninstall = Get-ChildItem "C:\Program Files\Git\unins*.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not (Test-RemoveSharedTool 'Git' 'git.exe' 'GIT_OWNED_BY_NOCVAULT')) {
        # left installed on purpose - Test-RemoveSharedTool already said why
    } elseif ($gitUninstall) {
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
# STEP 8 - Machine-level secrets (secrets.env)
# ================================================================
# The same defect STEP 6b was written to fix, one directory up. secrets.env holds
# SEVEN credentials in CLEARTEXT, all written by the installer:
#
#   POSTGRES_PASSWORD  superuser on the whole PostgreSQL cluster
#   NEXTAUTH_SECRET    signs every SSO token across all four consoles AND is the
#                      KDF input for DDIVault's stored-credential encryption, so
#                      it is the one secret whose leak outlives this machine: it
#                      is routinely carried to the REPLACEMENT server from a
#                      backup of this file
#   NOCVAULT_RO_PASS   the cross-DB read-only login
#   NV_/LV_/DDI_/SV_DB_PASS  the four per-app database logins
#
# STEP 6 has already deleted every app .env that held copies, so from here on
# this file is the ONLY copy on the disk.
#
# It is still NOT deleted by default, and that default is right: a re-install is
# meant to reuse this file so the new install keeps matching a PostgreSQL that
# was retained, and deleting it while a database or login role is still on the
# cluster strands them with no recorded password. What was missing is that the
# default is only defensible while that premise HOLDS - and it does not hold on
# the two paths this script also supports. Once the databases have been dropped,
# or the cluster itself uninstalled, the file is worthless for a re-install and
# still a full set of live secrets sitting under a green "Uninstall Complete"
# banner. Those paths now name the file and the secrets in it, and
# -RemoveSecrets deletes it outright.
#
# Reported by NAME ONLY (Get-SecretKeyNames) - never a value, never a line.
$secretsPresent = Test-Path -LiteralPath $SecretsFile
# Worthless for a re-install: nothing it names still exists here.
$secretsStale   = $script:PgRemoved -or ((-not $KeepDatabases) -and (-not $script:DbLeftBehind))
# Must NOT be deleted yet: something still on the cluster needs these passwords.
# Qualified by -not $script:PgRemoved on purpose - a database or role that could
# not be dropped went with the cluster when PostgreSQL was uninstalled, so there
# is nothing left for these passwords to strand and refusing to delete the file
# would only leave the secrets on the disk for no benefit.
$secretsNeeded  = (-not $script:PgRemoved) -and ($KeepDatabases -or $script:DbLeftBehind)
if (-not $secretsPresent) {
    Write-Step "Machine-level secrets"
    Write-Info "$SecretsFile not present - nothing to remove"
} elseif ($RemoveSecrets -and $secretsNeeded) {
    # Refuse rather than remove more. -RemoveSecrets here would be the only
    # irreversible step in the script: the databases or roles it unlocks are
    # still on the cluster, and STEP 6 already deleted the app .env copies, so
    # the passwords would exist nowhere.
    Write-Step "Machine-level secrets"
    Write-Warn "REFUSING to delete $SecretsFile despite -RemoveSecrets."
    if ($KeepDatabases) {
        Write-Warn "The four databases and their login roles were KEPT (-KeepDatabases). This file is now the only record of their passwords - STEP 6 deleted every app .env that held a copy."
    } else {
        Write-Warn "A database or login role could NOT be dropped (see the [!!] lines above). This file is now the only record of its password."
    }
    Write-Info "Finish the database step, or copy this file somewhere you control, and then delete $SecretsFile by hand."
    $script:SecretsLeftBehind = $true
} elseif ($RemoveSecrets) {
    Write-Step "Removing machine-level secrets"
    foreach ($k in @(Get-SecretKeyNames $SecretsFile)) { Write-Info "removing secret: $k" }
    try {
        Remove-Item -LiteralPath $SecretsFile -Force -ErrorAction Stop
        Write-OK "Removed $SecretsFile"
    } catch {
        # Louder than a directory failure for the same reason as the TLS key in
        # STEP 6b: the operator MUST act on this one before the disk moves.
        Write-Warn "COULD NOT REMOVE $SecretsFile - $_"
        Write-Warn "CLEARTEXT CREDENTIALS ARE STILL ON THIS DISK. Delete $SecretsFile by hand before the machine leaves your control."
        $script:SecretsLeftBehind = $true
    }
} elseif ($secretsStale) {
    Write-Step "Machine-level secrets"
    Write-Warn "$SecretsFile WAS KEPT, AND IT IS NOW WORTHLESS BUT NOT HARMLESS."
    if ($script:PgRemoved) {
        Write-Info "PostgreSQL itself was uninstalled, so nothing these credentials protect still exists on this machine."
    } else {
        Write-Info "The four databases and their login roles were dropped. POSTGRES_PASSWORD in this file is STILL the live superuser password of the PostgreSQL cluster that was left installed."
    }
    $secretKeys = @(Get-SecretKeyNames $SecretsFile)
    if ($secretKeys.Count -gt 0) {
        Write-Warn "Cleartext secrets still in that file: $($secretKeys -join ', ')."
    }
    Write-Warn "NEXTAUTH_SECRET signs every NocVault SSO token and keys DDIVault's stored-credential encryption. If this file was ever backed up and restored onto a replacement server, deleting this machine does not retire that secret - rotate it there."
    Write-Warn "Delete $SecretsFile by hand, or re-run with -RemoveSecrets, before this disk leaves your control."
    $script:SecretsLeftBehind = $true
} elseif ($KeepDatabases) {
    Write-Step "Machine-level secrets"
    Write-Info "Keeping $SecretsFile so a re-install still matches the databases preserved by -KeepDatabases."
} else {
    Write-Step "Machine-level secrets"
    Write-Info "Keeping $SecretsFile - the database step did not finish, and it holds the passwords needed to complete it by hand."
}

# ================================================================
# DONE
# ================================================================
Write-Host ""
if ($script:DbLeftBehind) {
    # Not "Complete". The services, files and keys are gone but the databases and
    # their login roles are still on the cluster, and a green COMPLETE banner over
    # that is how a half-finished uninstall gets filed as a finished one.
    Write-Host "  +======================================================+" -ForegroundColor Yellow
    Write-Host "  |   NocVault Suite - Uninstall INCOMPLETE              |" -ForegroundColor Yellow
    Write-Host "  +======================================================+" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Services, scheduled tasks, firewall rules, application files" -ForegroundColor Gray
    Write-Host "  and TLS keys were removed. The DATABASES and/or their LOGIN" -ForegroundColor Gray
    Write-Host "  ROLES were NOT - see the [!!] lines above. Those roles can" -ForegroundColor Yellow
    Write-Host "  still log in to this PostgreSQL cluster." -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "  +======================================================+" -ForegroundColor Green
    Write-Host "  |   NocVault Suite - Uninstall Complete                |" -ForegroundColor Green
    Write-Host "  +======================================================+" -ForegroundColor Green
    Write-Host ""
}
if ($script:SecretsLeftBehind) {
    # The banner above can legitimately say "Complete" while this file remains -
    # keeping it is the documented default - but an operator who reads only the
    # banner before wiping or shipping the disk must not miss it, so it is
    # repeated here, after the last [!!] line has scrolled past.
    Write-Host "  ACTION REQUIRED: cleartext credentials are still on this disk:" -ForegroundColor Yellow
    Write-Host "        $SecretsFile" -ForegroundColor Yellow
    Write-Host "        (see the [!!] lines above). Delete it before this machine" -ForegroundColor Yellow
    Write-Host "        or its disk leaves your control." -ForegroundColor Yellow
    Write-Host ""
}
if ($KeepDatabases) {
    Write-Host "  NOTE: Databases were preserved. To remove them later, re-run" -ForegroundColor Gray
    Write-Host "        without -KeepDatabases." -ForegroundColor Gray
    Write-Host ""
}
Write-Host "  If any directory could not be deleted (file lock), reboot and" -ForegroundColor Gray
Write-Host "  delete it manually under $InstallDir." -ForegroundColor Gray
Write-Host ""
