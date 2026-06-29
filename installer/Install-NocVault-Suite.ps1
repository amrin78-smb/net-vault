#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NocVault Suite Installer v1.3
.DESCRIPTION
    Installs NetVault, LogVault, DDIVault and SpanVault on a Windows Server.
    NetVault is mandatory. LogVault, DDIVault and SpanVault are optional.
    Requires internet access to clone from GitHub.
.PARAMETER InstallDir
    Root installation directory (default: C:\Apps)
.PARAMETER ServerIP
    Server IP address (default: auto-detected)
.PARAMETER InstallLogVault
    Install LogVault add-on (default: true)
.PARAMETER InstallDDIVault
    Install DDIVault add-on (default: true)
.PARAMETER InstallSpanVault
    Install SpanVault add-on (default: true)
.EXAMPLE
    .\Install-NocVault-Suite.ps1
    .\Install-NocVault-Suite.ps1 -InstallDir "D:\Apps" -ServerIP "10.10.1.50"
    .\Install-NocVault-Suite.ps1 -InstallLogVault $false -InstallDDIVault $false -InstallSpanVault $false
#>
param(
    [string]$InstallDir      = "C:\Apps",
    [string]$ServerIP        = "",
    [bool]$InstallLogVault   = $true,
    [bool]$InstallDDIVault   = $true,
    [bool]$InstallSpanVault  = $true,
    [string]$PgAdminPassword = "",
    [string]$NocReadOnlyPass = "",
    [switch]$Unattended
)

# Default PostgreSQL superuser password used for fully unattended (one-click)
# installs when -PgAdminPassword is not supplied. Printed at the end so the
# admin can change it. Interactive runs still prompt instead.
$DefaultPgPassword = "NocV@ult_Pg#2026"

# Default password for the cross-DB read-only role (nocvault_readonly) the NocVault
# Hub uses to read across all suite DBs. Used only in -Unattended mode (printed at
# the end so it can be changed); interactive installs prompt for it instead.
$DefaultNocRoPassword = "NocV@ult_RO#2026"

# ── Helpers ───────────────────────────────────────────────────────
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    [--] $msg" -ForegroundColor Gray }

# Grant the cross-DB read-only role (nocvault_readonly) SELECT on a database. Call
# AFTER that DB's schema is applied so existing AND future tables are covered. Feeds
# the NocVault Hub's cross-app reads (unified search / asset 360 / suite alerting).
function GrantNocRoRead($db) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d $db -c "GRANT CONNECT ON DATABASE $db TO nocvault_readonly;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d $db -c "GRANT USAGE ON SCHEMA public TO nocvault_readonly;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d $db -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocvault_readonly;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d $db -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nocvault_readonly;" 2>$null
}

# ── Banner ────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  +============================================+" -ForegroundColor White
Write-Host "  |   NocVault Suite Installer v1.3           |" -ForegroundColor White
Write-Host "  |   Network Intelligence Suite              |" -ForegroundColor White
Write-Host "  +============================================+" -ForegroundColor White
Write-Host ""

# ── Paths ─────────────────────────────────────────────────────────
$ScriptDir      = $PSScriptRoot
$DepsDir        = "$ScriptDir\dependencies"
$NVDir          = "$InstallDir\NetVault"
$LVDir          = "$InstallDir\LogVault"
$DDIDir         = "$InstallDir\DDIVault"
$SVDir          = "$InstallDir\SpanVault"
$NVAppDir       = "$NVDir\app"
$LVAppDir       = "$LVDir\app"
$DDIAppDir      = "$DDIDir\app"
$SVAppDir       = "$SVDir\app"
$PgBin          = "C:\Program Files\PostgreSQL\16\bin"
$NssmZip        = "$DepsDir\nssm-2.24.zip"
$NssmDir        = "$NVDir\nssm"
$NssmExe        = "$NssmDir\nssm-2.24\win64\nssm.exe"
$NodeMsi        = "$DepsDir\node-v20.19.0-x64.msi"
$PgInstaller    = (Get-ChildItem "$DepsDir\postgresql-16*windows-x64.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$GitInstaller   = "$DepsDir\Git-2.54.0-64-bit.exe"
$VcRedist       = "$DepsDir\VC_redist.x64.exe"

# ── GitHub URLs ───────────────────────────────────────────────────
$NVGitUrl       = "https://github.com/amrin78-smb/net-vault"
$LVGitUrl       = "https://github.com/amrin78-smb/logvault"
$DDIGitUrl      = "https://github.com/amrin78-smb/ddivault"
$SVGitUrl       = "https://github.com/amrin78-smb/spanvault"

# ── Credentials ───────────────────────────────────────────────────
$NVDbPass     = "PgAdmin@2026!"
$LVDbPass     = "NVAdmin@2026"
$DDIDbPass    = "NVAdmin@2026"
$SVDbPass     = "NVAdmin@2026"
$SharedSecret = "bue3VdWszntJ24GMhfKg1QkPIEaZYC95"
# CRON_SECRET authorises NetVault's daily health-snapshot job (Bearer token).
# Generated once here so .env, standalone .env.local, the NSSM service env and
# the scheduled task all share the same value.
$CronSecret   = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
# LOG_INTEGRITY_KEY keys LogVault's tamper-evident HMAC hash chain (prev_hash/entry_hash
# on syslog_entries). Generated once so the collector's NSSM env and LogVault .env.local
# share one value; if it is unset the chain is silently disabled, so fresh installs must
# set it for the Phase 3 log-integrity feature to work.
$LogIntegrityKey = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

# ── Auto-detect server IP ─────────────────────────────────────────
if (-not $ServerIP) {
    $ServerIP = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
}
# Never leave ServerIP empty - it would produce broken URLs like http://:3000
if (-not $ServerIP) {
    $ServerIP = "127.0.0.1"
    Write-Warn "Could not auto-detect a server IP - falling back to 127.0.0.1. Pass -ServerIP to override."
}

# ── Detect PostgreSQL service name ────────────────────────────────
$PgSvcName = (Get-Service | Where-Object {
    $_.Name -like "postgresql*" -or $_.DisplayName -like "*postgresql*"
} | Select-Object -First 1).Name
if (-not $PgSvcName) { $PgSvcName = "postgresql-x64-16" }

# ── Validate prerequisites ────────────────────────────────────────
Write-Step "Validating installer package"
$missing = @()
if (-not (Test-Path $NodeMsi))   { $missing += "dependencies\node-v20.19.0-x64.msi" }
if (-not (Test-Path $NssmZip))   { $missing += "dependencies\nssm-2.24.zip" }
if (-not $PgInstaller)           { $missing += "dependencies\postgresql-16*windows-x64.exe" }
if ($missing.Count -gt 0) {
    Write-Host "`n  Missing required files:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
    Write-Host "`n  Place missing files in the installer folder and retry.`n" -ForegroundColor Red
    exit 1
}
Write-OK "All required files present"

# ── Display config ────────────────────────────────────────────────
Write-Host ""
Write-Host "  Install directory  : $InstallDir" -ForegroundColor Gray
Write-Host "  Server IP          : $ServerIP" -ForegroundColor Gray
Write-Host "  PostgreSQL service : $PgSvcName" -ForegroundColor Gray
Write-Host "  Install LogVault   : $InstallLogVault" -ForegroundColor Gray
Write-Host "  Install DDIVault   : $InstallDDIVault" -ForegroundColor Gray
Write-Host "  Install SpanVault  : $InstallSpanVault" -ForegroundColor Gray
Write-Host ""
Write-Host "  NOTE: Internet access required (cloning from GitHub)." -ForegroundColor Yellow
Write-Host "  Estimated install time: 15-20 minutes." -ForegroundColor Gray
Write-Host ""

# ── PostgreSQL admin password ─────────────────────────────────────
if (-not $PgAdminPassword) {
    if ($Unattended) {
        $PgAdminPassword = $DefaultPgPassword
        Write-Info "Unattended mode: using default PostgreSQL password (shown at end)."
    } else {
        $secPwd = Read-Host "Set PostgreSQL admin (postgres) password" -AsSecureString
        $PgAdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPwd))
    }
}

# ── NocVault Hub read-only role password (cross-app reads across all suite DBs) ──
if (-not $NocReadOnlyPass) {
    if ($Unattended) {
        $NocReadOnlyPass = $DefaultNocRoPassword
        Write-Info "Unattended mode: using default NocVault read-only password (shown at end)."
    } else {
        $secRo = Read-Host "Set NocVault read-only (nocvault_readonly) DB password" -AsSecureString
        $NocReadOnlyPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secRo))
    }
}

if (-not $Unattended) {
    Write-Host ""
    Write-Host "  Ready to install. Press Enter to continue or Ctrl+C to cancel." -ForegroundColor Yellow
    Read-Host
}

# ================================================================
# STEP 1 — Directories
# ================================================================
Write-Step "Creating directories"
New-Item -ItemType Directory -Force -Path $NVDir | Out-Null
New-Item -ItemType Directory -Force -Path "$NVDir\logs" | Out-Null
New-Item -ItemType Directory -Force -Path "$NVDir\nssm" | Out-Null
if ($InstallLogVault) {
    New-Item -ItemType Directory -Force -Path $LVDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$LVDir\logs" | Out-Null
}
if ($InstallDDIVault) {
    New-Item -ItemType Directory -Force -Path $DDIDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$DDIDir\logs" | Out-Null
}
if ($InstallSpanVault) {
    New-Item -ItemType Directory -Force -Path $SVDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$SVDir\logs" | Out-Null
}
Write-OK "Directories created"

# ================================================================
# STEP 2 — VC Redist
# ================================================================
Write-Step "Installing Visual C++ Redistributable"
if (Test-Path $VcRedist) {
    Start-Process -Wait -FilePath $VcRedist -ArgumentList '/install','/quiet','/norestart'
    Write-OK "VC Redistributable installed"
} else {
    Write-Warn "VC Redistributable not found - skipping"
}

# ================================================================
# STEP 3 — Node.js
# ================================================================
Write-Step "Installing Node.js v20.19.0"
$nodeVer = & node --version 2>$null
if ($nodeVer -eq 'v20.19.0') {
    Write-OK "Node.js v20.19.0 already installed"
} else {
    Start-Process -Wait -FilePath "msiexec.exe" -ArgumentList "/I `"$NodeMsi`" /quiet"
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + $env:PATH
    Write-OK "Node.js v20.19.0 installed"
}

# ================================================================
# STEP 4 — Git
# ================================================================
Write-Step "Installing Git"
$gitVer = & git --version 2>$null
if ($gitVer) {
    Write-OK "Git already installed: $gitVer"
} elseif (Test-Path $GitInstaller) {
    Start-Process -Wait -FilePath $GitInstaller -ArgumentList '/VERYSILENT','/NORESTART'
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + $env:PATH
    Write-OK "Git installed"
} else {
    throw "Git installer not found and Git is not installed. Cannot continue."
}

# ================================================================
# STEP 5 — PostgreSQL
# ================================================================
Write-Step "Installing PostgreSQL 16"
if (Test-Path "$PgBin\psql.exe") {
    Write-OK "PostgreSQL already installed"
} else {
    Start-Process -Wait -FilePath $PgInstaller -ArgumentList `
        "--mode unattended",
        "--unattendedmodeui minimal",
        "--superpassword `"$PgAdminPassword`"",
        "--serverport 5432",
        "--servicename postgresql-x64-16"
    $env:PATH = "$PgBin;" + $env:PATH
    $PgSvcName = (Get-Service | Where-Object {
        $_.Name -like "postgresql*"
    } | Select-Object -First 1).Name
    if (-not $PgSvcName) { $PgSvcName = "postgresql-x64-16" }
    Write-OK "PostgreSQL 16 installed (service: $PgSvcName)"
}

# ================================================================
# STEP 6 — NSSM
# ================================================================
Write-Step "Installing NSSM"
Expand-Archive -Path $NssmZip -DestinationPath $NssmDir -Force
Write-OK "NSSM ready"

# ================================================================
# STEP 7 — Databases
# ================================================================
Write-Step "Creating databases and users"
$env:PGPASSWORD = $PgAdminPassword

& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER netvault WITH PASSWORD '$NVDbPass';" 2>$null
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE netvault OWNER netvault;" 2>$null
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "GRANT ALL PRIVILEGES ON DATABASE netvault TO netvault;" 2>$null
Write-OK "NetVault database ready"

# Cross-DB read-only role for the NocVault Hub (reads across all suite DBs).
# Created once here; per-DB SELECT grants are applied after each schema below.
# ALTER ... PASSWORD keeps it idempotent if the role already exists from a prior run.
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER nocvault_readonly WITH PASSWORD '$NocReadOnlyPass';" 2>$null
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "ALTER USER nocvault_readonly WITH PASSWORD '$NocReadOnlyPass';" 2>$null
Write-OK "NocVault read-only role ready"

if ($InstallLogVault) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER logvault_user WITH PASSWORD '$LVDbPass';" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE logvault OWNER logvault_user;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "GRANT ALL PRIVILEGES ON DATABASE logvault TO logvault_user;" 2>$null
    Write-OK "LogVault database ready"
}

if ($InstallDDIVault) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER ddivault_user WITH PASSWORD '$DDIDbPass';" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE ddivault OWNER ddivault_user;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "GRANT ALL PRIVILEGES ON DATABASE ddivault TO ddivault_user;" 2>$null
    Write-OK "DDIVault database ready"
}

if ($InstallSpanVault) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER spanvault_user WITH PASSWORD '$SVDbPass';" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE spanvault OWNER spanvault_user;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "GRANT ALL PRIVILEGES ON DATABASE spanvault TO spanvault_user;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT CONNECT ON DATABASE netvault TO spanvault_user;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT USAGE ON SCHEMA public TO spanvault_user;" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT SELECT ON devices, sites, countries, regions, brands, device_types, vendors, users, user_sites TO spanvault_user;" 2>$null
    Write-OK "SpanVault database ready"
}

# ================================================================
# STEP 8 — NetVault
# ================================================================
Write-Step "Installing NetVault"

if (Test-Path $NVAppDir) { Remove-Item $NVAppDir -Recurse -Force }
Write-Info "Cloning NetVault from GitHub..."
& git clone $NVGitUrl $NVAppDir
if ($LASTEXITCODE -ne 0) { throw "Failed to clone NetVault" }
# Mark repo safe for the SYSTEM account (services/update jobs run git as SYSTEM).
# --system is machine-wide so it covers SYSTEM even though the installer runs as admin.
& git config --system --add safe.directory ($NVAppDir -replace '\\','/') 2>$null
Write-OK "NetVault cloned"

# Run schema
$env:PGPASSWORD = $PgAdminPassword
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\schema.sql"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO netvault;"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO netvault;"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\setup.sql"
GrantNocRoRead "netvault"
Write-OK "NetVault schema applied"

# Create .env
# POSTGRES_PASSWORD lets the app's own Update-NetVault.ps1 re-apply schema.sql as
# the postgres superuser on later updates (new views, eol_* column-type fixes,
# ownership self-heal); without it that step soft-skips. Mirrors LogVault's .env.local.
@"
DATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault
NEXTAUTH_SECRET=$SharedSecret
NEXTAUTH_URL=http://${ServerIP}:3000
NODE_ENV=production
SSL_DISABLED=true
SERVER_IP=$ServerIP
CRON_SECRET=$CronSecret
NOCVAULT_RO_HOST=localhost
NOCVAULT_RO_PORT=5432
NOCVAULT_RO_USER=nocvault_readonly
NOCVAULT_RO_PASS=$NocReadOnlyPass
NEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000
POSTGRES_PASSWORD=$PgAdminPassword
"@ | Out-File -FilePath "$NVAppDir\.env" -Encoding UTF8 -NoNewline

# Build
Set-Location $NVAppDir
Write-Info "Installing NetVault dependencies..."
& npm install 2>&1 | Tee-Object -FilePath "$NVDir\logs\npm-install.log"
if ($LASTEXITCODE -ne 0) { throw "NetVault npm install failed" }
Write-Info "Building NetVault (3-5 minutes)..."
& npm run build 2>&1 | Tee-Object -FilePath "$NVDir\logs\npm-build.log"
if ($LASTEXITCODE -ne 0) { throw "NetVault build failed. Check $NVDir\logs\npm-build.log" }
Write-OK "NetVault built"

# Copy static files into standalone
$NVStandalone = "$NVAppDir\.next\standalone"
Copy-Item -Path "$NVAppDir\public" -Destination "$NVStandalone\public" -Recurse -Force
New-Item -ItemType Directory -Force -Path "$NVStandalone\.next" | Out-Null
Copy-Item -Path "$NVAppDir\.next\static" -Destination "$NVStandalone\.next\static" -Recurse -Force
Write-OK "NetVault static files copied"

# The Next.js standalone server loads .env.local from its working directory at
# runtime. OS/NSSM env wins for keys it sets, but CRON_SECRET and SERVER_IP are
# only guaranteed here - the health-snapshot route reads process.env.CRON_SECRET.
@"
DATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault
NEXTAUTH_SECRET=$SharedSecret
NEXTAUTH_URL=http://${ServerIP}:3000
NODE_ENV=production
SSL_DISABLED=true
SERVER_IP=$ServerIP
CRON_SECRET=$CronSecret
NOCVAULT_RO_HOST=localhost
NOCVAULT_RO_PORT=5432
NOCVAULT_RO_USER=nocvault_readonly
NOCVAULT_RO_PASS=$NocReadOnlyPass
NEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000
"@ | Out-File -FilePath "$NVStandalone\.env.local" -Encoding UTF8 -NoNewline
Write-OK "NetVault standalone .env.local written (incl. SERVER_IP, CRON_SECRET)"

# Register NSSM service
& $NssmExe stop NetVault confirm 2>$null
& $NssmExe remove NetVault confirm 2>$null
& $NssmExe install NetVault "C:\Program Files\nodejs\node.exe" "$NVStandalone\server.js"
& $NssmExe set NetVault AppDirectory        $NVStandalone
& $NssmExe set NetVault AppEnvironmentExtra "PORT=3000`nHOSTNAME=0.0.0.0`nNODE_ENV=production`nDATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault`nNEXTAUTH_SECRET=$SharedSecret`nNEXTAUTH_URL=http://${ServerIP}:3000`nSSL_DISABLED=true`nSERVER_IP=$ServerIP`nCRON_SECRET=$CronSecret`nNOCVAULT_RO_HOST=localhost`nNOCVAULT_RO_PORT=5432`nNOCVAULT_RO_USER=nocvault_readonly`nNOCVAULT_RO_PASS=$NocReadOnlyPass"
& $NssmExe set NetVault DisplayName         "NetVault - Network Asset Management"
& $NssmExe set NetVault Description         "NocVault Suite - Network Asset Management"
& $NssmExe set NetVault Start               SERVICE_AUTO_START
& $NssmExe set NetVault DependOnService     $PgSvcName
& $NssmExe set NetVault AppStdout           "$NVDir\logs\netvault.log"
& $NssmExe set NetVault AppStderr           "$NVDir\logs\netvault-error.log"
& $NssmExe set NetVault AppRotateFiles      1
& $NssmExe set NetVault AppRotateBytes      10485760
& $NssmExe set NetVault AppRotateOnline     1
& $NssmExe set NetVault AppRestartDelay     3000
Write-OK "NetVault service registered"

New-NetFirewallRule -DisplayName "NocVault NetVault 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-OK "Firewall rule added: port 3000"

# Daily fleet health-snapshot job (feeds health_score_history trend).
# Posts to NetVault with the shared CRON_SECRET as a Bearer token.
$nvSnapAction  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
$nvSnapTrigger = New-ScheduledTaskTrigger -Daily -At "00:00"
Register-ScheduledTask -TaskName "NetVault-HealthSnapshot" -Action $nvSnapAction -Trigger $nvSnapTrigger -RunLevel Highest -Force | Out-Null
Write-OK "Scheduled task 'NetVault-HealthSnapshot' registered (daily 00:00)"

# Daily EOL/EOS enrichment (matches devices against eol_seed, writes EOL/EOS dates;
# status-change recommendations stay human-gated). Mirrors Update-NetVault.ps1.
$nvEolAction  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
$nvEolTrigger = New-ScheduledTaskTrigger -Daily -At "01:00"
Register-ScheduledTask -TaskName "NetVault-EnrichEol" -Action $nvEolAction -Trigger $nvEolTrigger -RunLevel Highest -Force | Out-Null
Write-OK "Scheduled task 'NetVault-EnrichEol' registered (daily 01:00)"

# Weekly EOL feed sync (pulls the central signed seed into eol_seed; runs just ahead
# of Sunday's 01:00 enrichment so it applies the fresh seed; soft-skips when the
# feed is unreachable so offline/air-gapped installs keep the bundled seed floor).
$nvSyncAction  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://localhost:3000/api/system/sync-eol -H `"Authorization: Bearer $CronSecret`""
$nvSyncTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "00:15"
Register-ScheduledTask -TaskName "NetVault-SyncEol" -Action $nvSyncAction -Trigger $nvSyncTrigger -RunLevel Highest -Force | Out-Null
Write-OK "Scheduled task 'NetVault-SyncEol' registered (weekly Sun 00:15)"

# ================================================================
# STEP 9 — LogVault
# ================================================================
if ($InstallLogVault) {
    Write-Step "Installing LogVault"

    if (Test-Path $LVAppDir) { Remove-Item $LVAppDir -Recurse -Force }
    Write-Info "Cloning LogVault from GitHub..."
    & git clone $LVGitUrl $LVAppDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone LogVault" }
    New-Item -ItemType Directory -Force -Path "$LVAppDir\logs" | Out-Null
    & git config --system --add safe.directory ($LVAppDir -replace '\\','/') 2>$null
    Write-OK "LogVault cloned"

    # Run schema
    $env:PGPASSWORD = $PgAdminPassword
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -f "$LVAppDir\scripts\schema.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL ON SCHEMA public TO logvault_user;"
    # Re-assert the append-only tamper model: the blanket GRANT ALL above re-granted the
    # UPDATE/DELETE that schema.sql deliberately REVOKEs on the hash-chained tables.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "REVOKE UPDATE, DELETE ON syslog_entries FROM logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "REVOKE UPDATE, DELETE ON audit_log FROM logvault_user;"
    GrantNocRoRead "logvault"
    Write-OK "LogVault schema applied"

    # Create .env.local in root AND frontend
    # POSTGRES_PASSWORD lets the app's own Update-LogVault.ps1 re-apply schema.sql as
    # the postgres superuser on later updates; without it that step silently skips.
    $lvEnv = "DB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nLV_APP_PORT=3004`nLV_APP_URL=http://${ServerIP}:3004`nSYSLOG_PORTS=514,1514`nRETENTION_DAYS=90`nLOG_LEVEL=info`nNODE_ENV=production`nNEXTAUTH_URL=http://${ServerIP}:3004`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nLOG_INTEGRITY_KEY=$LogIntegrityKey`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass`nPOSTGRES_PASSWORD=$PgAdminPassword`nSERVER_IP=$ServerIP"
    $lvEnv | Out-File -FilePath "$LVAppDir\.env.local" -Encoding UTF8 -NoNewline
    $lvEnv | Out-File -FilePath "$LVAppDir\frontend\.env.local" -Encoding UTF8 -NoNewline
    Write-OK "LogVault .env.local created (root + frontend)"

    # npm install root + build frontend
    Set-Location $LVAppDir
    Write-Info "Installing LogVault root dependencies..."
    & npm install 2>&1 | Tee-Object -FilePath "$LVDir\logs\npm-install-root.log"
    if ($LASTEXITCODE -ne 0) { throw "LogVault root npm install failed" }

    $LVFrontendDir = "$LVAppDir\frontend"
    Set-Location $LVFrontendDir
    Write-Info "Installing LogVault frontend dependencies..."
    & npm install 2>&1 | Tee-Object -FilePath "$LVDir\logs\npm-install-frontend.log"
    if ($LASTEXITCODE -ne 0) { throw "LogVault frontend npm install failed" }
    Write-Info "Building LogVault frontend..."
    & npm run build 2>&1 | Tee-Object -FilePath "$LVDir\logs\npm-build.log"
    if ($LASTEXITCODE -ne 0) { throw "LogVault frontend build failed. Check $LVDir\logs\npm-build.log" }
    Write-OK "LogVault built"

    # NSSM — LogVault-Collector
    & $NssmExe stop LogVault-Collector confirm 2>$null
    & $NssmExe remove LogVault-Collector confirm 2>$null
    & $NssmExe install LogVault-Collector "C:\Program Files\nodejs\node.exe" "$LVAppDir\collector\collector.js"
    & $NssmExe set LogVault-Collector AppDirectory        $LVAppDir
    & $NssmExe set LogVault-Collector AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nSYSLOG_PORTS=514,1514`nRETENTION_DAYS=90`nLOG_LEVEL=info`nLOG_INTEGRITY_KEY=$LogIntegrityKey`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
    & $NssmExe set LogVault-Collector DependOnService     $PgSvcName
    & $NssmExe set LogVault-Collector DisplayName         "LogVault - Syslog Collector"
    & $NssmExe set LogVault-Collector Start               SERVICE_AUTO_START
    & $NssmExe set LogVault-Collector AppStdout           "$LVAppDir\logs\collector.log"
    & $NssmExe set LogVault-Collector AppStderr           "$LVAppDir\logs\collector-err.log"
    & $NssmExe set LogVault-Collector AppRotateFiles      1
    & $NssmExe set LogVault-Collector AppRotateBytes      10485760
    & $NssmExe set LogVault-Collector AppRotateOnline     1
    & $NssmExe set LogVault-Collector AppRestartDelay     3000
    & $NssmExe set LogVault-Collector AppThrottle         60000

    # NSSM — LogVault-API
    & $NssmExe stop LogVault-API confirm 2>$null
    & $NssmExe remove LogVault-API confirm 2>$null
    & $NssmExe install LogVault-API "C:\Program Files\nodejs\node.exe" "$LVAppDir\api\server.js"
    & $NssmExe set LogVault-API AppDirectory        $LVAppDir
    & $NssmExe set LogVault-API AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nLV_APP_URL=http://${ServerIP}:3004`nRETENTION_DAYS=90`nLOG_LEVEL=info`nSERVER_IP=$ServerIP"
    & $NssmExe set LogVault-API DependOnService     $PgSvcName
    & $NssmExe set LogVault-API DisplayName         "LogVault - API"
    & $NssmExe set LogVault-API Start               SERVICE_AUTO_START
    & $NssmExe set LogVault-API AppStdout           "$LVAppDir\logs\api.log"
    & $NssmExe set LogVault-API AppStderr           "$LVAppDir\logs\api-err.log"
    & $NssmExe set LogVault-API AppRotateFiles      1
    & $NssmExe set LogVault-API AppRotateBytes      10485760
    & $NssmExe set LogVault-API AppRotateOnline     1
    & $NssmExe set LogVault-API AppRestartDelay     3000
    & $NssmExe set LogVault-API AppThrottle         60000

    # NSSM — LogVault-App (uses next.cmd)
    $LVNextCmd = "$LVFrontendDir\node_modules\.bin\next.cmd"
    & $NssmExe stop LogVault-App confirm 2>$null
    & $NssmExe remove LogVault-App confirm 2>$null
    & $NssmExe install LogVault-App $LVNextCmd "start -p 3004"
    & $NssmExe set LogVault-App AppDirectory        $LVFrontendDir
    & $NssmExe set LogVault-App AppEnvironmentExtra "NODE_ENV=production`nLV_APP_PORT=3004`nNEXTAUTH_URL=http://${ServerIP}:3004`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
    & $NssmExe set LogVault-App DependOnService     $PgSvcName
    & $NssmExe set LogVault-App DisplayName         "LogVault - App"
    & $NssmExe set LogVault-App Start               SERVICE_AUTO_START
    & $NssmExe set LogVault-App AppStdout           "$LVAppDir\logs\app.log"
    & $NssmExe set LogVault-App AppStderr           "$LVAppDir\logs\app-err.log"
    & $NssmExe set LogVault-App AppRotateFiles      1
    & $NssmExe set LogVault-App AppRotateBytes      10485760
    & $NssmExe set LogVault-App AppRotateOnline     1
    & $NssmExe set LogVault-App AppRestartDelay     3000
    & $NssmExe set LogVault-App AppThrottle         60000
    Write-OK "LogVault services registered"

    New-NetFirewallRule -DisplayName "NocVault LogVault 3004"   -Direction Inbound -Protocol TCP -LocalPort 3004 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog UDP 514"  -Direction Inbound -Protocol UDP -LocalPort 514  -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog TCP 514"  -Direction Inbound -Protocol TCP -LocalPort 514  -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog UDP 1514" -Direction Inbound -Protocol UDP -LocalPort 1514 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog TCP 1514" -Direction Inbound -Protocol TCP -LocalPort 1514 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-OK "Firewall rules added for LogVault"

    # NOTE: No external cleanup scheduled task. Retention/partition cleanup now runs
    # IN-PROCESS inside LogVault-Collector (ensure 7 days of partitions ahead, drop aged
    # daily partitions, auto-ack/purge old alerts) ~60s after startup then every 24h.
}

# ================================================================
# STEP 10 — DDIVault
# ================================================================
if ($InstallDDIVault) {
    Write-Step "Installing DDIVault"

    if (Test-Path $DDIAppDir) { Remove-Item $DDIAppDir -Recurse -Force }
    Write-Info "Cloning DDIVault from GitHub..."
    & git clone $DDIGitUrl $DDIAppDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone DDIVault" }
    New-Item -ItemType Directory -Force -Path "$DDIAppDir\logs" | Out-Null
    New-Item -ItemType Directory -Force -Path "$DDIAppDir\frontend\public" | Out-Null
    & git config --system --add safe.directory ($DDIAppDir -replace '\\','/') 2>$null
    Write-OK "DDIVault cloned"

    # uuid-ossp extension is created by schema.sql below (line 9, correctly quoted).
    # Do NOT add a separate `psql -c 'CREATE EXTENSION ... "uuid-ossp"'` here:
    # PowerShell 5.1 strips the inner double-quotes when invoking the native exe,
    # so psql receives the hyphenated name unquoted and errors with a syntax error.
    $env:PGPASSWORD = $PgAdminPassword

    # Run 4 schemas in order
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema-ipam.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema-server-auth.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema-sites.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c "GRANT ALL ON SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT CONNECT ON DATABASE netvault TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT USAGE ON SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT SELECT ON sites, countries TO ddivault_user;"
    GrantNocRoRead "ddivault"

    # Reassign ownership of all app objects from postgres to ddivault_user. The schema
    # is applied as the postgres superuser, but the updater (and future migrations)
    # re-apply it AS ddivault_user, which requires ownership. Idempotent.
    $ddiReassign = @'
DO $$
DECLARE r RECORD;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ddivault_user') THEN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO ddivault_user', r.tablename);
    END LOOP;
    FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ddivault_user', r.sequencename);
    END LOOP;
    FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
      EXECUTE format('ALTER VIEW public.%I OWNER TO ddivault_user', r.viewname);
    END LOOP;
    FOR r IN SELECT p.proname AS nm, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') LOOP
      EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ddivault_user', r.nm, r.args);
    END LOOP;
    GRANT CREATE ON SCHEMA public TO ddivault_user;
  END IF;
END
$$;
'@
    $ddiReassign | & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -f -
    Write-OK "DDIVault schemas applied and cross-DB grants set"

    # Create .env.local in root AND frontend
    $ddiEnv = "DB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nDDI_API_PORT=3007`nDDI_APP_PORT=3006`nDDI_APP_URL=http://${ServerIP}:3006`nSERVER_IP=$ServerIP`nDHCP_SERVER=`nDNS_SERVER=`nPS_AUTH_MODE=kerberos`nPS_USERNAME=`nPS_PASSWORD=`nPS_TIMEOUT_MS=30000`nDHCP_LOG_UNC=`nDHCP_LOG_LOCAL=`nSCOPE_WARNING_PCT=80`nSCOPE_CRITICAL_PCT=90`nRETENTION_DAYS=90`nNODE_ENV=production`nNEXTAUTH_URL=http://${ServerIP}:3006`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass`nPOSTGRES_PASSWORD=$PgAdminPassword"
    $DDIFrontendDir = "$DDIAppDir\frontend"
    $ddiEnv | Out-File -FilePath "$DDIAppDir\.env.local" -Encoding UTF8 -NoNewline
    $ddiEnv | Out-File -FilePath "$DDIFrontendDir\.env.local" -Encoding UTF8 -NoNewline
    Write-OK "DDIVault .env.local created (root + frontend)"

    # npm install root + build frontend
    Set-Location $DDIAppDir
    Write-Info "Installing DDIVault root dependencies..."
    & npm install 2>&1 | Tee-Object -FilePath "$DDIDir\logs\npm-install-root.log"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault root npm install failed" }

    Set-Location $DDIFrontendDir
    Write-Info "Installing DDIVault frontend dependencies..."
    & npm install 2>&1 | Tee-Object -FilePath "$DDIDir\logs\npm-install-frontend.log"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault frontend npm install failed" }
    Write-Info "Building DDIVault frontend..."
    & npm run build 2>&1 | Tee-Object -FilePath "$DDIDir\logs\npm-build.log"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault frontend build failed. Check $DDIDir\logs\npm-build.log" }
    Write-OK "DDIVault built"

    # NSSM — DDIVault-API
    & $NssmExe stop DDIVault-API confirm 2>$null
    & $NssmExe remove DDIVault-API confirm 2>$null
    & $NssmExe install DDIVault-API "C:\Program Files\nodejs\node.exe" "$DDIAppDir\api\server.js"
    & $NssmExe set DDIVault-API AppDirectory        $DDIAppDir
    & $NssmExe set DDIVault-API AppEnvironmentExtra "NODE_ENV=production`nNEXTAUTH_SECRET=$SharedSecret`nDB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nDDI_API_PORT=3007`nDDI_APP_URL=http://${ServerIP}:3006`nDDI_APP_PORT=3006`nSERVER_IP=$ServerIP`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
    & $NssmExe set DDIVault-API DependOnService     $PgSvcName
    & $NssmExe set DDIVault-API DisplayName         "DDIVault - API"
    & $NssmExe set DDIVault-API Start               SERVICE_AUTO_START
    & $NssmExe set DDIVault-API AppStdout           "$DDIAppDir\logs\api.log"
    & $NssmExe set DDIVault-API AppStderr           "$DDIAppDir\logs\api-err.log"
    & $NssmExe set DDIVault-API AppRotateFiles      1
    & $NssmExe set DDIVault-API AppRotateBytes      10485760
    & $NssmExe set DDIVault-API AppRotateOnline     1
    & $NssmExe set DDIVault-API AppRestartDelay     3000

    # NSSM — DDIVault-App (uses next.cmd)
    $DDINextCmd = "$DDIFrontendDir\node_modules\.bin\next.cmd"
    & $NssmExe stop DDIVault-App confirm 2>$null
    & $NssmExe remove DDIVault-App confirm 2>$null
    & $NssmExe install DDIVault-App $DDINextCmd "start -p 3006"
    & $NssmExe set DDIVault-App AppDirectory        $DDIFrontendDir
    & $NssmExe set DDIVault-App AppEnvironmentExtra "NODE_ENV=production`nNEXTAUTH_URL=http://${ServerIP}:3006`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
    & $NssmExe set DDIVault-App DependOnService     $PgSvcName
    & $NssmExe set DDIVault-App DisplayName         "DDIVault - App"
    & $NssmExe set DDIVault-App Start               SERVICE_AUTO_START
    & $NssmExe set DDIVault-App AppStdout           "$DDIAppDir\logs\app.log"
    & $NssmExe set DDIVault-App AppStderr           "$DDIAppDir\logs\app-err.log"
    & $NssmExe set DDIVault-App AppRotateFiles      1
    & $NssmExe set DDIVault-App AppRotateBytes      10485760
    & $NssmExe set DDIVault-App AppRotateOnline     1
    & $NssmExe set DDIVault-App AppRestartDelay     3000

    # NSSM — DDIVault-Collector
    & $NssmExe stop DDIVault-Collector confirm 2>$null
    & $NssmExe remove DDIVault-Collector confirm 2>$null
    & $NssmExe install DDIVault-Collector "C:\Program Files\nodejs\node.exe" "$DDIAppDir\collector\collector.js"
    & $NssmExe set DDIVault-Collector AppDirectory        $DDIAppDir
    & $NssmExe set DDIVault-Collector AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nSCOPE_WARNING_PCT=80`nSCOPE_CRITICAL_PCT=90`nNEXTAUTH_SECRET=$SharedSecret`nPS_AUTH_MODE=kerberos`nPS_TIMEOUT_MS=30000"
    & $NssmExe set DDIVault-Collector DependOnService     $PgSvcName
    & $NssmExe set DDIVault-Collector DisplayName         "DDIVault - Collector"
    & $NssmExe set DDIVault-Collector Start               SERVICE_AUTO_START
    & $NssmExe set DDIVault-Collector AppStdout           "$DDIAppDir\logs\collector.log"
    & $NssmExe set DDIVault-Collector AppStderr           "$DDIAppDir\logs\collector-err.log"
    & $NssmExe set DDIVault-Collector AppRotateFiles      1
    & $NssmExe set DDIVault-Collector AppRotateBytes      10485760
    & $NssmExe set DDIVault-Collector AppRotateOnline     1
    & $NssmExe set DDIVault-Collector AppRestartDelay     3000
    Write-OK "DDIVault services registered"

    New-NetFirewallRule -DisplayName "NocVault DDIVault 3006" -Direction Inbound -Protocol TCP -LocalPort 3006 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-OK "Firewall rule added: port 3006"
}

# ================================================================
# STEP 11 — SpanVault
# ================================================================
if ($InstallSpanVault) {
    Write-Step "Installing SpanVault"

    if (Test-Path $SVAppDir) { Remove-Item $SVAppDir -Recurse -Force }
    Write-Info "Cloning SpanVault from GitHub..."
    & git clone $SVGitUrl $SVAppDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone SpanVault" }
    New-Item -ItemType Directory -Force -Path "$SVAppDir\logs" | Out-Null
    & git config --system --add safe.directory ($SVAppDir -replace '\\','/') 2>$null
    Write-OK "SpanVault cloned"

    # Run schema
    $env:PGPASSWORD = $PgAdminPassword
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -f "$SVAppDir\scripts\schema.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -c "GRANT ALL ON SCHEMA public TO spanvault_user;"
    GrantNocRoRead "spanvault"

    # Reassign ownership of all app objects from postgres to spanvault_user. The schema
    # is applied as the postgres superuser, but the updater (and the API at boot)
    # re-apply it AS spanvault_user, which requires ownership. Idempotent.
    $svReassign = @'
DO $$
DECLARE r RECORD;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'spanvault_user') THEN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO spanvault_user', r.tablename);
    END LOOP;
    FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO spanvault_user', r.sequencename);
    END LOOP;
    FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
      EXECUTE format('ALTER VIEW public.%I OWNER TO spanvault_user', r.viewname);
    END LOOP;
    FOR r IN SELECT p.proname AS nm, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') LOOP
      EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO spanvault_user', r.nm, r.args);
    END LOOP;
    GRANT CREATE ON SCHEMA public TO spanvault_user;
  END IF;
END
$$;
'@
    $svReassign | & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -f -
    Write-OK "SpanVault schema applied"

    # Create .env.local in root AND frontend
    $svEnv = "SV_APP_PORT=3008`nSV_API_PORT=3009`nSERVER_IP=$ServerIP`nSV_PUBLIC_URL=http://${ServerIP}:3008`nSV_WS_PORT=3010`nSV_NSSM_PATH=$NssmExe`nNEXTAUTH_URL=http://${ServerIP}:3008`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass`nSV_DB_HOST=localhost`nSV_DB_PORT=5432`nSV_DB_NAME=spanvault`nSV_DB_USER=spanvault_user`nSV_DB_PASS=$SVDbPass`nPOSTGRES_PASSWORD=$PgAdminPassword"
    $SVFrontendDir = "$SVAppDir\frontend"
    $svEnv | Out-File -FilePath "$SVAppDir\.env.local" -Encoding UTF8 -NoNewline
    $svEnv | Out-File -FilePath "$SVFrontendDir\.env.local" -Encoding UTF8 -NoNewline
    Write-OK "SpanVault .env.local created (root + frontend)"

    # npm install root
    Set-Location $SVAppDir
    Write-Info "Installing SpanVault root dependencies..."
    & npm install 2>&1 | Tee-Object -FilePath "$SVDir\logs\npm-install-root.log"
    if ($LASTEXITCODE -ne 0) { throw "SpanVault root npm install failed" }

    # npm install + build frontend
    Set-Location $SVFrontendDir
    Write-Info "Installing SpanVault frontend dependencies..."
    & npm install 2>&1 | Tee-Object -FilePath "$SVDir\logs\npm-install-frontend.log"
    if ($LASTEXITCODE -ne 0) { throw "SpanVault frontend npm install failed" }
    Write-Info "Building SpanVault frontend..."
    & npm run build 2>&1 | Tee-Object -FilePath "$SVDir\logs\npm-build.log"
    if ($LASTEXITCODE -ne 0) { throw "SpanVault frontend build failed. Check $SVDir\logs\npm-build.log" }
    Write-OK "SpanVault built"

    # NSSM — SpanVault-API
    & $NssmExe stop SpanVault-API confirm 2>$null
    & $NssmExe remove SpanVault-API confirm 2>$null
    & $NssmExe install SpanVault-API "C:\Program Files\nodejs\node.exe" "api\server.js"
    & $NssmExe set SpanVault-API AppDirectory        $SVAppDir
    & $NssmExe set SpanVault-API DisplayName         "SpanVault - API"
    & $NssmExe set SpanVault-API Start               SERVICE_AUTO_START
    & $NssmExe set SpanVault-API DependOnService     $PgSvcName
    & $NssmExe set SpanVault-API AppStdout           "$SVAppDir\logs\api.log"
    & $NssmExe set SpanVault-API AppStderr           "$SVAppDir\logs\api-err.log"
    & $NssmExe set SpanVault-API AppRotateFiles      1
    & $NssmExe set SpanVault-API AppRotateBytes      10485760
    & $NssmExe set SpanVault-API AppRotateOnline     1
    & $NssmExe set SpanVault-API AppRestartDelay     3000

    # NSSM — SpanVault-App (uses node.exe with next start)
    & $NssmExe stop SpanVault-App confirm 2>$null
    & $NssmExe remove SpanVault-App confirm 2>$null
    & $NssmExe install SpanVault-App "C:\Program Files\nodejs\node.exe" "node_modules\next\dist\bin\next start -p 3008"
    & $NssmExe set SpanVault-App AppDirectory        $SVFrontendDir
    & $NssmExe set SpanVault-App DisplayName         "SpanVault - App"
    & $NssmExe set SpanVault-App Start               SERVICE_AUTO_START
    & $NssmExe set SpanVault-App DependOnService     $PgSvcName
    & $NssmExe set SpanVault-App AppStdout           "$SVAppDir\logs\app.log"
    & $NssmExe set SpanVault-App AppStderr           "$SVAppDir\logs\app-err.log"
    & $NssmExe set SpanVault-App AppRotateFiles      1
    & $NssmExe set SpanVault-App AppRotateBytes      10485760
    & $NssmExe set SpanVault-App AppRotateOnline     1
    & $NssmExe set SpanVault-App AppRestartDelay     3000

    # NSSM — SpanVault-Collector
    & $NssmExe stop SpanVault-Collector confirm 2>$null
    & $NssmExe remove SpanVault-Collector confirm 2>$null
    & $NssmExe install SpanVault-Collector "C:\Program Files\nodejs\node.exe" "collector\collector.js"
    & $NssmExe set SpanVault-Collector AppDirectory        $SVAppDir
    & $NssmExe set SpanVault-Collector DisplayName         "SpanVault - Collector"
    & $NssmExe set SpanVault-Collector Start               SERVICE_AUTO_START
    & $NssmExe set SpanVault-Collector DependOnService     $PgSvcName
    & $NssmExe set SpanVault-Collector AppStdout           "$SVAppDir\logs\collector.log"
    & $NssmExe set SpanVault-Collector AppStderr           "$SVAppDir\logs\collector-err.log"
    & $NssmExe set SpanVault-Collector AppRotateFiles      1
    & $NssmExe set SpanVault-Collector AppRotateBytes      10485760
    & $NssmExe set SpanVault-Collector AppRotateOnline     1
    & $NssmExe set SpanVault-Collector AppRestartDelay     3000
    Write-OK "SpanVault services registered"

    New-NetFirewallRule -DisplayName "NocVault SpanVault 3008" -Direction Inbound -Protocol TCP -LocalPort 3008 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    # Port 3010 = remote distributed-polling agent WebSocket server (SV_WS_PORT, default 3010).
    # Needed only for off-box polling agents; core monitoring/UI works without it.
    New-NetFirewallRule -DisplayName "NocVault SpanVault 3010" -Direction Inbound -Protocol TCP -LocalPort 3010 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-OK "Firewall rules added: ports 3008, 3010"
}

# ================================================================
# STEP 12 — Start services
# ================================================================
Write-Step "Starting services"

& sc.exe start NetVault | Out-Null
Start-Sleep -Seconds 5
Write-OK "NetVault started"

# Baseline health snapshot so the trend chart has a starting data point.
try {
    & curl.exe -s -X POST "http://localhost:3000/api/system/health-snapshot" -H "Authorization: Bearer $CronSecret" | Out-Null
    Write-OK "Baseline health snapshot recorded"
} catch {
    Write-Warn "Baseline snapshot call failed (scheduler will take it at 00:00)"
}

if ($InstallLogVault) {
    & sc.exe start LogVault-Collector | Out-Null
    Start-Sleep -Seconds 3
    & sc.exe start LogVault-API | Out-Null
    Start-Sleep -Seconds 3
    & sc.exe start LogVault-App | Out-Null
    Start-Sleep -Seconds 3
    Write-OK "LogVault services started"
}

if ($InstallDDIVault) {
    & sc.exe start DDIVault-API | Out-Null
    Start-Sleep -Seconds 5
    & sc.exe start DDIVault-App | Out-Null
    Start-Sleep -Seconds 8
    & sc.exe start DDIVault-Collector | Out-Null
    Start-Sleep -Seconds 3
    Write-OK "DDIVault services started"
}

if ($InstallSpanVault) {
    & sc.exe start SpanVault-API | Out-Null
    Start-Sleep -Seconds 5
    & sc.exe start SpanVault-App | Out-Null
    Start-Sleep -Seconds 8
    & sc.exe start SpanVault-Collector | Out-Null
    Start-Sleep -Seconds 3
    Write-OK "SpanVault services started"
}

# ================================================================
# STEP 13 — Verify
# ================================================================
Write-Step "Verifying installation"
Start-Sleep -Seconds 15

$services = @("NetVault")
if ($InstallLogVault)  { $services += @("LogVault-Collector","LogVault-API","LogVault-App") }
if ($InstallDDIVault)  { $services += @("DDIVault-API","DDIVault-App","DDIVault-Collector") }
if ($InstallSpanVault) { $services += @("SpanVault-API","SpanVault-App","SpanVault-Collector") }

$allOK = $true
foreach ($svc in $services) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s -and $s.Status -eq 'Running') {
        Write-OK "$svc - Running"
    } else {
        Write-Warn "$svc - NOT running (check logs)"
        $allOK = $false
    }
}

# Confirm the NetVault scheduled tasks registered (health snapshot + EOL enrich/sync)
foreach ($taskName in @("NetVault-HealthSnapshot","NetVault-EnrichEol","NetVault-SyncEol")) {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($t) {
        Write-OK "Scheduled task $taskName - Registered"
    } else {
        Write-Warn "Scheduled task $taskName - NOT registered"
        $allOK = $false
    }
}

$ports = @(3000)
if ($InstallLogVault)  { $ports += 3004 }
if ($InstallDDIVault)  { $ports += 3006 }
if ($InstallSpanVault) { $ports += 3008 }
foreach ($port in $ports) {
    $listening = netstat -ano 2>$null | Select-String ":$port.*LISTENING"
    if ($listening) {
        Write-OK "Port $port - Listening"
    } else {
        Write-Warn "Port $port - Not listening yet"
    }
}

# ================================================================
# DONE
# ================================================================
Write-Host ""
if ($allOK) {
    Write-Host "  +======================================================+" -ForegroundColor Green
    Write-Host "  |   NocVault Suite - Installation Complete             |" -ForegroundColor Green
    Write-Host "  +======================================================+" -ForegroundColor Green
} else {
    Write-Host "  +======================================================+" -ForegroundColor Yellow
    Write-Host "  |   NocVault Suite - Installed (some services pending) |" -ForegroundColor Yellow
    Write-Host "  +======================================================+" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Access your applications:" -ForegroundColor White
Write-Host "  NocVault Hub : http://${ServerIP}:3000  (login here)" -ForegroundColor Cyan
Write-Host "  NetVault     : http://${ServerIP}:3000" -ForegroundColor Cyan
if ($InstallLogVault)  { Write-Host "  LogVault     : http://${ServerIP}:3004" -ForegroundColor Cyan }
if ($InstallDDIVault)  { Write-Host "  DDIVault     : http://${ServerIP}:3006" -ForegroundColor Cyan }
if ($InstallSpanVault) { Write-Host "  SpanVault    : http://${ServerIP}:3008" -ForegroundColor Cyan }
Write-Host ""
Write-Host "  Default login : admin@yourcompany.com / Admin1234!" -ForegroundColor Yellow
Write-Host "  IMPORTANT: Change the default password immediately!" -ForegroundColor Yellow
if ($Unattended -and $PgAdminPassword -eq $DefaultPgPassword) {
    Write-Host ""
    Write-Host "  PostgreSQL 'postgres' password (auto-set): $DefaultPgPassword" -ForegroundColor Yellow
    Write-Host "  IMPORTANT: Record and change this database superuser password." -ForegroundColor Yellow
}
if ($Unattended -and $NocReadOnlyPass -eq $DefaultNocRoPassword) {
    Write-Host ""
    Write-Host "  nocvault_readonly DB password (auto-set): $DefaultNocRoPassword" -ForegroundColor Yellow
    Write-Host "  IMPORTANT: Record and change this read-only role password." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Post-install checklist:" -ForegroundColor White
Write-Host "  [1] Change default admin password in Settings" -ForegroundColor Gray
Write-Host "  [2] Update company branding in Settings > Branding" -ForegroundColor Gray
if ($InstallLogVault) {
    Write-Host "  [3] Configure network devices to send syslog to ${ServerIP}:514" -ForegroundColor Gray
}
if ($InstallDDIVault) {
    Write-Host "  [4] Add DHCP/DNS servers in DDIVault > Known Servers" -ForegroundColor Gray
    Write-Host "  [5] Run Enable-PSRemoting -Force on each DHCP/DNS server" -ForegroundColor Gray
}
if ($InstallSpanVault) {
    Write-Host "  [6] Add devices to SpanVault for monitoring in SpanVault > Devices" -ForegroundColor Gray
    Write-Host "  [7] Configure SNMP community strings per device in SpanVault > Settings" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  Logs location:" -ForegroundColor White
Write-Host "  NetVault  : $NVDir\logs\" -ForegroundColor Gray
if ($InstallLogVault)  { Write-Host "  LogVault  : $LVAppDir\logs\" -ForegroundColor Gray }
if ($InstallDDIVault)  { Write-Host "  DDIVault  : $DDIAppDir\logs\" -ForegroundColor Gray }
if ($InstallSpanVault) { Write-Host "  SpanVault : $SVAppDir\logs\" -ForegroundColor Gray }
Write-Host ""
