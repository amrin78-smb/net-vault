#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NocVault Suite - Complete Installer
.DESCRIPTION
    Installs NetVault, LogVault and DDIVault on a Windows Server.
    NetVault is mandatory. LogVault and DDIVault are optional add-ons.
.PARAMETER InstallDir
    Root installation directory (default: C:\Apps)
.PARAMETER ServerIP
    Server IP address for NEXTAUTH_URL (default: auto-detected)
.PARAMETER InstallLogVault
    Install LogVault (default: true)
.PARAMETER InstallDDIVault
    Install DDIVault (default: true)
.PARAMETER PgAdminPassword
    PostgreSQL admin password (default: prompted)
.EXAMPLE
    .\Install-NocVault-Suite.ps1
    .\Install-NocVault-Suite.ps1 -InstallDir "D:\Apps" -InstallLogVault $false
#>
param(
    [string]$InstallDir        = "C:\Apps",
    [string]$ServerIP          = "",
    [bool]$InstallLogVault     = $true,
    [bool]$InstallDDIVault     = $true,
    [string]$PgAdminPassword   = ""
)

# ── Helper functions ──────────────────────────────────────────────
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    [--] $msg" -ForegroundColor Gray }

# ── Banner ────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor White
Write-Host "  ║     NocVault Suite - Installer v1.0      ║" -ForegroundColor White
Write-Host "  ║     Network Intelligence Suite           ║" -ForegroundColor White
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor White
Write-Host ""

# ── Paths ─────────────────────────────────────────────────────────
$ScriptDir    = $PSScriptRoot
$DepsDir      = "$ScriptDir\dependencies"
$AppsDir      = "$ScriptDir\apps"
$NVDir        = "$InstallDir\NetVault"
$LVDir        = "$InstallDir\LogVault"
$DDIDir       = "$InstallDir\DDIVault"
$PgBin        = "C:\Program Files\PostgreSQL\16\bin"
$NssmZip      = "$DepsDir\nssm-2.24.zip"
$NssmDir      = "$NVDir\nssm"
$NssmExe      = "$NssmDir\nssm-2.24\win64\nssm.exe"
$NodeMsi      = "$DepsDir\node-v20.19.0-x64.msi"
$PgInstaller  = (Get-ChildItem "$DepsDir\postgresql-16*windows-x64.exe" | Select-Object -First 1).FullName
$GitInstaller = "$DepsDir\Git-2.54.0-64-bit.exe"
$VcRedist     = "$DepsDir\VC_redist.x64.exe"

# ── Passwords ─────────────────────────────────────────────────────
$NVDbPass  = "PgAdmin@2026!"
$LVDbPass  = "NVAdmin@2026"
$DDIDbPass = "NVAdmin@2026"
$SharedSecret = "bue3VdWszntJ24GMhfKg1QkPIEaZYC95"

# ── Get server IP ─────────────────────────────────────────────────
if (-not $ServerIP) {
    $ServerIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' } | Select-Object -First 1).IPAddress
}
Write-Host "  Install directory : $InstallDir" -ForegroundColor Gray
Write-Host "  Server IP         : $ServerIP" -ForegroundColor Gray
Write-Host "  Install LogVault  : $InstallLogVault" -ForegroundColor Gray
Write-Host "  Install DDIVault  : $InstallDDIVault" -ForegroundColor Gray
Write-Host ""

# ── Get PostgreSQL admin password ─────────────────────────────────
if (-not $PgAdminPassword) {
    $secPwd = Read-Host "Enter PostgreSQL admin (postgres) password" -AsSecureString
    $PgAdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPwd))
}

# ── Confirm ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Ready to install. Press Enter to continue or Ctrl+C to cancel." -ForegroundColor Yellow
Read-Host

# ── Step 1: Create directories ────────────────────────────────────
Write-Step "Creating installation directories"
New-Item -ItemType Directory -Force -Path $NVDir | Out-Null
New-Item -ItemType Directory -Force -Path "$NVDir\logs" | Out-Null
if ($InstallLogVault) {
    New-Item -ItemType Directory -Force -Path $LVDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$LVDir\logs" | Out-Null
}
if ($InstallDDIVault) {
    New-Item -ItemType Directory -Force -Path $DDIDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$DDIDir\logs" | Out-Null
}
Write-OK "Directories created"

# ── Step 2: Install VC Redist ─────────────────────────────────────
Write-Step "Installing Visual C++ Redistributable"
if (Test-Path $VcRedist) {
    Start-Process -Wait -FilePath $VcRedist -ArgumentList '/install', '/quiet', '/norestart'
    Write-OK "VC Redistributable installed"
} else {
    Write-Warn "VC Redistributable not found - skipping (may already be installed)"
}

# ── Step 3: Install Node.js ───────────────────────────────────────
Write-Step "Installing Node.js v20.19.0"
$nodeCheck = & node --version 2>$null
if ($nodeCheck -eq 'v20.19.0') {
    Write-OK "Node.js v20.19.0 already installed"
} else {
    Start-Process -Wait -FilePath "msiexec.exe" -ArgumentList "/I `"$NodeMsi`" /quiet"
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    Write-OK "Node.js installed"
}

# ── Step 4: Install Git ───────────────────────────────────────────
Write-Step "Installing Git"
$gitCheck = & git --version 2>$null
if ($gitCheck) {
    Write-OK "Git already installed: $gitCheck"
} else {
    Start-Process -Wait -FilePath $GitInstaller -ArgumentList '/VERYSILENT', '/NORESTART'
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    Write-OK "Git installed"
}

# ── Step 5: Install PostgreSQL ────────────────────────────────────
Write-Step "Installing PostgreSQL 16"
$pgCheck = Test-Path $PgBin
if ($pgCheck) {
    Write-OK "PostgreSQL already installed"
} else {
    if (-not $PgInstaller) { throw "PostgreSQL installer not found in $DepsDir" }
    Start-Process -Wait -FilePath $PgInstaller -ArgumentList `
        "--mode unattended",
        "--unattendedmodeui minimal",
        "--superpassword `"$PgAdminPassword`"",
        "--serverport 5432",
        "--servicename postgresql-x64-16"
    Write-OK "PostgreSQL installed"
}

# ── Step 6: Install NSSM ──────────────────────────────────────────
Write-Step "Installing NSSM"
Expand-Archive -Path $NssmZip -DestinationPath $NssmDir -Force
Write-OK "NSSM ready at $NssmExe"

# ── Step 7: Setup databases ───────────────────────────────────────
Write-Step "Setting up databases"
$env:PGPASSWORD = $PgAdminPassword

# NetVault DB
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER netvault WITH PASSWORD '$NVDbPass';" 2>$null
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE netvault OWNER netvault;" 2>$null
Write-OK "NetVault database ready"

if ($InstallLogVault) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER logvault_user WITH PASSWORD '$LVDbPass';" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE logvault OWNER logvault_user;" 2>$null
    Write-OK "LogVault database ready"
}

if ($InstallDDIVault) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE USER ddivault_user WITH PASSWORD '$DDIDbPass';" 2>$null
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE DATABASE ddivault OWNER ddivault_user;" 2>$null
    # Grant DDIVault access to NetVault sites/countries
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT SELECT ON sites, countries TO ddivault_user;" 2>$null
    Write-OK "DDIVault database ready"
}

# ── Step 8: Clone and setup NetVault ──────────────────────────────
Write-Step "Installing NetVault"
$NVAppDir = "$NVDir\app"
if (Test-Path $NVAppDir) { Remove-Item $NVAppDir -Recurse -Force }
& git clone "https://github.com/amrin78-smb/net-vault" $NVAppDir
Set-Location $NVAppDir

# Run schema
$env:PGPASSWORD = $PgAdminPassword
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\schema.sql"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\setup.sql"
Write-OK "NetVault schema applied"

# Create .env
$nvEnv = @"
DATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault
NEXTAUTH_SECRET=$SharedSecret
NEXTAUTH_URL=http://${ServerIP}:3000
NODE_ENV=production
SSL_DISABLED=true
"@
$nvEnv | Out-File -FilePath "$NVAppDir\.env" -Encoding UTF8 -NoNewline

# Build
& npm install 2>&1 | Out-Null
& npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "NetVault build failed" }

# Copy static files
$nvStandalone = "$NVAppDir\.next\standalone"
Copy-Item -Path "$NVAppDir\public" -Destination "$nvStandalone\public" -Recurse -Force
Copy-Item -Path "$NVAppDir\.next\static" -Destination "$nvStandalone\.next\static" -Recurse -Force
Write-OK "NetVault built"

# Register NSSM service
& $NssmExe install NetVault "C:\Program Files\nodejs\node.exe" "$nvStandalone\server.js"
& $NssmExe set NetVault AppDirectory        $nvStandalone
& $NssmExe set NetVault AppEnvironmentExtra "PORT=3000" "HOSTNAME=0.0.0.0" "NODE_ENV=production" "DATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault" "NEXTAUTH_SECRET=$SharedSecret" "NEXTAUTH_URL=http://${ServerIP}:3000" "SSL_DISABLED=true"
& $NssmExe set NetVault DisplayName    "NetVault - Network Asset Management"
& $NssmExe set NetVault Start          SERVICE_AUTO_START
& $NssmExe set NetVault AppStdout      "$NVDir\logs\netvault.log"
& $NssmExe set NetVault AppStderr      "$NVDir\logs\netvault-error.log"
& $NssmExe set NetVault AppRotateFiles 1
& $NssmExe set NetVault AppRotateSeconds 86400
& $NssmExe set NetVault AppRestartDelay 3000
Write-OK "NetVault service registered"

# Firewall
New-NetFirewallRule -DisplayName "NocVault NetVault Port 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-OK "Firewall rule added for port 3000"

# ── Step 9: Install LogVault ──────────────────────────────────────
if ($InstallLogVault) {
    Write-Step "Installing LogVault"
    $LVAppDir = "$LVDir\app"
    if (Test-Path $LVAppDir) { Remove-Item $LVAppDir -Recurse -Force }
    & git clone "https://github.com/amrin78-smb/logvault" $LVAppDir
    Set-Location $LVAppDir

    # Run schema
    $env:PGPASSWORD = $LVDbPass
    & "$PgBin\psql.exe" -U logvault_user -h localhost -p 5432 -d logvault -f "$LVAppDir\scripts\schema.sql"
    Write-OK "LogVault schema applied"

    # Create .env
    $lvEnv = @"
DB_HOST=localhost
DB_PORT=5432
LV_DB_NAME=logvault
LV_DB_USER=logvault_user
LV_DB_PASS=$LVDbPass
LV_API_PORT=3005
LV_APP_PORT=3004
SYSLOG_PORTS=514,1514
RETENTION_DAYS=90
LOG_LEVEL=info
NODE_ENV=production
NEXTAUTH_URL=http://${ServerIP}:3004
NEXTAUTH_SECRET=$SharedSecret
NETVAULT_HUB_URL=http://${ServerIP}:3000
NEXT_PUBLIC_NETVAULT_HUB_URL=http://${ServerIP}:3000
NETVAULT_DB_HOST=localhost
NETVAULT_DB_PORT=5432
NETVAULT_DB_NAME=netvault
NETVAULT_DB_USER=netvault
NETVAULT_DB_PASS=$NVDbPass
"@
    $lvEnv | Out-File -FilePath "$LVAppDir\.env" -Encoding UTF8 -NoNewline

    # Build frontend
    & npm install 2>&1 | Out-Null
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "LogVault build failed" }

    $lvStandalone = "$LVAppDir\.next\standalone"
    Copy-Item -Path "$LVAppDir\public" -Destination "$lvStandalone\public" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path "$LVAppDir\.next\static" -Destination "$lvStandalone\.next\static" -Recurse -Force
    Write-OK "LogVault built"

    # Register 3 NSSM services
    # App service
    & $NssmExe install LogVault-App "C:\Program Files\nodejs\node.exe" "$lvStandalone\server.js"
    & $NssmExe set LogVault-App AppDirectory        $lvStandalone
    & $NssmExe set LogVault-App AppEnvironmentExtra "PORT=3004" "HOSTNAME=0.0.0.0" "NODE_ENV=production"
    & $NssmExe set LogVault-App DisplayName    "LogVault - Syslog App"
    & $NssmExe set LogVault-App Start          SERVICE_AUTO_START
    & $NssmExe set LogVault-App AppStdout      "$LVDir\logs\logvault-app.log"
    & $NssmExe set LogVault-App AppStderr      "$LVDir\logs\logvault-app-error.log"
    & $NssmExe set LogVault-App AppRestartDelay 3000

    # API service
    & $NssmExe install LogVault-API "C:\Program Files\nodejs\node.exe" "$LVAppDir\api\server.js"
    & $NssmExe set LogVault-API AppDirectory        $LVAppDir
    & $NssmExe set LogVault-API AppEnvironmentExtra "PORT=3005" "NODE_ENV=production"
    & $NssmExe set LogVault-API DisplayName    "LogVault - API"
    & $NssmExe set LogVault-API Start          SERVICE_AUTO_START
    & $NssmExe set LogVault-API AppStdout      "$LVDir\logs\logvault-api.log"
    & $NssmExe set LogVault-API AppStderr      "$LVDir\logs\logvault-api-error.log"
    & $NssmExe set LogVault-API AppRestartDelay 3000

    # Collector service
    & $NssmExe install LogVault-Collector "C:\Program Files\nodejs\node.exe" "$LVAppDir\collector\collector.js"
    & $NssmExe set LogVault-Collector AppDirectory        $LVAppDir
    & $NssmExe set LogVault-Collector AppEnvironmentExtra "NODE_ENV=production"
    & $NssmExe set LogVault-Collector DisplayName    "LogVault - Syslog Collector"
    & $NssmExe set LogVault-Collector Start          SERVICE_AUTO_START
    & $NssmExe set LogVault-Collector AppStdout      "$LVDir\logs\logvault-collector.log"
    & $NssmExe set LogVault-Collector AppStderr      "$LVDir\logs\logvault-collector-error.log"
    & $NssmExe set LogVault-Collector AppRestartDelay 3000
    Write-OK "LogVault services registered"

    # Firewall
    New-NetFirewallRule -DisplayName "NocVault LogVault Port 3004" -Direction Inbound -Protocol TCP -LocalPort 3004 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog UDP 514" -Direction Inbound -Protocol UDP -LocalPort 514 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog TCP 514" -Direction Inbound -Protocol TCP -LocalPort 514 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog UDP 1514" -Direction Inbound -Protocol UDP -LocalPort 1514 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "NocVault Syslog TCP 1514" -Direction Inbound -Protocol TCP -LocalPort 1514 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-OK "Firewall rules added for LogVault"
}

# ── Step 10: Install DDIVault ─────────────────────────────────────
if ($InstallDDIVault) {
    Write-Step "Installing DDIVault"
    $DDIAppDir = "$DDIDir\app"
    if (Test-Path $DDIAppDir) { Remove-Item $DDIAppDir -Recurse -Force }
    & git clone "https://github.com/amrin78-smb/ddivault" $DDIAppDir
    Set-Location $DDIAppDir

    # Run schemas in order
    $env:PGPASSWORD = $DDIDbPass
    & "$PgBin\psql.exe" -U ddivault_user -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema.sql"
    & "$PgBin\psql.exe" -U ddivault_user -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema-ipam.sql"
    & "$PgBin\psql.exe" -U ddivault_user -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema-server-auth.sql"
    & "$PgBin\psql.exe" -U ddivault_user -h localhost -p 5432 -d ddivault -f "$DDIAppDir\scripts\schema-sites.sql"
    Write-OK "DDIVault schemas applied"

    # Create .env
    $ddiEnv = @"
DB_HOST=localhost
DB_PORT=5432
DDI_DB_NAME=ddivault
DDI_DB_USER=ddivault_user
DDI_DB_PASS=$DDIDbPass
DDI_API_PORT=3007
DDI_APP_PORT=3006
DHCP_SERVER=
DNS_SERVER=
PS_AUTH_MODE=kerberos
PS_USERNAME=
PS_PASSWORD=
PS_TIMEOUT_MS=30000
DHCP_LOG_UNC=
DHCP_LOG_LOCAL=
SCOPE_WARNING_PCT=80
SCOPE_CRITICAL_PCT=90
RETENTION_DAYS=90
NODE_ENV=production
NEXTAUTH_URL=http://${ServerIP}:3006
NEXTAUTH_SECRET=$SharedSecret
NOCVAULT_HUB_URL=http://${ServerIP}:3000
NEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000
NETVAULT_DB_HOST=localhost
NETVAULT_DB_PORT=5432
NETVAULT_DB_NAME=netvault
NETVAULT_DB_USER=netvault
NETVAULT_DB_PASS=$NVDbPass
"@
    $ddiEnv | Out-File -FilePath "$DDIAppDir\.env" -Encoding UTF8 -NoNewline

    # Build frontend
    & npm install 2>&1 | Out-Null
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "DDIVault build failed" }

    $ddiStandalone = "$DDIAppDir\frontend\.next\standalone"
    if (-not (Test-Path $ddiStandalone)) {
        $ddiStandalone = "$DDIAppDir\.next\standalone"
    }
    Copy-Item -Path "$DDIAppDir\public" -Destination "$ddiStandalone\public" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path "$DDIAppDir\.next\static" -Destination "$ddiStandalone\.next\static" -Recurse -Force -ErrorAction SilentlyContinue
    Write-OK "DDIVault built"

    # Register 3 NSSM services
    # App service
    & $NssmExe install DDIVault-App "C:\Program Files\nodejs\node.exe" "$ddiStandalone\server.js"
    & $NssmExe set DDIVault-App AppDirectory        $ddiStandalone
    & $NssmExe set DDIVault-App AppEnvironmentExtra "PORT=3006" "HOSTNAME=0.0.0.0" "NODE_ENV=production"
    & $NssmExe set DDIVault-App DisplayName    "DDIVault - DNS DHCP IPAM App"
    & $NssmExe set DDIVault-App Start          SERVICE_AUTO_START
    & $NssmExe set DDIVault-App AppStdout      "$DDIDir\logs\ddivault-app.log"
    & $NssmExe set DDIVault-App AppStderr      "$DDIDir\logs\ddivault-app-error.log"
    & $NssmExe set DDIVault-App AppRestartDelay 3000

    # API service
    & $NssmExe install DDIVault-API "C:\Program Files\nodejs\node.exe" "$DDIAppDir\api\server.js"
    & $NssmExe set DDIVault-API AppDirectory        $DDIAppDir
    & $NssmExe set DDIVault-API AppEnvironmentExtra "PORT=3007" "NODE_ENV=production"
    & $NssmExe set DDIVault-API DisplayName    "DDIVault - API"
    & $NssmExe set DDIVault-API Start          SERVICE_AUTO_START
    & $NssmExe set DDIVault-API AppStdout      "$DDIDir\logs\ddivault-api.log"
    & $NssmExe set DDIVault-API AppStderr      "$DDIDir\logs\ddivault-api-error.log"
    & $NssmExe set DDIVault-API AppRestartDelay 3000

    # Collector service
    & $NssmExe install DDIVault-Collector "C:\Program Files\nodejs\node.exe" "$DDIAppDir\collector\collector.js"
    & $NssmExe set DDIVault-Collector AppDirectory        $DDIAppDir
    & $NssmExe set DDIVault-Collector AppEnvironmentExtra "NODE_ENV=production"
    & $NssmExe set DDIVault-Collector DisplayName    "DDIVault - Collector"
    & $NssmExe set DDIVault-Collector Start          SERVICE_AUTO_START
    & $NssmExe set DDIVault-Collector AppStdout      "$DDIDir\logs\ddivault-collector.log"
    & $NssmExe set DDIVault-Collector AppStderr      "$DDIDir\logs\ddivault-collector-error.log"
    & $NssmExe set DDIVault-Collector AppRestartDelay 3000
    Write-OK "DDIVault services registered"

    # Firewall
    New-NetFirewallRule -DisplayName "NocVault DDIVault Port 3006" -Direction Inbound -Protocol TCP -LocalPort 3006 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-OK "Firewall rule added for port 3006"
}

# ── Step 11: Start all services ───────────────────────────────────
Write-Step "Starting all services"
& sc.exe start NetVault | Out-Null
Start-Sleep -Seconds 3
Write-OK "NetVault started"

if ($InstallLogVault) {
    & sc.exe start LogVault-Collector | Out-Null
    & sc.exe start LogVault-API | Out-Null
    Start-Sleep -Seconds 2
    & sc.exe start LogVault-App | Out-Null
    Write-OK "LogVault services started"
}

if ($InstallDDIVault) {
    & sc.exe start DDIVault-Collector | Out-Null
    & sc.exe start DDIVault-API | Out-Null
    Start-Sleep -Seconds 2
    & sc.exe start DDIVault-App | Out-Null
    Write-OK "DDIVault services started"
}

# ── Done ──────────────────────────────────────────────────────────
Start-Sleep -Seconds 5
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║           NocVault Suite - Installation Complete     ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Access your applications:" -ForegroundColor White
Write-Host "  NetVault  : http://${ServerIP}:3000" -ForegroundColor Cyan
if ($InstallLogVault)  { Write-Host "  LogVault  : http://${ServerIP}:3004" -ForegroundColor Cyan }
if ($InstallDDIVault)  { Write-Host "  DDIVault  : http://${ServerIP}:3006" -ForegroundColor Cyan }
Write-Host ""
Write-Host "  Default login: admin@yourcompany.com / Admin1234!" -ForegroundColor Yellow
Write-Host "  Change this immediately after first login." -ForegroundColor Yellow
Write-Host ""
