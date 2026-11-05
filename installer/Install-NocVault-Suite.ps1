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
.PARAMETER TlsCertPath
    PEM certificate (leaf + chain) for the shared TLS terminator. Supply this
    AND -TlsKeyPath to front all four consoles with HTTPS. Omit both and the
    installer MINTS a self-signed pair under C:\ProgramData\NocVault\certs, so
    HTTPS is on by default; a real certificate replaces it later from Settings.
.PARAMETER TlsKeyPath
    PEM private key matching -TlsCertPath. Both or neither.
.PARAMETER NoSelfSignedTls
    Do NOT mint a self-signed certificate when none is configured, and install
    on plain HTTP exactly as the suite did before STEP 4b gained the mint.
    The one case this is for: a RE-RUN on a server that already has enrolled
    agents running an agent build that predates self-signed hub support. Those
    agents dial the hub on 3000 - the port the terminator takes over - so the
    cutover would break their control channel until they are updated. A fresh
    install has no agents and does not need this.
.PARAMETER TlsPublicHost
    The hostname users actually type. Optional. When set it pins the terminator's
    X-Forwarded-Host and is used for NEXTAUTH_URL instead of -ServerIP.
.PARAMETER OpenHttpRedirectPorts
    Also open the dedicated plain-HTTP redirect ports (3080/3084/3086/3088).
    Not needed for old http:// bookmarks - the terminator already answers those
    on the TLS port itself - so this is off by default.
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
    [string]$TlsCertPath     = "",
    [string]$TlsKeyPath      = "",
    [string]$TlsPublicHost   = "",
    [switch]$OpenHttpRedirectPorts,
    [switch]$NoSelfSignedTls,
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

# Cryptographically secure random bytes. Get-Random is NOT a CSPRNG - it is
# System.Random, seeded from a time-derived value on PS 5.1 - and these values are
# the PostgreSQL superuser password, NEXTAUTH_SECRET (which signs every cross-app
# SSO token and is the KDF input for DDIVault credential encryption), the LogVault
# tamper-chain HMAC key, and the four per-app DB passwords.
#
# PS 5.1 is Windows PowerShell (.NET Framework), so RandomNumberGenerator::GetInt32()
# and ::Fill() are unavailable - they are .NET Core only. Only the INSTANCE
# GetBytes([byte[]]) exists, so modulo bias has to be handled by the caller.
function Get-SecureBytes([int]$count) {
    $bytes = New-Object byte[] $count
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return $bytes
}
# 32 secure bytes rendered as 64 lowercase hex chars. No bias to handle: each byte
# maps to exactly two hex digits, consuming its full range.
function New-HexSecret([int]$bytes = 32) {
    -join ((Get-SecureBytes $bytes) | ForEach-Object { '{0:x2}' -f $_ })
}

# Generate a random alphanumeric password. Alphanumeric-only is deliberate: the
# values go into SQL string literals, a postgresql://user:PASS@host DATABASE_URL,
# and KEY=VALUE .env files, so they must have no special characters.
#
# The alphabet is 57 characters (ambiguity-stripped: no I/O/l/0/1). 256 is not a
# multiple of 57, so a plain byte % 57 would make the first 28 characters of the
# alphabet very slightly more likely than the rest. Rejection sampling removes that:
# 256 - (256 % 57) = 228, so any byte >= 228 is discarded rather than folded.
function New-Pass([int]$len = 28) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
    $n     = $chars.Length
    $limit = 256 - (256 % $n)
    $out   = New-Object char[] $len
    $i     = 0
    while ($i -lt $len) {
        # Draw in blocks so a rejected byte costs no extra RNG round-trip.
        foreach ($b in (Get-SecureBytes ([Math]::Max(32, $len * 2)))) {
            if ($b -lt $limit) {
                $out[$i] = $chars[$b % $n]
                $i++
                if ($i -ge $len) { break }
            }
        }
    }
    -join $out
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

# ── Shared TLS terminator certificate helper ──────────────────────
# installer\NocVault-Tls.ps1 holds Find-NocVaultOpenSsl / Get-NocVaultCertInfo /
# New-NocVaultCertificate: the self-signed mint for the TERMINATOR's own
# certificate (nocvault.crt / nocvault.key), ported from SecVault. It lives in
# its own file so the logic has one home if a second script ever needs to mint.
#
# ⛔ THE DOT-SOURCE IS GUARDED, NOT MANDATORY. A missing helper must cost the
# install its HTTPS, not the install itself: without it STEP 4b simply finds no
# certificate pair, gate 1 fails, and the suite installs on plain HTTP exactly
# as it always did. The whole installer\ folder ships together (see
# Build-Setup-Exe.ps1's closing note), so absence means somebody shipped a
# partial folder - worth a loud line, not a dead install.
$NocTlsHelperDir = $PSScriptRoot
if (-not $NocTlsHelperDir) {
    if ($PSCommandPath) { $NocTlsHelperDir = Split-Path -Parent $PSCommandPath }
}
#
# ⛔ THE FAILURE IS RECORDED HERE AND REPORTED IN STEP 4b, NOT PRINTED NOW. The
# banner below calls Clear-Host, so anything written at this point is wiped off
# an interactive console before a human reads it - and "the certificate helper
# is missing" is precisely the line that must not be lost.
$script:TlsHelperLoaded = $false
$script:TlsHelperError  = ''
if ($NocTlsHelperDir) {
    $NocTlsHelper = Join-Path $NocTlsHelperDir 'NocVault-Tls.ps1'
    if (Test-Path -LiteralPath $NocTlsHelper) {
        try {
            . $NocTlsHelper
            $script:TlsHelperLoaded = $true
        } catch {
            $script:TlsHelperError = "could not be loaded: $($_.Exception.Message)"
        }
    } else {
        $script:TlsHelperError = "not found at $NocTlsHelper"
    }
} else {
    $script:TlsHelperError = 'this script could not resolve its own folder, so the helper could not be located'
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
# ── Node.js: 22 LTS, not 20 ───────────────────────────────────────
# TWO independent blocking reasons, either of which is sufficient:
#   1. installer\terminator\start.mjs loads nocvault-tls-terminator.ts, which
#      imports lib/tlsConfig.ts. Node executes TypeScript from 22.6 behind
#      --experimental-strip-types and UNFLAGGED from 22.18; Node 20 never
#      received that backport. On Node 20 the terminator REFUSES to start (by
#      design - it will not serve plaintext it cannot prove was intended).
#   2. Node 20 LTS has been end-of-life since April 2026.
# 22.18.0 is the floor rather than 22.6.0 so NSSM does not have to pass an
# experimental flag (which also prints a warning on every single start).
$NodeRequired   = [version]'22.18.0'
# ⛔ THE .msi IS NOT IN THIS REPO. installer\dependencies\ is supplied alongside
# the scripts, so this RESOLVES whatever node-v22.*-x64.msi the operator dropped
# in rather than naming one exact build that would have to be chased on every
# Node release. Highest version at or above $NodeRequired wins.
$NodeMsi        = $null
$nodeMsiFound   = @(Get-ChildItem "$DepsDir\node-v22.*-x64.msi" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^node-v(\d+\.\d+\.\d+)-x64\.msi$' } |
    Where-Object { [version]($_.Name -replace '^node-v([\d\.]+)-x64\.msi$', '$1') -ge $NodeRequired } |
    Sort-Object { [version]($_.Name -replace '^node-v([\d\.]+)-x64\.msi$', '$1') } -Descending)
if ($nodeMsiFound.Count -gt 0) { $NodeMsi = $nodeMsiFound[0].FullName }
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

# Restrict the secrets file to SYSTEM (the NSSM service account) and Administrators,
# same idiom as the WS TLS private key above. Without this it inherits ProgramData's
# ACL, which grants BUILTIN\Users read - verified on the production server 2026-09-01,
# where POSTGRES_PASSWORD (superuser across all four databases) was readable by any
# local user. Nothing legitimate is locked out: this file is installer/updater state
# only and is never read at runtime by an app service - every reader runs elevated or
# as SYSTEM. /inheritance:r first, so the inherited Users ACE is actually removed and
# not merely supplemented. Best-effort like the TLS key, so it never fails an install.
try { & icacls.exe $SecretsFile /inheritance:r /grant '*S-1-5-18:(R)' /grant '*S-1-5-32-544:(F)' | Out-Null } catch {}

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
$CronSecret   = New-HexSecret 32
# LOG_INTEGRITY_KEY keys LogVault's tamper-evident HMAC hash chain (prev_hash/entry_hash
# on syslog_entries). Generated once so the collector's NSSM env and LogVault .env.local
# share one value; if it is unset the chain is silently disabled, so fresh installs must
# set it for the Phase 3 log-integrity feature to work.
# NOTE: drawn from a fresh CSPRNG read, not the same stream as $CronSecret above.
# Under the old Get-Random both came from one time-seeded sequence a few statements
# apart, so recovering either one materially helped predict the other.
$LogIntegrityKey = New-HexSecret 32

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
#
# ⛔ A DEPENDENCY'S INSTALLER IS ONLY REQUIRED WHEN THE DEPENDENCY ITSELF IS
# ABSENT, AND THIS BLOCK USED TO DEMAND ALL THREE UNCONDITIONALLY. That
# contradicted the body of this very script, which already handles each one
# being present:
#
#     "Node.js $nodeVer already installed (>= v$NodeRequired required)"
#     "PostgreSQL already installed"
#     "Git already installed: $gitVer"
#
# So the script was willing to SKIP installing a dependency but refused to START
# without that dependency's installer. On a machine that already satisfies every
# requirement — an existing PostgreSQL 16 the customer wants reused is the
# common case, not a corner — the install exited 1 having done nothing, naming
# files it was never going to run.
#
# ⛔ THE CHECKS BELOW TEST THE CAPABILITY FIRST AND THE FILE ONLY AS A
# FALLBACK, so a genuinely bare machine still gets the same refusal it always
# did. Each probe is wrapped where it invokes a tool (`& node`), because on a
# machine where the tool is truly absent that call raises a TERMINATING
# command-resolution error a bare 2>$null cannot catch — the trap CLAUDE.md
# records as having crashed a fresh install on a clean box.
Write-Step "Validating installer package"
$missing = @()

$nodeOk = $false
try {
    $nv = (& node --version 2>$null)
    if ($nv -and $nv -match 'v([\d\.]+)') { $nodeOk = ([version]$Matches[1] -ge $NodeRequired) }
} catch { $nodeOk = $false }
if (-not $nodeOk -and -not $NodeMsi) {
    $missing += "dependencies\node-v22.<x>.<y>-x64.msi  (ANY Node 22 LTS at or above v$NodeRequired - needed by the TLS terminator, and Node 20 is end-of-life). Node is not installed, or is older than v$NodeRequired."
} elseif ($nodeOk) {
    Write-OK "Node already satisfies v$NodeRequired - its installer is not required"
}

$nssmOk = $false
try { $nssmOk = [bool](Get-Command nssm.exe -ErrorAction SilentlyContinue) } catch { $nssmOk = $false }
if (-not $nssmOk -and (Test-Path 'C:\Windows\System32\nssm.exe')) { $nssmOk = $true }
if (-not $nssmOk -and -not (Test-Path $NssmZip)) {
    $missing += "dependencies\nssm-2.24.zip  (nssm.exe was not found on this machine)"
} elseif ($nssmOk) {
    Write-OK "nssm already present - its archive is not required"
}

$pgOk = [bool]$PgSvcName -and [bool](Get-Service -Name $PgSvcName -ErrorAction SilentlyContinue)
if (-not $pgOk -and -not $PgInstaller) {
    $missing += "dependencies\postgresql-16*windows-x64.exe  (no PostgreSQL service was found on this machine)"
} elseif ($pgOk) {
    Write-OK "PostgreSQL service '$PgSvcName' already present - its installer is not required"
}
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
Write-Step "Installing Node.js (>= v$NodeRequired)"
# On a truly clean machine (node not on PATH), `& node ...` throws a terminating
# "term not recognized" error that `2>$null` does NOT suppress (that redirects the
# native command's stderr stream; here there is no process to redirect from, since
# PowerShell's own command resolution fails first) - wrap in try/catch so a bare
# machine falls through to the msiexec install below instead of crashing the setup.
$nodeVer = try { & node --version 2>$null } catch { $null }

# Compare as a VERSION, not a string. The old check was $nodeVer -eq 'v20.19.0',
# so a machine already running a NEWER Node (anything the customer installed
# themselves) was treated as "wrong version" and had the bundled build reinstalled
# over the top of it on every run - a silent downgrade of someone else's runtime on
# a shared server. Accept anything at or above the required version instead, and
# only install when Node is genuinely absent or genuinely older.
# $NodeRequired (22.18.0) is set in the paths section above, with the reasoning.
$nodeCurrent  = $null
if ($nodeVer -match '^v?(\d+\.\d+\.\d+)') { $nodeCurrent = [version]$Matches[1] }
if ($nodeCurrent -and $nodeCurrent -ge $NodeRequired) {
    Write-OK "Node.js $nodeVer already installed (>= v$NodeRequired required)"
} else {
    # An OLDER Node already on the box is upgraded in place by the MSI. That is a
    # deliberate change of behaviour from the Node 20 era: a Node 20 left here
    # would build and run all four apps perfectly and then silently make the TLS
    # terminator unstartable, which STEP 4b turns into "no HTTPS" rather than an
    # outage - but it is still not what the operator asked for.
    if ($nodeCurrent) { Write-Warn "Node.js $nodeVer is older than v$NodeRequired - upgrading in place" }
    Start-Process -Wait -FilePath "msiexec.exe" -ArgumentList "/I `"$NodeMsi`" /quiet"
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + $env:PATH
    Write-OK "Node.js installed from $([System.IO.Path]::GetFileName($NodeMsi))"
}

# ================================================================
# STEP 4 — Git
# ================================================================
# ⛔ GIT IS INSTALLED BEFORE THE TLS PREFLIGHT, AND THAT ORDER IS NOW
# LOAD-BEARING. Git for Windows carries the openssl.exe that STEP 4b uses to
# mint the terminator's certificate (see Find-NocVaultOpenSsl's path list, and
# Get-WsTlsOpenSsl's, which is the same list). This step used to sit AFTER the
# preflight, which was fine while the preflight only looked for a certificate
# the customer had supplied - but a mint that runs before Git is installed finds
# no openssl on a clean machine and silently produces the plain-HTTP install
# this change exists to end. Nothing in the preflight needs anything else from
# this step, and nothing in this step needs anything from the preflight.
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
# STEP 4b — TLS terminator preflight (mints a certificate; DECIDES the rest)
# ================================================================
# ⛔ READ THIS BEFORE TOUCHING STEP 12.5.
#
# Moving the four consoles onto 127.0.0.1 is what turns the shared terminator
# into a security boundary. It is ALSO the single change in this installer that
# can make an entire customer suite unreachable: loopback consoles plus a
# terminator that did not start means all four web UIs are gone, with no way
# back in except console access to the box.
#
# So the loopback move and the terminator are gated on EACH OTHER, through
# three gates that must ALL hold. This step establishes the first two; it binds
# nothing, writes no service and edits no env file.
#
#   gate 1  a certificate PAIR is configured and both files exist.
#   gate 2  the Node that will run the service can actually execute TypeScript.
#   gate 3  (STEP 12.5) the terminator is PROVEN answering HTTPS on all four
#           public ports, with no "NOT STARTED" banner in its log.
#
# Fail any gate and the suite installs byte-for-byte as it always has: four
# consoles on 0.0.0.0:3000/3004/3006/3008 over plain HTTP, NEXTAUTH_URL http://,
# no NocVault-Tls service. There is no partial state to land in.
#
# ⛔ ONE THING HAPPENS HERE BEFORE ANY GATE IS JUDGED: IF NO CERTIFICATE IS
# CONFIGURED, ONE IS MINTED. That is the ONLY change to this step's behaviour,
# and it is why "the suite installs on plain HTTP" is now the EXCEPTION rather
# than the rule. The reasoning is SecVault's, which has shipped it since its
# v2.112.0: a terminator that engages only when the customer has already
# supplied a certificate engages almost never, so every console in the field
# stayed on plain HTTP - and plain HTTP on an administrator console is a worse
# outcome than a self-signed certificate an operator replaces from Settings.
# The earlier note here argued the opposite (that a self-signed certificate
# "trains every administrator to click through a browser warning, which is
# worse than plain HTTP because it looks safe"). That trade was reconsidered
# deliberately: a browser warning is VISIBLE and fixable, while unencrypted
# session cookies on a flat management LAN are neither.
#
# ⛔ GATE 1 IS STILL BOTH-OR-NEITHER, mirroring lib/tlsConfig.ts exactly, and the
# mint does NOT soften it. One path set alone is a half-finished configuration,
# not a disabled one, and calling it "TLS off" would silently ignore an operator
# who has clearly started turning it on - so a HALF-configured pair is still
# refused and is deliberately NOT completed by minting the missing half, which
# would pair a certificate with a key that does not match it.
#
# ⛔ AND THE MINT NEVER OVERWRITES. New-NocVaultCertificate's first act is to
# succeed without recreating anything when both files are present; that, not a
# condition in this step, is what makes an operator's real corporate
# certificate survive every re-run of this installer.
#
# ⛔ GATE 2 IS DETECTED BY ATTEMPTING IT, NEVER FROM A VERSION TABLE. That is the
# same rule installer\terminator\start.mjs follows, for the same reason: "which
# Node can strip types" (22.6 flagged, 22.18 unflagged, 23.6 unflagged, 20
# never) is a second source of truth that goes stale, and a stale copy of it
# here decides whether a customer's four consoles are reachable.
Write-Step "TLS terminator preflight (certificate + gates 1 and 2)"

# Run a throwaway .ts file and see whether Node accepts it.
#
# The probe file carries a TYPE ANNOTATION on purpose: a .ts that is also valid
# JavaScript would load on a Node that cannot strip types and pass the probe.
#
# try/catch, never a bare 2>$null - on a box where $nodeExe is not a real path,
# PowerShell's own command resolution throws a TERMINATING error before any
# process exists to redirect a stderr stream from (same gotcha as the Node/Git
# "is it installed" checks above). $ErrorActionPreference is assigned inside the
# function, which is function-scoped and reverts on return.
function Test-NodeCanRunTypeScript([string]$nodeExe) {
    $probeDir = Join-Path $env:TEMP ("nocvault-ts-probe-" + [guid]::NewGuid().ToString('N'))
    $ok = $false
    try {
        New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
        $probeFile = Join-Path $probeDir 'probe.ts'
        Set-Content -LiteralPath $probeFile -Encoding ASCII -Value 'const marker: string = "NOCVAULT_TS_OK"; console.log(marker)'
        $ErrorActionPreference = 'Continue'
        # Assign first: PowerShell 5.1 cannot pipe a command directly out of a
        # try block, so the capture and the test are separate statements.
        $probeOut = & $nodeExe $probeFile 2>&1
        $probeExit = $LASTEXITCODE
        $probeText = ($probeOut | Out-String)
        if ($probeExit -eq 0 -and $probeText -match 'NOCVAULT_TS_OK') { $ok = $true }
    } catch {
        $ok = $false
    } finally {
        try {
            if (Test-Path -LiteralPath $probeDir) {
                Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    return $ok
}

$NodeExe            = "C:\Program Files\nodejs\node.exe"
$CertDir            = 'C:\ProgramData\NocVault\certs'
$TlsPublicHostValue = $TlsPublicHost.Trim()
$TlsCert            = $TlsCertPath.Trim()
$TlsKey             = $TlsKeyPath.Trim()

# The convention path is probed so the graphical installer (which cannot pass new
# arguments without an .exe rebuild) can still enable TLS: drop the pair in
# $CertDir as nocvault.crt / nocvault.key before running setup. It is ALSO where
# the self-signed pair is minted, so the GUI install gets HTTPS with no
# arguments at all.
#
# ⛔ THE MINT RUNS ONLY WHEN NEITHER PATH PARAMETER WAS SUPPLIED. An operator who
# passed -TlsCertPath/-TlsKeyPath has made a choice, and a generated certificate
# must never appear beside it; an operator who passed exactly one has made a
# MISTAKE, and the warning below is the right answer to that, not a silent
# repair with a key that matches nothing.
$script:TlsMint = $null
if ((-not $TlsCert) -and (-not $TlsKey)) {
    if ($NoSelfSignedTls) {
        Write-Info "-NoSelfSignedTls was passed - no certificate will be generated."
    } elseif (-not $script:TlsHelperLoaded) {
        Write-Warn "installer\NocVault-Tls.ps1 $($script:TlsHelperError) - no certificate can be minted, so the suite will install on plain HTTP. Ship the whole installer folder together."
    } else {
        # ⛔ Minting is a FILE WRITE under C:\ProgramData\NocVault\certs and
        # nothing else. It binds no port, registers no service and edits no env
        # file, so this step keeps its "decides only" character: a minted
        # certificate that the gates then reject leaves two unused files behind
        # and changes the installed suite not at all.
        $script:TlsMint = New-NocVaultCertificate -CertDir $CertDir -ServerIp $ServerIP -PublicHost $TlsPublicHostValue
        if ($script:TlsMint.Success) {
            if ($script:TlsMint.Created) {
                Write-OK "Self-signed certificate minted: $($script:TlsMint.CertPath)"
                Write-Info "SANs: $($script:TlsMint.SanParts -join ', ')"
                if ($script:TlsMint.NotAfter) { Write-Info "Expires $($script:TlsMint.NotAfter.ToString('yyyy-MM-dd'))" }
            } else {
                Write-OK "Certificate pair already present in $CertDir - reused, NOT regenerated ($($script:TlsMint.Message))"
            }
        } else {
            # Not fatal, by design: no certificate means gate 1 fails below and
            # the suite installs on plain HTTP, which is exactly what it did
            # before this mint existed.
            Write-Warn "No certificate was generated: $($script:TlsMint.Error)"
            Write-Warn "The suite will install on plain HTTP. Fix the cause (usually a missing openssl.exe) or supply -TlsCertPath/-TlsKeyPath, then re-run."
        }
    }

    $defaultCert = Join-Path $CertDir 'nocvault.crt'
    $defaultKey  = Join-Path $CertDir 'nocvault.key'
    if ((Test-Path -LiteralPath $defaultCert) -and (Test-Path -LiteralPath $defaultKey)) {
        $TlsCert = $defaultCert
        $TlsKey  = $defaultKey
        Write-Info "Certificate pair found in $CertDir"
    }
}

$TlsGateOk     = $false
$TlsGateReason = ""
if ((-not $TlsCert) -and (-not $TlsKey)) {
    $TlsGateReason = "No TLS certificate configured (no -TlsCertPath/-TlsKeyPath and no pair in $CertDir). The suite installs on plain HTTP exactly as before."
    Write-Info $TlsGateReason
} elseif ((-not $TlsCert) -or (-not $TlsKey)) {
    $TlsGateReason = "TLS is HALF-configured - only one of -TlsCertPath / -TlsKeyPath was supplied. Set BOTH, or neither. The terminator will NOT be installed and the consoles stay on plain HTTP."
    Write-Warn $TlsGateReason
} elseif (-not (Test-Path -LiteralPath $TlsCert)) {
    $TlsGateReason = "TLS certificate not found at $TlsCert - the terminator will NOT be installed and the consoles stay on plain HTTP."
    Write-Warn $TlsGateReason
} elseif (-not (Test-Path -LiteralPath $TlsKey)) {
    $TlsGateReason = "TLS key not found at $TlsKey - the terminator will NOT be installed and the consoles stay on plain HTTP."
    Write-Warn $TlsGateReason
} elseif (-not (Test-Path -LiteralPath $NodeExe)) {
    $TlsGateReason = "node.exe not found at $NodeExe - cannot prove the runtime executes TypeScript, so the terminator will NOT be installed."
    Write-Warn $TlsGateReason
} elseif (-not (Test-NodeCanRunTypeScript $NodeExe)) {
    $TlsGateReason = "This Node cannot execute TypeScript, so installer\terminator\start.mjs would refuse to start and the consoles would be unreachable behind a dead terminator. Install Node >= v$NodeRequired and re-run. The terminator will NOT be installed."
    Write-Warn $TlsGateReason
} else {
    $TlsGateOk = $true
}

# What is actually on disk, read back from the certificate itself rather than
# from what this run did. $script:TlsCertFingerprint / $script:TlsCertSelfSigned
# are read by the closing summary.
#
# ⛔ "SELF-SIGNED" IS DECIDED BY subject == issuer, NOT BY "did we mint it". A
# re-install reuses the certificate minted by the previous run, so a
# did-I-create-it flag would stop reporting a self-signed certificate as
# self-signed on every run after the first - and the fingerprint line is the
# only thing telling an operator that their agents need a pin.
$script:TlsCertFingerprint = $null
$script:TlsCertSelfSigned  = $false
$script:TlsCertNotAfter    = $null
if ($TlsGateOk -and $script:TlsHelperLoaded) {
    $tlsInfo = Get-NocVaultCertInfo $TlsCert
    if ($tlsInfo.Ok) {
        $script:TlsCertFingerprint = $tlsInfo.Fingerprint
        $script:TlsCertSelfSigned  = $tlsInfo.SelfSigned
        $script:TlsCertNotAfter    = $tlsInfo.NotAfter
    } else {
        # A certificate the installer cannot parse is NOT reported as fine and
        # is NOT treated as a gate failure either: node may still load it
        # perfectly, and gate 3 is the thing that actually settles whether the
        # terminator serves. Say what could not be measured.
        Write-Warn "Could not read certificate details from $TlsCert ($($tlsInfo.Error)) - no fingerprint can be reported for it."
    }
}

if ($TlsGateOk) {
    Write-OK "Gate 1 PASS - certificate pair present ($TlsCert)"
    Write-OK "Gate 2 PASS - this Node executes TypeScript"
    if ($script:TlsCertFingerprint) {
        Write-Info "Certificate SHA-256: $($script:TlsCertFingerprint)"
    }
    if ($script:TlsCertSelfSigned) {
        # ⛔ A CONSTRAINT SECVAULT DOES NOT HAVE. The agents dial the HUB on port
        # 3000 - the same port the terminator takes over - for /api/agents/enroll,
        # /heartbeat, /policy, /update-manifest and /bundle. A CA-issued
        # certificate is transparent to them; a SELF-SIGNED one is not, so an
        # agent that cannot be told to trust this certificate loses its control
        # channel when the cutover lands. The fingerprint above is what it is
        # told. This is stated here AND in the closing summary because an
        # operator scrolling a 20-minute install sees one of the two.
        Write-Warn "This certificate is SELF-SIGNED. Agents dial the hub on :3000, which the terminator takes over, so an agent's hubUrl must become https:// and should pin the fingerprint above (the agent's 'hubFingerprint' config key)."
        Write-Info "Re-running on a server that already has enrolled agents? Their hubUrl is http://, which the terminator answers with a 301 that the agent does not follow. Update them, or pass -NoSelfSignedTls to stay on plain HTTP until you have."
    }
    Write-Info "The consoles still install on 0.0.0.0. They move to 127.0.0.1 only in STEP 12.5, and only after gate 3."
} else {
    Write-Info "TLS terminator will not be installed - continuing with the plain-HTTP install."
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
# ⛔ USE AN EXISTING nssm.exe RATHER THAN DEMANDING THE ARCHIVE. This step
# used to call Expand-Archive unconditionally, so a machine that already had
# nssm still needed dependencies\nssm-2.24.zip on disk — the same
# capability-vs-installer confusion the preflight had, and the preflight's old
# strictness is what hid it: it refused to start without the zip, so the
# unconditional expand could never be reached without one.
#
# Node, PostgreSQL and Git all have an "already installed" branch here. nssm did
# not. It does now, and $NssmExe is repointed at whatever we actually found, so
# every later `& $NssmExe` call works regardless of which path provided it.
if (Test-Path $NssmExe) {
    Write-OK "NSSM already extracted at $NssmExe"
} elseif (Test-Path $NssmZip) {
    Expand-Archive -Path $NssmZip -DestinationPath $NssmDir -Force
    Write-OK "NSSM extracted from the bundled archive"
} else {
    $existing = $null
    try { $existing = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source } catch { $existing = $null }
    if (-not $existing -and (Test-Path 'C:\Windows\System32\nssm.exe')) { $existing = 'C:\Windows\System32\nssm.exe' }
    if ($existing) {
        $NssmExe = $existing
        Write-OK "Using the nssm already on this machine: $NssmExe"
    } else {
        throw "nssm.exe was not found and dependencies\nssm-2.24.zip is missing - cannot register services."
    }
}

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

# ── The tail of NetVault's two env files ──────────────────────────
# ⛔ TLS_CERT_PATH / TLS_KEY_PATH GO IN THE ENV FILES AND **NOT** IN ANY NSSM
# AppEnvironmentExtra - not NetVault's, and not the terminator's. Both are
# lib/envTargets.ts MANAGED_KEYS, i.e. keys Settings writes at runtime, and that
# file records why pinning one is a silent trap: the service environment is read
# at runtime and dotenv never overrides a variable already in process.env, so a
# pinned value wins forever and the Settings save becomes a no-op with no error
# anywhere. Wave one removed NEXTAUTH_URL from three services for exactly this
# and added a convergence step to Update-NetVault.ps1; re-pinning the TLS pair
# here would reintroduce the same bug one process over.
#
# The terminator reaches them anyway and by design: nocvault-tls-terminator.ts's
# loadEnvironment() reads <root>\.env then .next\standalone\.env.local then
# process.env - the SAME two files resolveEnvTargets() writes. So a certificate
# changed from Settings is picked up by the terminator on its next restart with
# no installer involvement at all.
#
# TLS_PUBLIC_HOST is not a MANAGED_KEY today but is the same class of value (an
# operator-changeable deployment fact), and the terminator reads these files
# regardless, so pinning it would buy nothing and cost the same trap later.
#
# Ports are deliberately absent: tlsTerminator.ts's SUITE_UPSTREAMS already
# defaults to exactly 3000/3004/3006/3008 public and 13000/13004/13006/13008
# loopback, which is what this installer configures. A <APP>_HTTPS_PORT /
# <APP>_UPSTREAM_PORT line restating a default is a second place to keep in sync.
$NVEnvTailPairs = @()
if ($NVWsHubPairs.Count) { $NVEnvTailPairs += $NVWsHubPairs }
if ($TlsGateOk) {
    $NVEnvTailPairs += "TLS_CERT_PATH=$TlsCert"
    $NVEnvTailPairs += "TLS_KEY_PATH=$TlsKey"
    if ($TlsPublicHostValue) { $NVEnvTailPairs += "TLS_PUBLIC_HOST=$TlsPublicHostValue" }
}
$NVEnvTail = if ($NVEnvTailPairs.Count) { $NVEnvTailPairs -join "`n" } else { "" }

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
$NVEnvTail
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
$NVEnvTail
"@ | Out-File -FilePath "$NVStandalone\.env.local" -Encoding UTF8 -NoNewline
Write-OK "NetVault standalone .env.local written (incl. SERVER_IP, CRON_SECRET)"

# Register NSSM service
& $NssmExe stop NetVault confirm 2>$null
& $NssmExe remove NetVault confirm 2>$null
& $NssmExe install NetVault "C:\Program Files\nodejs\node.exe" "$NVStandalone\server.js"
& $NssmExe set NetVault AppDirectory        $NVStandalone
# Runtime-settable keys are DELIBERATELY ABSENT from the AppEnvironmentExtra
# below - do not "helpfully" add them back. NEXTAUTH_URL (the console address) is
# changeable at runtime from the app's Settings page, which writes it to the
# .env.local written just above. dotenv/loadEnvConfig never override a variable
# that is ALREADY present in process.env, so any value pinned in the service
# environment wins forever and the Settings write becomes a silent no-op that
# only reappears after a reinstall. The env file is therefore the single
# authority for these keys. What stays here is only what a customer cannot
# change from Settings: PORT/HOSTNAME/NODE_ENV, the DB URL, and the secrets the
# app has no other source for. The same rule will apply to TLS_CERT_PATH /
# TLS_KEY_PATH / ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET once
# Settings manages them - never pin those here either.
# Existing installs: Update-NetVault.ps1 clears these keys out of the service
# environment on upgrade, since NSSM persists them in the registry and a box
# provisioned before this change would otherwise never converge.
& $NssmExe set NetVault AppEnvironmentExtra "PORT=3000`nHOSTNAME=0.0.0.0`nNODE_ENV=production`nDATABASE_URL=postgresql://netvault:$NVDbPass@localhost:5432/netvault`nNEXTAUTH_SECRET=$SharedSecret`nSSL_DISABLED=true`nSERVER_IP=$ServerIP`nCRON_SECRET=$CronSecret`nNOCVAULT_RO_HOST=localhost`nNOCVAULT_RO_PORT=5432`nNOCVAULT_RO_USER=nocvault_readonly`nNOCVAULT_RO_PASS=$NocReadOnlyPass$NVWsHubNssm"
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
# Stop window. NSSM default is 1500ms per stage: it sends a console Ctrl-C event,
# waits, then escalates to WM_CLOSE, then thread termination, then TerminateProcess.
# Node maps that console event to SIGINT (NOT SIGTERM - a SIGTERM-only handler never
# fires under NSSM on Windows), and a service with no handler exits immediately on it,
# so this value is a CEILING rather than a delay - raising it costs nothing for a
# service that shuts down promptly. 1500ms is not enough for a collector that has to
# drain in-flight work before exiting, which is why it is raised here.
& $NssmExe set NetVault AppStopMethodConsole 15000
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
    & $NssmExe set LogVault-Collector AppStopMethodConsole 15000
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
    & $NssmExe set LogVault-API AppStopMethodConsole 15000
    & $NssmExe set LogVault-API AppThrottle         60000

    # NSSM — LogVault-App (uses next.cmd)
    $LVNextCmd = "$LVFrontendDir\node_modules\.bin\next.cmd"
    & $NssmExe stop LogVault-App confirm 2>$null
    & $NssmExe remove LogVault-App confirm 2>$null
    & $NssmExe install LogVault-App $LVNextCmd "start -p 3004"
    & $NssmExe set LogVault-App AppDirectory        $LVFrontendDir
    # NEXTAUTH_URL is deliberately NOT pinned here - it is runtime-settable from
    # Settings and lives in $LVFrontendDir\.env.local (written above), which
    # `next start` loads from its AppDirectory. See the long note on the NetVault
    # service above for why a value here would shadow that file permanently.
    & $NssmExe set LogVault-App AppEnvironmentExtra "NODE_ENV=production`nLV_APP_PORT=3004`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
    & $NssmExe set LogVault-App DependOnService     $PgSvcName
    & $NssmExe set LogVault-App DisplayName         "LogVault - App"
    & $NssmExe set LogVault-App Start               SERVICE_AUTO_START
    & $NssmExe set LogVault-App AppStdout           "$LVAppDir\logs\app.log"
    & $NssmExe set LogVault-App AppStderr           "$LVAppDir\logs\app-err.log"
    & $NssmExe set LogVault-App AppRotateFiles      1
    & $NssmExe set LogVault-App AppRotateBytes      10485760
    & $NssmExe set LogVault-App AppRotateOnline     1
    & $NssmExe set LogVault-App AppRestartDelay     3000
    & $NssmExe set LogVault-App AppStopMethodConsole 15000
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
    & $NssmExe set DDIVault-API AppStopMethodConsole 15000

    # NSSM — DDIVault-App (uses next.cmd)
    $DDINextCmd = "$DDIFrontendDir\node_modules\.bin\next.cmd"
    & $NssmExe stop DDIVault-App confirm 2>$null
    & $NssmExe remove DDIVault-App confirm 2>$null
    & $NssmExe install DDIVault-App $DDINextCmd "start -p 3006"
    & $NssmExe set DDIVault-App AppDirectory        $DDIFrontendDir
    # NEXTAUTH_URL is deliberately NOT pinned here - it is runtime-settable from
    # Settings and lives in $DDIFrontendDir\.env.local (written above), which
    # `next start` loads from its AppDirectory. See the long note on the NetVault
    # service above for why a value here would shadow that file permanently.
    & $NssmExe set DDIVault-App AppEnvironmentExtra "NODE_ENV=production`nNEXTAUTH_SECRET=$SharedSecret`nNOCVAULT_HUB_URL=http://${ServerIP}:3000`nNEXT_PUBLIC_NOCVAULT_HUB_URL=http://${ServerIP}:3000`nNETVAULT_DB_HOST=localhost`nNETVAULT_DB_PORT=5432`nNETVAULT_DB_NAME=netvault`nNETVAULT_DB_USER=netvault`nNETVAULT_DB_PASS=$NVDbPass"
    & $NssmExe set DDIVault-App DependOnService     $PgSvcName
    & $NssmExe set DDIVault-App DisplayName         "DDIVault - App"
    & $NssmExe set DDIVault-App Start               SERVICE_AUTO_START
    & $NssmExe set DDIVault-App AppStdout           "$DDIAppDir\logs\app.log"
    & $NssmExe set DDIVault-App AppStderr           "$DDIAppDir\logs\app-err.log"
    & $NssmExe set DDIVault-App AppRotateFiles      1
    & $NssmExe set DDIVault-App AppRotateBytes      10485760
    & $NssmExe set DDIVault-App AppRotateOnline     1
    & $NssmExe set DDIVault-App AppRestartDelay     3000
    & $NssmExe set DDIVault-App AppStopMethodConsole 15000

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
    & $NssmExe set DDIVault-Collector AppStopMethodConsole 15000
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
    & $NssmExe set SpanVault-API AppStopMethodConsole 15000

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
    & $NssmExe set SpanVault-App AppStopMethodConsole 15000

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
    & $NssmExe set SpanVault-Collector AppStopMethodConsole 15000
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
# STEP 12.5 — Shared TLS terminator + loopback cutover (GATE 3)
# ================================================================
# ⛔ THE ORDER OF THIS STEP IS THE ENTIRE SAFETY ARGUMENT. DO NOT REARRANGE IT,
# AND DO NOT "SIMPLIFY" THE REVERT AWAY.
#
# Everything above this line has already produced a working, fully verified
# plain-HTTP suite on 0.0.0.0. This step is the ONLY place that changes that,
# and it is written as one transaction with exactly two outcomes:
#
#   commit  - all four consoles bound to 127.0.0.1:1300X, NocVault-Tls serving
#             HTTPS on 3000/3004/3006/3008, PROVEN by a real HTTPS GET of each
#             console's /api/health through the terminator.
#   revert  - every console back on 0.0.0.0:300X, NEXTAUTH_URL back to http://,
#             the suite probe URLs back as they were, NocVault-Tls removed
#             entirely. Identical to never having run this step.
#
# It CANNOT half-apply, and the reason is structural rather than careful:
#   * one function (Set-ConsoleTransport) performs BOTH halves - the loopback
#     bind AND the https:// NEXTAUTH_URL - per console, so a scheme mismatch
#     (which bounces every sign-in silently, with no error in any log) cannot
#     be produced by a partial run;
#   * one function (Restore-ConsoleTransport) undoes both from a snapshot taken
#     before anything was touched, and it is called from EVERY failure path -
#     a console that would not restart, a terminator that would not start, a
#     missing HTTPS 200, the banner;
#   * the terminator cannot be left behind by a revert, because the revert
#     stops AND removes the service. A leftover auto-start NocVault-Tls would
#     fight the apps for port 3000 on the next reboot.
#
# ⛔ WHY THE CONSOLES MOVE FIRST AND ARE PROVEN SECOND, RATHER THAN THE REVERSE.
# It would be safer still to prove the terminator before moving anything, and
# it is not possible: the terminator's public ports ARE 3000/3004/3006/3008,
# the ports the four consoles are holding right now. Something has to let go
# first. So the move is made reversible instead of avoidable, and the window in
# which the consoles are not externally reachable is bounded by the health
# polls below - on a fresh install, before any user exists.
#
# ⛔ GATE 3 IS AN HTTPS REQUEST THAT RETURNS 200, NOT "the service says Running".
# NSSM reports Running for a process that bound nothing (start.mjs's own header
# records that exact failure), and the terminator deliberately degrades a broken
# certificate to plain HTTP rather than refusing to start - which would leave
# the consoles reachable but UNENCRYPTED while every check that only looks at
# service state passes. Only bytes off the socket settle it.
#
# Set once, here, and written ONLY on the commit path. STEP 13 and the closing
# summary read it to decide what to verify and which URL scheme to print, so a
# default of $false is what keeps a reverted run from advertising HTTPS.
$script:TlsCutoverApplied = $false

if (-not $TlsGateOk) {
    Write-Step "Shared TLS terminator"
    Write-Info "Not installed. $TlsGateReason"
    Write-Info "Consoles remain on 0.0.0.0:3000/3004/3006/3008 (plain HTTP), NEXTAUTH_URL stays http:// - the shipping configuration."
} else {
    Write-Step "Shared TLS terminator (NocVault-Tls)"

    # ---- helpers (local to this step) -----------------------------------
    # nssm emits UTF-16 and the NULs survive the capture; '' means "could not
    # read", which every caller treats as a reason not to proceed.
    function Get-NssmSetting([string]$nssmExe, [string]$service, [string]$setting) {
        $ErrorActionPreference = 'Continue'
        $raw = ''
        try { $raw = (& $nssmExe get $service $setting 2>&1 | Out-String) } catch { $raw = '' }
        $raw = $raw -replace "`0", ''
        return $raw.Trim()
    }

    # Rewrite one KEY=VALUE in place, leaving every other line untouched.
    # Reads RAW and splits on \r?\n itself: this installer writes these files
    # LF-only, but Settings and any later Add-Content write CRLF, and an
    # anchored regex tested against a line still carrying its trailing \r
    # silently stops matching.
    function Set-EnvFileKey([string]$path, [string]$key, [string]$value) {
        if (-not (Test-Path -LiteralPath $path)) { return $false }
        $raw = ''
        try { $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop) } catch { return $false }
        if ($null -eq $raw) { $raw = '' }
        $lines = @($raw -split "`r?`n")
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) {
                $lines[$i] = "$key=$value"
                $found = $true
            }
        }
        if (-not $found) { $lines = @($lines) + "$key=$value" }
        try { ($lines -join "`n") | Out-File -FilePath $path -Encoding UTF8 -NoNewline } catch { return $false }
        return $true
    }

    function Restart-NocService([string]$service) {
        $ErrorActionPreference = 'Continue'
        $null = & sc.exe stop $service 2>&1
        Start-Sleep -Seconds 4
        $null = & sc.exe start $service 2>&1
        # 1056 = ERROR_SERVICE_ALREADY_RUNNING. NSSM's AppRestartDelay can have
        # relaunched the child already; the health poll is the real verdict, so
        # this is not treated as a failure (same reasoning as Update-NetVault.ps1).
        return $true
    }

    function Wait-HttpOk([string]$url, [int]$timeoutSec) {
        for ($i = 0; $i -lt $timeoutSec; $i++) {
            try {
                $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
                if ($r.StatusCode -eq 200) { return $true }
            } catch {}
            Start-Sleep -Seconds 1
        }
        return $false
    }

    # ⛔ TLS 1.2 IS STATED EXPLICITLY AND THE CERTIFICATE IS DELIBERATELY NOT
    # VALIDATED - both halves are load-bearing.
    #
    # Windows PowerShell 5.1 is .NET Framework, where ServicePointManager
    # defaults to SSL3|TLS1.0. The terminator sets minVersion: 'TLSv1.2', so the
    # handshake fails against a listener that is working perfectly, gate 3 reads
    # that as "no HTTPS" and the whole cutover reverts for no reason. This is the
    # same trap already documented on Update-NetVault.ps1's agent-ingest probe,
    # where the default protocols produced "A call to SSPI failed" and the script
    # concluded the listener was plaintext.
    #
    # Validation is skipped because the question is "is the terminator
    # terminating TLS and is the console behind it answering", not "does this
    # chain to a root this box trusts". The probe dials 127.0.0.1, which no
    # customer certificate will ever name, so a validating probe could only
    # fail. The global callback is saved and restored in finally - it is
    # process-wide state and leaving it permissive would silently weaken every
    # later Invoke-WebRequest in this script.
    function Wait-HttpsOk([string]$url, [int]$timeoutSec) {
        $prevCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        $prevProtocol = [System.Net.ServicePointManager]::SecurityProtocol
        $ok = $false
        try {
            $proto = [System.Net.SecurityProtocolType]::Tls12
            if ([System.Net.SecurityProtocolType].GetEnumNames() -contains 'Tls13') {
                $proto = $proto -bor [System.Net.SecurityProtocolType]::Tls13
            }
            [System.Net.ServicePointManager]::SecurityProtocol = $proto
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            for ($i = 0; $i -lt $timeoutSec; $i++) {
                try {
                    # ⛔ HttpWebRequest, NOT Invoke-WebRequest. MEASURED on Windows 11
                    # / PowerShell 5.1 against this installer's own self-signed
                    # certificate: four clients, same server, same cert, same
                    # moment --
                    #     Invoke-WebRequest      FAILED "The underlying connection
                    #                            was closed: An unexpected error
                    #                            occurred on a send."
                    #     HttpWebRequest         HTTP 200
                    #     curl.exe               200
                    #     TcpClient + SslStream  HTTP/1.1 200 OK
                    # The TLS handshake itself SUCCEEDS in every case (the server
                    # logged "HANDSHAKE OK: TLSv1.2 ECDHE-RSA-AES128-GCM-SHA256"
                    # for the failing client too), so this is not the certificate,
                    # not the cipher suite and not the terminator -- it is
                    # Invoke-WebRequest alone.
                    #
                    # ⛔ AND IT MADE THE WHOLE FEATURE UNREACHABLE. Gate 3 is the
                    # proof that the terminator works; with this probe it could
                    # never return 200, so every install moved the consoles to
                    # loopback, failed the gate, and reverted. The cutover could
                    # not have engaged on ANY Windows box. Found only by running
                    # the install for real -- a parse check cannot see it.
                    $req = [System.Net.HttpWebRequest]::Create($url)
                    $req.Timeout          = 5000
                    $req.ReadWriteTimeout = 5000
                    $req.Method           = 'GET'
                    # Per-request as well as the global above: the global callback
                    # is what Invoke-WebRequest was also relying on, so do not
                    # depend on it alone.
                    $req.ServerCertificateValidationCallback = { $true }
                    $resp = $req.GetResponse()
                    $code = [int]$resp.StatusCode
                    $resp.Close()
                    if ($code -eq 200) { $ok = $true; break }
                } catch {}
                Start-Sleep -Seconds 1
            }
        } finally {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $prevCallback
            [System.Net.ServicePointManager]::SecurityProtocol = $prevProtocol
        }
        return $ok
    }

    # ---- the consoles, and only the consoles ----------------------------
    # The Express APIs (3005/3007/3009), the agent-ingest WebSockets (3010/3011)
    # and all three collectors are NOT touched by any of this. They are not
    # fronted by the terminator and nothing below names them.
    $TlsHost = if ($TlsPublicHostValue) { $TlsPublicHostValue } else { $ServerIP }
    $NVStandaloneDir = "$NVAppDir\.next\standalone"

    $Consoles = @()
    $Consoles += [pscustomobject]@{
        App = 'netvault'; Service = 'NetVault'; Public = 3000; Loopback = 13000
        # ⛔ Next's GENERATED standalone server.js reads
        # `process.env.HOSTNAME || '0.0.0.0'`. PORT alone moves the port and
        # leaves it bound on every interface, so 13000 would be a SECOND
        # publicly reachable plain-HTTP copy of the hub sitting behind the
        # terminator - strictly worse than before this step ran.
        Mode = 'standalone'
        EnvFiles = @("$NVAppDir\.env", "$NVStandaloneDir\.env.local")
    }
    if ($InstallLogVault) {
        $Consoles += [pscustomobject]@{
            App = 'logvault'; Service = 'LogVault-App'; Public = 3004; Loopback = 13004
            Mode = 'next-start'
            EnvFiles = @("$LVAppDir\.env.local", "$LVAppDir\frontend\.env.local")
        }
    }
    if ($InstallDDIVault) {
        $Consoles += [pscustomobject]@{
            App = 'ddivault'; Service = 'DDIVault-App'; Public = 3006; Loopback = 13006
            Mode = 'next-start'
            EnvFiles = @("$DDIAppDir\.env.local", "$DDIAppDir\frontend\.env.local")
        }
    }
    if ($InstallSpanVault) {
        $Consoles += [pscustomobject]@{
            App = 'spanvault'; Service = 'SpanVault-App'; Public = 3008; Loopback = 13008
            Mode = 'next-start'
            EnvFiles = @("$SVAppDir\.env.local", "$SVAppDir\frontend\.env.local")
        }
    }

    # ---- SNAPSHOT (before anything is touched) --------------------------
    # The whole FILE is snapshotted, not just the NEXTAUTH_URL line: this step
    # also rewrites the suite probe URLs into NetVault's two env files, and a
    # verbatim restore puts every one of them back in a single operation with
    # nothing to enumerate and therefore nothing to forget. Same shape as
    # Update-NetVault.ps1's $envBackup / $standaloneEnvBackup.
    Write-Info "Snapshotting console service + env state for an automatic revert"
    $snapshotOk = $true
    foreach ($c in $Consoles) {
        $c | Add-Member -NotePropertyName PrevParams   -NotePropertyValue (Get-NssmSetting $NssmExe $c.Service 'AppParameters')
        $c | Add-Member -NotePropertyName PrevEnvExtra -NotePropertyValue (Get-NssmSetting $NssmExe $c.Service 'AppEnvironmentExtra')
        $files = @{}
        foreach ($f in $c.EnvFiles) {
            if (Test-Path -LiteralPath $f) {
                $txt = $null
                try { $txt = (Get-Content -LiteralPath $f -Raw -ErrorAction Stop) } catch { $txt = $null }
                if ($null -eq $txt) {
                    Write-Warn "Could not read $f - refusing the cutover (a state that cannot be snapshotted cannot be reverted)"
                    $snapshotOk = $false
                } else {
                    $files[$f] = $txt
                }
            }
        }
        $c | Add-Member -NotePropertyName PrevEnvFiles -NotePropertyValue $files
        if ($c.Mode -eq 'standalone') {
            if (-not ($c.PrevEnvExtra -match '(?m)^\s*PORT\s*=')) {
                Write-Warn "NetVault service environment has no PORT entry to move - refusing the cutover"
                $snapshotOk = $false
            }
        } else {
            if (-not ($c.PrevParams -match ('-p\s+' + $c.Public + '(\s|$)'))) {
                Write-Warn "$($c.Service) AppParameters does not contain '-p $($c.Public)' - refusing the cutover rather than guessing its command line"
                $snapshotOk = $false
            }
        }
    }

    # ---- APPLY / REVERT -------------------------------------------------
    function Set-ConsoleTransport($console, [string]$nssmExe, [string]$publicHost) {
        # BOTH halves of one console in one function, on purpose. The bind and
        # the NEXTAUTH_URL scheme are a single fact; splitting them is how a
        # suite ends up serving https while NextAuth believes it is http, which
        # bounces every sign-in back to the login page with nothing logged
        # anywhere to say why.
        if ($console.Mode -eq 'standalone') {
            $lines = @($console.PrevEnvExtra -split "`r?`n" |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
            if ($lines.Count -lt 2) { return $false }
            $out = @()
            $sawPort = $false
            $sawHost = $false
            foreach ($l in $lines) {
                $name = ($l -split '=', 2)[0]
                if ($name -eq 'PORT')     { $out += ("PORT=" + $console.Loopback); $sawPort = $true; continue }
                if ($name -eq 'HOSTNAME') { $out += 'HOSTNAME=127.0.0.1';          $sawHost = $true; continue }
                $out += $l
            }
            if (-not $sawPort) { return $false }
            # HOSTNAME is appended rather than assumed - see the note on the
            # netvault console entry above for why its absence is not benign.
            if (-not $sawHost) { $out += 'HOSTNAME=127.0.0.1' }
            $ErrorActionPreference = 'Continue'
            $null = & $nssmExe set $console.Service AppEnvironmentExtra ($out -join "`n") 2>&1
            if ($LASTEXITCODE -ne 0) { return $false }
        } else {
            $newParams = $console.PrevParams -replace ('-p\s+' + $console.Public + '(?=\s|$)'), ("-p " + $console.Loopback + " -H 127.0.0.1")
            if ($newParams -eq $console.PrevParams) { return $false }
            $ErrorActionPreference = 'Continue'
            $null = & $nssmExe set $console.Service AppParameters $newParams 2>&1
            if ($LASTEXITCODE -ne 0) { return $false }
        }
        foreach ($f in $console.EnvFiles) {
            if (Test-Path -LiteralPath $f) {
                $null = Set-EnvFileKey $f 'NEXTAUTH_URL' ("https://" + $publicHost + ":" + $console.Public)
            }
        }
        return $true
    }

    function Restore-ConsoleTransport($console, [string]$nssmExe) {
        $ErrorActionPreference = 'Continue'
        if ($console.Mode -eq 'standalone') {
            $lines = @($console.PrevEnvExtra -split "`r?`n" |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
            if ($lines.Count -ge 2) { $null = & $nssmExe set $console.Service AppEnvironmentExtra ($lines -join "`n") 2>&1 }
        } elseif ($console.PrevParams) {
            $null = & $nssmExe set $console.Service AppParameters $console.PrevParams 2>&1
        }
        foreach ($f in $console.PrevEnvFiles.Keys) {
            try { $console.PrevEnvFiles[$f] | Out-File -FilePath $f -Encoding UTF8 -NoNewline } catch {}
        }
    }

    # Undo EVERYTHING this step did, including the service itself, and put the
    # consoles back on the air. Called from every failure path below.
    function Undo-TlsCutover([string]$reason, $consoles, [string]$nssmExe) {
        Write-Warn "REVERTING the TLS cutover - $reason"
        $null = & sc.exe stop NocVault-Tls 2>&1
        Start-Sleep -Seconds 2
        $null = & $nssmExe stop NocVault-Tls confirm 2>&1
        $null = & $nssmExe remove NocVault-Tls confirm 2>&1
        # EVERY console, not only the ones this run got as far as changing.
        # Restoring one that was never touched rewrites it with the byte-identical
        # snapshot taken before anything happened, so it is a no-op - and
        # tracking "which ones did I reach" would be one more thing to get
        # wrong on the path that exists to be reliable.
        foreach ($c in $consoles) {
            Restore-ConsoleTransport $c $nssmExe
            $null = Restart-NocService $c.Service
        }
        Start-Sleep -Seconds 5
        $backUp = $true
        foreach ($c in $consoles) {
            if (Wait-HttpOk ("http://127.0.0.1:" + $c.Public + "/api/health") 60) {
                Write-OK "$($c.App) is back on plain HTTP :$($c.Public)"
            } else {
                Write-Warn "$($c.App) did NOT answer http://127.0.0.1:$($c.Public)/api/health after the revert - check $($c.Service) and its log"
                $backUp = $false
            }
        }
        if ($backUp) {
            Write-OK "Revert complete - the suite is in its normal plain-HTTP configuration"
        } else {
            Write-Warn "Revert finished with at least one console not answering. The suite is NOT serving HTTPS; fix the service above before retrying TLS."
        }
    }

    if (-not $snapshotOk) {
        Write-Warn "Pre-cutover snapshot incomplete - the TLS terminator will NOT be installed and nothing has been changed."
    } else {
        # ---- register the service (registered stopped; started below) ----
        $TlsLog    = "$NVDir\logs\nocvault-tls.log"
        $TlsErrLog = "$NVDir\logs\nocvault-tls-error.log"
        # Truncate the previous run's logs so the NOT STARTED banner check below
        # cannot be answered by an old banner from a prior install attempt.
        foreach ($lf in @($TlsLog, $TlsErrLog)) {
            if (Test-Path -LiteralPath $lf) { Remove-Item -LiteralPath $lf -Force -ErrorAction SilentlyContinue }
        }
        $TlsDeps = @()
        foreach ($c in $Consoles) { $TlsDeps += $c.Service }

        & $NssmExe stop NocVault-Tls confirm 2>$null
        & $NssmExe remove NocVault-Tls confirm 2>$null
        & $NssmExe install NocVault-Tls "C:\Program Files\nodejs\node.exe" "$NVAppDir\installer\terminator\start.mjs"
        # AppDirectory is the NetVault repo root, not installer\terminator: the
        # terminator resolves <root>\.env and <root>\.next\standalone\.env.local
        # from its own module path, but every log path, relative import and
        # git-root probe is clearer from the root the rest of the app uses.
        & $NssmExe set NocVault-Tls AppDirectory        $NVAppDir
        # ⛔ NODE_ENV ONLY. The TLS pair, TLS_PUBLIC_HOST and the ports are all
        # ABSENT here and that is deliberate - see the long note at $NVEnvTail
        # above. TLS_CERT_PATH/TLS_KEY_PATH are lib/envTargets.ts MANAGED_KEYS
        # that Settings rewrites at runtime; a value pinned in a service
        # environment is read at runtime and beats any file, so pinning them
        # would make every future certificate change from Settings a silent
        # no-op for the one process that actually terminates TLS. The terminator
        # already reads those two files itself (loadEnvironment()).
        & $NssmExe set NocVault-Tls AppEnvironmentExtra "NODE_ENV=production"
        & $NssmExe set NocVault-Tls DisplayName         "NocVault - TLS Terminator"
        & $NssmExe set NocVault-Tls Description         "NocVault Suite - shared HTTPS front door for all four consoles"
        & $NssmExe set NocVault-Tls Start               SERVICE_AUTO_START
        # The four consoles, so a reboot brings the upstreams up first. This is
        # ordering only - Windows does not wait for an upstream to be READY, and
        # the terminator does not need it to be: a console that is still starting
        # produces a 502 from that one listener, not a failure to bind.
        & $NssmExe set NocVault-Tls DependOnService     ($TlsDeps -join "`n")
        & $NssmExe set NocVault-Tls AppStdout           $TlsLog
        & $NssmExe set NocVault-Tls AppStderr           $TlsErrLog
        & $NssmExe set NocVault-Tls AppRotateFiles      1
        & $NssmExe set NocVault-Tls AppRotateBytes      10485760
        & $NssmExe set NocVault-Tls AppRotateOnline     1
        & $NssmExe set NocVault-Tls AppRestartDelay     3000
        # See the NetVault block for why 15000 and not NSSM's 1500ms default:
        # the terminator tracks and tears down every live socket on stop,
        # including upgraded WebSockets, and must not be killed mid-drain.
        & $NssmExe set NocVault-Tls AppStopMethodConsole 15000
        Write-OK "NocVault-Tls service registered (not started yet)"

        # ---- move the consoles to loopback ------------------------------
        Write-Info "Moving the consoles to 127.0.0.1 and NEXTAUTH_URL to https:// (reversible from here)"
        $moveOk = $true
        foreach ($c in $Consoles) {
            if (Set-ConsoleTransport $c $NssmExe $TlsHost) {
                Write-OK "$($c.App): 127.0.0.1:$($c.Loopback), NEXTAUTH_URL https://${TlsHost}:$($c.Public)"
            } else {
                Write-Warn "$($c.App): could not rewrite $($c.Service) - aborting the cutover"
                $moveOk = $false
                break
            }
        }

        # ---- point the hub's suite probes at the loopback ports ----------
        # app/api/suite/{health,stats} default to http://127.0.0.1:300X, which
        # after the move is the TERMINATOR. A plain-HTTP probe there gets the
        # demux 301 to https, and the follow-up fails certificate validation
        # against 127.0.0.1 - so the launcher's Suite Health and stat tiles
        # would all read "Unavailable". No code change: these env overrides are
        # already honoured.
        if ($moveOk) {
            $probePairs = @{}
            foreach ($c in $Consoles) {
                $probePairs[($c.App.ToUpper() + "_HEALTH_URL")] = ("http://127.0.0.1:" + $c.Loopback + "/api/health")
                # There is no NETVAULT_STATS_URL - the hub reads its own stats
                # in-process and app/api/suite/stats lists only the three
                # satellites.
                if ($c.App -ne 'netvault') {
                    $probePairs[($c.App.ToUpper() + "_STATS_URL")] = ("http://127.0.0.1:" + $c.Loopback + "/api/stats")
                }
            }
            foreach ($f in @("$NVAppDir\.env", "$NVStandaloneDir\.env.local")) {
                if (Test-Path -LiteralPath $f) {
                    foreach ($k in $probePairs.Keys) { $null = Set-EnvFileKey $f $k $probePairs[$k] }
                }
            }
            Write-OK "Suite health/stats probes repointed at the loopback ports"
        }

        if (-not $moveOk) {
            Undo-TlsCutover "a console service could not be reconfigured" $Consoles $NssmExe
        } else {
            # ---- restart the consoles and prove them on loopback ---------
            foreach ($c in $Consoles) { $null = Restart-NocService $c.Service }
            Start-Sleep -Seconds 5
            $loopbackOk = $true
            foreach ($c in $Consoles) {
                if (Wait-HttpOk ("http://127.0.0.1:" + $c.Loopback + "/api/health") 90) {
                    Write-OK "$($c.App) answering on 127.0.0.1:$($c.Loopback)"
                } else {
                    Write-Warn "$($c.App) did NOT answer on 127.0.0.1:$($c.Loopback)"
                    $loopbackOk = $false
                }
            }

            if (-not $loopbackOk) {
                Undo-TlsCutover "a console did not come back up on its loopback port" $Consoles $NssmExe
            } else {
                # ---- start the terminator and prove GATE 3 ---------------
                Write-Info "Starting NocVault-Tls"
                $ErrorActionPreference = 'Continue'
                $null = & sc.exe start NocVault-Tls 2>&1
                Start-Sleep -Seconds 6

                $gate3 = $true
                foreach ($c in $Consoles) {
                    if (Wait-HttpsOk ("https://127.0.0.1:" + $c.Public + "/api/health") 60) {
                        Write-OK "HTTPS 200 for $($c.App) through the terminator on :$($c.Public)"
                    } else {
                        Write-Warn "No HTTPS 200 for $($c.App) on :$($c.Public)"
                        $gate3 = $false
                    }
                }

                # The terminator REFUSES to start (rather than serving
                # plaintext) on a runtime that cannot load lib/tlsConfig.ts, and
                # says so with a named banner. Gate 2 should have caught that
                # case already; this is the belt to its braces, and it also
                # catches the banner appearing for any reason gate 2 could not
                # foresee. Any occurrence fails the cutover.
                $tlsLogText = ""
                foreach ($lf in @($TlsErrLog, $TlsLog)) {
                    if (Test-Path -LiteralPath $lf) {
                        try { $tlsLogText += (Get-Content -LiteralPath $lf -Raw -ErrorAction Stop) } catch {}
                    }
                }
                if ($tlsLogText -match 'NOT STARTED') {
                    Write-Warn "The terminator logged its 'NOT STARTED' banner - it is not serving anything"
                    $gate3 = $false
                }

                $svcTls = Get-Service -Name NocVault-Tls -ErrorAction SilentlyContinue
                if (-not ($svcTls -and $svcTls.Status -eq 'Running')) {
                    Write-Warn "NocVault-Tls is not Running"
                    $gate3 = $false
                }

                if (-not $gate3) {
                    Undo-TlsCutover "the terminator did not prove itself on all four public ports" $Consoles $NssmExe
                } else {
                    $script:TlsCutoverApplied = $true
                    Write-OK "GATE 3 PASS - NocVault-Tls is terminating TLS for every installed console"
                    Write-OK "Consoles are now bound to 127.0.0.1 only; 3000/3004/3006/3008 are the terminator"

                    # ---- re-point the NetVault cron tasks ------------------
                    # ⛔ THE THREE SCHEDULED TASKS POST TO http://127.0.0.1:3000,
                    # which is now the TERMINATOR. curl.exe without -L would
                    # take the demux 301 and do nothing; with -L it would fail
                    # certificate validation against 127.0.0.1. Left alone,
                    # health snapshots, EOL enrichment and the weekly feed sync
                    # all stop silently - no error anywhere, just a trend chart
                    # that never gains a point. Re-registered against the hub's
                    # own loopback port, which is not fronted by anything.
                    $nvCronPort = $Consoles[0].Loopback
                    $snapA = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:$nvCronPort/api/system/health-snapshot -H `"Authorization: Bearer $CronSecret`""
                    Register-MaintenanceTask "NetVault-HealthSnapshot" $snapA (New-ScheduledTaskTrigger -Daily -At "00:00") "daily 00:00"
                    $eolA  = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:$nvCronPort/api/system/enrich-eol -H `"Authorization: Bearer $CronSecret`""
                    Register-MaintenanceTask "NetVault-EnrichEol" $eolA (New-ScheduledTaskTrigger -Daily -At "01:00") "daily 01:00"
                    $syncA = New-ScheduledTaskAction -Execute "curl.exe" -Argument "-s -X POST http://127.0.0.1:$nvCronPort/api/system/sync-eol -H `"Authorization: Bearer $CronSecret`""
                    Register-MaintenanceTask "NetVault-SyncEol" $syncA (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "00:15") "weekly Sun 00:15"
                    Write-OK "NetVault cron tasks re-pointed at 127.0.0.1:$nvCronPort"

                    # ---- firewall ------------------------------------------
                    # 3000/3004/3006/3008 are already open from the per-app
                    # steps above and stay open - same ports, now TLS. Nothing
                    # to add and nothing to remove.
                    #
                    # ⛔ 13000/13004/13006/13008 ARE NEVER OPENED. They are the
                    # consoles themselves, speaking plain HTTP with no
                    # authentication boundary in front of them; a rule here
                    # would hand the world an unencrypted bypass around the
                    # thing this whole step exists to install. They are bound to
                    # 127.0.0.1 as well, so this is the second of two locks.
                    if ($OpenHttpRedirectPorts) {
                        foreach ($c in $Consoles) {
                            $rp = $c.Public + 80
                            New-NetFirewallRule -DisplayName "NocVault TLS redirect $rp" -Direction Inbound -Protocol TCP -LocalPort $rp -Action Allow -ErrorAction SilentlyContinue | Out-Null
                        }
                        Write-OK "Firewall rules added for the dedicated HTTP redirect ports (3080/3084/3086/3088)"
                    } else {
                        Write-Info "Dedicated HTTP redirect ports left closed (old http:// bookmarks are already answered with a 301 on the TLS port itself). Pass -OpenHttpRedirectPorts to open them."
                    }
                }
            }
        }
    }
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
# Only when the cutover actually committed. A reverted run removed the service,
# so listing it unconditionally would report a failure for a suite that is
# correctly and deliberately serving plain HTTP.
if ($script:TlsCutoverApplied) { $services += "NocVault-Tls" }

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
# The scheme printed here is read off what actually happened, never off the
# -TlsCertPath argument: a run whose cutover reverted is serving plain HTTP, and
# printing https:// for it would send the operator to a port that refuses the
# handshake and then be blamed on the certificate.
if ($script:TlsCutoverApplied) {
    $AccessScheme = "https"
    $AccessHost   = if ($TlsPublicHostValue) { $TlsPublicHostValue } else { $ServerIP }
} else {
    $AccessScheme = "http"
    $AccessHost   = $ServerIP
}
Write-Host "  Access your applications:" -ForegroundColor White
Write-Host "  NocVault Hub : ${AccessScheme}://${AccessHost}:3000  (login here)" -ForegroundColor Cyan
Write-Host "  NetVault     : ${AccessScheme}://${AccessHost}:3000" -ForegroundColor Cyan
if ($InstallLogVault)  { Write-Host "  LogVault     : ${AccessScheme}://${AccessHost}:3004" -ForegroundColor Cyan }
if ($InstallDDIVault)  { Write-Host "  DDIVault     : ${AccessScheme}://${AccessHost}:3006" -ForegroundColor Cyan }
if ($InstallSpanVault) { Write-Host "  SpanVault    : ${AccessScheme}://${AccessHost}:3008" -ForegroundColor Cyan }
if ($script:TlsCutoverApplied) {
    Write-Host ""
    Write-Host "  TLS: NocVault-Tls terminates HTTPS on 3000/3004/3006/3008 for all four" -ForegroundColor Cyan
    Write-Host "       consoles. The apps themselves are bound to 127.0.0.1 only. An old" -ForegroundColor Gray
    Write-Host "       http:// bookmark on those ports is answered with a 301." -ForegroundColor Gray
    Write-Host "       Certificate: $TlsCert" -ForegroundColor Gray
    if ($script:TlsCertNotAfter) {
        Write-Host "       Expires: $($script:TlsCertNotAfter.ToString('yyyy-MM-dd'))" -ForegroundColor Gray
    }
    if ($script:TlsCertSelfSigned) {
        Write-Host "       This certificate is SELF-SIGNED, so browsers will warn on first visit." -ForegroundColor Yellow
        Write-Host "       That is the shipping default: HTTPS with a warning beats plain HTTP" -ForegroundColor Gray
        Write-Host "       on an administrator console. Install the organisation's own" -ForegroundColor Gray
        Write-Host "       certificate from Settings to clear it - the installer will NEVER" -ForegroundColor Gray
        Write-Host "       overwrite a certificate that is already in place." -ForegroundColor Gray
    }
    Write-Host "       To change it later use Settings (it rewrites TLS_CERT_PATH /" -ForegroundColor Gray
    Write-Host "       TLS_KEY_PATH in NetVault's env files) and restart NocVault-Tls." -ForegroundColor Gray
}
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
# ── Shared terminator certificate fingerprint ─────────────────────
# ⛔ PRINTED BECAUSE THE AGENTS DIAL THE HUB ON THE PORT THE TERMINATOR TOOK
# OVER. 3000 carries /api/agents/enroll, /heartbeat, /policy, /update-manifest
# and /bundle as well as the console, so a self-signed certificate in front of
# it is a fact about the agent fleet, not only about browsers. The agent has no
# chain to validate, exactly as with the two agent-ingest certificates below,
# so it is pinned by SHA-256 fingerprint and this is where the operator gets it.
#
# ⛔ PRINTED, NOT WRITTEN INTO AN ENV FILE. The WS fingerprints are also
# persisted (SPANVAULT_WS_FINGERPRINT / DDIVAULT_WS_FINGERPRINT) because
# app/api/agents/enroll-tokens/route.ts READS them to bake -WsFingerprint into
# the install command it hands out. Nothing reads a hub-certificate fingerprint
# yet, and this repo has a documented history of configuration that nothing
# reads being mistaken for configuration that works. When the agent side grows
# a hub pin and the enroll-token route grows the matching env key, persist it
# here in the SAME change - until then, printing it is the honest surface.
if ($script:TlsCutoverApplied -and $script:TlsCertSelfSigned -and $script:TlsCertFingerprint) {
    Write-Host "  Hub/console TLS (HTTPS on 3000/3004/3006/3008) - self-signed, pin this:" -ForegroundColor White
    Write-Host "  Terminator certificate SHA-256: $($script:TlsCertFingerprint)" -ForegroundColor Cyan
    Write-Host "    cert: $TlsCert" -ForegroundColor Gray
    Write-Host "    Agents reach the hub on :3000 THROUGH this certificate, so their hubUrl" -ForegroundColor Gray
    Write-Host "    must be https://${AccessHost}:3000 and 'hubFingerprint' in the agent's" -ForegroundColor Gray
    Write-Host "    config.json should carry the value above. Without the pin the channel is" -ForegroundColor Gray
    Write-Host "    encrypted but unauthenticated; with an http:// hubUrl it stops working." -ForegroundColor Gray
    Write-Host ""
}
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
