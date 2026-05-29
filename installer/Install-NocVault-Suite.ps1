#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NocVault Suite Installer v1.0
.DESCRIPTION
    Installs NetVault, LogVault and DDIVault on a Windows Server.
    NetVault is mandatory. LogVault and DDIVault are optional.
    Requires internet access to clone from GitHub.
.PARAMETER InstallDir
    Root installation directory (default: C:\Apps)
.PARAMETER ServerIP
    Server IP address (default: auto-detected)
.PARAMETER InstallLogVault
    Install LogVault add-on (default: true)
.PARAMETER InstallDDIVault
    Install DDIVault add-on (default: true)
.EXAMPLE
    .\Install-NocVault-Suite.ps1
    .\Install-NocVault-Suite.ps1 -InstallDir "D:\Apps" -ServerIP "10.10.1.50"
    .\Install-NocVault-Suite.ps1 -InstallLogVault $false -InstallDDIVault $false
#>
param(
    [string]$InstallDir      = "C:\Apps",
    [string]$ServerIP        = "",
    [bool]$InstallLogVault   = $true,
    [bool]$InstallDDIVault   = $true,
    [string]$PgAdminPassword = ""
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
Write-Host "  |   NocVault Suite Installer v1.0           |" -ForegroundColor White
Write-Host "  |   Network Intelligence Suite              |" -ForegroundColor White
Write-Host "  +============================================+" -ForegroundColor White
Write-Host ""

# ── Paths ─────────────────────────────────────────────────────────
$ScriptDir      = $PSScriptRoot
$DepsDir        = "$ScriptDir\dependencies"
$NVDir          = "$InstallDir\NetVault"
$LVDir          = "$InstallDir\LogVault"
$DDIDir         = "$InstallDir\DDIVault"
$NVAppDir       = "$NVDir\app"
$LVAppDir       = "$LVDir\app"
$DDIAppDir      = "$DDIDir\app"
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

# ── Credentials ───────────────────────────────────────────────────
$NVDbPass     = "PgAdmin@2026!"
$LVDbPass     = "NVAdmin@2026"
$DDIDbPass    = "NVAdmin@2026"
$SharedSecret = "bue3VdWszntJ24GMhfKg1QkPIEaZYC95"

# ── Auto-detect server IP ─────────────────────────────────────────
if (-not $ServerIP) {
    $ServerIP = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
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
Write-Host ""
Write-Host "  NOTE: Internet access required (cloning from GitHub)." -ForegroundColor Yellow
Write-Host "  Estimated install time: 15-20 minutes." -ForegroundColor Gray
Write-Host ""

# ── PostgreSQL admin password ─────────────────────────────────────
if (-not $PgAdminPassword) {
    $secPwd = Read-Host "Set PostgreSQL admin (postgres) password" -AsSecureString
    $PgAdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPwd))
}

Write-Host ""
Write-Host "  Ready to install. Press Enter to continue or Ctrl+C to cancel." -ForegroundColor Yellow
Read-Host

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

# ================================================================
# STEP 8 — NetVault
# ================================================================
Write-Step "Installing NetVault"

if (Test-Path $NVAppDir) { Remove-Item $NVAppDir -Recurse -Force }
Write-Info "Cloning NetVault from GitHub..."
& git clone $NVGitUrl $NVAppDir
if ($LASTEXITCODE -ne 0) { throw "Failed to clone NetVault" }
Write-OK "NetVault cloned"

# Run schema
$env:PGPASSWORD = $PgAdminPassword
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\schema.sql"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO netvault;"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO netvault;"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\setup.sql"
Write-OK "NetVault schema applied"

# Create .env
@"
DATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault
NEXTAUTH_SECRET=$SharedSecret
NEXTAUTH_URL=http://${ServerIP}:3000
NODE_ENV=production
SSL_DISABLED=true
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

# Register NSSM service
& $NssmExe stop NetVault confirm 2>$null
& $NssmExe remove NetVault confirm 2>$null
& $NssmExe install NetVault "C:\Program Files\nodejs\node.exe" "$NVStandalone\server.js"
& $NssmExe set NetVault AppDirectory        $NVStandalone
& $NssmExe set NetVault AppEnvironmentExtra "PORT=3000`nHOSTNAME=0.0.0.0`nNODE_ENV=production`nDATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault`nNEXTAUTH_SECRET=$SharedSecret`nNEXTAUTH_URL=http://${ServerIP}:3000`nSSL_DISABLED=true"
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
    Write-OK "LogVault cloned"

    # Run schema
    $env:PGPASSWORD = $PgAdminPassword
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -f "$LVAppDir\scripts\schema.sql"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL ON SCHEMA public TO logvault_user;"
    Write-OK "LogVault schema applied"

    # Create .env.local in root AND frontend
    $lvEnv = "DB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nLV_APP_PORT=3004`nLV_APP_URL=http://${ServerIP}:3004`nSYSLOG_PORTS=514,1514`nRETENTION_DAYS=90`nLOG_LEVEL=info`nNODE_ENV=production`nNEXTAUTH_URL=http://${ServerIP}:3004`nNEXTAUTH_SECRET=$SharedSecret`nNETVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NETVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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
    & $NssmExe set LogVault-Collector AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nSYSLOG_PORTS=514,1514`nRETENTION_DAYS=90`nLOG_LEVEL=info"
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
    & $NssmExe set LogVault-API AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nLV_APP_URL=http://${ServerIP}:3004`nRETENTION_DAYS=90`nLOG_LEVEL=info"
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
    & $NssmExe set LogVault-App AppEnvironmentExtra "NODE_ENV=production`nLV_APP_PORT=3004`nNEXTAUTH_URL=http://${ServerIP}:3004`nNEXTAUTH_SECRET=$SharedSecret`nNETVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NETVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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

    schtasks /create /tn "LogVault Cleanup" /tr "node `"$LVAppDir\scripts\cleanup.js`"" /sc daily /st 02:00 /f 2>$null | Out-Null
    Write-OK "LogVault cleanup task scheduled (daily 2AM)"
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
    Write-OK "DDIVault cloned"

    # uuid-ossp extension
    $env:PGPASSWORD = $PgAdminPassword
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
    Write-OK "uuid-ossp extension created"

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
    Write-OK "DDIVault schemas applied and cross-DB grants set"

    # Create .env.local in root AND frontend
    $ddiEnv = "DB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nDDI_API_PORT=3007`nDDI_APP_PORT=3006`nDHCP_SERVER=`nDNS_SERVER=`nPS_AUTH_MODE=kerberos`nPS_USERNAME=`nPS_PASSWORD=`nPS_TIMEOUT_MS=30000`nDHCP_LOG_UNC=`nDHCP_LOG_LOCAL=`nSCOPE_WARNING_PCT=80`nSCOPE_CRITICAL_PCT=90`nRETENTION_DAYS=90`nNODE_ENV=production`nNEXTAUTH_URL=http://${ServerIP}:3006`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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
    & $NssmExe set DDIVault-API AppEnvironmentExtra "NODE_ENV=production`nNEXTAUTH_SECRET=$SharedSecret`nDB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nDDI_API_PORT=3007`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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
# STEP 11 — Start services
# ================================================================
Write-Step "Starting services"

& sc.exe start NetVault | Out-Null
Start-Sleep -Seconds 5
Write-OK "NetVault started"

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

# ================================================================
# STEP 12 — Verify
# ================================================================
Write-Step "Verifying installation"
Start-Sleep -Seconds 15

$services = @("NetVault")
if ($InstallLogVault)  { $services += @("LogVault-Collector","LogVault-API","LogVault-App") }
if ($InstallDDIVault)  { $services += @("DDIVault-API","DDIVault-App","DDIVault-Collector") }

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

$ports = @(3000)
if ($InstallLogVault) { $ports += 3004 }
if ($InstallDDIVault) { $ports += 3006 }
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
Write-Host ""
Write-Host "  Default login : admin@yourcompany.com / Admin1234!" -ForegroundColor Yellow
Write-Host "  IMPORTANT: Change the default password immediately!" -ForegroundColor Yellow
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
Write-Host ""
Write-Host "  Logs location:" -ForegroundColor White
Write-Host "  NetVault  : $NVDir\logs\" -ForegroundColor Gray
if ($InstallLogVault) { Write-Host "  LogVault  : $LVAppDir\logs\" -ForegroundColor Gray }
if ($InstallDDIVault) { Write-Host "  DDIVault  : $DDIAppDir\logs\" -ForegroundColor Gray }
Write-Host ""
