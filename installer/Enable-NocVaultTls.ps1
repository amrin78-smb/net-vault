#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Turn HTTPS on for a NocVault suite that is ALREADY INSTALLED.
.DESCRIPTION
    Registers the shared TLS terminator (NocVault-Tls), moves the four consoles
    to 127.0.0.1, and proves HTTPS on 3000/3004/3006/3008 before committing. If
    anything fails it puts everything back and removes the service, leaving the
    suite exactly as it found it on plain HTTP.

    ⛔ WHY THIS EXISTS. Until now the suite INSTALLER was the only thing that
    could perform a cutover, so the only way to turn HTTPS on afterwards was to
    re-run the whole installer — which re-clones and rebuilds all four apps, and
    rewrites every .env from a fixed template that contains no ENTRA_* keys. An
    operator who had configured single sign-on and then ran the installer to get
    the HTTPS that single sign-on requires would silently lose the tenant, the
    client id and the client secret. This script changes service parameters and
    the env keys it owns, and nothing else.

    ⛔ IT SHARES ITS BODY WITH THE INSTALLER, IT DOES NOT REIMPLEMENT IT. The
    gates and the cutover are dot-sourced from NocVault-TlsPreflight.ps1 and
    NocVault-TlsCutover.ps1, which are the installer's own code moved into files
    both callers read. Two copies of a cutover are two cutovers that can
    disagree, and only one of them would be the tested one.
.PARAMETER InstallDir
    Root installation directory (default: C:\Apps)
.PARAMETER TlsCertPath
    PEM certificate (leaf + chain). Omit BOTH this and -TlsKeyPath to use, or
    mint, the pair at C:\ProgramData\NocVault\certs.
.PARAMETER TlsKeyPath
    PEM private key. Both or neither — one alone is refused, not completed.
.PARAMETER TlsPublicHost
    The hostname users type. Pins NEXTAUTH_URL to it instead of the IP.
.PARAMETER NoSelfSignedTls
    Do not mint a self-signed certificate if none is present. Without a
    certificate the gates fail and nothing is changed.
.PARAMETER OpenHttpRedirectPorts
    Also open the dedicated HTTP redirect ports (3080/3084/3086/3088).
.PARAMETER Disable
    Turn HTTPS back OFF: stop and remove NocVault-Tls, put the four consoles
    back on their public ports on 0.0.0.0, and set NEXTAUTH_URL back to http://.
    The cutover's own revert only exists inside a failed run, so without this
    there is no supported way back once a cutover has SUCCEEDED - only editing
    four services by hand.
.PARAMETER DryRun
    Evaluate the gates and report what WOULD happen. Changes nothing: no
    service is registered, no console is moved, no env file is edited. A
    certificate may still be minted — that is a file write under ProgramData
    and nothing else, and it is what makes the dry run's verdict real.
.EXAMPLE
    .\Enable-NocVaultTls.ps1 -DryRun
    .\Enable-NocVaultTls.ps1
    .\Enable-NocVaultTls.ps1 -TlsPublicHost nocvault.example.com -TlsCertPath C:\certs\wild.pem -TlsKeyPath C:\certs\wild.key
#>
param(
    [string]$InstallDir            = "C:\Apps",
    [string]$TlsCertPath           = "",
    [string]$TlsKeyPath            = "",
    [string]$TlsPublicHost         = "",
    [switch]$NoSelfSignedTls,
    [switch]$OpenHttpRedirectPorts,
    [switch]$DryRun,
    [switch]$Disable
)

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    [--] $msg" -ForegroundColor Gray }

Write-Host ""
Write-Host "  +============================================+" -ForegroundColor White
Write-Host "  |   NocVault - Enable HTTPS on an existing    |" -ForegroundColor White
Write-Host "  |   installation                              |" -ForegroundColor White
Write-Host "  +============================================+" -ForegroundColor White
if ($DryRun) { Write-Host "  DRY RUN - nothing will be changed" -ForegroundColor Yellow }
Write-Host ""

# ── Locate the sibling helpers ────────────────────────────────────
# Same guarded pattern the installer uses, and the same reason: a compiled .exe
# has an EMPTY $PSScriptRoot, so the folder is resolved from $PSCommandPath too.
$NocTlsHelperDir = $PSScriptRoot
if (-not $NocTlsHelperDir -and $PSCommandPath) { $NocTlsHelperDir = Split-Path -Parent $PSCommandPath }
if (-not $NocTlsHelperDir) { throw "Could not determine this script's own folder." }

$script:TlsHelperLoaded = $false
$script:TlsHelperError  = ''
$helper = Join-Path $NocTlsHelperDir 'NocVault-Tls.ps1'
if (Test-Path -LiteralPath $helper) {
    try { . $helper; $script:TlsHelperLoaded = $true }
    catch { $script:TlsHelperError = "could not be loaded: $($_.Exception.Message)" }
} else {
    $script:TlsHelperError = "was not found beside this script"
}

foreach ($n in 'NocVault-TlsPreflight.ps1', 'NocVault-TlsCutover.ps1') {
    if (-not (Test-Path -LiteralPath (Join-Path $NocTlsHelperDir $n))) {
        throw "$n is missing from $NocTlsHelperDir. Ship the whole installer folder together."
    }
}

# ── Discover the installation ─────────────────────────────────────
# ⛔ DISCOVERED, NEVER ASSUMED. The installer knows what it is about to build;
# this script has to read what is already there. Which apps are installed is
# decided by which SERVICES EXIST, not by which directories do: a directory can
# survive a failed install, and the cutover's whole job is to move services.
$NVDir = Join-Path $InstallDir 'NetVault'

function Test-NocService([string]$n) { [bool](Get-Service -Name $n -ErrorAction SilentlyContinue) }

# ⛔ THE INSTALL PATHS ARE NOT UNIFORM, AND GUESSING ONE IS HOW THIS BREAKS.
# NetVault and SpanVault live at <InstallDir>\<App>\app; LogVault and DDIVault
# are deployed with the REPO ROOT AS THE INSTALL ROOT on at least one real
# server — <InstallDir>\LogVault, no 'app' subfolder. Measured on production
# 2026-11-05: C:\Apps\LogVault\app does not exist there.
#
# A wrong directory here is not a crash, which is what makes it dangerous: the
# cutover would move that console to loopback and then fail to rewrite a
# NEXTAUTH_URL in a file that is not there, aborting mid-way.
#
# ⛔ AND NSSM'S AppDirectory IS *NOT* THE REPO ROOT. The first version of this
# asked the service for its AppDirectory and used it directly, reasoning that
# the directory a console actually runs from must be authoritative. It is
# authoritative — about something else. A dry run on production returned:
#
#   netvault  -> C:\Apps\NetVault\app\.next\standalone   (the build output)
#   logvault  -> C:\Apps\logvault\frontend                (the Next frontend)
#   spanvault -> C:\Apps\SpanVault\app\frontend
#
# Those are the WORKING DIRECTORIES of the processes, and the cutover would have
# gone looking for <that>\installer\terminator\start.mjs and found nothing.
# Worse, the env-file check PASSED, because a .env.local really does exist in
# both of those directories — just not the one the app reads at the repo root.
#
# So: start from the service's own working directory, which is at least
# guaranteed to be INSIDE the installation, and walk UP to the git checkout.
# Every app directory this installer creates is a clone, so `.git` is the one
# marker that identifies a repo root independently of how deep the service runs.
function Resolve-NocAppDir([string]$service, [string]$appName, [string]$nssm) {
    $fromService = ''
    if ($nssm -and (Test-NocService $service)) {
        try {
            $raw = (& $nssm get $service AppDirectory 2>&1 | Out-String) -replace "`0", ''
            $fromService = $raw.Trim()
        } catch { $fromService = '' }
    }

    # ⛔ THE OUTERMOST CHECKOUT, NOT THE FIRST ONE FOUND. Next's `output:
    # 'standalone'` build produces a near-complete COPY of the repository, and
    # on production that copy contains .git, package.json AND
    # installer\terminator\start.mjs. Measured:
    #
    #   C:\Apps\NetVault\app\.next\standalone   .git=True  pkg=True  start.mjs=True
    #   C:\Apps\NetVault\app                     .git=True  pkg=True  start.mjs=True
    #
    # So a walk that stops at the first marker stops inside the build output —
    # and every check then passes against a copy. The terminator would even have
    # STARTED from there; what would not have worked is the env files, because
    # the console's real .env is at the repo root and NEXTAUTH_URL would have
    # been written into a directory the app does not read. Walking to the
    # OUTERMOST match lands on the root in both shapes.
    #
    # ⛔ AND A BUILD-OUTPUT PATH IS REJECTED OUTRIGHT. `\.next\` can never be an
    # install root whatever markers it happens to contain; saying so structurally
    # is worth more than relying on the walk order alone.
    function Test-NocBuildOutput([string]$d) {
        return ($d -and ($d.ToLower() -replace '/', '\') -match '\\\.next\\')
    }
    if ($fromService -and (Test-Path -LiteralPath $fromService)) {
        $best = ''
        $d = $fromService
        $stopAt = $InstallDir.TrimEnd('\').ToLower()
        for ($i = 0; $i -lt 6 -and $d; $i++) {
            if ((Test-Path -LiteralPath (Join-Path $d '.git')) -and -not (Test-NocBuildOutput $d)) { $best = $d }
            $parent = Split-Path -Parent $d
            if (-not $parent -or $parent -eq $d) { break }
            # Never walk out of the installation root: a .git above it belongs
            # to somebody else.
            if ($parent.TrimEnd('\').ToLower() -eq $stopAt) { break }
            $d = $parent
        }
        if ($best) { return $best }
    }

    # Fall back to probing both known layouts, newest-convention first, and
    # still require the marker rather than accepting any directory that exists.
    foreach ($cand in @((Join-Path (Join-Path $InstallDir $appName) 'app'),
                        (Join-Path $InstallDir $appName))) {
        if ((Test-Path -LiteralPath (Join-Path $cand '.git')) -and -not (Test-NocBuildOutput $cand)) { return $cand }
    }
    foreach ($cand in @((Join-Path (Join-Path $InstallDir $appName) 'app'),
                        (Join-Path $InstallDir $appName))) {
        if ((Test-Path -LiteralPath (Join-Path $cand 'package.json')) -and -not (Test-NocBuildOutput $cand)) { return $cand }
    }
    return ''
}

Write-Step "Reading the installation"
if (-not (Test-NocService 'NetVault')) {
    throw "No NetVault service on this machine, so there is nothing to cut over. Run the suite installer first."
}
$InstallLogVault  = Test-NocService 'LogVault-App'
$InstallDDIVault  = Test-NocService 'DDIVault-App'
$InstallSpanVault = Test-NocService 'SpanVault-App'
Write-OK ("Consoles found: netvault" +
          $(if ($InstallLogVault)  { ', logvault' }  else { '' }) +
          $(if ($InstallDDIVault)  { ', ddivault' }  else { '' }) +
          $(if ($InstallSpanVault) { ', spanvault' } else { '' }))

# nssm.exe: read it from the service that is already using it rather than
# guessing a path. The installer puts it under <InstallDir>\NetVault\nssm, but a
# machine installed by an older build may have it elsewhere, and the one the
# running services were registered with is by definition the right one.
$NssmExe = $null
try {
    $svcPath = (Get-CimInstance Win32_Service -Filter "Name='NetVault'" -ErrorAction Stop).PathName
    if ($svcPath -match '^"?(.*?nssm\.exe)"?') { $NssmExe = $Matches[1] }
} catch {}
if (-not $NssmExe -or -not (Test-Path -LiteralPath $NssmExe)) {
    $fallback = Join-Path $NVDir 'nssm\nssm.exe'
    if (Test-Path -LiteralPath $fallback) { $NssmExe = $fallback }
}
if (-not $NssmExe) { throw "Could not find nssm.exe (looked at the NetVault service's own ImagePath and $NVDir\nssm)." }
Write-OK "nssm: $NssmExe"

# Now that nssm is known, ask each service where it actually runs from.
$NVAppDir  = Resolve-NocAppDir 'NetVault'      'NetVault'  $NssmExe
$LVAppDir  = Resolve-NocAppDir 'LogVault-App'  'LogVault'  $NssmExe
$DDIAppDir = Resolve-NocAppDir 'DDIVault-App'  'DDIVault'  $NssmExe
$SVAppDir  = Resolve-NocAppDir 'SpanVault-App' 'SpanVault' $NssmExe
if (-not $NVAppDir) { throw "Could not locate NetVault's application directory under $InstallDir." }
# ⛔ THE TERMINATOR'S ENTRY POINT IS THE PROOF. Everything else about a resolved
# path can look plausible — the dry run that caught this reported four
# directories that all existed and all had an .env.local in them. The one thing
# only the real repo root has is the script NocVault-Tls is registered to run,
# and if it is not there the terminator cannot start, so check for it HERE
# rather than discovering it at gate 3 with four consoles already on loopback.
$terminatorEntry = Join-Path $NVAppDir 'installer\terminator\start.mjs'
if (-not (Test-Path -LiteralPath $terminatorEntry)) {
    throw "Resolved NetVault to '$NVAppDir', but $terminatorEntry is not there - so that is not the repository root and the terminator could not start. Nothing has been changed."
}
# ⛔ AND IT MUST NOT BE THE BUILD OUTPUT. start.mjs exists in BOTH the repo root
# and .next\standalone (Next copies it), so its presence alone proves nothing —
# which is exactly how the first attempt at this guard passed against a copy.
if (($NVAppDir.ToLower() -replace '/','\\') -match '\\\.next\\') {
    throw "Resolved NetVault to '$NVAppDir', which is inside a .next build output rather than the installation root. Nothing has been changed."
}
Write-OK "netvault  : $NVAppDir"
if ($InstallLogVault)  { if ($LVAppDir)  { Write-OK "logvault  : $LVAppDir" }  else { throw "LogVault-App exists but its directory could not be located." } }
if ($InstallDDIVault)  { if ($DDIAppDir) { Write-OK "ddivault  : $DDIAppDir" } else { throw "DDIVault-App exists but its directory could not be located." } }
if ($InstallSpanVault) { if ($SVAppDir)  { Write-OK "spanvault : $SVAppDir" }  else { throw "SpanVault-App exists but its directory could not be located." } }

# ⛔ AND THE ENV FILES MUST REALLY BE THERE. The cutover rewrites NEXTAUTH_URL in
# each console's env file; Set-EnvFileKey returns false for a file that does not
# exist, which aborts the cutover PART WAY THROUGH. Far better to find out here,
# before a single service has been touched.
$envTargets = @{}
$envTargets['netvault'] = @((Join-Path $NVAppDir '.env'), (Join-Path $NVAppDir '.next\standalone\.env.local'))
if ($InstallLogVault)  { $envTargets['logvault']  = @((Join-Path $LVAppDir '.env.local'),  (Join-Path $LVAppDir 'frontend\.env.local')) }
if ($InstallDDIVault)  { $envTargets['ddivault']  = @((Join-Path $DDIAppDir '.env.local'), (Join-Path $DDIAppDir 'frontend\.env.local')) }
if ($InstallSpanVault) { $envTargets['spanvault'] = @((Join-Path $SVAppDir '.env.local'),  (Join-Path $SVAppDir 'frontend\.env.local')) }
$missingEnv = @()
foreach ($app in $envTargets.Keys) {
    $present = @($envTargets[$app] | Where-Object { Test-Path -LiteralPath $_ })
    if ($present.Count -eq 0) { $missingEnv += ("{0} (looked for: {1})" -f $app, ($envTargets[$app] -join ', ')) }
}
if ($missingEnv.Count -gt 0) {
    Write-Warn "No environment file found for: $($missingEnv -join '; ')"
    throw "The cutover rewrites NEXTAUTH_URL in each console's environment file, and at least one console has none where expected. Nothing has been changed."
}
Write-OK "Environment files located for every installed console"

# ServerIP: the address this install was built on. Read from NetVault's .env so
# the terminator's certificate and NEXTAUTH_URL agree with what is already
# there, instead of re-deriving it and quietly changing the console's address.
$ServerIP = ''
$nvEnv = Join-Path $NVAppDir '.env'
if (Test-Path -LiteralPath $nvEnv) {
    foreach ($line in (Get-Content -LiteralPath $nvEnv -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*SERVER_IP\s*=\s*(.+?)\s*$') { $ServerIP = $Matches[1].Trim() }
    }
}
if (-not $ServerIP) {
    $ServerIP = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                 Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
                 Select-Object -First 1).IPAddress
    Write-Warn "SERVER_IP not found in $nvEnv - using $ServerIP"
} else {
    Write-OK "Server address: $ServerIP"
}
if (-not $ServerIP) { throw "Could not determine this server's address." }

# CronSecret: the cutover takes a health snapshot afterwards. Read it from the
# existing .env; an absent one costs a snapshot, not the cutover.
$CronSecret = ''
if (Test-Path -LiteralPath $nvEnv) {
    foreach ($line in (Get-Content -LiteralPath $nvEnv -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*CRON_SECRET\s*=\s*(.+?)\s*$') { $CronSecret = $Matches[1].Trim() }
    }
}

# ⛔ EMPTY, AND IT MUST BE. $NVEnvTail is how the INSTALLER appends TLS_CERT_PATH
# and TLS_KEY_PATH while composing a brand-new .env from scratch. Here the .env
# already exists and belongs to the operator: the cutover edits the keys it owns
# line by line (Set-EnvFileKey), and appending a tail would duplicate keys in a
# file that already has them.
$NVEnvTail = ""

# ── -Disable: the supported way back to plain HTTP ────────────────
if ($Disable) {
    Write-Step "Turning HTTPS off"
    $tls = Get-Service -Name 'NocVault-Tls' -ErrorAction SilentlyContinue
    if (-not $tls) { Write-Info "NocVault-Tls is not installed - the consoles are already serving directly." }

    # ⛔ THE TERMINATOR GOES FIRST. Its DependOnService names all four consoles,
    # and Windows refuses `sc stop` on a service with a running dependent
    # (1051) - so stopping a console while the terminator runs fails, and the
    # console is then left half-reconfigured.
    if ($tls) {
        $null = & sc.exe stop 'NocVault-Tls' 2>&1
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 1
            $x = Get-Service -Name 'NocVault-Tls' -ErrorAction SilentlyContinue
            if (-not $x -or $x.Status -eq 'Stopped') { break }
        }
        $null = & $NssmExe remove 'NocVault-Tls' confirm 2>&1
        Write-OK "NocVault-Tls stopped and removed"
    }

    $host4 = if ($TlsPublicHost.Trim()) { $TlsPublicHost.Trim() } else { $ServerIP }
    $back = @()
    $back += [pscustomobject]@{ App='netvault'; Service='NetVault'; Public=3000; Loopback=13000; Mode='standalone'; EnvFiles=@((Join-Path $NVAppDir '.env'), (Join-Path $NVAppDir '.next\standalone\.env.local')) }
    if ($InstallLogVault)  { $back += [pscustomobject]@{ App='logvault';  Service='LogVault-App';  Public=3004; Loopback=13004; Mode='next-start'; EnvFiles=@((Join-Path $LVAppDir '.env.local'),  (Join-Path $LVAppDir 'frontend\.env.local')) } }
    if ($InstallDDIVault)  { $back += [pscustomobject]@{ App='ddivault';  Service='DDIVault-App';  Public=3006; Loopback=13006; Mode='next-start'; EnvFiles=@((Join-Path $DDIAppDir '.env.local'), (Join-Path $DDIAppDir 'frontend\.env.local')) } }
    if ($InstallSpanVault) { $back += [pscustomobject]@{ App='spanvault'; Service='SpanVault-App'; Public=3008; Loopback=13008; Mode='next-start'; EnvFiles=@((Join-Path $SVAppDir '.env.local'),  (Join-Path $SVAppDir 'frontend\.env.local')) } }

    function Set-EnvFileKeyBack([string]$path, [string]$key, [string]$value) {
        if (-not (Test-Path -LiteralPath $path)) { return $false }
        $raw = ''
        try { $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop) } catch { return $false }
        if ($null -eq $raw) { $raw = '' }
        $lines = @($raw -split "`r?`n")
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) { $lines[$i] = "$key=$value"; $found = $true }
        }
        if (-not $found) { $lines = @($lines) + "$key=$value" }
        try { ($lines -join "`n") | Out-File -FilePath $path -Encoding UTF8 -NoNewline } catch { return $false }
        return $true
    }

    foreach ($c in $back) {
        $ErrorActionPreference = 'Continue'
        if ($c.Mode -eq 'standalone') {
            $raw = (( & $NssmExe get $c.Service AppEnvironmentExtra 2>&1 | Out-String) -replace "`0", '').Trim()
            $lines = @($raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
            $out = @()
            foreach ($l in $lines) {
                $name = ($l -split '=', 2)[0]
                if ($name -eq 'PORT')         { $out += ("PORT=" + $c.Public); continue }
                if ($name -eq 'HOSTNAME')     { $out += 'HOSTNAME=0.0.0.0';    continue }
                if ($name -eq 'NEXTAUTH_URL') { $out += ("NEXTAUTH_URL=http://" + $host4 + ":" + $c.Public); continue }
                $out += $l
            }
            if ($out.Count -ge 1) { $null = & $NssmExe set $c.Service AppEnvironmentExtra ($out -join "`n") 2>&1 }
        } else {
            $prev = (( & $NssmExe get $c.Service AppParameters 2>&1 | Out-String) -replace "`0", '').Trim()
            # Reverse of the cutover's rewrite. Note it normalises `--port` to
            # `-p`: functionally identical to Next, and the alternative is
            # remembering a spelling across a reboot.
            $new = $prev -replace ('(?:-p|--port)\s+' + $c.Loopback + '\s+-H\s+127\.0\.0\.1(?=\s|$)'), ("-p " + $c.Public)
            if ($new -eq $prev) {
                $new = $prev -replace ('(?:-p|--port)\s+' + $c.Loopback + '(?=\s|$)'), ("-p " + $c.Public)
            }
            if ($new -ne $prev) { $null = & $NssmExe set $c.Service AppParameters $new 2>&1 }

            $raw = (( & $NssmExe get $c.Service AppEnvironmentExtra 2>&1 | Out-String) -replace "`0", '').Trim()
            if ($raw -match '(?m)^\s*NEXTAUTH_URL\s*=') {
                $lines = @($raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' })
                $out = @()
                foreach ($l in $lines) {
                    if ((($l -split '=', 2)[0]) -eq 'NEXTAUTH_URL') { $out += ("NEXTAUTH_URL=http://" + $host4 + ":" + $c.Public) }
                    else { $out += $l }
                }
                if ($out.Count -ge 1) { $null = & $NssmExe set $c.Service AppEnvironmentExtra ($out -join "`n") 2>&1 }
            }
        }
        foreach ($f in $c.EnvFiles) { $null = Set-EnvFileKeyBack $f 'NEXTAUTH_URL' ("http://" + $host4 + ":" + $c.Public) }
        Write-OK "$($c.App): back on 0.0.0.0:$($c.Public), NEXTAUTH_URL http://${host4}:$($c.Public)"
    }

    # The hub's suite probes, which the cutover pointed at the loopback ports.
    foreach ($f in @((Join-Path $NVAppDir '.env'), (Join-Path $NVAppDir '.next\standalone\.env.local'))) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        foreach ($c in $back) {
            if ($c.App -eq 'netvault') { continue }
            $null = Set-EnvFileKeyBack $f ($c.App.ToUpper() + '_HEALTH_URL') ("http://127.0.0.1:" + $c.Public + "/api/health")
            $null = Set-EnvFileKeyBack $f ($c.App.ToUpper() + '_STATS_URL')  ("http://127.0.0.1:" + $c.Public + "/api/stats")
        }
    }
    Write-OK "Suite probes pointed back at the public ports"

    Write-Step "Restarting the consoles"
    foreach ($c in $back) { $null = & sc.exe stop $c.Service 2>&1 }
    Start-Sleep -Seconds 6
    foreach ($c in $back) { $null = & sc.exe start $c.Service 2>&1; Start-Sleep -Seconds 2 }

    $allBack = $true
    foreach ($c in $back) {
        $ok = $false
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 1
            try {
                $q = [Net.HttpWebRequest]::Create("http://127.0.0.1:" + $c.Public + "/api/health")
                $q.Timeout = 3000
                $r = $q.GetResponse(); if ([int]$r.StatusCode -eq 200) { $ok = $true }; $r.Close()
            } catch {}
            if ($ok) { break }
        }
        if ($ok) { Write-OK "$($c.App) answering on :$($c.Public) over plain HTTP" }
        else { Write-Warn "$($c.App) is NOT answering on :$($c.Public)"; $allBack = $false }
    }
    Write-Host ""
    if ($allBack) { Write-Host "  HTTPS is OFF - all consoles are serving directly again." -ForegroundColor Green }
    else { Write-Host "  HTTPS is off but at least one console did not come back - see above." -ForegroundColor Yellow }
    Write-Host ""
    exit $(if ($allBack) { 0 } else { 1 })
}

# ── Gates 1 and 2, then the cutover ───────────────────────────────
. (Join-Path $NocTlsHelperDir 'NocVault-TlsPreflight.ps1')

if ($DryRun) {
    Write-Step "Dry run - stopping before anything is changed"
    if ($TlsGateOk) {
        Write-OK "Gates 1 and 2 PASS. A real run would now:"
        Write-Info "  register NocVault-Tls (node $NVAppDir\installer\terminator\start.mjs)"
        Write-Info "  move netvault to 127.0.0.1:13000, public 3000"
        if ($InstallLogVault)  { Write-Info "  move logvault  to 127.0.0.1:13004, public 3004" }
        if ($InstallDDIVault)  { Write-Info "  move ddivault  to 127.0.0.1:13006, public 3006" }
        if ($InstallSpanVault) { Write-Info "  move spanvault to 127.0.0.1:13008, public 3008" }
        Write-Info "  set NEXTAUTH_URL to https://$(if ($TlsPublicHostValue) { $TlsPublicHostValue } else { $ServerIP }):<port> on each console"
        Write-Info "  prove HTTPS 200 on every public port, and REVERT ALL OF IT if any one fails"
        Write-Host ""
        Write-Info "Re-run without -DryRun to do it."
    } else {
        Write-Warn "Gates did NOT pass, so a real run would change nothing either."
        Write-Info $TlsGateReason
    }
    Write-Host ""
    exit 0
}

. (Join-Path $NocTlsHelperDir 'NocVault-TlsCutover.ps1')

Write-Host ""
if ($script:TlsCutoverApplied) {
    $h = if ($TlsPublicHostValue) { $TlsPublicHostValue } else { $ServerIP }
    Write-Host "  +======================================================+" -ForegroundColor Green
    Write-Host "  |   HTTPS is ON                                        |" -ForegroundColor Green
    Write-Host "  +======================================================+" -ForegroundColor Green
    Write-Host ""
    Write-Host "  NocVault Hub : https://${h}:3000" -ForegroundColor White
    if ($InstallLogVault)  { Write-Host "  LogVault     : https://${h}:3004" -ForegroundColor White }
    if ($InstallDDIVault)  { Write-Host "  DDIVault     : https://${h}:3006" -ForegroundColor White }
    if ($InstallSpanVault) { Write-Host "  SpanVault    : https://${h}:3008" -ForegroundColor White }
    Write-Host ""
    Write-Host "  Old http:// bookmarks on those ports are answered with a 301." -ForegroundColor Gray
    Write-Host "  Replace a self-signed certificate from Settings > Certificate;" -ForegroundColor Gray
    Write-Host "  this script never overwrites one that is already in place." -ForegroundColor Gray
} else {
    Write-Host "  +======================================================+" -ForegroundColor Yellow
    Write-Host "  |   HTTPS was NOT enabled - the suite is unchanged      |" -ForegroundColor Yellow
    Write-Host "  +======================================================+" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  See the lines above for why. The consoles are still on" -ForegroundColor Gray
    Write-Host "  plain HTTP and still reachable." -ForegroundColor Gray
}
Write-Host ""
