<#
.SYNOPSIS
    Installs the NocVault Agent as a Windows service on a remote server.

.DESCRIPTION
    Preflight-checks connectivity to the server, writes config.json, installs
    Node.js + dependencies, ensures NSSM is available (auto-downloads it if
    missing), registers the NocVault-Agent service, starts it, and verifies it
    came up. Run on the remote (collecting) server in an elevated PowerShell.

    NOTE: the NocVault Agent is a MULTI-FILE agent (a whole agent\ directory:
    nocvault-agent.js + core\ + modules\), not a single agent.js. For Phase 1 this
    installer assumes those files are ALREADY laid down under -InstallDir (copied
    there beforehand). Hub-driven bundle distribution (fetch + signature verify of
    the agent bundle) is Phase 2 - see the marked spot below where the legacy
    single-file download used to live.

.PARAMETER ServerUrl
    Base URL of the app the agent ships telemetry to (the frontend, which proxies
    /api/*), e.g. http://<server>:3008

.PARAMETER ApiKey
    The agent's API key (generated when the agent was created in the UI).

.PARAMETER WsPort
    WebSocket port the agent connects to (default 3010).

.EXAMPLE
    .\install.ps1 -ServerUrl "http://<server>:3008" -ApiKey "abc-123-xyz"
#>
param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$ApiKey,
  [int]$WsPort = 3010
)

$ErrorActionPreference = 'Stop'
$InstallDir = "C:\Apps\NocVaultAgent"
$NodeUrl    = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"
$NssmZipUrl = "https://nssm.cc/release/nssm-2.24.zip"
$ServerUrl  = $ServerUrl.TrimEnd('/')

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

# -- Preflight: confirm the server is reachable before changing anything --------
Write-Step "Checking connectivity to $ServerUrl ..."
try {
  Invoke-WebRequest -Uri "$ServerUrl/api/health" -UseBasicParsing -TimeoutSec 10 | Out-Null
  Write-Ok "  Server reachable."
} catch {
  Write-Fail "Cannot reach $ServerUrl/api/health - $($_.Exception.Message)"
  Write-Fail "Verify the URL, that this host can route to the server, and that the port is open."
  throw "Preflight connectivity check failed."
}

# Warn early if the WebSocket port looks unreachable (non-fatal - firewalls vary).
try {
  $wsHost = ([Uri]$ServerUrl).Host
  $probe = Test-NetConnection -ComputerName $wsHost -Port $WsPort -WarningAction SilentlyContinue
  if (-not $probe.TcpTestSucceeded) {
    Write-Fail "  Warning: WebSocket port $WsPort on $wsHost did not respond. The agent will keep retrying once installed; open that port if it stays offline."
  } else {
    Write-Ok "  WebSocket port $WsPort reachable."
  }
} catch { <# Test-NetConnection may be unavailable on older hosts - skip #> }

# -- Node.js -------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Step "Installing Node.js..."
  $msi = "$env:TEMP\node.msi"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $msi -UseBasicParsing
  Start-Process msiexec -Args "/i `"$msi`" /quiet /norestart" -Wait
  $env:PATH += ";C:\Program Files\nodejs"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js install did not complete. Install Node 20 LTS manually and re-run."
  }
}

# -- Install directory ---------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# -- Agent files ---------------------------------------------------------------
#    PHASE 1: the multi-file agent (nocvault-agent.js + core\ + modules\ +
#    package.json) is expected to ALREADY be present under $InstallDir - copy the
#    agent\ directory here before running this installer.
#
#    << This is where the legacy SpanVault installer downloaded a SINGLE agent.js
#       (and package.json) from the server and sha256-verified it. The unified
#       agent is a directory, not one file, so that per-file download is replaced
#       by Phase 2's hub-driven signed-bundle distribution (fetch bundle + verify
#       Ed25519 signature + sha256 before laying files down). Until then, this
#       installer assumes the files are staged here already. >>
if (-not (Test-Path "$InstallDir\nocvault-agent.js")) {
  Write-Fail "Agent files not found at $InstallDir\nocvault-agent.js"
  Write-Fail "Copy the agent\ directory (nocvault-agent.js, core\, modules\, package.json) into $InstallDir first, then re-run."
  throw "Agent files missing - stage the agent directory under $InstallDir before installing."
}

# -- Config: write UTF-8 WITHOUT a BOM. Windows PowerShell's Out-File -Encoding
#    UTF8 prepends a BOM that Node's JSON.parse rejects, crashing the agent. -----
$cfgJson = @{ serverUrl = $ServerUrl; apiKey = $ApiKey; wsPort = $WsPort } | ConvertTo-Json
[System.IO.File]::WriteAllText("$InstallDir\config.json", $cfgJson, (New-Object System.Text.UTF8Encoding $false))

# -- Dependencies (skip if a bundled node_modules is already present - offline) -
if (Test-Path "$InstallDir\node_modules\ws") {
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
  $shared = "C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe"
  if (Test-Path $shared) { return $shared }
  # 2) On PATH?
  $onPath = (Get-Command nssm -ErrorAction SilentlyContinue)
  if ($onPath) { return $onPath.Source }
  # 3) Previously downloaded by this installer?
  $local = "$InstallDir\nssm\nssm.exe"
  if (Test-Path $local) { return $local }

  New-Item -ItemType Directory -Force -Path "$InstallDir\nssm" | Out-Null

  # 4) Last resort: the public nssm.cc zip (may be unreachable in some networks).
  Write-Step "Downloading NSSM from nssm.cc..."
  $zip = "$env:TEMP\nssm.zip"
  $ex  = "$env:TEMP\nssm-extract"
  Invoke-WebRequest -Uri $NssmZipUrl -OutFile $zip -UseBasicParsing
  if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
  $src  = Get-ChildItem -Path $ex -Recurse -Filter nssm.exe |
            Where-Object { $_.FullName -match "\\$arch\\" } | Select-Object -First 1
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
& $NssmPath set NocVault-Agent AppParameters "$InstallDir\nocvault-agent.js" | Out-Null
& $NssmPath set NocVault-Agent AppDirectory $InstallDir | Out-Null
& $NssmPath set NocVault-Agent DisplayName "NocVault Agent" | Out-Null
& $NssmPath set NocVault-Agent Description "NocVault unified remote collection agent" | Out-Null
& $NssmPath set NocVault-Agent Start SERVICE_AUTO_START | Out-Null
& $NssmPath set NocVault-Agent AppStdout "$InstallDir\agent.log" | Out-Null
& $NssmPath set NocVault-Agent AppStderr "$InstallDir\agent-err.log" | Out-Null
& $NssmPath set NocVault-Agent AppRotateFiles 1 | Out-Null

& $NssmPath start NocVault-Agent | Out-Null

# -- Verify the service actually came up ---------------------------------------
Start-Sleep -Seconds 3
$svc = Get-Service -Name NocVault-Agent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
  Write-Ok "`nNocVault Agent installed and running."
  Write-Host "It should appear Online in the UI within ~30 seconds." -ForegroundColor Gray
  Write-Host "Logs: $InstallDir\agent.log  (errors: $InstallDir\agent-err.log)" -ForegroundColor Gray
} else {
  $state = if ($svc) { $svc.Status } else { 'not installed' }
  Write-Fail "`nService state is '$state' - it did not start cleanly."
  Write-Fail "Check $InstallDir\agent-err.log for details, then: $NssmPath start NocVault-Agent"
  throw "NocVault-Agent did not reach Running state."
}
