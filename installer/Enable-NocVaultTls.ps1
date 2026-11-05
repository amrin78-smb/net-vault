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
    [switch]$DryRun
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
$NVDir     = Join-Path $InstallDir 'NetVault'
$NVAppDir  = Join-Path $NVDir 'app'
$LVAppDir  = Join-Path (Join-Path $InstallDir 'LogVault')  'app'
$DDIAppDir = Join-Path (Join-Path $InstallDir 'DDIVault')  'app'
$SVAppDir  = Join-Path (Join-Path $InstallDir 'SpanVault') 'app'

function Test-NocService([string]$n) { [bool](Get-Service -Name $n -ErrorAction SilentlyContinue) }

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
