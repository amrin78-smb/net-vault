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
    4. HTTP health + deployed versions for all 4 apps
    5. Public endpoints + launcher performance (suite probes, cache, license)
    6. NextAuth / login smoke (best-effort)
    7. Scheduled tasks (the 3 NetVault cron tasks)
    8. Firewall rules (NocVault*)
    9. Database deep checks (schema, the 3 bug-fixes, tamper model, grants, seed,
       Hub cross-DB reads incl. column-level grants, and the credential/secret
       exclusions -- readonly role blocked from secret columns + *_public views)
   10. COLLECTORS:
        - LogVault : live synthetic syslog packet -> confirm it lands in the DB
                     (full pipeline: socket -> parser -> taxonomy -> DB)
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
function Resolve-PgPassword([string]$installDir) {
    $candidates = @(
        'C:\ProgramData\NocVault\secrets.env',
        (Join-Path $installDir 'NetVault\app\.env'),
        (Join-Path $installDir 'LogVault\app\.env.local'),
        (Join-Path $installDir 'DDIVault\app\.env.local'),
        (Join-Path $installDir 'SpanVault\app\.env.local')
    )
    foreach ($f in $candidates) { $v = Get-EnvVal $f 'POSTGRES_PASSWORD'; if ($v) { return $v } }
    return $null
}

function VerGE($got, $min) { try { return ([version]$got -ge [version]$min) } catch { return $false } }

function Http($url, [int]$timeoutSec = 15, [switch]$NoRedirect) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $p = @{ Uri = $url; UseBasicParsing = $true; TimeoutSec = $timeoutSec; ErrorAction = "Stop" }
        if ($NoRedirect) { $p["MaximumRedirection"] = 0 }
        $r = Invoke-WebRequest @p
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
        $PgPassword = Resolve-PgPassword $InstallDir
        if ($PgPassword) {
            Inf "Using stored PostgreSQL password."
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
$nssm = $null
foreach ($n in @("$InstallDir\NetVault\nssm\nssm-2.24\win64\nssm.exe",
                 "C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe",
                 "$InstallDir\nssm\nssm-2.24\win64\nssm.exe")) {
    if (Test-Path $n) { $nssm = $n; break }
}
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
Section "4. HTTP Health + Versions"
$apps = @(
    @{ Name="netvault";  Port=3000; Min="1.19.7" },
    @{ Name="logvault";  Port=3004; Min="2.18.2" },
    @{ Name="ddivault";  Port=3006; Min="1.17.0" },
    @{ Name="spanvault"; Port=3008; Min="1.48.4" }
)
foreach ($a in $apps) {
    $r = Http ("http://127.0.0.1:" + $a.Port + "/api/health") 20
    if ($r.Code -eq 200 -and $r.Content) {
        $ver = $null
        try { $ver = ($r.Content | ConvertFrom-Json).version } catch {}
        if ($ver) {
            if (VerGE $ver $a.Min) { Ok ($a.Name + " health 200, version " + $ver + " (>= " + $a.Min + "), " + $r.Ms + "ms") }
            else { Wn ($a.Name + " health 200 but version " + $ver + " BELOW expected " + $a.Min) }
        } else { Wn ($a.Name + " health 200 but no version field; raw: " + $r.Content) }
    } else { Bad ($a.Name + " health FAILED (code=" + $r.Code + " err=" + $r.Err + ")") }
}

# ---------------------------------------------------------------
Section "5. Public Endpoints + Launcher Performance"
$sh1 = Http "http://127.0.0.1:3000/api/suite/health" 12
if ($sh1.Code -eq 200) {
    $sh2 = Http "http://127.0.0.1:3000/api/suite/health" 12
    Ok ("/api/suite/health 200 (cold " + $sh1.Ms + "ms, warm " + $sh2.Ms + "ms)")
    if ($sh1.Ms -gt 3000) { Wn ("suite/health cold > 3s (" + $sh1.Ms + "ms) - a sibling app may be slow") }
} else { Bad ("/api/suite/health FAILED (code=" + $sh1.Code + ")") }

$ss1 = Http "http://127.0.0.1:3000/api/suite/stats" 12
if ($ss1.Code -eq 200) {
    $ss2 = Http "http://127.0.0.1:3000/api/suite/stats" 12
    Ok ("/api/suite/stats 200 (cold " + $ss1.Ms + "ms, warm " + $ss2.Ms + "ms)")
    if ($ss2.Ms -lt $ss1.Ms) { Inf "warm call faster -> in-memory cache appears active" }
} else { Bad ("/api/suite/stats FAILED (code=" + $ss1.Code + ")") }

$lic = Http "http://127.0.0.1:3000/api/license" 12
if ($lic.Code -eq 200 -and $lic.Content) {
    $sid = $null; try { $sid = ($lic.Content | ConvertFrom-Json).serverId } catch {}
    Ok ("/api/license 200 (" + $lic.Ms + "ms)" + $(if ($sid) { " serverId=" + $sid } else { "" }))
} else { Wn ("/api/license code=" + $lic.Code) }

$set = Http "http://127.0.0.1:3000/api/settings" 12
if ($set.Code -eq 200) { Ok ("/api/settings 200 (" + $set.Ms + "ms)") } else { Wn ("/api/settings code=" + $set.Code) }

$lvs = Http "http://127.0.0.1:3004/api/stats" 12
if ($lvs.Code -eq 200) { Ok ("LogVault /api/stats 200 (" + $lvs.Ms + "ms)") } else { Wn ("LogVault /api/stats code=" + $lvs.Code) }

# NocVault Agent bootstrap (Phase 2 hub-served bundle). The minted install
# one-liner does `irm <hub>/api/agents/install.ps1`, which in turn pulls the
# agent files from /api/agents/bundle. Both are PUBLIC (no session). These 503
# (never 200) if the on-disk agent\ dir isn't present at the standalone runtime
# root - the exact failure mode that would make a minted install command 404.
$aps = Http "http://127.0.0.1:3000/api/agents/install.ps1" 12
if ($aps.Code -eq 200 -and $aps.Content -match 'param\(' -and $aps.Content -match 'NocVault-Agent') {
    Ok ("/api/agents/install.ps1 serves the installer (200, " + $aps.Ms + "ms)")
} else {
    Bad ("/api/agents/install.ps1 FAILED (code=" + $aps.Code + ") - agent installer not served (minted install one-liner would 404)")
}
$abn = Http "http://127.0.0.1:3000/api/agents/bundle" 12
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
$aum = Http "http://127.0.0.1:3000/api/agents/update-manifest" 12
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
    $rf = Invoke-WebRequest "http://127.0.0.1:3000/api/agents/smoke-test/refresh" -Method Post -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
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
    $lf = Invoke-WebRequest "http://127.0.0.1:3000/api/agents/smoke-test/logs" -Method Post -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
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
    $cf = Invoke-WebRequest "http://127.0.0.1:3000/api/agents/smoke-test/commands" -Method Post -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
    $cmdCode = [int]$cf.StatusCode
} catch {
    if ($_.Exception.Response) { try { $cmdCode = [int]$_.Exception.Response.StatusCode } catch {} }
}
if ($cmdCode -eq 401) {
    Ok "/api/agents/<id>/commands exists and is session-gated (unauthed POST -> 401)"
} else {
    Bad ("/api/agents/<id>/commands unauthed POST returned code=" + $cmdCode + " (expected 401 - route missing or not gated)")
}

$root = Http "http://127.0.0.1:3000/" 12 -NoRedirect
if ($root.Code -ge 300 -and $root.Code -lt 400) { Ok ("NetVault / redirects (" + $root.Code + " -> " + $root.Loc + ")") }
elseif ($root.Code -eq 200) { Inf "NetVault / returned 200 (no redirect)" }
else { Wn ("NetVault / code=" + $root.Code) }

$login = Http "http://127.0.0.1:3000/login" 12
if ($login.Code -eq 200) { Ok "NetVault /login renders (200)" } else { Wn ("NetVault /login code=" + $login.Code) }

# ---------------------------------------------------------------
Section "6. Auth / NextAuth"
$csrf = Http "http://127.0.0.1:3000/api/auth/csrf" 12
if ($csrf.Code -eq 200 -and $csrf.Content) {
    $tok = $null; try { $tok = ($csrf.Content | ConvertFrom-Json).csrfToken } catch {}
    if ($tok) { Ok "NextAuth csrf endpoint OK (auth stack is up)" } else { Wn "csrf 200 but no token parsed" }
} else { Bad ("NextAuth csrf FAILED (code=" + $csrf.Code + ")") }

if ($TestLogin) {
    Inf "Attempting credentials login with default admin (admin@yourcompany.com / Admin1234!) ..."
    try {
        $sess = $null
        $c = Invoke-WebRequest "http://127.0.0.1:3000/api/auth/csrf" -UseBasicParsing -SessionVariable sess -TimeoutSec 12
        $tk = ($c.Content | ConvertFrom-Json).csrfToken
        $body = @{ csrfToken = $tk; email = "admin@yourcompany.com"; password = "Admin1234!"; redirect = "false"; json = "true" }
        $null = Invoke-WebRequest "http://127.0.0.1:3000/api/auth/callback/credentials" -Method Post -Body $body -WebSession $sess -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 12 -ErrorAction SilentlyContinue
        $hasSession = $false
        foreach ($ck in $sess.Cookies.GetCookies("http://127.0.0.1:3000")) { if ($ck.Name -like "*session-token*") { $hasSession = $true } }
        if ($hasSession) { Ok "Login smoke: session cookie issued (default admin login works)" }
        else { Wn "Login smoke: no session cookie - default password may have changed, or flow differs. Verify in browser." }
    } catch { Wn ("Login smoke error: " + $_.Exception.Message) }
} else {
    Inf "Skipping live login (pass -TestLogin). Verify a real browser login + SSO into each app manually."
}

# ---------------------------------------------------------------
Section "7. Scheduled Tasks (NetVault cron)"
foreach ($t in @("NetVault-HealthSnapshot","NetVault-EnrichEol","NetVault-SyncEol")) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task) { Ok ($t + " registered (State=" + $task.State + ")") } else { Bad ($t + " NOT registered") }
}

# ---------------------------------------------------------------
Section "8. Firewall Rules (NocVault*)"
$fw = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "NocVault*" }
if ($fw) {
    Ok ("Found " + ($fw | Measure-Object).Count + " NocVault firewall rule(s)")
    foreach ($r in $fw) { Inf (" - " + $r.DisplayName + " [" + $r.Enabled + "/" + $r.Direction + "/" + $r.Action + "]") }
} else { Wn "No firewall rules matching 'NocVault*'" }

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
    # new column is hidden by default — verify that actually held rather than
    # assuming it.
    $mfaLeak = Pg "netvault" "SELECT count(*) FROM information_schema.columns WHERE table_name='users_public' AND column_name LIKE 'mfa%';"
    if ($script:PgExit -eq 0 -and $mfaLeak -eq "0") { Ok "users_public exposes no MFA columns (secret not readable by diagnostics)" } else { Bad ("users_public LEAKS MFA columns (got '" + $mfaLeak + "')") }
    $aset = Pg "netvault" "SELECT count(*) FROM app_settings;"
    if ($script:PgExit -eq 0) { Ok ("app_settings present (" + $aset + " keys)") } else { Bad "app_settings unreadable" }
    # agent_registry — NocVault Agents Phase 2 hub control plane (netvault 1.24.0).
    # ROLE-SCOPED: the netvault app role must be able to SELECT each of the 4 tables.
    # agent_commands (Phase 4a poll-carried command channel) is included below —
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
    # ROLE-SCOPED: reporting engine tables (2.20.0) — mirrors the DDIVault check above.
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
        @{ Db="netvault";  Tbl="app_settings" }
    )
    $vwOk = $true; $vwBad = @()
    foreach ($v in $secView) {
        $base = Pg $v.Db "SELECT has_table_privilege('nocvault_readonly','$($v.Tbl)','SELECT');"
        $pub  = Pg $v.Db "SELECT has_table_privilege('nocvault_readonly','$($v.Tbl)_public','SELECT');"
        if ($base -ne "f") { $vwOk = $false; $vwBad += ($v.Db + "." + $v.Tbl + " base READABLE") }
        if ($pub  -ne "t") { $vwOk = $false; $vwBad += ($v.Db + "." + $v.Tbl + "_public NOT readable/missing") }
    }
    if ($vwOk) { Ok "nocvault_readonly reads the filtered *_public views (app_settings/api_keys/smtp_config/users) but NOT the secret base tables" }
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
        $det = Pg "logvault" "SELECT vendor||' | cat='||COALESCE(category,'(null)')||' | risk='||risk_score::text||' | hashed='||(entry_hash IS NOT NULL)::text FROM syslog_entries WHERE raw_message LIKE '%$token%' ORDER BY received_at DESC LIMIT 1;"
        Inf ("  parsed: " + $det)
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
