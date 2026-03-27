#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NetVault - IT Asset Management Platform
    On-Premises Installer for Windows Server
#>

param(
    [string]$InstallDir = "C:\NetVault",
    [int]$AppPort       = 3000
)

$ErrorActionPreference = "Stop"
$AppDir    = "$InstallDir\app"
$DbName    = "netvault"
$DbUser    = "netvault"
$PgPort    = 5432
$PgBin     = "C:\Program Files\PostgreSQL\16\bin"
$NssmUrl   = "https://nssm.cc/release/nssm-2.24.zip"
$NodeUrl   = "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi"
$PgUrl     = "https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64.exe"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }

Clear-Host
Write-Host @"

  _   _      _    __      __          _ _
 | \ | |    | |   \ \    / /         | | |
 |  \| | ___| |_   \ \  / /_ _ _   _| | |_
 | . ' |/ _ \ __|   \ \/ / _' | | | | | __|
 | |\  |  __/ |_     \  / (_| | |_| | | |_
 |_| \_|\___|\__|     \/ \__,_|\__,_|_|\__|

  IT Asset Management Platform - On-Premises Installer
"@ -ForegroundColor White

Write-Host "  Install directory : $InstallDir" -ForegroundColor Gray
Write-Host "  App port          : $AppPort" -ForegroundColor Gray
Write-Host "  PostgreSQL port   : $PgPort" -ForegroundColor Gray
Write-Host ""

$PgPassword = Read-Host "Enter PostgreSQL password for 'netvault' user" -AsSecureString
$PgPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PgPassword))

$PgAdminPassword = Read-Host "Enter PostgreSQL admin (postgres) password" -AsSecureString
$PgAdminPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PgAdminPassword))

$NextAuthSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 48 | % {[char]$_})

$ServerIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1).IPAddress
if (-not $ServerIP) { $ServerIP = "localhost" }
Write-Host "  Detected server IP : $ServerIP" -ForegroundColor Gray
Write-Host ""

Write-Step "Creating install directories"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
Write-OK "Created $InstallDir"

Write-Step "Checking Node.js"
$nodeVer = $null
try { $nodeVer = & node --version 2>$null } catch {}
if ($nodeVer) {
    Write-OK "Node.js already installed: $nodeVer"
} else {
    Write-Host "    Downloading Node.js 20 LTS..." -ForegroundColor Gray
    $nodeMsi = "$env:TEMP\node-installer.msi"
    Invoke-WebRequest -Uri $NodeUrl -OutFile $nodeMsi -UseBasicParsing
    Start-Process msiexec.exe -Wait -ArgumentList "/i `"$nodeMsi`" /quiet /norestart"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-OK "Node.js installed"
}

Write-Step "Checking PostgreSQL"
$pgVer = $null
try { $pgVer = & "$PgBin\psql.exe" --version 2>$null } catch {}
if ($pgVer) {
    Write-OK "PostgreSQL already installed: $pgVer"
} else {
    Write-Host "    Downloading PostgreSQL 16..." -ForegroundColor Gray
    $pgInstaller = "$env:TEMP\pg-installer.exe"
    Invoke-WebRequest -Uri $PgUrl -OutFile $pgInstaller -UseBasicParsing
    $pgArgs = "--mode unattended --unattendedmodeui none --superpassword `"$PgAdminPasswordPlain`" --servicename postgresql --serverport $PgPort --datadir `"C:\Program Files\PostgreSQL\16\data`""
    Start-Process $pgInstaller -Wait -ArgumentList $pgArgs
    $env:Path += ";$PgBin"
    Write-OK "PostgreSQL installed"
}

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
$createDbSql | & "$PgBin\psql.exe" -U postgres -h localhost -p $PgPort
Write-OK "Database and user ready"

Write-Step "Running schema migration"
$env:PGPASSWORD = $PgAdminPasswordPlain
$schemaSql = @"
CREATE TABLE IF NOT EXISTS vendors (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS purchase_vendor_id INTEGER REFERENCES vendors(id);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ma_vendor_id       INTEGER REFERENCES vendors(id);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS purchase_date      DATE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS cost               NUMERIC(12,2);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mgmt_protocol      TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mgmt_url           TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_detail    TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS risk_score         INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS technical_debt     NUMERIC(12,2);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remark             TEXT;
GRANT ALL PRIVILEGES ON TABLE vendors TO $DbUser;
GRANT USAGE, SELECT ON SEQUENCE vendors_id_seq TO $DbUser;
"@
$schemaSql | & "$PgBin\psql.exe" -U postgres -h localhost -p $PgPort -d $DbName
Write-OK "Schema migration complete"

Write-Step "Importing data"
$sqlFile = "$PSScriptRoot\netvault_export.sql"
if (Test-Path $sqlFile) {
    $env:PGPASSWORD        = $PgPasswordPlain
    $env:PGCLIENTENCODING  = "UTF8"
    & "$PgBin\psql.exe" -U $DbUser -h localhost -p $PgPort -d $DbName -f $sqlFile
    Write-OK "Data imported"
} else {
    Write-Warn "netvault_export.sql not found - database will be empty"
}

Write-Step "Cloning app from GitHub"
$gitUrl = "https://github.com/amrin78-smb/net-vault.git"
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
& git clone $gitUrl $AppDir
if ($LASTEXITCODE -ne 0) { throw "Git clone failed" }
Write-OK "App cloned to $AppDir"

Write-Step "Creating environment configuration"
$envContent = @"
DATABASE_URL=postgresql://${DbUser}:${PgPasswordPlain}@localhost:${PgPort}/${DbName}
NEXTAUTH_SECRET=$NextAuthSecret
NEXTAUTH_URL=http://${ServerIP}:${AppPort}
NODE_ENV=production
SSL_DISABLED=true
"@
$envContent | Out-File -FilePath "$AppDir\.env" -Encoding UTF8
Write-OK ".env created (NEXTAUTH_URL=http://${ServerIP}:${AppPort})"

Write-Step "Installing dependencies"
Set-Location $AppDir
& npm install --production=false 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-install.log"
Write-OK "Dependencies installed"

Write-Step "Building NetVault"
& npm run build 2>&1 | Tee-Object -FilePath "$InstallDir\logs\npm-build.log"
if ($LASTEXITCODE -ne 0) { throw "Build failed. Check $InstallDir\logs\npm-build.log" }
Write-OK "Build complete"

Write-Step "Copying static files into standalone output"
$standaloneDir = "$AppDir\.next\standalone"
if (-not (Test-Path $standaloneDir)) { throw "Standalone output not found" }
$publicDest = "$standaloneDir\public"
if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
Copy-Item -Path "$AppDir\public" -Destination $publicDest -Recurse -Force
Write-OK "Copied public/"
New-Item -ItemType Directory -Force -Path "$standaloneDir\.next" | Out-Null
$staticDest = "$standaloneDir\.next\static"
if (Test-Path $staticDest) { Remove-Item $staticDest -Recurse -Force }
Copy-Item -Path "$AppDir\.next\static" -Destination $staticDest -Recurse -Force
Write-OK "Copied .next/static/"
if (-not (Test-Path "$standaloneDir\server.js")) { throw "server.js not found" }
Write-OK "server.js confirmed"

Write-Step "Installing NSSM"
$nssmZip = "$env:TEMP\nssm.zip"
$nssmDir = "$InstallDir\nssm"
Invoke-WebRequest -Uri $NssmUrl -OutFile $nssmZip -UseBasicParsing
Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
$nssmExe = "$nssmDir\nssm-2.24\win64\nssm.exe"
Write-OK "NSSM ready"

Write-Step "Registering Windows Service"
$existingSvc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($existingSvc) {
    & $nssmExe stop NetVault confirm 2>$null
    & $nssmExe remove NetVault confirm
    Start-Sleep -Seconds 2
}
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) { $nodePath = "C:\Program Files\nodejs\node.exe" }
& $nssmExe install NetVault $nodePath "$standaloneDir\server.js"
& $nssmExe set NetVault AppDirectory         $standaloneDir
& $nssmExe set NetVault AppEnvironmentExtra  `
    "PORT=$AppPort"                          `
    "HOSTNAME=0.0.0.0"                       `
    "NODE_ENV=production"                    `
    "SSL_DISABLED=true"                      `
    "DATABASE_URL=postgresql://${DbUser}:${PgPasswordPlain}@localhost:${PgPort}/${DbName}" `
    "NEXTAUTH_SECRET=$NextAuthSecret"        `
    "NEXTAUTH_URL=http://${ServerIP}:${AppPort}"
& $nssmExe set NetVault DisplayName    "NetVault - IT Asset Management"
& $nssmExe set NetVault Description    "NetVault IT Asset Management Platform"
& $nssmExe set NetVault Start          SERVICE_AUTO_START
& $nssmExe set NetVault AppStdout      "$InstallDir\logs\netvault.log"
& $nssmExe set NetVault AppStderr      "$InstallDir\logs\netvault-error.log"
& $nssmExe set NetVault AppRotateFiles 1
& $nssmExe set NetVault AppRotateSeconds 86400
& $nssmExe set NetVault AppRestartDelay 3000
Write-OK "Windows Service registered"

Write-Step "Configuring firewall"
$ruleName = "NetVault Port $AppPort"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
        -Protocol TCP -LocalPort $AppPort -Action Allow | Out-Null
}
Write-OK "Firewall rule added for port $AppPort"

Write-Step "Starting NetVault service"
& $nssmExe start NetVault
Start-Sleep -Seconds 6
$svc = Get-Service -Name NetVault -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-OK "NetVault service is running"
} else {
    Write-Warn "Service may still be starting - check logs at $InstallDir\logs"
}

Write-Step "Creating desktop shortcut"
$WshShell = New-Object -ComObject WScript.Shell
$shortcut = $WshShell.CreateShortcut("$env:PUBLIC\Desktop\NetVault.lnk")
$shortcut.TargetPath = "http://${ServerIP}:${AppPort}"
$shortcut.Save()
Write-OK "Desktop shortcut created"

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host "  NetVault installation complete!" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host ""
Write-Host "  Access NetVault at : http://${ServerIP}:${AppPort}" -ForegroundColor White
Write-Host "  Local access       : http://localhost:${AppPort}" -ForegroundColor White
Write-Host ""
Write-Host "  Logs               : $InstallDir\logs\" -ForegroundColor Gray
Write-Host "  Service commands:" -ForegroundColor Gray
Write-Host "    Start  : sc start NetVault" -ForegroundColor Gray
Write-Host "    Stop   : sc stop NetVault" -ForegroundColor Gray
Write-Host "    Status : Get-Service NetVault" -ForegroundColor Gray
Write-Host "    Logs   : Get-Content $InstallDir\logs\netvault.log -Tail 50 -Wait" -ForegroundColor Gray
Write-Host ""
