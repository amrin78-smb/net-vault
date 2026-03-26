#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NetVault - IT Asset Management Platform
    On-Premises Installer for Windows Server
.DESCRIPTION
    Installs Node.js, PostgreSQL, and NetVault as a Windows Service
#>

$ErrorActionPreference = "Stop"
$InstallDir = "C:\NetVault"
$AppDir = "$InstallDir\app"
$DbName = "netvault"
$DbUser = "netvault"
$PgPort = 5432
$AppPort = 3000
$NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$NodeUrl = "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi"
$PgUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64.exe"

function Write-Step($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "    [OK] $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "    [!!] $msg" -ForegroundColor Yellow
}

# ── Banner ─────────────────────────────────────────────────────
Clear-Host
Write-Host @"

  _   _      _    __      __          _ _
 | \ | |    | |   \ \    / /         | | |
 |  \| | ___| |_   \ \  / /_ _ _   _| | |_
 | . `` |/ _ \ __|   \ \/ / _`` | | | | | __|
 | |\  |  __/ |_     \  / (_| | |_| | | |_
 |_| \_|\___|\__|     \/ \__,_|\__,_|_|\__|

  IT Asset Management Platform - On-Premises Installer
"@ -ForegroundColor White

Write-Host "  Install directory : $InstallDir" -ForegroundColor Gray
Write-Host "  App port          : $AppPort" -ForegroundColor Gray
Write-Host "  PostgreSQL port   : $PgPort" -ForegroundColor Gray
Write-Host ""

# ── Ask for passwords ──────────────────────────────────────────
$PgPassword = Read-Host "Enter PostgreSQL password for 'netvault' user" -AsSecureString
$PgPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PgPassword))

$PgAdminPassword = Read-Host "Enter PostgreSQL admin (postgres) password" -AsSecureString
$PgAdminPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PgAdminPassword))

$NextAuthSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | % {[char]$_})

# ── Create install directory ───────────────────────────────────
Write-Step "Creating install directory"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
Write-OK "Created $InstallDir"

# ── Check / Install Node.js ────────────────────────────────────
Write-Step "Checking Node.js"
$nodeInstalled = $null
try { $nodeInstalled = & node --version 2>$null } catch {}

if ($nodeInstalled) {
    Write-OK "Node.js already installed: $nodeInstalled"
} else {
    Write-Host "    Downloading Node.js 20 LTS..." -ForegroundColor Gray
    $nodeMsi = "$env:TEMP\node-installer.msi"
    Invoke-WebRequest -Uri $NodeUrl -OutFile $nodeMsi -UseBasicParsing
    Write-Host "    Installing Node.js (silent)..." -ForegroundColor Gray
    Start-Process msiexec.exe -Wait -ArgumentList "/i `"$nodeMsi`" /quiet /norestart"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-OK "Node.js installed"
}

# ── Check / Install PostgreSQL ─────────────────────────────────
Write-Step "Checking PostgreSQL"
$pgInstalled = $null
try { $pgInstalled = & psql --version 2>$null } catch {}

if ($pgInstalled) {
    Write-OK "PostgreSQL already installed: $pgInstalled"
} else {
    Write-Host "    Downloading PostgreSQL 16..." -ForegroundColor Gray
    $pgInstaller = "$env:TEMP\pg-installer.exe"
    Invoke-WebRequest -Uri $PgUrl -OutFile $pgInstaller -UseBasicParsing
    Write-Host "    Installing PostgreSQL (silent, this may take a few minutes)..." -ForegroundColor Gray
    $pgArgs = "--mode unattended --unattendedmodeui none --superpassword `"$PgAdminPasswordPlain`" --servicename postgresql --serverport $PgPort --datadir `"C:\Program Files\PostgreSQL\16\data`""
    Start-Process $pgInstaller -Wait -ArgumentList $pgArgs
    $env:Path += ";C:\Program Files\PostgreSQL\16\bin"
    Write-OK "PostgreSQL installed"
}

# ── Setup database ─────────────────────────────────────────────
Write-Step "Setting up NetVault database"
$env:PGPASSWORD = $PgAdminPasswordPlain

$createDbSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DbUser') THEN
    CREATE USER $DbUser WITH PASSWORD '$PgPasswordPlain';
  END IF;
END
`$`$;

SELECT 'CREATE DATABASE $DbName OWNER $DbUser'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DbName')\gexec

GRANT ALL PRIVILEGES ON DATABASE $DbName TO $DbUser;
"@

$createDbSql | & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -p $PgPort
Write-OK "Database and user created"

# ── Import data ────────────────────────────────────────────────
Write-Step "Importing NetVault data"
$sqlFile = "$PSScriptRoot\netvault_export.sql"
if (Test-Path $sqlFile) {
    $env:PGPASSWORD = $PgPasswordPlain
    & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U $DbUser -h localhost -p $PgPort -d $DbName -f $sqlFile
    Write-OK "Data imported successfully"
} else {
    Write-Warn "netvault_export.sql not found - database will be empty"
    Write-Warn "Copy netvault_export.sql to $PSScriptRoot and run: psql -U netvault -d netvault -f netvault_export.sql"
}

# ── Copy app files ─────────────────────────────────────────────
Write-Step "Copying application files"
$sourceDir = Split-Path $PSScriptRoot -Parent
if (Test-Path "$sourceDir\package.json") {
    Copy-Item -Path $sourceDir -Destination $AppDir -Recurse -Force -Exclude @('.git','node_modules','.next','installer')
    Write-OK "App files copied to $AppDir"
} else {
    Write-Warn "App source not found at $sourceDir"
    Write-Warn "Please copy the NetVault app files to $AppDir manually"
}

# ── Create .env file ───────────────────────────────────────────
Write-Step "Creating environment configuration"
$envContent = @"
DATABASE_URL=postgresql://${DbUser}:${PgPasswordPlain}@localhost:${PgPort}/${DbName}
NEXTAUTH_SECRET=$NextAuthSecret
NEXTAUTH_URL=http://localhost:$AppPort
"@
$envContent | Out-File -FilePath "$AppDir\.env" -Encoding UTF8
Write-OK ".env file created"

# ── Install dependencies and build ────────────────────────────
Write-Step "Installing dependencies (this may take a few minutes)"
Set-Location $AppDir
& npm install --production=false 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
Write-OK "Dependencies installed"

Write-Step "Building NetVault"
& npm run build 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-build.log"
Write-OK "Build complete"

# ── Install NSSM and create Windows Service ───────────────────
Write-Step "Installing Windows Service"
$nssmZip = "$env:TEMP\nssm.zip"
$nssmDir = "$InstallDir\nssm"
Invoke-WebRequest -Uri $NssmUrl -OutFile $nssmZip -UseBasicParsing
Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
$nssmExe = "$nssmDir\nssm-2.24\win64\nssm.exe"

$nodePath = (Get-Command node).Source
& $nssmExe install NetVault $nodePath "$AppDir\node_modules\.bin\next start -- -p $AppPort"
& $nssmExe set NetVault AppDirectory $AppDir
& $nssmExe set NetVault AppEnvironmentExtra `
    "DATABASE_URL=postgresql://${DbUser}:${PgPasswordPlain}@localhost:${PgPort}/${DbName}" `
    "NEXTAUTH_SECRET=$NextAuthSecret" `
    "NEXTAUTH_URL=http://localhost:$AppPort" `
    "NODE_ENV=production"
& $nssmExe set NetVault DisplayName "NetVault - IT Asset Management"
& $nssmExe set NetVault Description "NetVault IT Asset Management Platform"
& $nssmExe set NetVault Start SERVICE_AUTO_START
& $nssmExe set NetVault AppStdout "$InstallDir\logs\netvault.log"
& $nssmExe set NetVault AppStderr "$InstallDir\logs\netvault-error.log"
& $nssmExe set NetVault AppRotateFiles 1
& $nssmExe set NetVault AppRotateSeconds 86400
Write-OK "Windows Service registered"

# ── Firewall rule ──────────────────────────────────────────────
Write-Step "Configuring firewall"
$ruleName = "NetVault App Port $AppPort"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $AppPort -Action Allow | Out-Null
}
Write-OK "Firewall rule added for port $AppPort"

# ── Start service ──────────────────────────────────────────────
Write-Step "Starting NetVault service"
& $nssmExe start NetVault
Start-Sleep -Seconds 5
$svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-OK "NetVault service is running"
} else {
    Write-Warn "Service may still be starting - check logs at $InstallDir\logs"
}

# ── Create desktop shortcut ────────────────────────────────────
Write-Step "Creating shortcuts"
$WshShell = New-Object -ComObject WScript.Shell
$shortcut = $WshShell.CreateShortcut("$env:PUBLIC\Desktop\NetVault.lnk")
$shortcut.TargetPath = "http://localhost:$AppPort"
$shortcut.Save()
Write-OK "Desktop shortcut created"

# ── Done ───────────────────────────────────────────────────────
Write-Host "`n" + "="*60 -ForegroundColor Green
Write-Host "  NetVault installation complete!" -ForegroundColor Green
Write-Host "="*60 -ForegroundColor Green
Write-Host ""
Write-Host "  Access NetVault at: http://localhost:$AppPort" -ForegroundColor White
Write-Host "  Or from network  : http://<server-ip>:$AppPort" -ForegroundColor White
Write-Host ""
Write-Host "  Logs location    : $InstallDir\logs\" -ForegroundColor Gray
Write-Host "  App location     : $AppDir\" -ForegroundColor Gray
Write-Host "  Service name     : NetVault" -ForegroundColor Gray
Write-Host ""
Write-Host "  To manage the service:" -ForegroundColor Gray
Write-Host "    Start : sc start NetVault" -ForegroundColor Gray
Write-Host "    Stop  : sc stop NetVault" -ForegroundColor Gray
Write-Host "    Status: sc query NetVault" -ForegroundColor Gray
Write-Host ""
