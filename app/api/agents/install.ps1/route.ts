import { NextRequest, NextResponse } from 'next/server'
import { resolveOrigin } from '@/lib/publicUrl'

export const dynamic = 'force-dynamic'

// GET /api/agents/install.ps1 — PUBLIC (no session). Returns the PowerShell
// installer as text/plain, with the hub origin BAKED in so the downloaded agent
// files (and enroll/heartbeat traffic) point back here. Public is correct: the
// remote host runs `irm` before it has any credential, so there is no session to
// require. (This used to cite SpanVault serving its own install.ps1 publicly as
// precedent; SpanVault removed that route in 1.101.0 when agents were centralised
// here, so this is now the suite's only agent installer endpoint. The security
// boundary is the enrollment token in the minted one-liner, not the route.)
// Based on agent/install.ps1 — the elevation / Node /
// NSSM / service logic is kept close to verbatim; the two changes are (1) fetch
// the agent bundle from the hub instead of assuming pre-staged files, and (2) a
// Token-driven config.json (hub channel) with the span data path optional.
export async function GET(req: NextRequest) {
  const origin = resolveOrigin(req, 3000, process.env.NEXTAUTH_URL || 'http://localhost:3000')
  const script = buildInstallScript(origin)
  return new NextResponse(script, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function buildInstallScript(hubOrigin: string): string {
  // hubOrigin is server-derived (resolveOrigin validates host shape) — safe to
  // inline as the $HubUrl default.
  return `<#
.SYNOPSIS
    Installs the NocVault Agent as a Windows service on a remote server.

.DESCRIPTION
    Elevation-checks, downloads the multi-file agent bundle from the NocVault hub,
    installs Node.js + dependencies, ensures NSSM is available (auto-downloads it
    if missing), writes config.json, registers the NocVault-Agent service, starts
    it, and verifies it came up. Run on the remote (collecting) server in an
    elevated PowerShell.

.PARAMETER Token
    One-time enrollment token minted by the hub (required). The agent redeems it
    on first contact for a durable hub-signed identity.

.PARAMETER HubUrl
    Base URL of the NocVault hub (NetVault). Defaults to the hub that served this
    script.

.PARAMETER ServerUrl
    OPTIONAL. Base URL of the app the agent ships span telemetry to (the frontend
    that proxies /api/*), e.g. http://<server>:3008. Omit to enroll + heartbeat to
    the hub with no span collection.

.PARAMETER ApiKey
    OPTIONAL. The agent's span API key (paired with -ServerUrl).

.PARAMETER WsPort
    WebSocket port the span data path connects to (default 3010).

.PARAMETER Modules
    Comma-separated module slugs the agent should load, e.g. "span,ddi". Supplied
    automatically by the hub's minted install command from the enrollment preset.
    Omit to load span only.

.EXAMPLE
    & ([scriptblock]::Create((irm ${hubOrigin}/api/agents/install.ps1))) -Token "enr_..."
#>
param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$HubUrl='${hubOrigin}',
  [string]$ServerUrl,
  [string]$ApiKey,
  [int]$WsPort = 3010,
  [string]$Modules,
  [string]$WsFingerprint,
  [string]$WsFingerprintDdi,
  [string]$InstallDir = 'C:\\Apps\\NocVaultAgent'
)

$ErrorActionPreference = 'Stop'
$NodeUrl    = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"
$NssmZipUrl = "https://nssm.cc/release/nssm-2.24.zip"
$HubUrl     = $HubUrl.TrimEnd('/')
if ($ServerUrl) { $ServerUrl = $ServerUrl.TrimEnd('/') }

function Write-Step($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Write-Fail($msg) { Write-Host $msg -ForegroundColor Red }

Write-Host "=== NocVault Agent Installer ===" -ForegroundColor Cyan

# -- Require elevation up front (installing a Windows service needs admin) so we
#    fail fast with clear guidance instead of after downloading files + NSSM. ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Fail "This installer must run in an elevated PowerShell (Run as Administrator)."
  Write-Fail "Right-click PowerShell, choose 'Run as administrator', then paste the install command again."
  throw "Administrator rights required."
}

# -- Preflight: confirm the hub is reachable before changing anything -----------
Write-Step "Checking connectivity to $HubUrl ..."
try {
  Invoke-WebRequest -Uri "$HubUrl/api/health" -UseBasicParsing -TimeoutSec 10 | Out-Null
  Write-Ok "  Hub reachable."
} catch {
  Write-Fail "Cannot reach $HubUrl/api/health - $($_.Exception.Message)"
  Write-Fail "Verify the hub URL, that this host can route to it, and that the port is open."
  throw "Preflight connectivity check failed."
}

# Warn early if a span data path was given but its WebSocket port looks
# unreachable (non-fatal - firewalls vary).
if ($ServerUrl) {
  try {
    $wsHost = ([Uri]$ServerUrl).Host
    $probe = Test-NetConnection -ComputerName $wsHost -Port $WsPort -WarningAction SilentlyContinue
    if (-not $probe.TcpTestSucceeded) {
      Write-Fail "  Warning: WebSocket port $WsPort on $wsHost did not respond. The agent will keep retrying once installed; open that port if it stays offline."
    } else {
      Write-Ok "  WebSocket port $WsPort reachable."
    }
  } catch { <# Test-NetConnection may be unavailable on older hosts - skip #> }
}

# -- Node.js -------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Step "Installing Node.js..."
  $msi = "$env:TEMP\\node.msi"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $msi -UseBasicParsing
  Start-Process msiexec -Args "/i \`"$msi\`" /quiet /norestart" -Wait
  $env:PATH += ";C:\\Program Files\\nodejs"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js install did not complete. Install Node 20 LTS manually and re-run."
  }
}

# -- Install directory ---------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# -- Lock down the agent directory ---------------------------------------------
#    This directory holds hub-issued secrets: config.json (enrollment +
#    connection credentials) and hub-identity.json (the hub-signed JWT this
#    agent authenticates to every app with). Node creates both with a default
#    ACL inherited from C:, so on a domain-joined box every interactive user
#    could read the JWT straight off disk and impersonate this agent.
#
#    The grant goes on the DIRECTORY with (OI)(CI) so new files INHERIT it -
#    deliberately not on the files themselves. The agent replaces both files
#    with a write-to-.tmp + rename (nocvault-agent.js persistConfig, and
#    core/identity-store.js) whenever hub policy changes the module set or the
#    JWT rotates, and a renamed-in file carries the DIRECTORY ACL, not whatever
#    the file it replaced had. A per-file grant would therefore be silently
#    discarded the first time an admin toggled a module - a fix that reverts
#    itself, and looks applied right up until it matters.
#
#    SYSTEM gets (F), NOT the (R) used for secrets.env in the suite installer:
#    this is a live working directory the service writes to. Read-only SYSTEM
#    would break config persistence, identity rotation and self-update outright.
try {
  & icacls.exe $InstallDir /inheritance:r /grant '*S-1-5-18:(OI)(CI)(F)' /grant '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
} catch {
  Write-Host "  ! Could not restrict permissions on $InstallDir - secrets may be world-readable." -ForegroundColor Yellow
}


# -- Agent files: fetch the bundle manifest from the hub, then download each file
#    into $InstallDir (creating parent dirs). Replaces the Phase 1 "pre-staged
#    files" assumption. ----------------------------------------------------------
Write-Step "Downloading agent bundle from $HubUrl ..."
try {
  $manifest = Invoke-RestMethod -Uri "$HubUrl/api/agents/bundle" -UseBasicParsing -TimeoutSec 30
} catch {
  Write-Fail "Failed to fetch the agent bundle manifest - $($_.Exception.Message)"
  throw "Could not retrieve the agent bundle from the hub."
}
if (-not $manifest.files -or @($manifest.files).Count -eq 0) {
  throw "Agent bundle manifest was empty - the hub has no agent files to serve."
}
foreach ($rel in $manifest.files) {
  $dest = Join-Path $InstallDir ($rel -replace '/', '\\')
  $destDir = Split-Path -Parent $dest
  if ($destDir -and -not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
  Invoke-WebRequest -Uri "$HubUrl/api/agents/bundle/$rel" -OutFile $dest -UseBasicParsing -TimeoutSec 60
}
Write-Ok "  Downloaded $(@($manifest.files).Count) agent file(s)."
if (-not (Test-Path "$InstallDir\\nocvault-agent.js")) {
  throw "Agent bundle did not include nocvault-agent.js - aborting."
}

# -- Config: write UTF-8 WITHOUT a BOM. Windows PowerShell's Out-File -Encoding
#    UTF8 prepends a BOM that Node's JSON.parse rejects, crashing the agent. -----
#    Always write the hub channel (hubUrl + enrollToken). Add the span data path
#    (serverUrl/apiKey/wsPort) ONLY when both -ServerUrl and -ApiKey were given.
$cfg = [ordered]@{ hubUrl = $HubUrl; enrollToken = $Token }
if ($ServerUrl -and $ApiKey) {
  $cfg.serverUrl = $ServerUrl
  $cfg.apiKey    = $ApiKey
  $cfg.wsPort    = $WsPort
}
# -- Modules the agent should LOAD. The hub's enrollment preset only seeds its own
#    agent_modules rows (what the fleet page shows); the agent reads config.modules
#    and nothing else, so without this it loads span only and a "ddi enabled" agent
#    never connects to DDIVault. span is always on in the agent regardless; listing
#    it here is harmless and keeps config.json self-describing.
if ($Modules) {
  $mods = [ordered]@{}
  foreach ($m in ($Modules -split ',')) {
    $slug = $m.Trim().ToLower()
    if ($slug) { $mods[$slug] = @{ enabled = $true } }
  }
  if ($mods.Count -gt 0) { $cfg.modules = $mods }
}
# -- TLS certificate pins for the wss:// data plane. The app servers terminate
#    wss:// with a SELF-SIGNED cert they generate themselves, so there is no chain
#    to validate and the agent instead verifies the cert's SHA-256 fingerprint
#    (core/transport.js). Written as a PER-APP map because SpanVault and DDIVault
#    each present their own certificate when they are on different hosts - one
#    shared pin would verify one and reject the other.
#    -WsFingerprint alone covers the common single-host install, where one cert
#    serves both listeners; pass -WsFingerprintDdi as well only for a split
#    deployment. Omitting both leaves the agent encrypted-but-unpinned, which it
#    logs plainly rather than implying the connection is verified.
if ($WsFingerprint -or $WsFingerprintDdi) {
  $fps = [ordered]@{}
  if ($WsFingerprint)    { $fps.span = $WsFingerprint }
  if ($WsFingerprintDdi) { $fps.ddi  = $WsFingerprintDdi } elseif ($WsFingerprint) { $fps.ddi = $WsFingerprint }
  $cfg.wsFingerprints = $fps
}
# -Depth 4 is defensive headroom: the default (2) is enough for the shape above,
# but a nested per-module config block would serialise as the literal string
# "System.Collections.Hashtable" once it exceeds the depth.
$cfgJson = $cfg | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText("$InstallDir\\config.json", $cfgJson, (New-Object System.Text.UTF8Encoding $false))

# -- Dependencies (skip if a bundled node_modules is already present - offline) -
if (Test-Path "$InstallDir\\node_modules\\ws") {
  Write-Ok "Dependencies already present (offline bundle) - skipping npm install."
} else {
  Write-Step "Installing dependencies..."
  Push-Location $InstallDir
  npm install --omit=dev 2>&1 | Out-Null
  $npmExit = $LASTEXITCODE
  Pop-Location
  if ($npmExit -ne 0) {
    throw "npm install failed (exit $npmExit). Agent dependencies are incomplete - aborting before service registration."
  }
}

# -- Ensure NSSM is available (auto-download if missing) ------------------------
function Resolve-Nssm {
  # 1) A sibling NocVault app may already bundle it (only if the agent shares the
  #    box with the suite). This shared copy is the suite standard.
  $shared = "C:\\Apps\\NetVault\\nssm\\nssm-2.24\\win64\\nssm.exe"
  if (Test-Path $shared) { return $shared }
  # 2) On PATH?
  $onPath = (Get-Command nssm -ErrorAction SilentlyContinue)
  if ($onPath) { return $onPath.Source }
  # 3) Previously downloaded by this installer?
  $local = "$InstallDir\\nssm\\nssm.exe"
  if (Test-Path $local) { return $local }

  New-Item -ItemType Directory -Force -Path "$InstallDir\\nssm" | Out-Null

  # 4) Last resort: the public nssm.cc zip (may be unreachable in some networks).
  Write-Step "Downloading NSSM from nssm.cc..."
  $zip = "$env:TEMP\\nssm.zip"
  $ex  = "$env:TEMP\\nssm-extract"
  Invoke-WebRequest -Uri $NssmZipUrl -OutFile $zip -UseBasicParsing
  if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
  $src  = Get-ChildItem -Path $ex -Recurse -Filter nssm.exe |
            Where-Object { $_.FullName -match "\\\\$arch\\\\" } | Select-Object -First 1
  if (-not $src) { throw "Could not locate nssm.exe in the downloaded archive." }
  Copy-Item $src.FullName -Destination $local -Force
  Write-Ok "  NSSM ready."
  return $local
}
$NssmPath = Resolve-Nssm

# -- Register (idempotent) + start the service ---------------------------------
Write-Step "Registering Windows service..."
# Remove any prior registration so re-running the installer is clean. Only touch
# the service if it already exists, and relax error handling around these native
# nssm calls (on a fresh host the service is absent and nssm writes to stderr,
# which would otherwise trip ErrorActionPreference='Stop').
if (Get-Service -Name NocVault-Agent -ErrorAction SilentlyContinue) {
  Write-Step "Removing existing NocVault-Agent service..."
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & $NssmPath stop NocVault-Agent confirm 2>&1 | Out-Null
  & $NssmPath remove NocVault-Agent confirm 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  $ErrorActionPreference = $eap
}

& $NssmPath install NocVault-Agent (Get-Command node).Source | Out-Null
& $NssmPath set NocVault-Agent AppParameters "$InstallDir\\nocvault-agent.js" | Out-Null
& $NssmPath set NocVault-Agent AppDirectory $InstallDir | Out-Null
& $NssmPath set NocVault-Agent DisplayName "NocVault Agent" | Out-Null
& $NssmPath set NocVault-Agent Description "NocVault unified remote collection agent" | Out-Null
& $NssmPath set NocVault-Agent Start SERVICE_AUTO_START | Out-Null
& $NssmPath set NocVault-Agent AppStdout "$InstallDir\\agent.log" | Out-Null
& $NssmPath set NocVault-Agent AppStderr "$InstallDir\\agent-err.log" | Out-Null
& $NssmPath set NocVault-Agent AppRotateFiles 1 | Out-Null

& $NssmPath start NocVault-Agent | Out-Null

# -- Verify the service actually came up ---------------------------------------
Start-Sleep -Seconds 3
$svc = Get-Service -Name NocVault-Agent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
  Write-Ok "\`nNocVault Agent installed and running."
  Write-Host "It should appear Online in the UI within ~30 seconds." -ForegroundColor Gray
  Write-Host "Logs: $InstallDir\\agent.log  (errors: $InstallDir\\agent-err.log)" -ForegroundColor Gray
} else {
  $state = if ($svc) { $svc.Status } else { 'not installed' }
  Write-Fail "\`nService state is '$state' - it did not start cleanly."
  Write-Fail "Check $InstallDir\\agent-err.log for details, then: $NssmPath start NocVault-Agent"
  throw "NocVault-Agent did not reach Running state."
}
`
}
