#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NocVault Suite Installer v1.5
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

# The PostgreSQL superuser password ($DefaultPgPassword) and the cross-DB read-only
# role password ($DefaultNocRoPassword) are NO LONGER hardcoded. They are generated
# uniquely per install (or loaded from a prior install) in the Credentials section
# below, persisted to C:\ProgramData\NocVault\secrets.env. -PgAdminPassword /
# -NocReadOnlyPass still override them.

# ── Helpers ───────────────────────────────────────────────────────
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    [--] $msg" -ForegroundColor Gray }

# Generate a random alphanumeric password. Alphanumeric-only is deliberate: the
# values go into SQL string literals, a postgresql://user:PASS@host DATABASE_URL,
# and KEY=VALUE .env files, so they must have no special characters.
function New-Pass([int]$len = 28) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
    -join (1..$len | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}
# Read a single KEY=VALUE from a machine-level secrets file (UTF-8, one per line).
function Get-EnvVal([string]$file, [string]$key) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=\s*(.+?)\s*$") { return $Matches[1].Trim() }
    }
    return $null
}

# Grant the cross-DB read-only role (nocvault_readonly) SELECT on a database. Call
# AFTER that DB's schema is applied so existing AND future tables are covered. Feeds
# the NocVault Hub's cross-app reads (unified search / asset 360 / suite alerting).
function GrantNocRoRead($db) {
    # Run the RO grants WITHOUT swallowing stderr (mirrors the per-app table
    # grants below) so a real failure surfaces instead of silently shipping a
    # degraded Hub install. Check $LASTEXITCODE per statement and warn on failure.
    $roGrants = @(
        "GRANT CONNECT ON DATABASE $db TO nocvault_readonly;",
        "GRANT USAGE ON SCHEMA public TO nocvault_readonly;",
        "GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocvault_readonly;",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nocvault_readonly;"
    )
    foreach ($g in $roGrants) {
        & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d $db -c $g
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "nocvault_readonly grant on '$db' FAILED (exit $LASTEXITCODE): $g - Hub cross-DB reads may be degraded."
        }
    }
}

# ── Agent WebSocket TLS (wss://) ──────────────────────────────────
# The common NocVault agent connects to two app ingest WebSockets - SpanVault
# 3010 and DDIVault 3011 - and those frames carry DECRYPTED credentials (the
# ddi_config frame ships WinRM passwords), so the sockets must run wss://.
# Certificates are SELF-SIGNED and minted here: the operator must NEVER have to
# obtain or deploy a certificate. The agent pins the server by SHA-256
# fingerprint, so a pair is generated ONCE and NEVER regenerated - a new key
# silently breaks every already-pinned agent in the fleet.
$WsTlsCertDir = 'C:\ProgramData\NocVault\certs'

# openssl.exe mints the pair because Node's https.createServer needs a PEM cert
# + PEM key, and New-SelfSignedCertificate on Windows PowerShell 5.1 can only
# export PFX (.NET Framework has no PKCS#8 private-key export). Git for Windows
# is a hard dependency of this suite and bundles OpenSSL 3.x, so it is present
# by the time this runs (STEP 4 installs Git).
function Get-WsTlsOpenSsl {
    $paths = @(
        "$env:ProgramFiles\Git\usr\bin\openssl.exe",
        "$env:ProgramFiles\Git\mingw64\bin\openssl.exe",
        "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
        "C:\Program Files\PostgreSQL\16\bin\openssl.exe"
    )
    foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
    # PATH lookup last, via Get-Command - '& openssl' would THROW on a machine
    # that genuinely lacks it (PowerShell command resolution fails before any
    # process exists to redirect stderr from).
    try { $c = Get-Command openssl.exe -ErrorAction SilentlyContinue; if ($c) { return $c.Source } } catch {}
    return $null
}

# SHA-256 over the certificate DER. Byte-identical to Node's
# tls.getPeerCertificate().fingerprint256, which is what the agent pins on.
function Get-WsTlsFingerprint([string]$certPath) {
    try {
        $pem = Get-Content -LiteralPath $certPath -Raw
        $b64 = ($pem -replace '-----BEGIN CERTIFICATE-----','' -replace '-----END CERTIFICATE-----','') -replace '\s',''
        $der = [Convert]::FromBase64String($b64)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        return (($sha.ComputeHash($der) | ForEach-Object { $_.ToString('X2') }) -join ':')
    } catch { return $null }
}

# Generate (once) the wss:// cert+key for one app. IDEMPOTENT: if both files
# already exist it re-reads them and returns the SAME fingerprint. NEVER throws
# - a TLS failure must degrade to "no TLS configured", never abort an install.
function New-WsTlsCert([string]$app, [string]$serverIp, [int]$years = 5) {
    $dir = 'C:\ProgramData\NocVault\certs'
    $res = [pscustomobject]@{
        App         = $app
        Cert        = (Join-Path $dir "$app-ws.crt")
        Key         = (Join-Path $dir "$app-ws.key")
        Fingerprint = $null
        NotAfter    = $null
        Created     = $false
        Ok          = $false
        Warning     = $null
        Error       = $null
    }
    try {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        if (-not ((Test-Path -LiteralPath $res.Cert) -and (Test-Path -LiteralPath $res.Key))) {
            $ssl = Get-WsTlsOpenSsl
            if (-not $ssl) {
                $res.Error = 'openssl.exe not found (looked in Git for Windows, PostgreSQL and PATH)'
                return $res
            }
            # A config FILE is used rather than -subj/-addext: no leading-slash
            # argument that an MSYS-linked openssl could path-mangle, and no
            # dependency on OpenSSL >= 1.1.1 for -addext. The SAN MUST carry the
            # server IP - agents dial by IP, and an IP absent from the SAN fails
            # certificate verification outright no matter what the CN says.
            $cfg = Join-Path $env:TEMP ("nocvault-{0}-ws-{1}.cnf" -f $app, ([guid]::NewGuid().ToString('N')))
            $cfgText = @"
[ req ]
default_bits       = 2048
default_md         = sha256
prompt             = no
distinguished_name = nv_dn
x509_extensions    = nv_ext

[ nv_dn ]
CN = $serverIp
O  = NocVault

[ nv_ext ]
basicConstraints = critical,CA:FALSE
keyUsage         = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = @nv_alt

[ nv_alt ]
IP.1  = $serverIp
IP.2  = 127.0.0.1
DNS.1 = $env:COMPUTERNAME
DNS.2 = localhost
"@
            [System.IO.File]::WriteAllText($cfg, $cfgText, (New-Object System.Text.UTF8Encoding($false)))
            $days = ($years * 365) + 2
            # openssl streams key-generation progress dots to STDERR. Under a
            # host that merges stderr into PowerShell's error stream that reads
            # as a failure even on exit 0, so relax ErrorActionPreference for the
            # call and judge success on the files it produced instead.
            $prevEA = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $ssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days $days -config $cfg -keyout $res.Key -out $res.Cert
            } finally {
                $ErrorActionPreference = $prevEA
                Remove-Item -LiteralPath $cfg -Force -ErrorAction SilentlyContinue
            }
            if (-not ((Test-Path -LiteralPath $res.Cert) -and (Test-Path -LiteralPath $res.Key))) {
                $res.Error = "openssl did not produce $($res.Cert)"
                return $res
            }
            $res.Created = $true
            # The key is an unencrypted private key on disk - restrict it to
            # SYSTEM (the NSSM service account) and Administrators.
            try { & icacls.exe $res.Key /inheritance:r /grant '*S-1-5-18:(R)' /grant '*S-1-5-32-544:(F)' | Out-Null } catch {}
        }
        $res.Fingerprint = Get-WsTlsFingerprint $res.Cert
        try {
            $pem = Get-Content -LiteralPath $res.Cert -Raw
            $b64 = ($pem -replace '-----BEGIN CERTIFICATE-----','' -replace '-----END CERTIFICATE-----','') -replace '\s',''
            $x   = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,[Convert]::FromBase64String($b64))
            $res.NotAfter = $x.NotAfter
            $san = (($x.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ' ')
            if ($serverIp -and $san -and ($san -notmatch [regex]::Escape($serverIp))) {
                $res.Warning = "existing certificate SAN does not cover $serverIp - agents dialling that IP will reject it"
            }
        } catch {}
        $res.Ok = [bool]$res.Fingerprint
    } catch {
        $res.Error = $_.Exception.Message
    }
    return $res
}

# ── Banner ────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  +============================================+" -ForegroundColor White
Write-Host "  |   NocVault Suite Installer v1.5           |" -ForegroundColor White
Write-Host "  |   Network Intelligence Suite              |" -ForegroundColor White
Write-Host "  +============================================+" -ForegroundColor White
Write-Host ""

# Resolve a path to its TRUE on-disk casing. Windows paths are case-insensitive but
# Node/Next are not: `next build` bakes the directory it was invoked with into the
# standalone output, so reaching the same folder through a differently-cased path
# (C:\apps\... vs C:\Apps\...) on a later run can trace against a root the previous
# build never used. All four per-app updaters pin this; the suite installer did not,
# so an idempotent RE-RUN over an existing, mis-cased install could hit exactly that.
# Same helper as Update-NetVault.ps1, verbatim.
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

# ── Paths ─────────────────────────────────────────────────────────
# Pin the install root to its real casing FIRST, so every path derived below
# inherits it. On a fresh install the folder may not exist yet — the helper then
# just returns the normalized full path, which is the same thing.
$InstallDir     = Get-TrueCasePath $InstallDir
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
# Re-resolve each app dir too: on a RE-RUN these already exist, and the mis-casing
# this guards against can be in the app folder itself, not just the install root.
$NVAppDir       = Get-TrueCasePath $NVAppDir
$LVAppDir       = Get-TrueCasePath $LVAppDir
$DDIAppDir      = Get-TrueCasePath $DDIAppDir
$SVAppDir       = Get-TrueCasePath $SVAppDir
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

# ── Credentials (unique per install, persisted so re-installs are idempotent) ──
# Secrets are generated once and stored machine-level in secrets.env, so re-running
# the installer reuses the same values (existing databases/services keep working).
# No password prompts in any mode.
New-Item -ItemType Directory -Force 'C:\ProgramData\NocVault' | Out-Null
$SecretsFile = 'C:\ProgramData\NocVault\secrets.env'
$script:SecretsExisted = Test-Path $SecretsFile

$PostgresPassword = Get-EnvVal $SecretsFile 'POSTGRES_PASSWORD'; if (-not $PostgresPassword) { $PostgresPassword = New-Pass 28 }
$NextAuthSecret   = Get-EnvVal $SecretsFile 'NEXTAUTH_SECRET';   if (-not $NextAuthSecret)   { $NextAuthSecret   = New-Pass 32 }
$NocRoPass        = Get-EnvVal $SecretsFile 'NOCVAULT_RO_PASS';  if (-not $NocRoPass)        { $NocRoPass        = New-Pass 28 }
$NvPass           = Get-EnvVal $SecretsFile 'NV_DB_PASS';        if (-not $NvPass)           { $NvPass           = New-Pass 28 }
$LvPass           = Get-EnvVal $SecretsFile 'LV_DB_PASS';        if (-not $LvPass)           { $LvPass           = New-Pass 28 }
$DdiPass          = Get-EnvVal $SecretsFile 'DDI_DB_PASS';       if (-not $DdiPass)          { $DdiPass          = New-Pass 28 }
$SvPass           = Get-EnvVal $SecretsFile 'SV_DB_PASS';        if (-not $SvPass)           { $SvPass           = New-Pass 28 }

# Persist ALL keys back (newly generated values become permanent; existing ones are
# re-written unchanged). UTF-8 no BOM, one KEY=VALUE per line.
$secretsContent = @(
    "POSTGRES_PASSWORD=$PostgresPassword",
    "NEXTAUTH_SECRET=$NextAuthSecret",
    "NOCVAULT_RO_PASS=$NocRoPass",
    "NV_DB_PASS=$NvPass",
    "LV_DB_PASS=$LvPass",
    "DDI_DB_PASS=$DdiPass",
    "SV_DB_PASS=$SvPass"
) -join "`r`n"
[System.IO.File]::WriteAllText($SecretsFile, $secretsContent + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

# Assign the credential variables everything downstream references (names unchanged).
$NVDbPass             = $NvPass
$LVDbPass             = $LvPass
$DDIDbPass            = $DdiPass
$SVDbPass             = $SvPass
$SharedSecret         = $NextAuthSecret
$DefaultPgPassword    = $PostgresPassword
$DefaultNocRoPassword = $NocRoPass
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

# ── PostgreSQL admin + NocVault read-only role passwords ──────────
# No prompting in any mode: use the per-install generated secrets unless the caller
# passed an explicit override. Record whether -PgAdminPassword was supplied so the
# pre-existing-PostgreSQL sanity check below can distinguish an override from a
# freshly generated password.
$PgAdminPasswordProvided = [bool]$PgAdminPassword
if (-not $PgAdminPassword) { $PgAdminPassword = $DefaultPgPassword }
if (-not $NocReadOnlyPass) { $NocReadOnlyPass = $DefaultNocRoPassword }

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
# On a truly clean machine (node not on PATH), `& node ...` throws a terminating
# "term not recognized" error that `2>$null` does NOT suppress (that redirects the
# native command's stderr stream; here there is no process to redirect from, since
# PowerShell's own command resolution fails first) - wrap in try/catch so a bare
# machine falls through to the msiexec install below instead of crashing the setup.
$nodeVer = try { & node --version 2>$null } catch { $null }
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
# Same command-not-found gotcha as the Node.js check above - see that comment.
$gitVer = try { & git --version 2>$null } catch { $null }
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
# Record whether PostgreSQL already existed before this run (its superuser password
# may differ from the one NocVault holds - checked before we create databases).
$PgPreInstalled = Test-Path "$PgBin\psql.exe"
if ($PgPreInstalled) {
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
# STEP 6.5 — Agent WebSocket TLS certificates (wss://)
# ================================================================
# Runs BEFORE the app steps so the generated paths can be baked straight into
# each app's .env.local / NSSM environment below. Everything here is best-effort:
# if a certificate cannot be minted the apps fall back to exactly today's plain
# ws:// behaviour (DDIVault keeps its DDI_WS_ALLOW_PLAINTEXT=1 opt-out) rather
# than failing the install.
Write-Step "Generating agent WebSocket TLS certificates"
$SVWsTls = $null
$DDIWsTls = $null
# Env fragments spliced into the app env blocks further down. Defaults preserve
# the pre-TLS behaviour so a cert failure is a graceful degrade, not a breakage.
$SVWsEnvLines  = ""
$DDIWsEnvLines = "DDI_WS_ALLOW_PLAINTEXT=1"

if ($InstallSpanVault) {
    $SVWsTls = New-WsTlsCert 'spanvault' $ServerIP 5
    if ($SVWsTls.Ok) {
        $SVWsEnvLines = "SV_WS_TLS_CERT=$($SVWsTls.Cert)`nSV_WS_TLS_KEY=$($SVWsTls.Key)"
        if ($SVWsTls.Created) { Write-OK "SpanVault agent WS certificate created (expires $($SVWsTls.NotAfter.ToString('yyyy-MM-dd')))" }
        else                  { Write-OK "SpanVault agent WS certificate already present - reused, NOT regenerated (expires $($SVWsTls.NotAfter.ToString('yyyy-MM-dd')))" }
        if ($SVWsTls.Warning) { Write-Warn "SpanVault WS cert: $($SVWsTls.Warning)" }
    } else {
        Write-Warn "SpanVault agent WS certificate NOT created ($($SVWsTls.Error)) - port 3010 stays plain ws://"
    }
}

if ($InstallDDIVault) {
    $DDIWsTls = New-WsTlsCert 'ddivault' $ServerIP 5
    if ($DDIWsTls.Ok) {
        # TLS is on, so the cleartext opt-out MUST go: leaving
        # DDI_WS_ALLOW_PLAINTEXT=1 in place would keep the guard in
        # api/ws-server.js permanently defeated for any future config drift.
        $DDIWsEnvLines = "DDI_WS_TLS_CERT=$($DDIWsTls.Cert)`nDDI_WS_TLS_KEY=$($DDIWsTls.Key)"
        if ($DDIWsTls.Created) { Write-OK "DDIVault agent WS certificate created (expires $($DDIWsTls.NotAfter.ToString('yyyy-MM-dd')))" }
        else                   { Write-OK "DDIVault agent WS certificate already present - reused, NOT regenerated (expires $($DDIWsTls.NotAfter.ToString('yyyy-MM-dd')))" }
        if ($DDIWsTls.Warning) { Write-Warn "DDIVault WS cert: $($DDIWsTls.Warning)" }
        Write-OK "DDI_WS_ALLOW_PLAINTEXT removed - the DDIVault agent ingest now requires wss://"
    } else {
        Write-Warn "DDIVault agent WS certificate NOT created ($($DDIWsTls.Error)) - keeping DDI_WS_ALLOW_PLAINTEXT=1 so port 3011 still binds"
    }
}

if (-not $InstallSpanVault -and -not $InstallDDIVault) { Write-Info "No agent-WS apps selected - skipping" }

# The HUB half of the same switch. A cert on the app server only flips the
# LISTENER: ws-server.js swaps in https.createServer and then speaks wss:// and
# nothing else. The hub separately decides which URL to hand each agent
# (lib/agentIdentity.ts deriveIngest), and since the hub is served over plain
# HTTP the request-derived scheme is always ws:// - so without these flags a
# fresh install would generate certs, flip both listeners to TLS-only, and then
# tell every agent to dial ws://, which fails the handshake. The two halves must
# be set in the SAME run that mints the cert; they are useless apart.
#
# The fingerprints ride along so the enroll-token route can bake a -WsFingerprint
# into the install command it prints (app/api/agents/enroll-tokens/route.ts).
$NVWsHubPairs = @()
if ($SVWsTls -and $SVWsTls.Ok) {
    $NVWsHubPairs += "SPANVAULT_WS_TLS=1"
    $NVWsHubPairs += "SPANVAULT_WS_FINGERPRINT=$($SVWsTls.Fingerprint)"
}
if ($DDIWsTls -and $DDIWsTls.Ok) {
    $NVWsHubPairs += "DDIVAULT_WS_TLS=1"
    $NVWsHubPairs += "DDIVAULT_WS_FINGERPRINT=$($DDIWsTls.Fingerprint)"
}
# Two shapes: newline-terminated for the .env heredocs (empty => contributes
# nothing at all, not a stray blank line), newline-PREFIXED for the NSSM
# AppEnvironmentExtra strings, which are backtick-n joined already.
$NVWsHubBlock = if ($NVWsHubPairs.Count) { $NVWsHubPairs -join "`n" } else { "" }
$NVWsHubNssm  = if ($NVWsHubPairs.Count) { "`n" + ($NVWsHubPairs -join "`n") } else { "" }
if ($NVWsHubPairs.Count) { Write-OK "Hub agent-ingest TLS flags set - agents will be told to dial wss://" }

# ================================================================
# STEP 7 — Databases
# ================================================================
Write-Step "Creating databases and users"
$env:PGPASSWORD = $PgAdminPassword

# Sanity check: if PostgreSQL pre-existed on this machine, the superuser password we
# hold may not match its actual password. When we just generated a brand-new password
# (no prior secrets.env) and the caller did not supply -PgAdminPassword, a mismatch
# would fail cryptically here - convert it into a clear, actionable message instead.
if ($PgPreInstalled) {
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -c "SELECT 1" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $script:SecretsExisted -and -not $PgAdminPasswordProvided) {
        throw "PostgreSQL is already installed but its superuser password is not known to NocVault. Uninstall PostgreSQL (or run the uninstaller with -RemoveDependencies) and re-install, or re-run with -PgAdminPassword <existing password>."
    }
}

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
# GrantNocRoRead runs BEFORE schema.sql, not after (security fix, 2026-07) —
# schema.sql's own tail end narrows nocvault_readonly's access on secret-
# bearing tables (users_public/app_settings_public views instead of raw
# table SELECT); whichever grant runs LAST wins in Postgres, so
# GrantNocRoRead's blanket GRANT SELECT ON ALL TABLES must execute first or
# it silently re-widens access schema.sql just narrowed. Safe to run before
# any table exists yet — GRANT SELECT ON ALL TABLES on zero tables is a
# harmless no-op, and its ALTER DEFAULT PRIVILEGES only auto-grants SELECT
# on tables schema.sql is ABOUT to create, which schema.sql's own later
# REVOKE still correctly narrows regardless of how the grant first landed.
GrantNocRoRead "netvault"
# -v ON_ERROR_STOP=1 (added 2026-07-23): a fresh install must not silently
# "succeed" with a broken schema - without this flag psql prints a SQL error
# (e.g. a CREATE VIEW referencing a nonexistent column) and keeps going,
# exiting 0 regardless, which is how the users_public/app_settings_public
# security fix shipped un-applied for a full release without anyone noticing.
# schema.sql's own idempotent statements (IF NOT EXISTS/IF EXISTS/OR REPLACE/
# ON CONFLICT) are not errors on a fresh DB, so this does not affect them -
# only a genuine SQL error now stops the install.
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -v ON_ERROR_STOP=1 -f "$NVAppDir\schema.sql"
if ($LASTEXITCODE -ne 0) { throw "NetVault schema.sql failed to apply (exit $LASTEXITCODE) - installation aborted; a security-relevant grant/view may not have applied. Check the psql output above." }
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO netvault;"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO netvault;"
& "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -f "$NVAppDir\setup.sql"
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
$NVWsHubBlock
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
$NVWsHubBlock
"@ | Out-File -FilePath "$NVStandalone\.env.local" -Encoding UTF8 -NoNewline
Write-OK "NetVault standalone .env.local written (incl. SERVER_IP, CRON_SECRET)"

# Register NSSM service
& $NssmExe stop NetVault confirm 2>$null
& $NssmExe remove NetVault confirm 2>$null
& $NssmExe install NetVault "C:\Program Files\nodejs\node.exe" "$NVStandalone\server.js"
& $NssmExe set NetVault AppDirectory        $NVStandalone
& $NssmExe set NetVault AppEnvironmentExtra "PORT=3000`nHOSTNAME=0.0.0.0`nNODE_ENV=production`nDATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault`nNEXTAUTH_SECRET=$SharedSecret`nNEXTAUTH_URL=http://${ServerIP}:3000`nSSL_DISABLED=true`nSERVER_IP=$ServerIP`nCRON_SECRET=$CronSecret`nNOCVAULT_RO_HOST=localhost`nNOCVAULT_RO_PORT=5432`nNOCVAULT_RO_USER=nocvault_readonly`nNOCVAULT_RO_PASS=$NocReadOnlyPass$NVWsHubNssm"
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

# Register a recurring maintenance task as Local SYSTEM via the well-known SID
# (S-1-5-18) with an explicit principal, instead of the bare `-RunLevel Highest`
# form that baked the ambient account name into the task XML's <UserId>. That name
# had to resolve to a SID at registration, which fails with ERROR_NONE_MAPPED ("No
# mapping between account names and security IDs was done") under a SYSTEM/localized/
# fresh-install context on some boxes. A fixed SID needs no lookup (works anywhere),
# ServiceAccount runs unattended, and it's NON-FATAL so a task hiccup can't abort an
# otherwise-successful install.
function Register-MaintenanceTask([string]$Name, $Action, $Trigger, [string]$When) {
    try {
        $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Principal $principal -Force | Out-Null
        Write-OK "Scheduled task '$Name' registered ($When)"
    } catch {
        Write-Warn "Could not register scheduled task '$Name' ($When) - non-fatal: $($_.Exception.Message)"
    }
}

# Daily fleet health-snapshot job (feeds health_score_history trend).
# Posts to NetVault with the shared CRON_SECRET as a Bearer token.
$nvSnapAction  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
$nvSnapTrigger = New-ScheduledTaskTrigger -Daily -At "00:00"
Register-MaintenanceTask "NetVault-HealthSnapshot" $nvSnapAction $nvSnapTrigger "daily 00:00"

# Daily EOL/EOS enrichment (matches devices against eol_seed, writes EOL/EOS dates;
# status-change recommendations stay human-gated). Mirrors Update-NetVault.ps1.
$nvEolAction  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
$nvEolTrigger = New-ScheduledTaskTrigger -Daily -At "01:00"
Register-MaintenanceTask "NetVault-EnrichEol" $nvEolAction $nvEolTrigger "daily 01:00"

# Weekly EOL feed sync (pulls the central signed seed into eol_seed; runs just ahead
# of Sunday's 01:00 enrichment so it applies the fresh seed; soft-skips when the
# feed is unreachable so offline/air-gapped installs keep the bundled seed floor).
$nvSyncAction  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:3000/api/system/sync-eol -H `"Authorization: Bearer $CronSecret`""
$nvSyncTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "00:15"
Register-MaintenanceTask "NetVault-SyncEol" $nvSyncAction $nvSyncTrigger "weekly Sun 00:15"

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
    # GrantNocRoRead runs BEFORE schema.sql — see the NetVault step above for
    # why (security fix, 2026-07): whichever grant runs LAST wins, and
    # schema.sql's own tail end narrows nocvault_readonly off app_settings
    # (secrets: smtp_pass/abuseipdb_api_key) onto an allowlist view instead.
    GrantNocRoRead "logvault"
    # -v ON_ERROR_STOP=1 (added 2026-07-23, mirrors the NetVault/SpanVault steps
    # above): a fresh install must not silently "succeed" with a broken schema -
    # without this flag psql prints a genuine SQL error and keeps going, exiting 0
    # regardless, which is how the users_public/app_settings_public fix on NetVault
    # shipped un-applied for a full release without anyone noticing. schema.sql's
    # own idempotent statements (IF NOT EXISTS/IF EXISTS/OR REPLACE/ON CONFLICT) are
    # not errors on a fresh DB, so this does not affect them - only a genuine SQL
    # error now stops the install.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -v ON_ERROR_STOP=1 -f "$LVAppDir\scripts\schema.sql"
    if ($LASTEXITCODE -ne 0) { throw "LogVault schema.sql failed to apply (exit $LASTEXITCODE) - installation aborted; the append-only tamper-evidence REVOKEs or a partition function may not have applied. Check the psql output above." }
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "GRANT ALL ON SCHEMA public TO logvault_user;"
    # Re-assert the append-only tamper model: the blanket GRANT ALL above re-granted the
    # UPDATE/DELETE that schema.sql deliberately REVOKEs on the hash-chained tables.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "REVOKE UPDATE, DELETE ON syslog_entries FROM logvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d logvault -c "REVOKE UPDATE, DELETE ON audit_log FROM logvault_user;"
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
    & $NssmExe set LogVault-API AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nLV_DB_NAME=logvault`nLV_DB_USER=logvault_user`nLV_DB_PASS=$LVDbPass`nLV_API_PORT=3005`nLV_APP_URL=http://${ServerIP}:3004`nRETENTION_DAYS=90`nLOG_LEVEL=info`nSERVER_IP=$ServerIP`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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

    # GrantNocRoRead runs BEFORE the schema files — see the NetVault step
    # above for why (security fix, 2026-07): whichever grant runs LAST wins,
    # and scripts/schema.sql's own tail end narrows nocvault_readonly off
    # app_settings/api_keys onto allowlist views instead. schema-ipam/
    # -server-auth/-sites.sql never touch nocvault_readonly at all, so
    # running GrantNocRoRead before the whole 4-file sequence is sufficient.
    GrantNocRoRead "ddivault"

    # Run 4 schemas in order
    # -v ON_ERROR_STOP=1 (added 2026-07-23, mirrors the NetVault/LogVault/
    # SpanVault steps above - this DDIVault step was the one missed in that
    # same pass): without this flag psql prints a SQL error and keeps going,
    # exiting 0 regardless, which is how the ddi_servers/smtp_config
    # credential-column REVOKE could silently fail to apply on a fresh
    # install without anyone noticing. Each of the 4 files' own idempotent
    # statements (IF NOT EXISTS/OR REPLACE/ON CONFLICT) are not errors on a
    # fresh DB, so this does not affect them - only a genuine SQL error now
    # aborts the install.
    # --single-transaction (added 2026-07-24, installer-parity fix mirroring
    # Update-DDIVault.ps1's own updater, which gained this same day as part
    # of the resilience-system review): without it, a failure partway through
    # one of these 4 files can leave that file's DDL partially committed on a
    # fresh install, same as on an upgrade. Confirmed (same review) that none
    # of the 4 files use a statement that cannot run inside a transaction
    # (no CREATE INDEX CONCURRENTLY, ALTER TYPE ... ADD VALUE, VACUUM, or
    # CREATE DATABASE) - safe to wrap each file's own apply in one transaction.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -v ON_ERROR_STOP=1 --single-transaction -f "$DDIAppDir\scripts\schema.sql"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault schema.sql failed to apply (exit $LASTEXITCODE) - installation aborted; a security-relevant grant/view (app_settings_public/api_keys_public/smtp_config_public views or the ddi_servers credential-column REVOKE) may not have applied. Check the psql output above." }
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -v ON_ERROR_STOP=1 --single-transaction -f "$DDIAppDir\scripts\schema-ipam.sql"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault schema-ipam.sql failed to apply (exit $LASTEXITCODE) - installation aborted. Check the psql output above." }
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -v ON_ERROR_STOP=1 --single-transaction -f "$DDIAppDir\scripts\schema-server-auth.sql"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault schema-server-auth.sql failed to apply (exit $LASTEXITCODE) - installation aborted; the ddi_servers ps_username/ps_password credential columns may not exist. Check the psql output above." }
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -v ON_ERROR_STOP=1 --single-transaction -f "$DDIAppDir\scripts\schema-sites.sql"
    if ($LASTEXITCODE -ne 0) { throw "DDIVault schema-sites.sql failed to apply (exit $LASTEXITCODE) - installation aborted. Check the psql output above." }
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d ddivault -c "GRANT ALL ON SCHEMA public TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT CONNECT ON DATABASE netvault TO ddivault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT USAGE ON SCHEMA public TO ddivault_user;"
    # `agents` added (Phase 4b): DDIVault's agent-WS ingest does
    # `SELECT 1 FROM agents WHERE id=$1 AND revoked_at IS NULL` against the netvault
    # DB on every agent connect to honour hub revocation. Without this SELECT the
    # ingest fails closed and no agent can connect. Uses the SAME narrow ddivault_user
    # netvault-read role that already reads sites/countries.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT SELECT ON sites, countries, agents TO ddivault_user;"

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
    # $DDIWsEnvLines is either the DDI_WS_TLS_CERT/KEY pair (TLS on) or
    # DDI_WS_ALLOW_PLAINTEXT=1 (cert generation failed in STEP 6.5) - never both.
    $ddiEnv = "DB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nDDI_API_PORT=3007`nDDI_APP_PORT=3006`nDDI_WS_PORT=3011`n$DDIWsEnvLines`nDDI_APP_URL=http://${ServerIP}:3006`nSERVER_IP=$ServerIP`nDHCP_SERVER=`nDNS_SERVER=`nPS_AUTH_MODE=kerberos`nPS_USERNAME=`nPS_PASSWORD=`nPS_TIMEOUT_MS=30000`nDHCP_LOG_UNC=`nDHCP_LOG_LOCAL=`nSCOPE_WARNING_PCT=80`nSCOPE_CRITICAL_PCT=90`nRETENTION_DAYS=90`nNODE_ENV=production`nNEXTAUTH_URL=http://${ServerIP}:3006`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass`nPOSTGRES_PASSWORD=$PgAdminPassword"
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
    # NSSM's AppEnvironmentExtra wins over .env.local (dotenv does not override an
    # already-set process env var), so the WS TLS decision has to be mirrored here
    # or the .env.local copy above is inert.
    & $NssmExe set DDIVault-API AppEnvironmentExtra "NODE_ENV=production`nNEXTAUTH_SECRET=$SharedSecret`nDB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nDDI_API_PORT=3007`nDDI_WS_PORT=3011`n$DDIWsEnvLines`nDDI_APP_URL=http://${ServerIP}:3006`nDDI_APP_PORT=3006`nSERVER_IP=$ServerIP`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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
    & $NssmExe set DDIVault-Collector AppEnvironmentExtra "NODE_ENV=production`nDB_HOST=localhost`nDB_PORT=5432`nDDI_DB_NAME=ddivault`nDDI_DB_USER=ddivault_user`nDDI_DB_PASS=$DDIDbPass`nSCOPE_WARNING_PCT=80`nSCOPE_CRITICAL_PCT=90`nNEXTAUTH_SECRET=$SharedSecret`nPS_AUTH_MODE=kerberos`nPS_TIMEOUT_MS=30000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
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
    # Port 3011 (DDI_WS_PORT) — the agent-WS ingest, bound to all interfaces inside the
    # existing DDIVault-API process (no separate NSSM service). The REST API (3007) stays
    # loopback; this is the only DDIVault port besides the App (3006) that must be inbound.
    New-NetFirewallRule -DisplayName "NocVault DDIVault WS 3011" -Direction Inbound -Protocol TCP -LocalPort 3011 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-OK "Firewall rule added: port 3011 (agent WS ingest)"
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
    # GrantNocRoRead runs BEFORE schema.sql — see the NetVault step above for
    # why (security fix, 2026-07): whichever grant runs LAST wins, and
    # schema.sql's own tail end narrows nocvault_readonly off
    # wireless_controllers' 5 credential columns onto a column-level grant.
    GrantNocRoRead "spanvault"
    # -v ON_ERROR_STOP=1 (added 2026-07-23, mirrors the NetVault step above):
    # a fresh install must not silently "succeed" with a broken schema -
    # without this flag psql prints a SQL error and keeps going, exiting 0
    # regardless, which is how the users_public/app_settings_public fix on
    # NetVault shipped un-applied for a full release without anyone noticing.
    # schema.sql's own idempotent statements (IF NOT EXISTS/IF EXISTS/OR
    # REPLACE/ON CONFLICT) are not errors on a fresh DB, so this does not
    # affect them - only a genuine SQL error now stops the install.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -v ON_ERROR_STOP=1 -f "$SVAppDir\scripts\schema.sql"
    if ($LASTEXITCODE -ne 0) { throw "SpanVault schema.sql failed to apply (exit $LASTEXITCODE) - installation aborted; a security-relevant grant/view (monitored_devices/agents/agent_discovered_devices/app_settings secret exclusions or wireless_controllers) may not have applied. Check the psql output above." }
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d spanvault -c "GRANT ALL ON SCHEMA public TO spanvault_user;"

    # Cross-DB grant: SpanVault reads NetVault for SSO + device sync. Done HERE (not in
    # STEP 7) because netvault's tables don't exist until STEP 8 applies its schema; a
    # premature multi-table GRANT would error out entirely. No 2>$null so a real failure surfaces.
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT CONNECT ON DATABASE netvault TO spanvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT USAGE ON SCHEMA public TO spanvault_user;"
    & "$PgBin\psql.exe" -U postgres -h localhost -p 5432 -d netvault -c "GRANT SELECT ON devices, sites, countries, regions, brands, device_types, vendors, users, user_sites TO spanvault_user;"

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
    # SpanVault-API has no NSSM AppEnvironmentExtra - api/server.js dotenv-loads
    # this file, so .env.local is the ONLY place SV_WS_TLS_* can be set.
    # $SVWsEnvLines is the SV_WS_TLS_CERT/KEY pair, or empty if STEP 6.5 could not
    # mint a certificate (port 3010 then stays plain ws://, as before).
    $svWsBlock = ""
    if ($SVWsEnvLines) { $svWsBlock = $SVWsEnvLines + "`n" }
    $svEnv = "NODE_ENV=production`nSV_APP_PORT=3008`nSV_API_PORT=3009`nSERVER_IP=$ServerIP`nSV_PUBLIC_URL=http://${ServerIP}:3008`nSV_WS_PORT=3010`n${svWsBlock}SV_NSSM_PATH=$NssmExe`nNEXTAUTH_URL=http://${ServerIP}:3008`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass`nSV_DB_HOST=localhost`nSV_DB_PORT=5432`nSV_DB_NAME=spanvault`nSV_DB_USER=spanvault_user`nSV_DB_PASS=$SVDbPass`nPOSTGRES_PASSWORD=$PgAdminPassword"
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
    & curl.exe -s -X POST "http://127.0.0.1:3000/api/system/health-snapshot" -H "Authorization: Bearer $CronSecret" | Out-Null
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
# ── Agent WebSocket TLS fingerprints ──────────────────────────────
# These certificates are self-signed, so there is no chain for an agent to
# validate - the agent pins the SHA-256 fingerprint instead. Print it here (and
# ONLY here) so the operator can carry it into the agent install command.
if (($SVWsTls -and $SVWsTls.Ok) -or ($DDIWsTls -and $DDIWsTls.Ok)) {
    Write-Host "  Agent WebSocket TLS (wss://) - self-signed, pin these fingerprints:" -ForegroundColor White
    if ($SVWsTls -and $SVWsTls.Ok) {
        Write-Host "  SpanVault agent WS TLS fingerprint: $($SVWsTls.Fingerprint)" -ForegroundColor Cyan
        Write-Host "    (pass to the agent installer as -WsFingerprint)" -ForegroundColor Gray
        Write-Host "    cert: $($SVWsTls.Cert)  expires: $($SVWsTls.NotAfter.ToString('yyyy-MM-dd'))" -ForegroundColor Gray
    }
    if ($DDIWsTls -and $DDIWsTls.Ok) {
        Write-Host "  DDIVault agent WS TLS fingerprint: $($DDIWsTls.Fingerprint)" -ForegroundColor Cyan
        Write-Host "    (pass to the agent installer as -WsFingerprintDdi)" -ForegroundColor Gray
        Write-Host "    cert: $($DDIWsTls.Cert)  expires: $($DDIWsTls.NotAfter.ToString('yyyy-MM-dd'))" -ForegroundColor Gray
    }
    Write-Host "  Record these now - re-running the installer REUSES the same certificates," -ForegroundColor Gray
    Write-Host "  and deleting them to regenerate breaks every already-pinned agent." -ForegroundColor Gray
    Write-Host ""
}
Write-Host "  Logs location:" -ForegroundColor White
Write-Host "  NetVault  : $NVDir\logs\" -ForegroundColor Gray
if ($InstallLogVault)  { Write-Host "  LogVault  : $LVAppDir\logs\" -ForegroundColor Gray }
if ($InstallDDIVault)  { Write-Host "  DDIVault  : $DDIAppDir\logs\" -ForegroundColor Gray }
if ($InstallSpanVault) { Write-Host "  SpanVault : $SVAppDir\logs\" -ForegroundColor Gray }
Write-Host ""
