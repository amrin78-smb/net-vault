<#
================================================================
  NocVault Suite - Post-Install Smoke Test  (v2.0)
  Run this ON THE SERVER/LAPTOP where the suite was installed.

  WHAT IT CHECKS
    1. Environment (psql / node present, server IP, DB connect)
    2. Windows services (all 10 NSSM services Running)
    3. TCP/UDP ports listening
    4. HTTP health + deployed versions for all 4 apps
    5. Public endpoints + launcher performance (suite probes, cache, license)
    6. NextAuth / login smoke (best-effort)
    7. Scheduled tasks (the 3 NetVault cron tasks)
    8. Firewall rules (NocVault*)
    9. Database deep checks (schema, the 3 bug-fixes, tamper model, grants, seed)
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
Section "NocVault Suite Smoke Test (v2.0)"
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
        $sec = Read-Host "Enter PostgreSQL 'postgres' password" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        $PgPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
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

# LogVault-API must carry SERVER_IP in its service env, or LogVault's in-app update
# (its API requires SERVER_IP) silently fails on fresh installs. Read it back via nssm.
$nssm = $null
foreach ($n in @("$InstallDir\NetVault\nssm\nssm-2.24\win64\nssm.exe",
                 "C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe",
                 "$InstallDir\nssm\nssm-2.24\win64\nssm.exe")) {
    if (Test-Path $n) { $nssm = $n; break }
}
if (-not $nssm) { $c = Get-Command nssm -ErrorAction SilentlyContinue; if ($c) { $nssm = $c.Source } }
if (-not $nssm) {
    Wn "nssm.exe not found - cannot verify LogVault-API SERVER_IP env (skipped)"
} else {
    $lvApiEnv = (& $nssm get LogVault-API AppEnvironmentExtra 2>$null | Out-String)
    if ($lvApiEnv -match "SERVER_IP") { Ok "LogVault-API service env contains SERVER_IP (in-app update can resolve server IP)" }
    else { Bad "LogVault-API service env MISSING SERVER_IP - LogVault in-app update will fail" }
}

# ---------------------------------------------------------------
Section "3. Ports Listening"
$tcpPorts = @{
    3000 = "NetVault / Hub (public)"; 3004 = "LogVault-App (public)"; 3005 = "LogVault-API (internal)";
    3006 = "DDIVault-App (public)";   3007 = "DDIVault-API (internal)";
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
Section "4. HTTP Health + Versions"
$apps = @(
    @{ Name="netvault";  Port=3000; Min="1.19.7" },
    @{ Name="logvault";  Port=3004; Min="2.18.2" },
    @{ Name="ddivault";  Port=3006; Min="1.15.3" },
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
    $col = Pg "netvault" "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='support_vendor_id');"
    if ($col -eq "t") { Ok "devices.support_vendor_id column exists" } else { Bad ("devices.support_vendor_id missing (got '" + $col + "')") }
    $vw = Pg "netvault" "SELECT to_regclass('public.v_devices_flat') IS NOT NULL;"
    if ($vw -eq "t") { Ok "v_devices_flat view exists" } else { Bad ("v_devices_flat view MISSING (got '" + $vw + "')") }
    $vsel = Pg "netvault" "SELECT count(*) FROM v_devices_flat;"
    if ($script:PgExit -eq 0) { Ok ("v_devices_flat queryable (" + $vsel + " rows)") } else { Bad ("SELECT from v_devices_flat FAILED: " + $vsel) }
    $usr = Pg "netvault" "SELECT count(*) FROM users;"
    if ($script:PgExit -eq 0 -and [int]$usr -ge 1) { Ok ("users seeded (" + $usr + " row(s))") } else { Bad ("users empty/unreadable (" + $usr + ")") }
    $aset = Pg "netvault" "SELECT count(*) FROM app_settings;"
    if ($script:PgExit -eq 0) { Ok ("app_settings present (" + $aset + " keys)") } else { Bad "app_settings unreadable" }

    Write-Host "  --- DDIVault (uuid-ossp fix) ---" -ForegroundColor DarkGray
    $ext = Pg "ddivault" "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='uuid-ossp');"
    if ($ext -eq "t") { Ok "uuid-ossp extension installed" } else { Bad ("uuid-ossp MISSING (got '" + $ext + "')") }
    $ddt = Pg "ddivault" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ddi_servers','dhcp_scopes','dns_zones','ipam_subnets');"
    if ($ddt -eq "4") { Ok "DDIVault core tables present" } else { Bad ("DDIVault core tables: expected 4, found " + $ddt) }

    Write-Host "  --- SpanVault (map shapes + connection waypoints) ---" -ForegroundColor DarkGray
    $ms = Pg "spanvault" "SELECT to_regclass('public.map_shapes') IS NOT NULL;"
    if ($ms -eq "t") { Ok "map_shapes table exists" } else { Bad ("map_shapes MISSING (got '" + $ms + "')") }
    $mc = Pg "spanvault" "SELECT count(*) FROM information_schema.columns WHERE table_name='map_shapes' AND column_name IN ('locked','group_id');"
    if ($mc -eq "2") { Ok "map_shapes has locked + group_id columns" } else { Bad ("map_shapes locked/group_id: expected 2, found " + $mc) }
    $wp = Pg "spanvault" "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='map_connections' AND column_name='waypoints');"
    if ($wp -eq "t") { Ok "map_connections.waypoints column exists (adjustable elbow lines)" } else { Bad ("map_connections.waypoints missing (got '" + $wp + "')") }
    $svt = Pg "spanvault" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('monitored_devices','alerts','sv_maps','wireless_controllers');"
    if ($svt -eq "4") { Ok "SpanVault core tables present" } else { Bad ("SpanVault core tables: expected 4, found " + $svt) }

    Write-Host "  --- LogVault (append-only tamper model) ---" -ForegroundColor DarkGray
    $se = Pg "logvault" "SELECT to_regclass('public.syslog_entries') IS NOT NULL;"
    if ($se -eq "t") { Ok "syslog_entries table exists" } else { Bad ("syslog_entries MISSING (got '" + $se + "')") }
    $ins = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','INSERT');"
    $upd = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','UPDATE');"
    $del = Pg "logvault" "SELECT has_table_privilege('logvault_user','syslog_entries','DELETE');"
    if ($ins -eq "t") { Ok "logvault_user CAN INSERT syslog_entries" } else { Bad ("logvault_user cannot INSERT (got '" + $ins + "')") }
    if ($upd -eq "f" -and $del -eq "f") { Ok "logvault_user CANNOT UPDATE/DELETE syslog_entries (tamper model intact)" }
    else { Bad ("Tamper model BROKEN: UPDATE=" + $upd + " DELETE=" + $del + " (expected f/f)") }

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

    # nocvault_readonly can actually connect + SELECT?
    Write-Host "  --- nocvault_readonly (Hub cross-DB role) ---" -ForegroundColor DarkGray
    $roSel = Pg "netvault" "SELECT has_table_privilege('nocvault_readonly','devices','SELECT');"
    if ($roSel -eq "t") { Ok "nocvault_readonly has SELECT on netvault.devices" }
    elseif ($roSel -eq "f") { Wn "nocvault_readonly exists but lacks SELECT on devices (Hub cross-DB reads may be limited)" }
    else { Wn ("nocvault_readonly privilege check inconclusive (" + $roSel + ")") }
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

# ---- 10b. SpanVault: ping/SNMP poll heartbeat ----
Write-Host "  --- SpanVault collector (poll heartbeat) ---" -ForegroundColor DarkGray
if ($script:DbReady) {
    $dev = Pg "spanvault" "SELECT count(*) FROM monitored_devices WHERE COALESCE(active,true)=true;"
    if ([int]$dev -eq 0) {
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
    $srv = Pg "ddivault" "SELECT count(*) FROM ddi_servers;"
    if ([int]$srv -eq 0) {
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
