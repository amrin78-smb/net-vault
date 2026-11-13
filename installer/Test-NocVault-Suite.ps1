<#
================================================================
  NocVault Suite - Post-Install Smoke Test  (v2.3)
  Run this ON THE SERVER/LAPTOP where the suite was installed.

  WHAT IT CHECKS
    1. Environment (psql / node present, server IP, DB connect)
    2. Windows services (all 10 NSSM services Running)
    3. TCP/UDP ports listening
   3b. Agent WebSocket TLS: self-signed certs on disk, SV_/DDI_WS_TLS_* wired
       into the env each app reads, 3010/3011 listening, cert SAN covers the
       server IP, expiry runway, and DDI_WS_ALLOW_PLAINTEXT no longer set
   3c. Shared TLS terminator (NocVault-Tls), when the suite is TLS-fronted:
       the service runs, every console answers HTTPS /api/health through it,
       a plaintext request to a TLS port is answered 301, the consoles are on
       127.0.0.1 only, no loopback port is open in the firewall, NEXTAUTH_URL
       is https:// in every env file, and the terminator logged no
       "NOT STARTED" banner. On a plain-HTTP suite the section reports that and
       checks nothing further - that is a supported configuration, not a fault
    4. HTTP health + deployed versions for all 4 apps: /api/health must report
       the SAME version as that app's own root package.json on disk (catches a
       service still serving an older build than its checkout), plus a coarse
       floor for a checkout that is itself ancient
    5. Public endpoints + launcher performance (suite probes, cache, license)
    6. NextAuth / login smoke (best-effort)
    7. Scheduled tasks (the 3 NetVault cron tasks): enabled with a live trigger,
       posting to the port the console really listens on, with a Bearer token
       that matches the live CRON_SECRET
    8. Firewall rules (NocVault*)
    9. Database deep checks (schema, the 3 bug-fixes, tamper model, grants, seed,
       Hub cross-DB reads incl. column-level grants, and the credential/secret
       exclusions -- readonly role blocked from secret columns + *_public views)
   10. COLLECTORS:
        - LogVault : live synthetic syslog packet -> confirm it lands in the DB
                     (full pipeline: socket -> parser -> taxonomy -> DB) AND that
                     the row it wrote is hash-chained (tamper evidence is on)
        - SpanVault: ping/SNMP poll heartbeat (recent rows)
        - DDIVault : poll heartbeat (server_health_history) / liveness
        - crash-pattern scan of every collector error log

  HOW TO RUN  (Administrator PowerShell):
      powershell -ExecutionPolicy Bypass -File .\Test-NocVault-Suite.ps1

  Prompts once for the PostgreSQL 'postgres' password (DB + collector checks).
    -SkipDb               skip all DB/collector-DB checks (no password)
    -TestLogin            attempt a real login with default admin creds
    -InstallDir <path>    app root (default C:\Apps)
    -ServerIP / -PgPassword   pass inline to avoid prompts
================================================================
#>
# Requires elevation: this script reads C:\ProgramData\NocVault\secrets.env, which is
# restricted to SYSTEM + Administrators by the installer. It also queries service state.
# Without this the script still RUNS unelevated but silently degrades - it cannot read
# the secrets file and falls through to prompting for the postgres password.
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$ServerIP = "",
    [string]$PgPassword = "",
    [string]$InstallDir = "C:\Apps",
    [switch]$SkipDb,
    [switch]$TestLogin
)

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

# ---- counters / output helpers --------------------------------
$script:Pass = 0; $script:Fail = 0; $script:Warn = 0
$script:Failures = @()
$script:PgExit = 0
$script:DbReady = $false

function Section($t) { Write-Host ""; Write-Host ("=" * 64) -ForegroundColor Cyan; Write-Host "  $t" -ForegroundColor Cyan; Write-Host ("=" * 64) -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ PASS ] $m" -ForegroundColor Green; $script:Pass++ }
function Bad($m)  { Write-Host "  [ FAIL ] $m" -ForegroundColor Red;   $script:Fail++; $script:Failures += $m }
function Wn($m)   { Write-Host "  [ WARN ] $m" -ForegroundColor Yellow; $script:Warn++ }
function Inf($m)  { Write-Host "  [ INFO ] $m" -ForegroundColor Gray }

# ---- PostgreSQL password auto-discovery -----------------------
function Get-EnvVal([string]$file, [string]$key) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)) {
        if ($line -match "^\s*$([regex]::Escape($key))\s*=\s*(.+?)\s*$") { return $Matches[1].Trim() }
    }
    return $null
}
# Does this password actually authenticate as the postgres superuser?
# Uses $script:Psql, which is resolved further down but well before the only
# caller of Resolve-PgPassword (PowerShell binds $script: variables at call time).
function Test-PgSuperuserPassword([string]$pw) {
    if (-not $pw) { return $false }
    if (-not $script:Psql) { return $false }
    $had  = Test-Path Env:\PGPASSWORD
    $prev = if ($had) { $env:PGPASSWORD } else { $null }
    $env:PGPASSWORD = $pw
    try {
        & $script:Psql -U postgres -h localhost -p 5432 -tAc "SELECT 1" 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        if ($had) { $env:PGPASSWORD = $prev } else { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    }
}

# ⛔ EVERY CANDIDATE IS TESTED - see the long note on the identical function in
# Uninstall-NocVault-Suite.ps1. In short: secrets.env is first in this list but
# its POSTGRES_PASSWORD is not guaranteed to be the cluster's, because an install
# onto a pre-existing PostgreSQL takes the real password from -PgAdminPassword.
# Returning the first value FOUND rather than the first value that WORKS made
# this script report "Cannot connect as postgres" - and skip every schema, grant
# and collector-DB check - on a suite that was perfectly healthy.
function Resolve-PgPassword([string]$installDir) {
    $candidates = @(
        'C:\ProgramData\NocVault\secrets.env',
        (Join-Path $installDir 'NetVault\app\.env'),
        (Join-Path $installDir 'LogVault\app\.env.local'),
        (Join-Path $installDir 'DDIVault\app\.env.local'),
        (Join-Path $installDir 'SpanVault\app\.env.local'),
        # Installs whose repo root IS the install root (no 'app' subfolder).
        (Join-Path $installDir 'LogVault\.env.local'),
        (Join-Path $installDir 'DDIVault\.env.local'),
        (Join-Path $installDir 'SpanVault\.env.local')
    )
    foreach ($f in $candidates) {
        $v = Get-EnvVal $f 'POSTGRES_PASSWORD'
        if ($v -and (Test-PgSuperuserPassword $v)) {
            return [pscustomobject]@{ Password = $v; Source = $f }
        }
    }
    return $null
}

function VerGE($got, $min) { try { return ([version]$got -ge [version]$min) } catch { return $false } }

function Http($url, [int]$timeoutSec = 15, [switch]$NoRedirect) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # ⛔ HttpWebRequest, NOT Invoke-WebRequest. Measured on Windows 11 /
        # PowerShell 5.1: Invoke-WebRequest cannot complete a request to a node
        # https server presenting a self-signed certificate, while
        # HttpWebRequest, curl.exe and a raw SslStream all return 200 from the
        # same server. The handshake itself succeeds, so it is the client.
        # Left unfixed, every HTTPS check in this script would report a healthy
        # TLS suite as DOWN - a test that fails on working software is worse
        # than no test, because the next person deletes it.
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Timeout          = $timeoutSec * 1000
        $req.ReadWriteTimeout = $timeoutSec * 1000
        $req.Method           = 'GET'
        $req.ServerCertificateValidationCallback = { $true }
        if ($NoRedirect) { $req.AllowAutoRedirect = $false }
        $raw = $req.GetResponse()
        $body = ''
        try {
            $sr = New-Object System.IO.StreamReader($raw.GetResponseStream())
            $body = $sr.ReadToEnd(); $sr.Close()
        } catch {}
        $r = [pscustomobject]@{
            StatusCode = [int]$raw.StatusCode
            Content    = $body
            Headers    = @{ Location = $raw.Headers['Location'] }
        }
        $raw.Close()
        $sw.Stop()
        return [pscustomobject]@{ Code = [int]$r.StatusCode; Content = $r.Content; Ms = $sw.ElapsedMilliseconds; Loc = $r.Headers.Location; Err = $null }
    } catch {
        $sw.Stop()
        $code = $null; $loc = $null
        if ($_.Exception.Response) {
            try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            try { $loc  = $_.Exception.Response.Headers["Location"] } catch {}
        }
        return [pscustomobject]@{ Code = $code; Content = $null; Ms = $sw.ElapsedMilliseconds; Loc = $loc; Err = $_.Exception.Message }
    }
}

# HTTPS variant of Http, for probing the TLS terminator.
#
# ⛔ TLS 1.2 IS STATED EXPLICITLY AND THE CERTIFICATE IS DELIBERATELY NOT
# VALIDATED. Windows PowerShell 5.1 is .NET Framework, where
# ServicePointManager defaults to SSL3|TLS1.0; the terminator sets
# minVersion 'TLSv1.2' and refuses them, so a default-protocol probe fails
# against a listener that is working perfectly - the same trap recorded on
# Update-NetVault.ps1's agent-ingest probe ("A call to SSPI failed", measured
# on the production server 2026-09-01). Validation is skipped because this
# dials 127.0.0.1, which no customer certificate will ever name; a failure to
# validate here would say nothing about whether the customer's chain is good.
# Both globals are saved and restored - they are process-wide, and leaving the
# callback permissive would quietly weaken every later probe in this script.
function Https($url, [int]$timeoutSec = 15) {
    $prevCb    = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    $prevProto = [System.Net.ServicePointManager]::SecurityProtocol
    try {
        $proto = [System.Net.SecurityProtocolType]::Tls12
        if ([System.Net.SecurityProtocolType].GetEnumNames() -contains 'Tls13') {
            $proto = $proto -bor [System.Net.SecurityProtocolType]::Tls13
        }
        [System.Net.ServicePointManager]::SecurityProtocol = $proto
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        return (Http $url $timeoutSec)
    } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $prevCb
        [System.Net.ServicePointManager]::SecurityProtocol = $prevProto
    }
}

# psql scalar helper (set after psql is located + PGPASSWORD set)
function Pg($db, $sql) {
    $out = & $script:Psql -U postgres -h 127.0.0.1 -p 5432 -d $db -tAc $sql 2>&1
    $script:PgExit = $LASTEXITCODE
    return ($out | Out-String).Trim()
}

# ===============================================================
Section "NocVault Suite Smoke Test (v2.3)"
Inf ("Run time : " + (Get-Date))
Inf ("Host     : " + $env:COMPUTERNAME)
Inf ("InstallDir: " + $InstallDir)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Wn "Not running as Administrator - run elevated for full firewall/task/log access." }

if (-not $ServerIP) {
    try {
        $ServerIP = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
            Select-Object -First 1).IPAddress
    } catch {}
}
if (-not $ServerIP) { $ServerIP = "127.0.0.1" }
Inf ("Server IP: " + $ServerIP)

# ---------------------------------------------------------------
Section "1. Environment"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Ok ("node present: " + (& node --version 2>$null)) } else { Wn "node not on PATH (ok if services run; build/runtime use full paths)" }

$script:Psql = $null
foreach ($p in @("C:\Program Files\PostgreSQL\16\bin\psql.exe","C:\Program Files\PostgreSQL\17\bin\psql.exe","C:\Program Files\PostgreSQL\15\bin\psql.exe")) {
    if (Test-Path $p) { $script:Psql = $p; break }
}
if (-not $script:Psql) { $c = Get-Command psql -ErrorAction SilentlyContinue; if ($c) { $script:Psql = $c.Source } }
if ($script:Psql) { Ok ("psql found: " + $script:Psql) } else { Wn "psql.exe not found - DB + collector-DB checks will be skipped" }

$pgsvc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if ($pgsvc -and $pgsvc.Status -eq "Running") { Ok ("PostgreSQL service running: " + $pgsvc.Name) } else { Bad "PostgreSQL service not running" }

# DB connection setup (shared by sections 9 + 10)
if (-not $SkipDb -and $script:Psql) {
    if (-not $PgPassword) {
        $resolved = Resolve-PgPassword $InstallDir
        if ($resolved) {
            $PgPassword = $resolved.Password
            Inf "Using the PostgreSQL password from $($resolved.Source)."
        } else {
            $sec = Read-Host "Enter PostgreSQL 'postgres' password" -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
            $PgPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        }
    }
    $env:PGPASSWORD = $PgPassword
    $ping = Pg "postgres" "SELECT 1;"
    if ($script:PgExit -eq 0 -and $ping -eq "1") { $script:DbReady = $true; Ok "Connected to PostgreSQL as postgres" }
    else { Bad ("Cannot connect as postgres (" + $ping + ") - DB + collector-DB checks limited") }
} else {
    Inf "DB checks disabled (-SkipDb or no psql)"
}

# ---------------------------------------------------------------
Section "2. Windows Services (expect all Running)"
$services = @("NetVault",
              "LogVault-Collector","LogVault-API","LogVault-App",
              "DDIVault-API","DDIVault-App","DDIVault-Collector",
              "SpanVault-API","SpanVault-App","SpanVault-Collector")
foreach ($s in $services) {
    $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
    if (-not $svc) { Bad "$s : NOT INSTALLED" }
    elseif ($svc.Status -eq "Running") {
        $st = (Get-Service -Name $s).StartType
        if ($st -ne "Automatic") { Wn "$s : Running but StartType=$st (should be Automatic to survive reboot)" }
        else { Ok "$s : Running (Automatic)" }
    }
    else { Bad ("$s : " + $svc.Status) }
}

# LogVault's in-app update needs the API to resolve a server IP. The LogVault-API
# PROCESS env = NSSM AppEnvironmentExtra UNION the root .env.local it loads via
# dotenv (override:false), so SERVER_IP from EITHER source reaches the process.
# Check both (NSSM env OR .env.local); only fail if neither has it.
# ⛔ NSSM IS NOT ALWAYS THE COPY THIS INSTALLER DOWNLOADED. When nssm.exe is
# already on the machine (on PATH, or in System32 - a common state on a server
# that has run other NSSM-managed software), the installer USES that one and
# never creates a bundled copy. Looking only in the bundled locations then left
# $nssm $null, and because every service-environment read in this script is
# guarded by `if ($nssm)`, the script could not read ANY service environment -
# it just silently skipped them and fell through to defaults.
# MEASURED on Windows staging 2026-11-09, where nssm lives in System32: a
# correct, fully TLS-fronted fresh install reported NINE failures, including
# "the suite is HALF cut over" and "every sign-in will bounce silently", on a
# suite that was serving HTTPS perfectly. A test that fails on working software
# is worse than no test - the same rule the Http helper below was written for.
$nssm = $null
foreach ($n in @("$InstallDir\NetVault\nssm\nssm-2.24\win64\nssm.exe",
                 "C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe",
                 "$InstallDir\nssm\nssm-2.24\win64\nssm.exe",
                 "$env:SystemRoot\System32\nssm.exe",
                 "$env:SystemRoot\nssm.exe")) {
    if (Test-Path $n) { $nssm = $n; break }
}
if (-not $nssm) {
    $nssmCmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($nssmCmd) { $nssm = $nssmCmd.Source }
}
if ($nssm) { Inf ("nssm: " + $nssm) }
else { Wn "nssm.exe not found (bundled paths, System32, or PATH) - every service-environment check below is UNVERIFIED, not passed" }
$lvApiEnv = ""
if ($nssm) { $lvApiEnv = (& $nssm get LogVault-API AppEnvironmentExtra 2>$null | Out-String) }
$lvEnvFile   = Join-Path $InstallDir "LogVault\app\.env.local"
$lvFileHasIp = (Test-Path $lvEnvFile) -and (Select-String -Path $lvEnvFile -Pattern 'SERVER_IP=' -SimpleMatch -Quiet)
if ($lvApiEnv -match "SERVER_IP") { Ok "LogVault-API resolves SERVER_IP from NSSM service env (in-app update OK)" }
elseif ($lvFileHasIp)             { Ok "LogVault-API resolves SERVER_IP from .env.local via dotenv (in-app update OK)" }
elseif (-not $nssm -and -not (Test-Path $lvEnvFile)) { Wn "Cannot verify LogVault-API SERVER_IP (nssm + .env.local both unreadable)" }
else { Bad "LogVault-API has no SERVER_IP in NSSM env or .env.local - LogVault in-app update may fail" }

# ---------------------------------------------------------------
Section "3. Ports Listening"
$tcpPorts = @{
    3000 = "NetVault / Hub (public)"; 3004 = "LogVault-App (public)"; 3005 = "LogVault-API (internal)";
    3006 = "DDIVault-App (public)";   3007 = "DDIVault-API (internal)"; 3011 = "DDIVault WS (agent ingest, public)";
    3008 = "SpanVault-App (public)";  3009 = "SpanVault-API (internal)"; 3010 = "SpanVault WS (internal)";
    5432 = "PostgreSQL (internal)"
}
foreach ($port in ($tcpPorts.Keys | Sort-Object)) {
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listen) { Ok ("TCP $port LISTEN - " + $tcpPorts[$port]) } else { Bad ("TCP $port NOT listening - " + $tcpPorts[$port]) }
}
foreach ($uport in @(514, 1514)) {
    $u = Get-NetUDPEndpoint -LocalPort $uport -ErrorAction SilentlyContinue
    if ($u) { Ok "UDP $uport bound - LogVault syslog" } else { Bad "UDP $uport NOT bound - LogVault syslog collector" }
}

# ---------------------------------------------------------------
Section "3b. Agent WebSocket TLS (wss:// on 3010 / 3011)"
# The common NocVault agent ships DECRYPTED credentials over these two ingest
# sockets, so both must terminate wss://. The installer mints a SELF-SIGNED cert
# per app under C:\ProgramData\NocVault\certs and points the app's env at it.
# Checked here: the PEM pair exists and parses, the env vars are set where each
# app actually reads them, the ports listen, and - critically - DDIVault's
# cleartext opt-out DDI_WS_ALLOW_PLAINTEXT is GONE (it defeats the guard in
# api/ws-server.js, so leaving it behind silently keeps the ingest plaintext-capable).
$certDir = 'C:\ProgramData\NocVault\certs'

# SHA-256 over the DER - the same value Node reports as fingerprint256 and the
# agent pins on. Returns $null if the file is missing or not a parsable PEM.
function WsCertInfo([string]$certPath) {
    if (-not (Test-Path -LiteralPath $certPath)) { return $null }
    try {
        $pem = Get-Content -LiteralPath $certPath -Raw
        $b64 = ($pem -replace '-----BEGIN CERTIFICATE-----','' -replace '-----END CERTIFICATE-----','') -replace '\s',''
        $der = [Convert]::FromBase64String($b64)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $fp  = (($sha.ComputeHash($der) | ForEach-Object { $_.ToString('X2') }) -join ':')
        $x   = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$der)
        $san = (($x.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ' ')
        return [pscustomobject]@{ Fingerprint = $fp; NotAfter = $x.NotAfter; San = $san }
    } catch { return $null }
}

# The env a service actually sees = NSSM AppEnvironmentExtra UNION the .env.local
# it dotenv-loads. dotenv does NOT override an already-set process var, so NSSM
# wins on a conflict - check BOTH sources for every var below.
function WsSvcEnv([string]$service) {
    if (-not $nssm) { return "" }
    $raw = ""
    try { $raw = (& $nssm get $service AppEnvironmentExtra 2>$null | Out-String) } catch { $raw = "" }
    return ($raw -replace "`0", '')
}
function WsEnvFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return "" }
    try { return (Get-Content -LiteralPath $path -Raw) } catch { return "" }
}

$svEnvFile   = Join-Path $InstallDir "SpanVault\app\.env.local"
$ddiEnvFile  = Join-Path $InstallDir "DDIVault\app\.env.local"
$svApiEnv    = WsSvcEnv 'SpanVault-API'
$ddiApiEnv   = WsSvcEnv 'DDIVault-API'
$svEnvText   = WsEnvFile $svEnvFile
$ddiEnvText  = WsEnvFile $ddiEnvFile

foreach ($t in @(
    @{ App='spanvault'; Label='SpanVault'; Port=3010; CertVar='SV_WS_TLS_CERT';  KeyVar='SV_WS_TLS_KEY';  Env=($svApiEnv  + "`n" + $svEnvText)  },
    @{ App='ddivault';  Label='DDIVault';  Port=3011; CertVar='DDI_WS_TLS_CERT'; KeyVar='DDI_WS_TLS_KEY'; Env=($ddiApiEnv + "`n" + $ddiEnvText) }
)) {
    $crt = Join-Path $certDir ($t.App + "-ws.crt")
    $key = Join-Path $certDir ($t.App + "-ws.key")
    $info = WsCertInfo $crt

    if ($info -and (Test-Path -LiteralPath $key)) {
        Ok ($t.Label + " WS cert + key present: " + $crt)
        Inf ($t.Label + " WS TLS fingerprint: " + $info.Fingerprint)
        $daysLeft = [int]([math]::Floor(($info.NotAfter - (Get-Date)).TotalDays))
        if ($daysLeft -lt 0)        { Bad ($t.Label + " WS cert EXPIRED on " + $info.NotAfter.ToString('yyyy-MM-dd') + " - every pinned agent is disconnected") }
        elseif ($daysLeft -lt 90)   { Wn  ($t.Label + " WS cert expires in " + $daysLeft + " days (" + $info.NotAfter.ToString('yyyy-MM-dd') + ") - re-issue + re-pin the fleet before then") }
        else                        { Ok  ($t.Label + " WS cert valid until " + $info.NotAfter.ToString('yyyy-MM-dd') + " (" + $daysLeft + " days)") }
        # Agents dial by IP, so the IP must be in the SAN or verification fails
        # outright regardless of what the CN says.
        if ($info.San -and ($info.San -match [regex]::Escape($ServerIP))) { Ok ($t.Label + " WS cert SAN covers " + $ServerIP) }
        else { Bad ($t.Label + " WS cert SAN does NOT cover " + $ServerIP + " - agents dialling that IP will reject it (SAN: " + $info.San + ")") }
    }
    elseif (Test-Path -LiteralPath $crt) { Bad ($t.Label + " WS cert exists but is unreadable/not PEM, or the key is missing: " + $crt) }
    else { Bad ($t.Label + " WS cert MISSING (" + $crt + ") - agent traffic on " + $t.Port + " is plain ws://") }

    $hasCertVar = ($t.Env -match ("(?m)^\s*" + $t.CertVar + "\s*=\s*\S"))
    $hasKeyVar  = ($t.Env -match ("(?m)^\s*" + $t.KeyVar  + "\s*=\s*\S"))
    if ($hasCertVar -and $hasKeyVar) { Ok ($t.Label + " " + $t.CertVar + " + " + $t.KeyVar + " set (NSSM env or .env.local)") }
    elseif (-not $nssm -and -not (Test-Path -LiteralPath $svEnvFile) -and -not (Test-Path -LiteralPath $ddiEnvFile)) { Wn ("Cannot verify " + $t.Label + " WS TLS env (nssm + .env.local both unreadable)") }
    else { Bad ($t.Label + " " + $t.CertVar + "/" + $t.KeyVar + " NOT set - the app serves plain ws:// on " + $t.Port + " regardless of the cert on disk") }

    $listen = Get-NetTCPConnection -LocalPort $t.Port -State Listen -ErrorAction SilentlyContinue
    if ($listen) { Ok ("TCP " + $t.Port + " LISTEN - " + $t.Label + " agent WS ingest") }
    else { Bad ("TCP " + $t.Port + " NOT listening - " + $t.Label + " agent WS ingest is down") }
}

# DDIVault's cleartext opt-in must be gone once TLS is configured, in BOTH places
# the app reads env from. If TLS was never configured the var is legitimately
# required (without it the ingest refuses to bind 3011 at all), so only report it
# as a failure when TLS IS in place.
$ddiTlsOn = (($ddiApiEnv + "`n" + $ddiEnvText) -match '(?m)^\s*DDI_WS_TLS_CERT\s*=\s*\S')
$plainNssm = ($ddiApiEnv -match '(?m)^\s*DDI_WS_ALLOW_PLAINTEXT\s*=\s*1')
$plainFile = ($ddiEnvText -match '(?m)^\s*DDI_WS_ALLOW_PLAINTEXT\s*=\s*1')
if ($plainNssm -or $plainFile) {
    $where = @(); if ($plainNssm) { $where += 'NSSM service env' }; if ($plainFile) { $where += '.env.local' }
    if ($ddiTlsOn) { Bad ("DDI_WS_ALLOW_PLAINTEXT=1 still set in " + ($where -join ' + ') + " - the cleartext guard in api/ws-server.js stays defeated even though TLS is configured") }
    else           { Wn  ("DDI_WS_ALLOW_PLAINTEXT=1 set in " + ($where -join ' + ') + " - expected while TLS is unconfigured, but WinRM credentials cross port 3011 in cleartext") }
} else {
    Ok "DDI_WS_ALLOW_PLAINTEXT not set (NSSM env or .env.local) - cleartext opt-out is off"
}

# ---------------------------------------------------------------
Section "3c. Shared TLS Terminator (NocVault-Tls)"
# The suite installer can front all four consoles with ONE TLS terminator: each
# console moves to 127.0.0.1:1300X and NocVault-Tls takes over the public port
# it used to hold (3000/3004/3006/3008 - deliberately the SAME ports, so every
# bookmark, ticket link and firewall rule still points at the right place).
#
# ⛔ A SUITE WITH NO TERMINATOR IS NOT A FAILURE. Plain HTTP on 0.0.0.0 is how
# this suite has shipped for its whole life and is still fully supported - a
# customer with no certificate gets it by design. So this section first decides
# WHICH configuration is installed and then checks that one is coherent. What it
# must never do is pass a suite that is half-way between the two.
$script:TlsFronted = $false
# ⛔ $null means UNKNOWN, NOT 3000. This started life as `= 3000`, so a box
# where the service environment could not be read (see the nssm note above)
# looked exactly like a box where the console really is still on 3000 - and the
# TLS section below turns that into a hard "the suite is HALF cut over" FAIL.
# Same bug class as a PowerShell function returning @() and handing the caller
# $null: a default that also means "no answer" cannot be told apart from a real
# reading, so it must be a value no real reading can produce.
$script:NvNssmPort = $null
$NocTlsSvc = Get-Service -Name 'NocVault-Tls' -ErrorAction SilentlyContinue

$Consoles = @(
    @{ App='netvault';  Label='NetVault';      Service='NetVault';       Public=3000; Loopback=13000;
       EnvFiles=@((Join-Path $InstallDir 'NetVault\app\.env'), (Join-Path $InstallDir 'NetVault\app\.next\standalone\.env.local')) },
    @{ App='logvault';  Label='LogVault-App';  Service='LogVault-App';   Public=3004; Loopback=13004;
       EnvFiles=@((Join-Path $InstallDir 'LogVault\app\.env.local'), (Join-Path $InstallDir 'LogVault\app\frontend\.env.local')) },
    @{ App='ddivault';  Label='DDIVault-App';  Service='DDIVault-App';   Public=3006; Loopback=13006;
       EnvFiles=@((Join-Path $InstallDir 'DDIVault\app\.env.local'), (Join-Path $InstallDir 'DDIVault\app\frontend\.env.local')) },
    @{ App='spanvault'; Label='SpanVault-App'; Service='SpanVault-App';  Public=3008; Loopback=13008;
       EnvFiles=@((Join-Path $InstallDir 'SpanVault\app\.env.local'), (Join-Path $InstallDir 'SpanVault\app\frontend\.env.local')) }
)

# Read the port NetVault's own service environment pins. $nssm was located in
# section 2. A terminator service plus NetVault still on 3000 is NOT a
# TLS-fronted suite (nothing can bind one port twice) - it is the half-way state
# this section exists to catch.
if ($nssm) {
    $nvExtra = ""
    try { $nvExtra = (& $nssm get NetVault AppEnvironmentExtra 2>$null | Out-String) } catch { $nvExtra = "" }
    $nvExtra = $nvExtra -replace "`0", ''
    foreach ($line in @($nvExtra -split "`r?`n")) {
        if ($line.Trim() -match '^PORT\s*=\s*(\d+)$') { $script:NvNssmPort = [int]$Matches[1] }
    }
}
if ($NocTlsSvc -and $script:NvNssmPort -ne $null -and $script:NvNssmPort -ne 3000) { $script:TlsFronted = $true }
# Could not read the port, but a terminator service exists and the loopback
# console port answers? Then it IS fronted - judge the thing itself rather than
# reporting a healthy suite as broken because one lookup was unavailable.
if ($NocTlsSvc -and $script:NvNssmPort -eq $null) {
    $lb = $null
    try { $lb = (New-Object System.Net.Sockets.TcpClient); $lb.Connect('127.0.0.1', 13000); $script:TlsFronted = $true; $lb.Close() } catch { }
    if ($script:TlsFronted) { Inf "NetVault service PORT unreadable, but 127.0.0.1:13000 is listening - treating the suite as TLS-fronted" }
}

# Every later section probes the CONSOLE directly, so its base URL depends on
# where the console actually listens. Set here, before section 4 uses it.
# Unchanged from the historic values on a plain-HTTP suite.
$NVBase  = "http://127.0.0.1:3000"
$LVBase  = "http://127.0.0.1:3004"
$DDIBase = "http://127.0.0.1:3006"
$SVBase  = "http://127.0.0.1:3008"
if ($script:TlsFronted) {
    $NVBase  = "http://127.0.0.1:13000"
    $LVBase  = "http://127.0.0.1:13004"
    $DDIBase = "http://127.0.0.1:13006"
    $SVBase  = "http://127.0.0.1:13008"
}
$ConsoleBase = @{ 'netvault' = $NVBase; 'logvault' = $LVBase; 'ddivault' = $DDIBase; 'spanvault' = $SVBase }

# NEXTAUTH_URL's scheme must match the transport on EVERY console. A mismatch is
# the worst failure mode in this whole feature: NextAuth silently bounces every
# sign-in back to the login page with no error in any log, on either side.
function NextAuthUrls($files) {
    $found = @()
    foreach ($f in $files) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        $raw = ""
        try { $raw = (Get-Content -LiteralPath $f -Raw -ErrorAction Stop) } catch { continue }
        foreach ($line in @($raw -split "`r?`n")) {
            if ($line.Trim() -match '^NEXTAUTH_URL\s*=\s*(\S+)$') { $found += [pscustomobject]@{ File = $f; Url = $Matches[1] } }
        }
    }
    return $found
}

if (-not $script:TlsFronted) {
    if ($NocTlsSvc -and $script:NvNssmPort -eq $null) {
        Wn "NocVault-Tls exists but NetVault's service PORT could not be read and 127.0.0.1:13000 is not listening - TLS state UNVERIFIED (not the same as half cut over)"
    } elseif ($NocTlsSvc) {
        Bad ("NocVault-Tls exists but NetVault's service PORT is still " + $script:NvNssmPort + " - the suite is HALF cut over. The terminator cannot bind a port the console is holding; one of the two is not serving.")
    } else {
        Inf "No NocVault-Tls service - this is a plain-HTTP suite (supported: the installer leaves it that way when no certificate is configured)"
    }
    # The mirror-image scheme mismatch: https:// baked in on a suite serving
    # plain HTTP breaks sign-in just as thoroughly.
    $wrongScheme = @()
    foreach ($c in $Consoles) {
        foreach ($n in (NextAuthUrls $c.EnvFiles)) {
            if ($n.Url -like 'https://*') { $wrongScheme += ($c.Label + " -> " + $n.File) }
        }
    }
    if ($wrongScheme.Count -gt 0) {
        Bad ("NEXTAUTH_URL is https:// on a plain-HTTP suite (" + ($wrongScheme -join '; ') + ") - every sign-in will bounce silently")
    } else {
        Ok "NEXTAUTH_URL is http:// everywhere, matching the plain-HTTP transport"
    }
} else {
    # ---- the service itself ----
    if ($NocTlsSvc.Status -eq 'Running') {
        $tlsStart = (Get-Service -Name 'NocVault-Tls').StartType
        if ($tlsStart -ne 'Automatic') { Wn ("NocVault-Tls Running but StartType=" + $tlsStart + " - a reboot would leave all four consoles unreachable (they are bound to 127.0.0.1)") }
        else { Ok "NocVault-Tls : Running (Automatic)" }
    } else {
        Bad ("NocVault-Tls : " + $NocTlsSvc.Status + " - ALL FOUR consoles are unreachable, they are bound to 127.0.0.1 only")
    }

    # ⛔ "Running" IS NOT "SERVING". start.mjs's own header records a launcher
    # that imported the terminator, bound nothing, logged nothing and exited 0
    # while NSSM reported Running. And the terminator deliberately degrades a
    # BROKEN certificate to plain HTTP rather than refusing to start - so a
    # service-state check alone passes a suite that is reachable and completely
    # unencrypted. Only bytes off the socket settle it, which is the next check.
    foreach ($c in $Consoles) {
        $h = Https ("https://127.0.0.1:" + $c.Public + "/api/health") 20
        if ($h.Code -eq 200) { Ok ($c.App + " answers HTTPS /api/health through the terminator on :" + $c.Public + " (" + $h.Ms + "ms)") }
        else { Bad ($c.App + " HTTPS /api/health on :" + $c.Public + " FAILED (code=" + $h.Code + " err=" + $h.Err + ") - the terminator may have degraded to plain HTTP; check " + (Join-Path $InstallDir 'NetVault\logs\nocvault-tls-error.log')) }
    }

    # The same-port plaintext demux. A plaintext request into a TLS listener is a
    # PROTOCOL failure, not a redirect, so without the demux every old
    # http://host:3000 bookmark would get an unexplained connection error with
    # nothing in any log to explain it. The terminator peeks the first byte and
    # answers non-TLS with a 301.
    foreach ($c in $Consoles) {
        $p = Http ("http://127.0.0.1:" + $c.Public + "/") 12 -NoRedirect
        if ($p.Code -eq 301 -and $p.Loc -and ([string]$p.Loc) -like 'https://*') {
            Ok ($c.App + " plaintext on :" + $c.Public + " -> 301 " + $p.Loc)
        } elseif ($p.Code -eq 301) {
            Bad ($c.App + " plaintext on :" + $c.Public + " -> 301 but Location is not https (" + $p.Loc + ")")
        } else {
            Bad ($c.App + " plaintext on :" + $c.Public + " did NOT get a 301 (code=" + $p.Code + " err=" + $p.Err + ") - old http:// bookmarks will fail with an unexplained connection error")
        }
    }

    # ---- the consoles are LOOPBACK-ONLY ----
    # This is the half of the feature that makes the terminator a security
    # boundary rather than a convenience. A console still answering plain HTTP
    # on its public-facing interface is an unencrypted bypass around it.
    foreach ($c in $Consoles) {
        $lb = Get-NetTCPConnection -LocalPort $c.Loopback -State Listen -ErrorAction SilentlyContinue
        if (-not $lb) {
            Bad ("TCP " + $c.Loopback + " NOT listening - " + $c.Label + " is not where the terminator expects it")
        } else {
            $addrs = @($lb | ForEach-Object { $_.LocalAddress } | Sort-Object -Unique)
            $wide  = @($addrs | Where-Object { $_ -ne '127.0.0.1' })
            if ($wide.Count -gt 0) {
                Bad ($c.Label + " is listening on " + ($addrs -join ',') + ":" + $c.Loopback + " - not loopback-only. HOSTNAME/-H did not take effect and the console is reachable unencrypted, bypassing the terminator.")
            } else {
                Ok ($c.Label + " bound to 127.0.0.1:" + $c.Loopback + " only")
            }
        }
    }

    # ⛔ AND NO FIREWALL RULE MAY OPEN ONE. The loopback bind is one lock; the
    # absent firewall rule is the second. A rule here would hand the world a
    # plain-HTTP route straight past the thing this whole feature installs.
    $badFw = @()
    foreach ($c in $Consoles) {
        $hit = Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } |
            Where-Object {
                $pf = $null
                try { $pf = ($_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue) } catch { $pf = $null }
                $pf -and (@($pf.LocalPort) -contains ([string]$c.Loopback))
            }
        if ($hit) { $badFw += ([string]$c.Loopback + " (" + (@($hit | ForEach-Object { $_.DisplayName }) -join ', ') + ")") }
    }
    if ($badFw.Count -gt 0) { Bad ("Inbound firewall rule(s) OPEN a console loopback port: " + ($badFw -join '; ') + " - remove them, they bypass TLS entirely") }
    else { Ok "No inbound firewall rule opens 13000/13004/13006/13008" }

    # ---- NEXTAUTH_URL scheme ----
    $schemeBad = @()
    $schemeSeen = 0
    foreach ($c in $Consoles) {
        foreach ($n in (NextAuthUrls $c.EnvFiles)) {
            $schemeSeen++
            if (-not ($n.Url -like 'https://*')) { $schemeBad += ($c.Label + " -> " + $n.File + " = " + $n.Url) }
        }
    }
    if ($schemeSeen -eq 0) { Wn "No NEXTAUTH_URL found in any console env file - cannot verify the scheme" }
    elseif ($schemeBad.Count -gt 0) { Bad ("NEXTAUTH_URL is still http:// behind TLS (" + ($schemeBad -join '; ') + ") - every sign-in bounces back to the login page with no error anywhere") }
    else { Ok ("NEXTAUTH_URL is https:// in all " + $schemeSeen + " console env file(s)") }

    # ---- the certificate the terminator is actually configured with ----
    # Read from NetVault's env files, because that is where the terminator reads
    # them from (nocvault-tls-terminator.ts loadEnvironment()) and where
    # Settings writes them (lib/envTargets.ts MANAGED_KEYS).
    $nvEnvFiles = $Consoles[0].EnvFiles
    $certPath = $null; $keyPath = $null
    foreach ($f in $nvEnvFiles) {
        if (-not $certPath) { $certPath = Get-EnvVal $f 'TLS_CERT_PATH' }
        if (-not $keyPath)  { $keyPath  = Get-EnvVal $f 'TLS_KEY_PATH' }
    }
    if ($certPath -and $keyPath) {
        if ((Test-Path -LiteralPath $certPath) -and (Test-Path -LiteralPath $keyPath)) {
            Ok ("TLS_CERT_PATH + TLS_KEY_PATH set and both files present (" + $certPath + ")")
            # Expiry runway on the LEAF. Parsed from the first PEM block only -
            # a real certificate file here carries leaf + intermediates, so
            # base64-decoding the whole file (the way the agent WS check above
            # can, since those are single self-signed certs) would fail.
            $leaf = $null
            try {
                $pem = Get-Content -LiteralPath $certPath -Raw
                $m = [regex]::Match($pem, '-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----')
                if ($m.Success) {
                    $der = [Convert]::FromBase64String(($m.Groups[1].Value -replace '\s',''))
                    $leaf = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$der)
                }
            } catch { $leaf = $null }
            if ($leaf) {
                $days = [int]([math]::Floor(($leaf.NotAfter - (Get-Date)).TotalDays))
                if ($days -lt 0)     { Bad ("Terminator certificate EXPIRED on " + $leaf.NotAfter.ToString('yyyy-MM-dd') + " - every console shows a browser error") }
                elseif ($days -lt 30){ Wn  ("Terminator certificate expires in " + $days + " days (" + $leaf.NotAfter.ToString('yyyy-MM-dd') + ")") }
                else                 { Ok  ("Terminator certificate valid until " + $leaf.NotAfter.ToString('yyyy-MM-dd') + " (" + $days + " days)") }
            } else {
                Wn ("Could not parse a certificate out of " + $certPath + " - expiry not checked")
            }
        } else {
            Bad ("TLS_CERT_PATH/TLS_KEY_PATH point at a file that is missing (cert=" + $certPath + " key=" + $keyPath + ") - the terminator degrades to PLAIN HTTP on all four ports")
        }
    } else {
        Bad "TLS_CERT_PATH / TLS_KEY_PATH not found in NetVault's env files - the terminator cannot be serving TLS from a configured certificate"
    }

    # ⛔ AND THEY MUST NOT BE PINNED IN ANY SERVICE ENVIRONMENT. They are
    # lib/envTargets.ts MANAGED_KEYS: a value in AppEnvironmentExtra is read at
    # runtime and beats any file, because dotenv never overrides an existing
    # process.env entry. Pinned, a certificate changed from Settings saves
    # cleanly, restarts cleanly and changes nothing - the exact bug wave one
    # removed NEXTAUTH_URL from three services to fix.
    if ($nssm) {
        $pinned = @()
        foreach ($svcName in @('NocVault-Tls','NetVault','LogVault-App','DDIVault-App','SpanVault-App')) {
            if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) { continue }
            $envRaw = ""
            try { $envRaw = (& $nssm get $svcName AppEnvironmentExtra 2>$null | Out-String) } catch { $envRaw = "" }
            $envRaw = $envRaw -replace "`0", ''
            foreach ($k in @('TLS_CERT_PATH','TLS_KEY_PATH','TLS_PUBLIC_HOST','NEXTAUTH_URL')) {
                if ($envRaw -match ("(?m)^\s*" + $k + "\s*=")) { $pinned += ($svcName + "/" + $k) }
            }
        }
        if ($pinned.Count -gt 0) { Bad ("Runtime-settable key(s) PINNED in a service environment: " + ($pinned -join ', ') + " - they shadow the env file forever and make the Settings page a silent no-op") }
        else { Ok "No runtime-settable TLS/auth key is pinned in any service environment - the env files are authoritative" }
    } else {
        Wn "nssm.exe not found - could not verify that TLS_*/NEXTAUTH_URL are unpinned in the service environments"
    }

    # ---- the refusal banner ----
    # start.mjs prints "NocVault TLS terminator: NOT STARTED" and exits rather
    # than serving plaintext when it cannot load lib/tlsConfig.ts (a Node that
    # cannot execute TypeScript). Nothing is being served when that happens, so
    # its presence in the log is decisive even if some other check passed.
    $tlsLogDir = Join-Path $InstallDir 'NetVault\logs'
    $tlsLogText = ""
    foreach ($lf in @((Join-Path $tlsLogDir 'nocvault-tls-error.log'), (Join-Path $tlsLogDir 'nocvault-tls.log'))) {
        if (Test-Path -LiteralPath $lf) {
            try { $tlsLogText += (Get-Content -LiteralPath $lf -Raw -ErrorAction Stop) } catch {}
        }
    }
    if (-not $tlsLogText) {
        Wn ("No terminator log found under " + $tlsLogDir + " - cannot check for the 'NOT STARTED' banner")
    } elseif ($tlsLogText -match 'NOT STARTED') {
        Bad "The terminator logged its 'NOT STARTED' banner - it refused to start (a Node that cannot execute TypeScript) and is serving nothing"
    } else {
        Ok "No 'NOT STARTED' banner in the terminator log"
        # The other banner: a BROKEN certificate degrades to plain HTTP loudly
        # rather than refusing to start, which is only safe because it is never
        # silent. If it is there, the consoles are up and UNENCRYPTED.
        if ($tlsLogText -match 'traffic is NOT encrypted') {
            Bad "The terminator logged its degrade-to-plain-HTTP banner - the consoles are reachable but NOT encrypted. Fix TLS_CERT_PATH/TLS_KEY_PATH and restart NocVault-Tls."
        }
    }
}

# ---------------------------------------------------------------
Section "4. HTTP Health + Versions"
# ⛔ WHAT THIS SECTION IS FOR: proving the install deployed a REAL, RECENT build -
# not that it is exactly version X. The old form carried nothing but a hardcoded
# $Min per app, and by the time anyone read them they were 40-90 releases stale
# (netvault floor 1.19.7 against a 1.63.x that was shipping), so the assertion
# could not fail for any plausible install - and it was only a Wn even when it
# did. Re-pinning the numbers to today's would have been stale again next week.
# So the check now has two independent halves:
#
#   1. The PRIMARY assertion is SELF-MAINTAINING and has no number in it: read
#      the app's OWN root package.json off the install directory and require
#      /api/health to report that exact version. That is what catches the real
#      defect this section is supposed to catch - a service still serving an
#      OLDER build than the checkout it was installed from (an updater that
#      pulled and built but never restarted the service, a rollback that put
#      .next/node_modules back but not the code, a stale *.replaced-* copy
#      still live). All four apps report the ROOT package.json version and
#      nothing else: netvault imports it in app/api/health/route.ts, and the
#      three Express apps do require('../package.json') (api/server.js) - so
#      equality here is exact, not approximate. The frontend/package.json
#      versions drift behind on purpose and are NOT what /api/health reports;
#      do not "fix" this to read those.
#
#   2. The floor stays, but only as a coarse backstop for the one case half 1
#      cannot see: a checkout that is ITSELF ancient (disk and health agree
#      perfectly at 1.19.7). It is marked >>> BUMP ME <<< below, is the only
#      place to edit, and a version under it is now a Bad, not a Wn.
#
# >>> BUMP ME <<< Coarse "is this checkout ancient" floor - one line per app.
# Deliberately a ROUND number a few releases BELOW what currently ships: it is a
# backstop, not a pin, so it does not need to move every release and must never
# be set to the exact shipping version (that turns every install made the day
# before a bump into a FAIL). Reviewed 2026-11-07 against netvault 1.63.2 /
# logvault 2.38.0 / ddivault 1.33.0 / spanvault 1.115.9.
$apps = @(
    @{ Name="netvault";  Port=3000; Min="1.60.0";  Dir="NetVault"  },
    @{ Name="logvault";  Port=3004; Min="2.36.0";  Dir="LogVault"  },
    @{ Name="ddivault";  Port=3006; Min="1.32.0";  Dir="DDIVault"  },
    @{ Name="spanvault"; Port=3008; Min="1.114.0"; Dir="SpanVault" }
)

# The DEPLOYED root package.json. The install layout is NOT uniform across the
# four apps - the installer lays every app down under '<App>\app', but installs
# that predate that (and the LogVault/DDIVault boxes where the repo root IS the
# install root) have it one level up, which is why Resolve-PgPassword above
# carries the same two-candidate list. Probe both and report which one answered.
# ⛔ Finding nothing is a Wn, never a Bad: a layout we failed to guess must not
# fail an otherwise healthy install - that would be exactly the kind of noise
# that got the old floors ignored.
function DiskVer([string]$appDir) {
    foreach ($cand in @((Join-Path $InstallDir ($appDir + '\app\package.json')),
                        (Join-Path $InstallDir ($appDir + '\package.json')))) {
        if (-not (Test-Path -LiteralPath $cand)) { continue }
        try {
            $pk = (Get-Content -LiteralPath $cand -Raw -ErrorAction Stop | ConvertFrom-Json)
            if ($pk -and $pk.version) { return @{ Ver = ([string]$pk.version).Trim(); Path = $cand } }
        } catch {}
    }
    return $null
}

# ⛔ $ConsoleBase, not the public port. Behind the TLS terminator the public port
# is the TERMINATOR: an http:// probe there is answered with the demux 301, and
# Invoke-WebRequest then follows it to https://127.0.0.1 and fails certificate
# validation - so all four apps would be reported DOWN on a perfectly healthy
# TLS suite. Section 3c sets this to the console's real listening address, and
# leaves it at the historic public port on a plain-HTTP suite. The HTTPS path
# through the terminator is checked in 3c, where a failure can be attributed.
foreach ($a in $apps) {
    $r = Http (($ConsoleBase[$a.Name]) + "/api/health") 20
    if (-not ($r.Code -eq 200 -and $r.Content)) {
        Bad ($a.Name + " health FAILED (code=" + $r.Code + " err=" + $r.Err + ")")
        continue
    }

    $ver = $null
    try { $ver = ($r.Content | ConvertFrom-Json).version } catch {}
    if (-not $ver) {
        # ⛔ A Bad, not a Wn. No version field means the running build cannot be
        # IDENTIFIED, so neither assertion below can run at all - and every app
        # does report it (the per-app updaters' own post-update health checks key
        # off this same field, so a health response without it breaks them too).
        Bad ($a.Name + " health 200 but reports NO version field - the deployed build cannot be identified, and the updater's post-update version check reads this same field; raw: " + $r.Content)
        continue
    }

    $disk = DiskVer $a.Dir
    if ($null -eq $disk) {
        Wn ($a.Name + " health 200, version " + $ver + " - but no root package.json was found under " + (Join-Path $InstallDir $a.Dir) + " (looked in '\app\' and the directory root), so the RUNNING build could not be compared with the checkout on disk")
    } elseif ($disk.Ver -eq $ver) {
        Ok ($a.Name + " health 200, version " + $ver + " matches the deployed package.json, " + $r.Ms + "ms")
    } elseif (VerGE $disk.Ver $ver) {
        Bad ($a.Name + " is SERVING AN OLDER BUILD than its own checkout: /api/health reports " + $ver + " but " + $disk.Path + " is " + $disk.Ver + " - the files were updated and the service was never restarted (or a rollback restored .next/node_modules without the code). Restart this app's service and re-check.")
    } else {
        Bad ($a.Name + " version MISMATCH: /api/health reports " + $ver + " but " + $disk.Path + " is " + $disk.Ver + " - the running process is NEWER than the files on disk, so what is being served is not this directory (wrong -InstallDir, or a leftover *.replaced-* copy is the live one; see section 8b)")
    }

    # Coarse floor - see >>> BUMP ME <<< above. Deliberately separate from the
    # match check: an ancient CHECKOUT passes the match (disk and health agree)
    # and this is the only half that can see it.
    if (-not (VerGE $ver $a.Min)) {
        Bad ($a.Name + " version " + $ver + " is BELOW the minimum expected build " + $a.Min + " - this install came from a stale checkout; pull and re-run this app's updater")
    }
}

# ---------------------------------------------------------------
Section "5. Public Endpoints + Launcher Performance"
$sh1 = Http "$NVBase/api/suite/health" 12
if ($sh1.Code -eq 200) {
    $sh2 = Http "$NVBase/api/suite/health" 12
    Ok ("/api/suite/health 200 (cold " + $sh1.Ms + "ms, warm " + $sh2.Ms + "ms)")
    if ($sh1.Ms -gt 3000) { Wn ("suite/health cold > 3s (" + $sh1.Ms + "ms) - a sibling app may be slow") }
} else { Bad ("/api/suite/health FAILED (code=" + $sh1.Code + ")") }

$ss1 = Http "$NVBase/api/suite/stats" 12
if ($ss1.Code -eq 200) {
    $ss2 = Http "$NVBase/api/suite/stats" 12
    Ok ("/api/suite/stats 200 (cold " + $ss1.Ms + "ms, warm " + $ss2.Ms + "ms)")
    if ($ss2.Ms -lt $ss1.Ms) { Inf "warm call faster -> in-memory cache appears active" }
} else { Bad ("/api/suite/stats FAILED (code=" + $ss1.Code + ")") }

$lic = Http "$NVBase/api/license" 12
if ($lic.Code -eq 200 -and $lic.Content) {
    $sid = $null; try { $sid = ($lic.Content | ConvertFrom-Json).serverId } catch {}
    Ok ("/api/license 200 (" + $lic.Ms + "ms)" + $(if ($sid) { " serverId=" + $sid } else { "" }))
} else { Wn ("/api/license code=" + $lic.Code) }

$set = Http "$NVBase/api/settings" 12
if ($set.Code -eq 200) { Ok ("/api/settings 200 (" + $set.Ms + "ms)") } else { Wn ("/api/settings code=" + $set.Code) }

$lvs = Http "$LVBase/api/stats" 12
if ($lvs.Code -eq 200) { Ok ("LogVault /api/stats 200 (" + $lvs.Ms + "ms)") } else { Wn ("LogVault /api/stats code=" + $lvs.Code) }

# NocVault Agent bootstrap (Phase 2 hub-served bundle). The minted install
# one-liner does `irm <hub>/api/agents/install.ps1`, which in turn pulls the
# agent files from /api/agents/bundle. Both are PUBLIC (no session). These 503
# (never 200) if the on-disk agent\ dir isn't present at the standalone runtime
# root - the exact failure mode that would make a minted install command 404.
$aps = Http "$NVBase/api/agents/install.ps1" 12
if ($aps.Code -eq 200 -and $aps.Content -match 'param\(' -and $aps.Content -match 'NocVault-Agent') {
    Ok ("/api/agents/install.ps1 serves the installer (200, " + $aps.Ms + "ms)")
} else {
    Bad ("/api/agents/install.ps1 FAILED (code=" + $aps.Code + ") - agent installer not served (minted install one-liner would 404)")
}
$abn = Http "$NVBase/api/agents/bundle" 12
if ($abn.Code -eq 200 -and $abn.Content) {
    $files = $null; try { $files = ($abn.Content | ConvertFrom-Json).files } catch {}
    if ($files -and @($files).Count -ge 1) {
        Ok ("/api/agents/bundle manifest 200 (" + @($files).Count + " agent file(s))")
        if (-not ($files -contains 'nocvault-agent.js')) { Wn "agent bundle manifest missing nocvault-agent.js" }
    } else {
        Bad "/api/agents/bundle returned 200 but an empty/unparseable files list - agent\ dir may be missing at runtime root"
    }
} else {
    Bad ("/api/agents/bundle FAILED (code=" + $abn.Code + ") - agent\ dir not present at NetVault standalone runtime root")
}

# Phase 3 Workstream B: the signed self-update manifest. PUBLIC (the agent fetches
# it pre-credential on its policy tick), served from the committed
# agent\update-manifest.json produced offline by scripts/sign-agent.js. A fresh
# install with no committed/signed manifest legitimately 503s (advertises no
# update) - but the repo ships a signed one, so a real deploy must serve 200 with
# a body carrying version + files + sig.
$aum = Http "$NVBase/api/agents/update-manifest" 12
if ($aum.Code -eq 200 -and $aum.Content) {
    $man = $null; try { $man = ($aum.Content | ConvertFrom-Json) } catch {}
    if ($man -and $man.version -and $man.files -and $man.sig) {
        Ok ("/api/agents/update-manifest 200 (v" + $man.version + ", " + @($man.files).Count + " signed file(s))")
    } else {
        Bad "/api/agents/update-manifest returned 200 but body is missing version/files/sig - manifest malformed"
    }
} elseif ($aum.Code -eq 503) {
    Bad "/api/agents/update-manifest 503 - no signed agent\update-manifest.json committed (run scripts/sign-agent.js; the repo must ship one)"
} else {
    Bad ("/api/agents/update-manifest FAILED (code=" + $aum.Code + ") - route missing or agent\ dir not at NetVault standalone runtime root")
}

# Phase 3 A5: the agent identity-refresh route must EXIST and be agent-gated. A
# POST with no Bearer token returns 401 (requireAgentAuth) - proving the route
# is present AND locked down, not a 404 (route missing) or 405 (wrong method).
$refCode = $null
try {
    $rf = Invoke-WebRequest "$NVBase/api/agents/smoke-test/refresh" -Method Post -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
    $refCode = [int]$rf.StatusCode
} catch {
    if ($_.Exception.Response) { try { $refCode = [int]$_.Exception.Response.StatusCode } catch {} }
}
if ($refCode -eq 401) {
    Ok "/api/agents/<id>/refresh exists and is agent-gated (unauthed POST -> 401)"
} else {
    Bad ("/api/agents/<id>/refresh unauthed POST returned code=" + $refCode + " (expected 401 - route missing or not agent-gated)")
}

# Phase 4a: the poll-carried command channel. The agent-authed log return path
# (POST /api/agents/<id>/logs) must EXIST and reject an unauthed POST with 401
# (requireAgentAuth, same guard as heartbeat/refresh) - proving it's present and
# locked to agent JWTs, not a 404 (route missing).
$logCode = $null
try {
    $lf = Invoke-WebRequest "$NVBase/api/agents/smoke-test/logs" -Method Post -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
    $logCode = [int]$lf.StatusCode
} catch {
    if ($_.Exception.Response) { try { $logCode = [int]$_.Exception.Response.StatusCode } catch {} }
}
if ($logCode -eq 401) {
    Ok "/api/agents/<id>/logs exists and is agent-gated (unauthed POST -> 401)"
} else {
    Bad ("/api/agents/<id>/logs unauthed POST returned code=" + $logCode + " (expected 401 - route missing or not agent-gated)")
}

# The super_admin command-enqueue route (POST /api/agents/<id>/commands) must
# EXIST and reject an unauthed POST with 401 (no session) - proving it's present
# and session-gated, not a 404. A logged-in super_admin then gets 400/404 on a
# bad type / unknown agent; unauthed can never reach that logic.
$cmdCode = $null
try {
    $cf = Invoke-WebRequest "$NVBase/api/agents/smoke-test/commands" -Method Post -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
    $cmdCode = [int]$cf.StatusCode
} catch {
    if ($_.Exception.Response) { try { $cmdCode = [int]$_.Exception.Response.StatusCode } catch {} }
}
if ($cmdCode -eq 401) {
    Ok "/api/agents/<id>/commands exists and is session-gated (unauthed POST -> 401)"
} else {
    Bad ("/api/agents/<id>/commands unauthed POST returned code=" + $cmdCode + " (expected 401 - route missing or not gated)")
}

$root = Http "$NVBase/" 12 -NoRedirect
if ($root.Code -ge 300 -and $root.Code -lt 400) { Ok ("NetVault / redirects (" + $root.Code + " -> " + $root.Loc + ")") }
elseif ($root.Code -eq 200) { Inf "NetVault / returned 200 (no redirect)" }
else { Wn ("NetVault / code=" + $root.Code) }

$login = Http "$NVBase/login" 12
if ($login.Code -eq 200) { Ok "NetVault /login renders (200)" } else { Wn ("NetVault /login code=" + $login.Code) }

# ---------------------------------------------------------------
Section "6. Auth / NextAuth"
$csrf = Http "$NVBase/api/auth/csrf" 12
if ($csrf.Code -eq 200 -and $csrf.Content) {
    $tok = $null; try { $tok = ($csrf.Content | ConvertFrom-Json).csrfToken } catch {}
    if ($tok) { Ok "NextAuth csrf endpoint OK (auth stack is up)" } else { Wn "csrf 200 but no token parsed" }
} else { Bad ("NextAuth csrf FAILED (code=" + $csrf.Code + ")") }

if ($TestLogin) {
    # ⛔ THE SEEDED ADMIN PASSWORD IS PER-INSTALL NOW, SO IT CANNOT BE A LITERAL
    # HERE. The suite installer generates it and persists it as NV_ADMIN_PASSWORD in
    # secrets.env; it used to seed the same shipped default on every install, and this
    # block posted that default as a constant. Left as a constant, -TestLogin would
    # fail on every freshly installed suite and the failure would look like a broken
    # auth stack rather than a tester that no longer knows the password.
    #
    # ⛔ THE FALLBACK IS THE SHIPPED DEFAULT, AND REACHING IT IS ITSELF A FINDING.
    # A box installed before per-install passwords existed still has the shipped
    # default live, which is exactly the weakness that change closed - so say so
    # rather than quietly logging in. It stays a Wn, not a Bad: the password may also
    # have been changed deliberately by the customer, and this script cannot tell
    # those two apart from the outside.
    #
    # ⛔ NEVER PRINTED. The whole point of moving it into secrets.env is that it
    # stops appearing in console output and logs; this block reports the SOURCE it
    # resolved the password from, never the value.
    $adminEmail  = "admin@yourcompany.com"
    $adminPw     = Get-EnvVal 'C:\ProgramData\NocVault\secrets.env' 'NV_ADMIN_PASSWORD'
    $adminPwFrom = 'NV_ADMIN_PASSWORD in secrets.env'
    $usingShippedDefault = $false
    if (-not $adminPw) {
        $adminPw = "Admin1234!"
        $adminPwFrom = 'the SHIPPED DEFAULT (no NV_ADMIN_PASSWORD in secrets.env)'
        $usingShippedDefault = $true
    }
    Inf ("Attempting credentials login as " + $adminEmail + ", password from " + $adminPwFrom + " (value not shown) ...")
    try {
        $sess = $null
        $c = Invoke-WebRequest "$NVBase/api/auth/csrf" -UseBasicParsing -SessionVariable sess -TimeoutSec 12
        $tk = ($c.Content | ConvertFrom-Json).csrfToken
        $body = @{ csrfToken = $tk; email = $adminEmail; password = $adminPw; redirect = "false"; json = "true" }
        $null = Invoke-WebRequest "$NVBase/api/auth/callback/credentials" -Method Post -Body $body -WebSession $sess -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 12 -ErrorAction SilentlyContinue
        $hasSession = $false
        foreach ($ck in $sess.Cookies.GetCookies("$NVBase")) { if ($ck.Name -like "*session-token*") { $hasSession = $true } }

        # ⛔ ON A TLS SUITE THE SESSION COOKIE IS `Secure`, SO A PLAIN-HTTP
        # LOOPBACK LOGIN CAN NEVER KEEP IT. $NVBase is http://127.0.0.1:13000 once
        # the consoles move behind the terminator, and NEXTAUTH_URL is https:// -
        # next-auth therefore marks the cookie Secure and the client drops it on an
        # http:// origin. The credentials were CORRECT and the server issued the
        # cookie; only the transport threw it away. Reported as "no session cookie",
        # that reads as a wrong password and sends the operator to reset an account
        # that works - the same "a test that fails on working software" trap this
        # file already warns about twice.
        # MEASURED on staging 2026-11-09: the identical credentials through
        # https://127.0.0.1:3000 returned a full super_admin session and
        # GET /api/settings answered 200.
        # curl.exe (shipped with Windows 10 1803+ / Server 2019+) is used because
        # Invoke-WebRequest on PS 5.1 cannot complete a request to a node https
        # server presenting a self-signed certificate - see the Http helper.
        if (-not $hasSession -and $script:TlsFronted) {
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($curl) {
                $tlsBase = "https://127.0.0.1:3000"
                $jar  = Join-Path $env:TEMP ("nv-smoke-" + [guid]::NewGuid().ToString("N") + ".txt")
                $bodyF = Join-Path $env:TEMP ("nv-smoke-" + [guid]::NewGuid().ToString("N") + ".dat")
                try {
                    $cj = (& $curl.Source -sk -c $jar "$tlsBase/api/auth/csrf" 2>$null | Out-String).Trim()
                    $tk2 = ($cj | ConvertFrom-Json).csrfToken
                    # The body goes in a FILE: a password on a command line is readable
                    # from Win32_Process.CommandLine by anything on the box.
                    ("csrfToken=" + $tk2 + "&email=" + [Uri]::EscapeDataString($adminEmail) + "&password=" + [Uri]::EscapeDataString($adminPw) + "&redirect=false&json=true") |
                        Out-File -FilePath $bodyF -Encoding ascii -NoNewline
                    $null = (& $curl.Source -sk -b $jar -c $jar -X POST "$tlsBase/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" --data "@$bodyF" 2>$null | Out-String)
                    $sj = (& $curl.Source -sk -b $jar "$tlsBase/api/auth/session" 2>$null | Out-String).Trim()
                    if ($sj -match '"email"') {
                        $hasSession = $true
                        Inf "  (the loopback attempt could not keep the Secure cookie; retried through the HTTPS front door)"
                    }
                } catch {
                } finally {
                    Remove-Item $bodyF, $jar -Force -ErrorAction SilentlyContinue
                }
            } else {
                Inf "  curl.exe not available - a TLS suite's Secure session cookie cannot be tested over the plain-HTTP loopback"
            }
        }

        if ($hasSession) {
            if ($usingShippedDefault) {
                Wn ("Login smoke: session cookie issued, but using " + $adminPwFrom + " - the shipped default admin password is STILL LIVE on this box. Change it in Settings -> Users, or re-run the suite installer so a per-install password is generated.")
            } else {
                Ok "Login smoke: session cookie issued (per-install admin password from secrets.env works)"
            }
        }
        else {
            if ($usingShippedDefault) {
                Wn "Login smoke: no session cookie, and secrets.env has no NV_ADMIN_PASSWORD. Either the admin password was changed by hand (fine - verify in a browser), or this install predates per-install admin passwords and the seed never matched."
            } else {
                Wn "Login smoke: no session cookie although NV_ADMIN_PASSWORD was found - the admin password was changed after install, or the credentials flow differs. Verify in browser."
            }
        }
    } catch { Wn ("Login smoke error: " + $_.Exception.Message) }
} else {
    Inf "Skipping live login (pass -TestLogin). Verify a real browser login + SSO into each app manually."
}

# --- Console address (NEXTAUTH_URL) must stay RUNTIME-SETTABLE from Settings ---
# Two conditions, and both matter:
#   1. the env FILE the service loads supplies it - otherwise the app has no
#      value for it at all and sign-in/callback redirects break;
#   2. the NSSM service environment does NOT pin it - dotenv/loadEnvConfig never
#      override a variable that is already in process.env, so a value in
#      AppEnvironmentExtra shadows the file permanently and a Settings change is
#      a silent no-op that only reappears after a reinstall. The suite installer
#      used to pin it on NetVault/LogVault-App/DDIVault-App; it no longer does,
#      and each app's Update-*.ps1 clears it from the service environment on
#      upgrade so field boxes converge. SpanVault has never had an
#      AppEnvironmentExtra block at all - that is the reference shape.
# When Settings starts managing TLS_CERT_PATH / TLS_KEY_PATH / ENTRA_TENANT_ID /
# ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET, add them to $runtimeKeys in the SAME
# change as the installer + updater edits.
$runtimeKeys = @('NEXTAUTH_URL')
foreach ($rsa in @(
    @{ Svc='NetVault';      File=(Join-Path $InstallDir "NetVault\app\.next\standalone\.env.local") },
    @{ Svc='LogVault-App';  File=(Join-Path $InstallDir "LogVault\app\frontend\.env.local") },
    @{ Svc='DDIVault-App';  File=(Join-Path $InstallDir "DDIVault\app\frontend\.env.local") },
    @{ Svc='SpanVault-App'; File=(Join-Path $InstallDir "SpanVault\app\frontend\.env.local") }
)) {
    $rsSvcEnv  = WsSvcEnv $rsa.Svc
    $rsFileEnv = WsEnvFile $rsa.File
    foreach ($rsk in $runtimeKeys) {
        $rsPat     = "(?m)^\s*" + $rsk + "\s*=\s*\S"
        $rsInFile  = ($rsFileEnv -match $rsPat)
        $rsInSvc   = ($rsSvcEnv  -match $rsPat)
        if ($rsInSvc -and $rsInFile) {
            Bad ($rsa.Svc + ": " + $rsk + " is pinned in the NSSM service environment AND in " + $rsa.File + " - the service env wins, so changing it from Settings silently does nothing. Fix: re-run this app's updater (it clears the key), or inspect with 'nssm get " + $rsa.Svc + " AppEnvironmentExtra'")
        }
        elseif ($rsInSvc) {
            Bad ($rsa.Svc + ": " + $rsk + " comes ONLY from the NSSM service environment - Settings cannot change it and " + $rsa.File + " does not supply it")
        }
        elseif ($rsInFile) {
            if ($nssm) { Ok  ($rsa.Svc + ": " + $rsk + " is file-supplied only (" + $rsa.File + ") - runtime-settable from Settings") }
            else       { Wn  ($rsa.Svc + ": " + $rsk + " found in " + $rsa.File + ", but nssm.exe was not located - could not confirm the service environment does not also pin it") }
        }
        elseif (-not (Test-Path -LiteralPath $rsa.File)) {
            Wn ("Cannot verify " + $rsa.Svc + " " + $rsk + " - env file not found at " + $rsa.File)
        }
        else {
            Bad ($rsa.Svc + ": " + $rsk + " is set NOWHERE (neither " + $rsa.File + " nor the NSSM service environment) - sign-in and callback redirects will break")
        }
    }
}

# ---- the agent-ingest TLS pins: NSSM must not hold them ----
# ⛔ THESE ARE OPTIONAL KEYS, SO ONLY THE *PIN* IS A FAILURE - NEVER THEIR
# ABSENCE. That is why they cannot simply join $runtimeKeys above: that loop runs
# over all four consoles and ends in a Bad for any key it finds nowhere, while
# these four are read ONLY by NetVault (lib/agentIdentity.ts and
# app/api/agents/enroll-tokens/route.ts) and are legitimately unset whenever
# agent-ingest TLS is off - which is the default. Adding them there would print
# four confident failures on a perfectly healthy install, once per app.
#
# The state that IS worth asserting is the one that breaks silently: pinned in the
# NSSM service environment, which beats both env files for ever. Update-NetVault.ps1
# clears exactly these four for that reason ($RuntimeSettableEnvKeys), because a
# pinned fingerprint is baked into every agent enrollment command the hub hands
# out, and a pinned *_WS_TLS=1 against a listener that is really plaintext makes
# every agent's WS link fail closed.
$nvWsPinned = @()
$nvWsSvcEnv = WsSvcEnv 'NetVault'
foreach ($wk in @('SPANVAULT_WS_TLS','SPANVAULT_WS_FINGERPRINT','DDIVAULT_WS_TLS','DDIVAULT_WS_FINGERPRINT')) {
    if ($nvWsSvcEnv -match ("(?m)^\s*" + $wk + "\s*=\s*\S")) { $nvWsPinned += $wk }
}
if (-not $nssm) {
    Wn "nssm.exe was not located - could not check whether the agent-ingest TLS keys are pinned in the NetVault service environment"
} elseif ($nvWsPinned.Count -gt 0) {
    Bad ("NetVault: " + ($nvWsPinned -join ', ') + " pinned in the NSSM service environment - a pin there overrides both env files permanently, so Settings cannot change it and the pinned value is handed out in every agent enrollment command. Fix: re-run Update-NetVault.ps1 (it clears these four), or inspect with 'nssm get NetVault AppEnvironmentExtra'")
} else {
    Ok "NetVault: the agent-ingest TLS keys are not pinned in the service environment (Settings can manage them)"
}

# ---------------------------------------------------------------
Section "7. Scheduled Tasks (NetVault cron)"
# ⛔ "REGISTERED" IS NOT "WILL RUN". This section used to PRINT the state it had
# just read - Ok ("... registered (State=" + $task.State + ")") - so a Disabled
# task, a task with no trigger, a task still posting at the TERMINATOR's port and
# a task carrying a stale Bearer token all passed the one independent check the
# suite has. Every one of those failure modes is SILENT by construction: curl -s
# discards the response body, so Task Scheduler records "0x0 completed
# successfully" whether the endpoint answered 200, a demux 301 or a 401, and the
# only visible symptom is a health trend that never gains a point.
#
# So the three things that actually decide whether the job runs are now asserted:
# the task is enabled AND has a live trigger, the action targets the port the
# console really listens on with the right endpoint, and its Bearer token equals
# the CRON_SECRET the route will compare against.

# ---- the live CRON_SECRET, resolved the way the ROUTE will see it ----
# ⛔ NEVER PRINTED, ONLY COMPARED. The Bad line below says "does not match" and
# stops there - this is a credential and the tester's output gets pasted into
# tickets. lib/cronAuth.ts reads process.env.CRON_SECRET and fails CLOSED when it
# is unset, so the token baked into the task argument has to be equal byte for
# byte or the task 401s forever.
# Precedence here is the PROCESS's, not the file's: NSSM's AppEnvironmentExtra is
# already in the environment when the Next standalone server starts and @next/env
# never overwrites a key that is already set - so the service env wins over
# .env.local, the same precedence section 6 above checks for NEXTAUTH_URL.
$cronLive = ''
foreach ($line in @((WsSvcEnv 'NetVault') -split "`r?`n")) {
    if ($line.Trim() -match '^CRON_SECRET\s*=\s*(\S+)$') { $cronLive = $Matches[1] }
}
if (-not $cronLive) {
    foreach ($cf in @((Join-Path $InstallDir 'NetVault\app\.next\standalone\.env.local'),
                      (Join-Path $InstallDir 'NetVault\app\.env'))) {
        if ($cronLive) { continue }
        $cv = Get-EnvVal $cf 'CRON_SECRET'
        if ($cv) { $cronLive = $cv }
    }
}

# The port the tasks MUST post to is wherever the NetVault console itself
# listens, which section 3c already worked out - 3000 on a plain-HTTP suite,
# 13000 behind the terminator. Derived from $NVBase rather than re-deciding it
# here, so this cannot drift from the rest of the script.
$nvCronPort = 3000
if ($NVBase -match ':(\d+)$') { $nvCronPort = [int]$Matches[1] }

foreach ($ct in @(
    @{ Name='NetVault-HealthSnapshot'; Path='/api/system/health-snapshot'; Does='the daily fleet health snapshot (health_score_history)' },
    @{ Name='NetVault-EnrichEol';      Path='/api/system/enrich-eol';      Does='the daily EOL/EOS enrichment' },
    @{ Name='NetVault-SyncEol';        Path='/api/system/sync-eol';        Does='the weekly EOL feed sync' }
)) {
    $tn   = $ct.Name
    $task = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
    if (-not $task) {
        Bad ($tn + " NOT registered - " + $ct.Does + " will never run")
        continue
    }

    # ---- enabled + actually triggered ----
    # Register-MaintenanceTask is deliberately non-fatal in the installer, and a
    # hand-edited or Disabled task looks identical to a healthy one in the list.
    # A task with zero (or only disabled) triggers is Ready and never fires.
    $tState = [string]$task.State
    $tTrig  = @($task.Triggers)
    $tLive  = @($tTrig | Where-Object { $_.Enabled -ne $false })
    if ($tState -eq 'Disabled') {
        Bad ($tn + " is DISABLED (State=Disabled) - it is registered but will never run, so " + $ct.Does + " silently stops")
    } elseif ($tState -eq 'Unknown') {
        Bad ($tn + " is in State=Unknown - Task Scheduler cannot run it (usually a broken principal; it must be registered against SID S-1-5-18)")
    } elseif ($tTrig.Count -eq 0) {
        Bad ($tn + " has NO trigger - State=" + $tState + " but nothing will ever start it, so " + $ct.Does + " silently stops")
    } elseif ($tLive.Count -eq 0) {
        Bad ($tn + " has " + $tTrig.Count + " trigger(s) and every one of them is DISABLED - it will never start")
    } else {
        Ok ($tn + " is enabled with a live trigger (State=" + $tState + ", " + $tLive.Count + " trigger(s))")
    }

    # ---- the action: right port, right endpoint ----
    $tArg = ''
    try { $tArg = (@($task.Actions | ForEach-Object { $_.Arguments }) -join ' ') } catch { $tArg = '' }
    $tPort = 0; $tPath = ''
    if ($tArg -match 'http://127\.0\.0\.1:(\d+)(/api/system/[A-Za-z0-9\-]+)') { $tPort = [int]$Matches[1]; $tPath = $Matches[2] }
    if ($tPort -eq 0) {
        Bad ($tn + " action has no http://127.0.0.1:<port>/api/system/... target (Execute/Arguments were hand-edited, or the task was registered by something other than the installer) - it cannot be doing " + $ct.Does)
    } elseif ($tPath -ne $ct.Path) {
        Bad ($tn + " action posts to " + $tPath + " but must post to " + $ct.Path + " - " + $ct.Does + " never happens")
    } elseif ($tPort -ne $nvCronPort) {
        # ⛔ THE TLS-CUTOVER TRAP. Behind the terminator the public port IS the
        # terminator: a plaintext POST there is answered with the demux 301 and
        # curl (no -L) does nothing with it. NocVault-TlsCutover.ps1 re-points
        # these three tasks at the console's loopback port for exactly this
        # reason, but a box cut over by an older Enable-NocVaultTls.ps1, a
        # non-fatal Register-MaintenanceTask failure during the cutover, or a
        # hand-edited task all land here - and nothing else in the suite notices.
        Bad ($tn + " action posts to 127.0.0.1:" + $tPort + " but the NetVault console listens on " + $nvCronPort + " - the request goes to the TLS terminator and is answered with the demux 301, which curl ignores, so " + $ct.Does + " stops with no error anywhere. Re-run Enable-NocVaultTls.ps1 or re-point the task by hand.")
    } else {
        Ok ($tn + " action posts to 127.0.0.1:" + $nvCronPort + $ct.Path + " (the console's real listening port)")
    }

    # ---- the Bearer token ----
    $tTok = ''
    if ($tArg -match 'Authorization:\s*Bearer\s+([^\s"]+)') { $tTok = $Matches[1] }
    if (-not $cronLive) {
        Wn ($tn + " Bearer token could not be verified - CRON_SECRET was not readable from NetVault's service environment or its .env files (nssm.exe may not have been located in section 2, or the env files are missing)")
    } elseif (-not $tTok) {
        Bad ($tn + " action carries NO 'Authorization: Bearer' header - isCronAuthorized fails closed, so every run is answered 401 and " + $ct.Does + " never happens")
    } elseif ($tTok -ceq $cronLive) {
        Ok ($tn + " Bearer token matches the live CRON_SECRET")
    } else {
        Bad ($tn + " Bearer token does NOT match the live CRON_SECRET (values deliberately not shown) - every run is answered 401 and " + $ct.Does + " silently stops. The secret was rotated (or the app re-installed) without re-registering the task.")
    }
}

# ---------------------------------------------------------------
Section "8. Firewall Rules (NocVault*)"
$fw = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "NocVault*" }
if ($fw) {
    Ok ("Found " + ($fw | Measure-Object).Count + " NocVault firewall rule(s)")
    foreach ($r in $fw) { Inf (" - " + $r.DisplayName + " [" + $r.Enabled + "/" + $r.Direction + "/" + $r.Action + "]") }
} else { Wn "No firewall rules matching 'NocVault*'" }

# Duplicates mean the same DisplayName was created more than once. The installer
# now refuses to add a rule that already exists (Add-NocFirewallRule), so a
# duplicate here says the box was installed by a build older than 1.57.2 - the
# rules still work, but the extras are noise an operator should clear.
$dupFw = @($fw | Group-Object DisplayName | Where-Object { $_.Count -gt 1 })
if ($dupFw.Count -gt 0) {
    foreach ($d in $dupFw) { Wn ("Duplicate firewall rule x" + $d.Count + ": " + $d.Name + " - safe to remove the extras (Remove-NetFirewallRule removes all copies at once)") }
}

# ---------------------------------------------------------------
Section "8b. Leftover Replaced Installations"
# STEP 7.5 of the installer moves an existing app directory aside as
# '<name>.replaced-<timestamp>' rather than deleting it in place, and STEP 12
# removes the aside copy once the new services are up. One still sitting here
# means that cleanup did not happen - which is harmless to the running suite
# (it is serving out of its own directory) but can be a lot of disk.
$aside = @()
foreach ($d in @("$InstallDir\NetVault", "$InstallDir\LogVault", "$InstallDir\DDIVault", "$InstallDir\SpanVault")) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $aside += @(Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like '*.replaced-*' })
}
if ($aside.Count -eq 0) {
    Ok "No leftover '.replaced-*' directories"
} else {
    foreach ($a in $aside) {
        $mb = 0
        try { $mb = [math]::Round((Get-ChildItem -LiteralPath $a.FullName -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum / 1MB) } catch {}
        Wn ("Leftover previous installation: " + $a.FullName + " (~" + $mb + " MB) - the running suite does not use it; delete it to reclaim the space")
    }
}

# ---------------------------------------------------------------
Section "9. Database Deep Checks"
if (-not $script:DbReady) { Wn "DB not available - section skipped" }
else {
    $dbc = Pg "postgres" "SELECT count(*) FROM pg_database WHERE datname IN ('netvault','logvault','ddivault','spanvault');"
    if ($dbc -eq "4") { Ok "All 4 databases exist" } else { Bad ("Expected 4 databases, found " + $dbc) }

    $rc = Pg "postgres" "SELECT count(*) FROM pg_roles WHERE rolname IN ('netvault','logvault_user','ddivault_user','spanvault_user','nocvault_readonly');"
    if ($rc -eq "5") { Ok "All 5 roles exist (incl. nocvault_readonly)" } else { Bad ("Expected 5 roles, found " + $rc) }

    Write-Host "  --- NetVault (support_vendor_id / v_devices_flat fix) ---" -ForegroundColor DarkGray
    # ROLE-SCOPED: assert the app role (netvault) can actually SELECT the object,
    # not merely that it exists in the catalog (a superuser-visible existence check
    # FALSE-PASSES when the app role can't read it).
    $col = Pg "netvault" "SELECT has_column_privilege('netvault','devices','support_vendor_id','SELECT');"
    if ($col -eq "t") { Ok "netvault role can SELECT devices.support_vendor_id" } else { Bad ("netvault role cannot SELECT devices.support_vendor_id (got '" + $col + "')") }
    $vw = Pg "netvault" "SELECT has_table_privilege('netvault','v_devices_flat','SELECT');"
    if ($vw -eq "t") { Ok "netvault role can SELECT v_devices_flat view" } else { Bad ("netvault role cannot SELECT v_devices_flat (got '" + $vw + "')") }
    $vsel = Pg "netvault" "SELECT count(*) FROM v_devices_flat;"
    if ($script:PgExit -eq 0) { Ok ("v_devices_flat queryable (" + $vsel + " rows)") } else { Bad ("SELECT from v_devices_flat FAILED: " + $vsel) }
    $usr = Pg "netvault" "SELECT count(*) FROM users;"
    if ($script:PgExit -eq 0 -and [int]$usr -ge 1) { Ok ("users seeded (" + $usr + " row(s))") } else { Bad ("users empty/unreadable (" + $usr + ")") }
    # user_apps drives per-user app-access RBAC (netvault 1.23.0). No rows for a user = all apps.
    $uapps = Pg "netvault" "SELECT has_table_privilege('netvault','user_apps','SELECT');"
    if ($script:PgExit -eq 0 -and $uapps -eq "t") { Ok "user_apps table present (per-user app access)" } else { Bad ("user_apps table missing/unreadable (got '" + $uapps + "')") }

    # Directory sign-in (Microsoft Entra ID, netvault 1.56.0+). Three objects
    # back it: the two users columns a provisioned account needs, and the
    # group -> role table that decides what it becomes.
    $dcols = Pg "netvault" "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name IN ('auth_provider','entra_oid');"
    if ($script:PgExit -eq 0 -and [int]$dcols -eq 2) { Ok "users.auth_provider + users.entra_oid present (directory sign-in)" }
    else { Bad ("directory sign-in columns missing on users (found " + $dcols + " of 2)") }
    $dmap = Pg "netvault" "SELECT has_table_privilege('netvault','directory_role_mappings','SELECT');"
    if ($script:PgExit -eq 0 -and $dmap -eq "t") { Ok "directory_role_mappings table present" }
    else { Bad ("directory_role_mappings missing/unreadable (got '" + $dmap + "')") }

    # ⛔ AN EMPTY MAPPING TABLE REFUSES EVERY DIRECTORY SIGN-IN, AND THAT IS THE
    # STATE A FRESH INSTALL IS IN. It is correct (a default mapping would grant a
    # role to a group nobody here administers) but it is also invisible: the
    # tenant is configured, Microsoft authenticates the person, and the hub
    # refuses them. Reported as INFO when single sign-on is off and as a WARNING
    # when it is on, because only in the second case is somebody about to hit it.
    $dmapN = Pg "netvault" "SELECT count(*) FROM directory_role_mappings;"
    if ($script:PgExit -eq 0) {
        $entraOn = $false
        foreach ($f in @("$InstallDir\NetVault\app\.env", "$InstallDir\NetVault\app\.next\standalone\.env.local")) {
            if (Get-EnvVal $f 'ENTRA_TENANT_ID') { $entraOn = $true }
        }
        if ([int]$dmapN -gt 0) {
            Ok ("directory group mappings configured (" + $dmapN + ")")
        } elseif ($entraOn) {
            Wn "Single sign-on is configured but NO directory group is mapped - every Entra sign-in will be refused. Settings > Single sign-on > Directory group to role mappings."
        } else {
            Inf "No directory group mappings (expected: single sign-on is not configured)"
        }
    }

    # MFA (TOTP second factor, netvault 1.33.0). The hub is the suite's only
    # password-verification point, so these back the second factor for all four
    # apps. Check the columns AND the backup-code table: without the latter a
    # user who loses their authenticator has no way back in.
    $mfaCols = Pg "netvault" "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name IN ('mfa_secret','mfa_enabled','mfa_enrolled_at','mfa_last_step','mfa_failed_attempts','mfa_locked_until');"
    if ($script:PgExit -eq 0 -and $mfaCols -eq "6") { Ok "users MFA columns present (6/6)" } else { Bad ("users MFA columns incomplete (expected 6, got '" + $mfaCols + "')") }
    $mfaBk = Pg "netvault" "SELECT has_table_privilege('netvault','user_mfa_backup_codes','SELECT');"
    if ($script:PgExit -eq 0 -and $mfaBk -eq "t") { Ok "user_mfa_backup_codes table present (MFA recovery)" } else { Bad ("user_mfa_backup_codes missing/unreadable (got '" + $mfaBk + "')") }
    # The policy key must exist and default to empty. Shipping a non-empty value
    # would demand MFA from roles before anyone in them has enrolled, locking
    # them out of a brand-new install with psql as the only way back.
    $mfaPolicy = Pg "netvault" "SELECT value FROM app_settings WHERE key='mfa_required_roles';"
    if ($script:PgExit -eq 0 -and $mfaPolicy -eq "[]") { Ok "mfa_required_roles seeded empty (opt-in)" } else { Bad ("mfa_required_roles missing or not empty on a fresh install (got '" + $mfaPolicy + "')") }
    # mfa_secret is a bearer credential. users_public is a column allowlist, so a
    # new column is hidden by default - verify that actually held rather than
    # assuming it.
    $mfaLeak = Pg "netvault" "SELECT count(*) FROM information_schema.columns WHERE table_name='users_public' AND column_name LIKE 'mfa%';"
    if ($script:PgExit -eq 0 -and $mfaLeak -eq "0") { Ok "users_public exposes no MFA columns (secret not readable by diagnostics)" } else { Bad ("users_public LEAKS MFA columns (got '" + $mfaLeak + "')") }
    $aset = Pg "netvault" "SELECT count(*) FROM app_settings;"
    if ($script:PgExit -eq 0) { Ok ("app_settings present (" + $aset + " keys)") } else { Bad "app_settings unreadable" }

    # Suite-wide SMTP, owned by the hub: one SMTP server configured once for all
    # four apps instead of separately in each. Two objects back it - the
    # smtp_config base table (whose password column holds an AES-256-GCM
    # ciphertext) and the smtp_config_public view, which is every column EXCEPT
    # that one and is what the readonly diagnostic roles are allowed to read.
    #
    # EXISTENCE IS ASSERTED HERE, SEPARATELY FROM THE GRANTS BELOW, ON PURPOSE.
    # The REVOKE/GRANT block for these sits after a CREATE OR REPLACE VIEW in
    # schema.sql, and on 2026-11-05 exactly that shape (a column-order error in
    # users_public) aborted a whole schema apply under ON_ERROR_STOP and
    # silently skipped every privilege block after it. A fresh install where the
    # SMTP block never ran has to FAIL the tester rather than pass quietly, and
    # the grant checks below cannot deliver that on their own:
    # has_table_privilege on a table that does not exist just ERRORS, which is
    # indistinguishable from "locked down" unless something checks first.
    $smtpTbl = Pg "netvault" "SELECT to_regclass('public.smtp_config') IS NOT NULL;"
    if ($smtpTbl -eq "t") { Ok "netvault.smtp_config table exists (suite-wide SMTP, hub-owned)" }
    else { Bad ("netvault.smtp_config table MISSING (got '" + $smtpTbl + "') - schema.sql never applied its SMTP block, so suite-wide SMTP cannot be configured") }
    $smtpVw = Pg "netvault" "SELECT to_regclass('public.smtp_config_public') IS NOT NULL;"
    if ($smtpVw -eq "t") { Ok "netvault.smtp_config_public view exists (password-free projection)" }
    else { Bad ("netvault.smtp_config_public view MISSING (got '" + $smtpVw + "') - the readonly diagnostic roles have no safe way to read SMTP config") }
    # The view is the ONLY thing between a diagnostic role and the encrypted SMTP
    # password, so assert it really drops that column instead of assuming the
    # projection was written correctly (same reasoning as the users_public MFA
    # check above - a column allowlist still has to be verified).
    $smtpLeak = Pg "netvault" "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='smtp_config_public' AND column_name='password';"
    if ($script:PgExit -eq 0 -and $smtpLeak -eq "0") { Ok "smtp_config_public exposes no password column (SMTP secret not readable by diagnostics)" }
    else { Bad ("smtp_config_public LEAKS the password column (got '" + $smtpLeak + "')") }
    # agent_registry - NocVault Agents Phase 2 hub control plane (netvault 1.24.0).
    # ROLE-SCOPED: the netvault app role must be able to SELECT each of the 4 tables.
    # agent_commands (Phase 4a poll-carried command channel) is included below -
    # it must exist (fresh installs) AND be role-SELECTable for the fleet page.
    $agOk = $true; $agBad = @()
    foreach ($t in @('agents','agent_enrollment_tokens','agent_modules','agent_health','agent_commands')) {
        $p = Pg "netvault" "SELECT has_table_privilege('netvault','$t','SELECT');"
        if ($p -ne "t") { $agOk = $false; $agBad += ($t + "=" + $p) }
    }
    if ($agOk) { Ok "netvault role can SELECT all agent_registry tables (agents, agent_enrollment_tokens, agent_modules, agent_health, agent_commands)" } else { Bad ("netvault role cannot SELECT agent_registry tables: " + ($agBad -join ', ')) }
    # Phase 4a: the log return-path columns on `agents` must be present (added via
    # idempotent ALTER; a get_logs command stashes its tail here for the GET to read).
    $llc = Pg "netvault" "SELECT has_column_privilege('netvault','agents','last_logs','SELECT');"
    if ($llc -eq "t") { Ok "agents.last_logs column present (Phase 4a log return path)" } else { Bad ("agents.last_logs column missing/unreadable (got '" + $llc + "')") }

    Write-Host "  --- DDIVault (uuid-ossp fix) ---" -ForegroundColor DarkGray
    $ext = Pg "ddivault" "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='uuid-ossp');"
    if ($ext -eq "t") { Ok "uuid-ossp extension installed" } else { Bad ("uuid-ossp MISSING (got '" + $ext + "')") }
    # ROLE-SCOPED: the ddivault_user app role must be able to SELECT each core table.
    $ddOk = $true; $ddBad = @()
    foreach ($t in @('ddi_servers','dhcp_scopes','dns_zones','ipam_subnets','saved_reports','report_schedules','report_run_history','report_email_log')) {
        $p = Pg "ddivault" "SELECT has_table_privilege('ddivault_user','$t','SELECT');"
        if ($p -ne "t") { $ddOk = $false; $ddBad += ($t + "=" + $p) }
    }
    if ($ddOk) { Ok "ddivault_user can SELECT all DDIVault core tables" } else { Bad ("ddivault_user cannot SELECT DDIVault core tables: " + ($ddBad -join ', ')) }
    # Phase 4b: the agent data plane. ddi_agents (per-agent registry, no credential -
    # agents auth via hub-signed JWT) and ddi_servers.agent_hub_id (the column that
    # binds a monitored server to a remote agent) must both exist, or agent-collected
    # data has nowhere to land.
    $ddAg = Pg "ddivault" "SELECT to_regclass('public.ddi_agents') IS NOT NULL;"
    if ($ddAg -eq "t") { Ok "ddivault.ddi_agents table exists (Phase 4b agent registry)" } else { Bad ("ddivault.ddi_agents table MISSING (got '" + $ddAg + "')") }
    $ddHub = Pg "ddivault" "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ddi_servers' AND column_name='agent_hub_id');"
    if ($ddHub -eq "t") { Ok "ddivault.ddi_servers.agent_hub_id column exists (Phase 4b)" } else { Bad ("ddivault.ddi_servers.agent_hub_id column MISSING (got '" + $ddHub + "')") }

    Write-Host "  --- SpanVault (map shapes + connection waypoints) ---" -ForegroundColor DarkGray
    # ROLE-SCOPED: assert the spanvault_user app role can SELECT each object/column.
    $ms = Pg "spanvault" "SELECT has_table_privilege('spanvault_user','map_shapes','SELECT');"
    if ($ms -eq "t") { Ok "spanvault_user can SELECT map_shapes" } else { Bad ("spanvault_user cannot SELECT map_shapes (got '" + $ms + "')") }
    $mcL = Pg "spanvault" "SELECT has_column_privilege('spanvault_user','map_shapes','locked','SELECT');"
    $mcG = Pg "spanvault" "SELECT has_column_privilege('spanvault_user','map_shapes','group_id','SELECT');"
    if ($mcL -eq "t" -and $mcG -eq "t") { Ok "spanvault_user can SELECT map_shapes.locked + group_id" } else { Bad ("spanvault_user cannot SELECT map_shapes locked/group_id (locked=" + $mcL + " group_id=" + $mcG + ")") }
    $wp = Pg "spanvault" "SELECT has_column_privilege('spanvault_user','map_connections','waypoints','SELECT');"
    if ($wp -eq "t") { Ok "spanvault_user can SELECT map_connections.waypoints (adjustable elbow lines)" } else { Bad ("spanvault_user cannot SELECT map_connections.waypoints (got '" + $wp + "')") }
    $svOk = $true; $svBad = @()
    foreach ($t in @('monitored_devices','alerts','sv_maps','wireless_controllers')) {
        $p = Pg "spanvault" "SELECT has_table_privilege('spanvault_user','$t','SELECT');"
        if ($p -ne "t") { $svOk = $false; $svBad += ($t + "=" + $p) }
    }
    if ($svOk) { Ok "spanvault_user can SELECT all SpanVault core tables" } else { Bad ("spanvault_user cannot SELECT SpanVault core tables: " + ($svBad -join ', ')) }

    Write-Host "  --- LogVault (append-only tamper model) ---" -ForegroundColor DarkGray
    # ROLE-SCOPED: the logvault_user app role must be able to SELECT syslog_entries.
    $se = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','SELECT');"
    if ($se -eq "t") { Ok "logvault_user can SELECT syslog_entries" } else { Bad ("logvault_user cannot SELECT syslog_entries (got '" + $se + "')") }
    $ins = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','INSERT');"
    $upd = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','UPDATE');"
    $del = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','DELETE');"
    if ($ins -eq "t") { Ok "logvault_user CAN INSERT syslog_entries" } else { Bad ("logvault_user cannot INSERT (got '" + $ins + "')") }
    if ($upd -eq "f" -and $del -eq "f") { Ok "logvault_user CANNOT UPDATE/DELETE syslog_entries (tamper model intact)" }
    else { Bad ("Tamper model BROKEN: UPDATE=" + $upd + " DELETE=" + $del + " (expected f/f)") }
    # ROLE-SCOPED: reporting engine tables (2.20.0) - mirrors the DDIVault check above.
    $lvOk = $true; $lvBad = @()
    foreach ($t in @('saved_reports','report_run_history')) {
        $p = Pg "logvault" "SELECT has_table_privilege('logvault_user','$t','SELECT');"
        if ($p -ne "t") { $lvOk = $false; $lvBad += ($t + "=" + $p) }
    }
    if ($lvOk) { Ok "logvault_user can SELECT reporting-engine tables (saved_reports, report_run_history)" } else { Bad ("logvault_user cannot SELECT reporting-engine tables: " + ($lvBad -join ', ')) }

    # ROLE-SCOPED: dashboard-widget rollup tables + srcip column (perf pass, 2.20.x).
    $lvrOk = $true; $lvrBad = @()
    foreach ($t in @('syslog_stats_rollup','syslog_talker_rollup')) {
        $p = Pg "logvault" "SELECT has_table_privilege('logvault_user','$t','SELECT');"
        if ($p -ne "t") { $lvrOk = $false; $lvrBad += ($t + "=" + $p) }
    }
    $srcipCol = Pg "logvault" "SELECT has_column_privilege('logvault_user','syslog_entries','srcip','SELECT');"
    if ($srcipCol -ne "t") { $lvrOk = $false; $lvrBad += ("syslog_entries.srcip=" + $srcipCol) }
    if ($lvrOk) { Ok "logvault_user can SELECT the rollup tables + srcip column (syslog_stats_rollup, syslog_talker_rollup, syslog_entries.srcip)" } else { Bad ("logvault_user cannot SELECT rollup tables/column: " + ($lvrBad -join ', ')) }

    # ROLE-SCOPED: Phase 2/3 dashboard-widget rollup tables (perf pass, 2.23.0-2.24.0).
    $lvr2Ok = $true; $lvr2Bad = @()
    foreach ($t in @('syslog_security_event_rollup','syslog_dest_event_rollup','syslog_vpn_rollup','syslog_dest_rollup','syslog_source_host_rollup','syslog_distinct_value_rollup','syslog_known_bad_hit_rollup')) {
        $p = Pg "logvault" "SELECT has_table_privilege('logvault_user','$t','SELECT');"
        if ($p -ne "t") { $lvr2Ok = $false; $lvr2Bad += ($t + "=" + $p) }
    }
    if ($lvr2Ok) { Ok "logvault_user can SELECT the Phase 2/3 rollup tables (7 tables)" } else { Bad ("logvault_user cannot SELECT Phase 2/3 rollup tables: " + ($lvr2Bad -join ', ')) }

    # ROLE-SCOPED: Phase 4 dashboard-widget rollup tables (perf pass, 2.24.x).
    $lvr3Ok = $true; $lvr3Bad = @()
    foreach ($t in @('syslog_fortinet_field_rollup','syslog_device_status_rollup','syslog_entity_activity_rollup')) {
        $p = Pg "logvault" "SELECT has_table_privilege('logvault_user','$t','SELECT');"
        if ($p -ne "t") { $lvr3Ok = $false; $lvr3Bad += ($t + "=" + $p) }
    }
    if ($lvr3Ok) { Ok "logvault_user can SELECT the Phase 4 rollup tables (3 tables)" } else { Bad ("logvault_user cannot SELECT Phase 4 rollup tables: " + ($lvr3Bad -join ', ')) }

    Write-Host "  --- Cross-DB grants ---" -ForegroundColor DarkGray
    $svSites = Pg "netvault" "SELECT has_table_privilege('spanvault_user','sites','SELECT');"
    if ($script:PgExit -eq 0 -and $svSites -eq "t") { Ok "spanvault_user has SELECT on netvault.sites" }
    else { Bad ("spanvault_user missing SELECT on netvault.sites (got '" + $svSites + "')") }
    $svUsers = Pg "netvault" "SELECT has_table_privilege('spanvault_user','users','SELECT');"
    if ($script:PgExit -eq 0 -and $svUsers -eq "t") { Ok "spanvault_user has SELECT on netvault.users (SpanVault SSO)" }
    else { Bad ("spanvault_user missing SELECT on netvault.users (got '" + $svUsers + "') -- SpanVault SSO broken") }
    $ddSites = Pg "netvault" "SELECT has_table_privilege('ddivault_user','sites','SELECT');"
    if ($script:PgExit -eq 0 -and $ddSites -eq "t") { Ok "ddivault_user has SELECT on netvault.sites" }
    else { Bad ("ddivault_user missing SELECT on netvault.sites (got '" + $ddSites + "')") }
    # Phase 4b: DDIVault's agent-WS ingest reads netvault.agents (revocation check) via
    # the SAME narrow ddivault_user role. Without this SELECT every agent connect fails
    # closed. (SpanVault uses the broader `netvault` role which already has full SELECT.)
    $ddAgents = Pg "netvault" "SELECT has_table_privilege('ddivault_user','agents','SELECT');"
    if ($script:PgExit -eq 0 -and $ddAgents -eq "t") { Ok "ddivault_user has SELECT on netvault.agents (Phase 4b agent-revocation check)" }
    else { Bad ("ddivault_user missing SELECT on netvault.agents (got '" + $ddAgents + "') -- agent WS ingest fails closed") }

    # nocvault_readonly (the Hub's cross-DB read role) must be able to read a
    # representative object in each suite DB. NOTE (2026-07 security fix): two of
    # these tables now have COLUMN-LEVEL grants (credential columns excluded), so a
    # TABLE-level has_table_privilege check returns 'f' BY DESIGN and is the WRONG
    # assertion for them -- the Hub reads the non-secret columns and that still
    # works. Check table-level only where the grant is genuinely table-wide, and a
    # representative NON-secret column where the grant is column-level.
    Write-Host "  --- nocvault_readonly (Hub cross-DB role) ---" -ForegroundColor DarkGray
    $roTable = @(
        @{ Db="netvault"; Tbl="devices" },
        @{ Db="logvault"; Tbl="syslog_entries" }
    )
    foreach ($ro in $roTable) {
        $roSel = Pg $ro.Db "SELECT has_table_privilege('nocvault_readonly','$($ro.Tbl)','SELECT');"
        if ($roSel -eq "t") { Ok ("nocvault_readonly has SELECT on " + $ro.Db + "." + $ro.Tbl) }
        else { Bad ("nocvault_readonly missing SELECT on " + $ro.Db + "." + $ro.Tbl + " (got '" + $roSel + "') -- Hub cross-DB reads broken") }
    }
    $roCol = @(
        @{ Db="ddivault";  Tbl="ddi_servers";       Col="id" },
        @{ Db="spanvault"; Tbl="monitored_devices"; Col="id" }
    )
    foreach ($ro in $roCol) {
        $roSel = Pg $ro.Db "SELECT has_column_privilege('nocvault_readonly','$($ro.Tbl)','$($ro.Col)','SELECT');"
        if ($roSel -eq "t") { Ok ("nocvault_readonly can SELECT " + $ro.Db + "." + $ro.Tbl + "." + $ro.Col + " (column-level grant; table-level intentionally revoked by the credential-column security fix)") }
        else { Bad ("nocvault_readonly cannot SELECT " + $ro.Db + "." + $ro.Tbl + "." + $ro.Col + " (got '" + $roSel + "') -- Hub cross-DB reads broken") }
    }

    # Credential/secret exclusions (2026-07 security fix). The readonly diagnostic
    # role must NOT be able to read secret columns or secret-bearing base tables:
    # they were revoked and replaced with column-level grants (ddi_servers,
    # monitored_devices, agents, agent_discovered_devices, wireless_controllers)
    # or filtered *_public views (app_settings, api_keys, smtp_config, users).
    # This is the guard for the exact regression the app CLAUDE.md warns about --
    # a blanket "GRANT SELECT ON ALL TABLES" re-run silently re-widens the secret.
    # Checks nocvault_readonly (installer-created); claude_readonly is dev-only and
    # deliberately not assumed to exist on a customer box.
    Write-Host "  --- Secret exclusions (readonly role must NOT read credentials) ---" -ForegroundColor DarkGray
    # (a) column-level: a representative secret column must be UNreadable.
    $secCol = @(
        @{ Db="ddivault";  Tbl="ddi_servers";              Col="ps_password" },
        @{ Db="spanvault"; Tbl="monitored_devices";        Col="snmp_community" },
        @{ Db="spanvault"; Tbl="agents";                   Col="api_key" },
        @{ Db="spanvault"; Tbl="agent_discovered_devices"; Col="snmp_community" },
        @{ Db="spanvault"; Tbl="wireless_controllers";     Col="api_refresh_token" },
        # MFA backup-code hashes. Added after a fresh-install audit found this
        # column readable by both diagnostic roles on a from-scratch install -
        # the blanket grant covers the table because it is created before that
        # grant runs, and nothing revoked it afterwards the way users does.
        @{ Db="netvault";  Tbl="user_mfa_backup_codes";    Col="code_hash" }
    )
    $secOk = $true; $secBad = @()
    foreach ($s in $secCol) {
        $r = Pg $s.Db "SELECT has_column_privilege('nocvault_readonly','$($s.Tbl)','$($s.Col)','SELECT');"
        if ($r -ne "f") { $secOk = $false; $secBad += ($s.Db + "." + $s.Tbl + "." + $s.Col + "=" + $r) }
    }
    if ($secOk) { Ok "nocvault_readonly is BLOCKED from every secret credential column (ddi_servers.ps_password, monitored_devices/agent_discovered_devices.snmp_community, agents.api_key, wireless_controllers.api_refresh_token, user_mfa_backup_codes.code_hash)" }
    else { Bad ("SECURITY REGRESSION: nocvault_readonly CAN read secret column(s): " + ($secBad -join ', ') + " -- a blanket GRANT likely re-widened access") }
    # (b) view-based: each secret base table must be UNreadable AND its *_public view readable.
    $secView = @(
        @{ Db="ddivault";  Tbl="smtp_config" },
        @{ Db="ddivault";  Tbl="api_keys" },
        @{ Db="ddivault";  Tbl="app_settings" },
        @{ Db="spanvault"; Tbl="app_settings" },
        @{ Db="netvault";  Tbl="users" },
        @{ Db="netvault";  Tbl="app_settings" },
        # Suite-wide SMTP on the hub. Same shape as DDIVault's: the password
        # column is an AES-256-GCM ciphertext, so the base table is revoked and
        # the roles read smtp_config_public instead. Existence of both objects is
        # asserted earlier in this section - a missing table would otherwise show
        # up here only as a psql error.
        @{ Db="netvault";  Tbl="smtp_config" }
    )
    $vwOk = $true; $vwBad = @()
    foreach ($v in $secView) {
        $base = Pg $v.Db "SELECT has_table_privilege('nocvault_readonly','$($v.Tbl)','SELECT');"
        $baseExit = $script:PgExit
        $pub  = Pg $v.Db "SELECT has_table_privilege('nocvault_readonly','$($v.Tbl)_public','SELECT');"
        $pubExit = $script:PgExit
        # A privilege check on an object that does not exist ERRORS - it does not
        # answer 'f'. Report that as MISSING rather than letting it masquerade as
        # a readable base table (or as a missing grant on the view).
        if ($baseExit -ne 0 -or $base -eq "") { $vwOk = $false; $vwBad += ($v.Db + "." + $v.Tbl + " base table MISSING (privilege check errored)") }
        elseif ($base -ne "f") { $vwOk = $false; $vwBad += ($v.Db + "." + $v.Tbl + " base READABLE") }
        if ($pubExit -ne 0 -or $pub -eq "") { $vwOk = $false; $vwBad += ($v.Db + "." + $v.Tbl + "_public view MISSING (privilege check errored)") }
        elseif ($pub -ne "t") { $vwOk = $false; $vwBad += ($v.Db + "." + $v.Tbl + "_public NOT readable") }
    }
    if ($vwOk) { Ok "nocvault_readonly reads the filtered *_public views (app_settings, api_keys, users, and smtp_config in BOTH ddivault and netvault) but NOT the secret base tables behind them" }
    else { Bad ("SECURITY REGRESSION or missing view: " + ($vwBad -join ', ')) }
}

# ---------------------------------------------------------------
Section "10. Collectors"

# ---- 10a. LogVault: live synthetic syslog -> DB round trip ----
Write-Host "  --- LogVault collector (live syslog injection) ---" -ForegroundColor DarkGray
$token = "NOCVAULT-SMOKETEST-" + ([guid]::NewGuid().ToString("N"))
$stamp = (Get-Date).ToString("MMM dd HH:mm:ss")
$payload = "<134>$stamp SMOKETEST nocvault-tester: $token synthetic syslog smoke test"
$sent = $false
try {
    $udp = New-Object System.Net.Sockets.UdpClient
    $b = [Text.Encoding]::ASCII.GetBytes($payload)
    [void]$udp.Send($b, $b.Length, "127.0.0.1", 514)
    $udp.Close()
    $sent = $true
    Inf ("Sent synthetic syslog packet to 127.0.0.1:514 (token " + $token + ")")
} catch { Bad ("Failed to send syslog packet: " + $_.Exception.Message) }

if ($sent -and $script:DbReady) {
    $hit = $false
    for ($i = 0; $i -lt 9; $i++) {
        Start-Sleep -Seconds 2
        $cnt = Pg "logvault" "SELECT count(*) FROM syslog_entries WHERE raw_message LIKE '%$token%' OR message LIKE '%$token%';"
        if ($script:PgExit -eq 0 -and [int]$cnt -ge 1) { $hit = $true; break }
    }
    if ($hit) {
        Ok "LogVault collector INGESTED the test packet (socket -> parser -> DB round-trip confirmed)"
        $det = Pg "logvault" "SELECT vendor||' | cat='||COALESCE(category,'(null)')||' | risk='||risk_score::text FROM syslog_entries WHERE raw_message LIKE '%$token%' ORDER BY received_at DESC LIMIT 1;"
        Inf ("  parsed: " + $det)

        # ⛔ ASSERTED, NOT PRINTED. 'hashed=' used to be just another field inside
        # the Inf line above, so an install where LOG_INTEGRITY_KEY never reached
        # the collector showed "hashed=false" in a grey INFO line among ~150 PASS
        # lines and the suite still ended on 0 FAIL. Tamper evidence is the one
        # security control in LogVault, the installer goes to real trouble to
        # provision the key, and the related REVOKE UPDATE/DELETE check in
        # section 9 hard-fails already - this has to as well.
        # Without the key the collector logs '[Integrity] LOG_INTEGRITY_KEY not
        # set - hash chain disabled' once at startup and then writes entry_hash
        # NULL on every row, so the row just ingested is a complete and current
        # test of the whole feature.
        # ⛔ "NO ROWS" IS NOT A FAILURE, and the two cases must not be conflated.
        # An empty result means there was nothing to judge (the test row was
        # removed by retention or another cleanup between the two queries, or
        # psql errored) -> Wn. Only a row that EXISTS and is UNHASHED is a Bad.
        # The legitimate no-logs-yet install cannot reach here at all: this block
        # only runs once the synthetic packet has been confirmed in the table.
        # ⛔ `::text` ON A BOOLEAN YIELDS 'true'/'false', NOT 't'/'f'. The t/f
        # form is psql's DISPLAY format for a boolean COLUMN - casting to text
        # produces the whole word, and this one line casts. So the comparison
        # below could never match and this check reported "tamper evidence is
        # OFF" on every install whose rows were correctly hash-chained, then
        # told the operator to go and set a key that was already set.
        # MEASURED on staging 2026-11-09: the query returns [true] for a row
        # whose entry_hash is present. Every OTHER t/f comparison in this file
        # reads a real boolean column and is correct - do not ""fix"" those.
        # Asking for the word explicitly removes the dependency on either format.
        $hashed = Pg "logvault" "SELECT CASE WHEN entry_hash IS NOT NULL THEN 'hashed' ELSE 'unhashed' END FROM syslog_entries WHERE raw_message LIKE '%$token%' ORDER BY received_at DESC LIMIT 1;"
        if ($script:PgExit -ne 0 -or $hashed -eq "") {
            Wn "  could not read the test row's entry_hash back - hash-chain state UNVERIFIED (no row to judge, which is not the same as an unhashed one)"
        } elseif ($hashed -eq "hashed") {
            Ok "  test row is HASH-CHAINED (entry_hash present) - LOG_INTEGRITY_KEY reached the collector"
        } else {
            Bad "LogVault tamper evidence is OFF: the row just ingested has entry_hash NULL - the collector is running without LOG_INTEGRITY_KEY, so NOTHING it writes is hash-chained and scripts/verify-integrity.js has nothing to verify. Set LOG_INTEGRITY_KEY in LogVault's root .env.local (and check it is not missing from the LogVault-Collector service environment), then restart the collector."
        }

        $del = Pg "logvault" "DELETE FROM syslog_entries WHERE raw_message LIKE '%$token%' OR message LIKE '%$token%';"
        if ($script:PgExit -eq 0) { Inf "  cleaned up test row(s)" } else { Wn "  could not delete test row (harmless, clearly marked)" }
    } else {
        Bad "LogVault collector did NOT store the test packet within ~18s - collector may not be ingesting (check collector-err.log + collector_allowed_sources)"
    }
} elseif ($sent) {
    Wn ("Packet sent but DB unavailable to verify - search LogVault Log Explorer for token " + $token)
}

# ---- 10a-ii. LogVault: collector heartbeat + listener state ----
# The collector publishes its own liveness to app_settings.collector_status every
# 60s, and /api/health reports it. Before that existed the header pill was driven
# by the health endpoint's status code alone, so it showed a healthy collector
# whenever the API could answer - including with the collector stopped. Assert the
# channel actually works on a fresh install, otherwise the indicator silently goes
# back to being decorative.
#
# Read via app_settings_public: the raw table is not readable by the readonly
# roles (it holds smtp_pass), and collector_status is deliberately on that view.
if ($script:DbReady) {
    $hb = Pg "logvault" "SELECT EXTRACT(EPOCH FROM (NOW() - updated_at))::int FROM app_settings_public WHERE key='collector_status';"
    if ($script:PgExit -eq 0 -and $hb -ne "" -and $null -ne $hb) {
        if ([int]$hb -le 180) {
            Ok ("LogVault collector heartbeat is fresh (" + $hb + "s old, stale threshold 180s)")
            $st = Pg "logvault" "SELECT value FROM app_settings_public WHERE key='collector_status';"
            if ($st -match '"ok":false') { Wn "  one or more syslog listeners FAILED to bind - traffic to those ports is being discarded by the OS" }
            else { Inf "  all syslog listeners bound" }
        } else {
            Bad ("LogVault collector heartbeat is STALE (" + $hb + "s old) - the collector is not running, or cannot write to app_settings")
        }
    } else {
        Bad "LogVault collector has never written a heartbeat (app_settings.collector_status absent) - the header collector indicator cannot report real state"
    }
}

# ---- 10b. SpanVault: ping/SNMP poll heartbeat ----
Write-Host "  --- SpanVault collector (poll heartbeat) ---" -ForegroundColor DarkGray
if ($script:DbReady) {
    # Count active devices. Guard the query exit + non-empty result BEFORE the [int]
    # cast (mirrors the v_devices_flat check above): a query error returns an error
    # string that [int] would silently coerce to 0 and mislabel as "idle by design".
    # monitored_devices.active is the correct column name (verified against the schema).
    $dev = Pg "spanvault" "SELECT count(*) FROM monitored_devices WHERE COALESCE(active,true)=true;"
    if (-not ($script:PgExit -eq 0 -and $dev -match '^\d+$')) {
        Bad ("SpanVault: count of active monitored_devices FAILED: " + $dev)
    } elseif ([int]$dev -eq 0) {
        Inf "No active monitored_devices - SpanVault collector idle by design on a fresh install (add a device to test polling)"
    } else {
        $recent = Pg "spanvault" "SELECT count(*) FROM ping_results WHERE ts > NOW() - INTERVAL '5 minutes';"
        if ($script:PgExit -eq 0 -and [int]$recent -ge 1) { Ok ("SpanVault ping poll ACTIVE (" + $recent + " ping_results in last 5 min across " + $dev + " device(s))") }
        else {
            $last = Pg "spanvault" "SELECT COALESCE(to_char(max(ts),'YYYY-MM-DD HH24:MI:SS'),'never') FROM ping_results;"
            Wn ("SpanVault: " + $dev + " device(s) but no ping_results in last 5 min (last: " + $last + ") - collector idle/slow or poll interval > 5m")
        }
        $snmp = Pg "spanvault" "SELECT count(*) FROM snmp_results WHERE ts > NOW() - INTERVAL '15 minutes';"
        if ([int]$snmp -ge 1) { Ok ("SpanVault SNMP poll ACTIVE (" + $snmp + " snmp_results in last 15 min)") }
        else { Inf "No recent snmp_results (needs an SNMP-enabled device + community string)" }
    }
} else { Wn "SpanVault collector heartbeat needs DB - skipped" }

# ---- 10c. DDIVault: poll heartbeat / liveness ----
Write-Host "  --- DDIVault collector (poll heartbeat) ---" -ForegroundColor DarkGray
if ($script:DbReady) {
    # Guard the query exit + non-empty result BEFORE the [int] cast so a broken/
    # unreadable ddi_servers table reports FAIL instead of false "idle by design".
    $srv = Pg "ddivault" "SELECT count(*) FROM ddi_servers;"
    if (-not ($script:PgExit -eq 0 -and $srv -match '^\d+$')) {
        Bad ("DDIVault: count of ddi_servers FAILED: " + $srv)
    } elseif ([int]$srv -eq 0) {
        Inf "No ddi_servers configured - DDIVault collector idle by design (add a WinRM DHCP/DNS server to test polling)"
    } else {
        $rh = Pg "ddivault" "SELECT count(*) FROM server_health_history WHERE recorded_at > NOW() - INTERVAL '15 minutes';"
        if ($script:PgExit -eq 0 -and [int]$rh -ge 1) { Ok ("DDIVault poll ACTIVE (" + $rh + " server_health_history rows in last 15 min across " + $srv + " server(s))") }
        else {
            $last = Pg "ddivault" "SELECT COALESCE(to_char(max(recorded_at),'YYYY-MM-DD HH24:MI:SS'),'never') FROM server_health_history;"
            Wn ("DDIVault: " + $srv + " server(s) but no health history in last 15 min (last: " + $last + ") - check WinRM reachability + collector-err.log")
        }
    }
} else { Wn "DDIVault collector heartbeat needs DB - skipped" }

# ---- 10d. Collector error-log crash scan ----
Write-Host "  --- Collector / service error logs (crash scan) ---" -ForegroundColor DarkGray
$logTargets = @(
    @{ Name="NetVault";            Path=(Join-Path $InstallDir "NetVault\logs\netvault-error.log") },
    @{ Name="LogVault-Collector";  Path=(Join-Path $InstallDir "LogVault\app\logs\collector-err.log") },
    @{ Name="DDIVault-Collector";  Path=(Join-Path $InstallDir "DDIVault\app\logs\collector-err.log") },
    @{ Name="SpanVault-Collector"; Path=(Join-Path $InstallDir "SpanVault\app\logs\collector-err.log") }
)
$crashPat = "uncaughtException|unhandledRejection|EADDRINUSE|EACCES|MODULE_NOT_FOUND|FATAL|Error: listen|TypeError|ReferenceError"
foreach ($lt in $logTargets) {
    if (Test-Path $lt.Path) {
        $tail = Get-Content $lt.Path -Tail 250 -ErrorAction SilentlyContinue
        $hits = $tail | Select-String -Pattern $crashPat -ErrorAction SilentlyContinue
        if ($hits) {
            $sample = ($hits[-1].Line).Trim()
            if ($sample.Length -gt 160) { $sample = $sample.Substring(0,160) + "..." }
            Wn ($lt.Name + ": " + $hits.Count + " crash-pattern line(s) in last 250 of " + (Split-Path $lt.Path -Leaf) + " - sample: " + $sample)
        } else { Ok ($lt.Name + ": no crash patterns in recent error log") }
    } else {
        Inf ($lt.Name + ": no error log at " + $lt.Path + " (often a clean start)")
    }
}

if ($script:DbReady) { $env:PGPASSWORD = $null }

# ---------------------------------------------------------------
Section "SUMMARY"
Write-Host ("  PASS : " + $script:Pass) -ForegroundColor Green
Write-Host ("  WARN : " + $script:Warn) -ForegroundColor Yellow
Write-Host ("  FAIL : " + $script:Fail) -ForegroundColor Red
if ($script:Fail -gt 0) {
    Write-Host ""
    Write-Host "  Failed checks:" -ForegroundColor Red
    foreach ($f in $script:Failures) { Write-Host ("   - " + $f) -ForegroundColor Red }
    Write-Host ""
    Write-Host "  RESULT: NOT fully healthy - review FAILs above." -ForegroundColor Red
} elseif ($script:Warn -gt 0) {
    Write-Host ""
    Write-Host "  RESULT: Healthy, with warnings to eyeball (some are expected on a fresh box with no devices added)." -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "  RESULT: ALL CHECKS PASSED - production-like." -ForegroundColor Green
}
Write-Host ""
Write-Host "  Manual checks still recommended: browser login + SSO into each app;" -ForegroundColor Cyan
Write-Host "  add one real device per app (syslog source / SNMP device / WinRM DDI server)" -ForegroundColor Cyan
Write-Host "  and confirm live data appears." -ForegroundColor Cyan
Write-Host ""
Write-Host "  (Copy ALL output above and paste it back for review.)" -ForegroundColor Cyan
