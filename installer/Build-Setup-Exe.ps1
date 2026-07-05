<#
================================================================
  Build the NocVault Suite GUI executables from the WPF wrappers.
  Compiles each *-GUI.ps1 into a no-console, self-elevating, STA .exe
  using the ps2exe module:

      Install-NocVault-Suite-GUI.ps1   -> NocVault-Suite-Setup.exe
      Uninstall-NocVault-Suite-GUI.ps1 -> NocVault-Suite-Uninstall.exe
      Test-NocVault-Suite-GUI.ps1      -> NocVault-Suite-Test.exe

  Run once on the BUILD machine (first run fetches the ps2exe module):
      powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-Setup-Exe.ps1

  -STA is REQUIRED: WPF needs a single-threaded-apartment thread, or the
  window renders but text/password fields cannot be clicked.

  Optional Authenticode signing (removes the SmartScreen "unknown publisher"
  warning if the signing cert is trusted on the target machines):
      .\Build-Setup-Exe.ps1 -CertPfx C:\path\nocvault-codesign.pfx -CertPassword 'secret'

  Each .exe is only a GUI SHELL - it still needs its matching .ps1 (and the
  rest of installer\) beside it at run time, so ship the whole folder together.
================================================================
#>
[CmdletBinding()]
param(
    [string]$IconFile     = "",   # defaults to nocvault.ico next to this script
    [string]$CertPfx      = "",   # optional .pfx code-signing certificate
    [string]$CertPassword = "",
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }

# default icon
if (-not $IconFile) {
    $defIco = Join-Path $here 'nocvault.ico'
    if (Test-Path $defIco) { $IconFile = $defIco }
}

$targets = @(
    @{ Src='Install-NocVault-Suite-GUI.ps1';   Out='NocVault-Suite-Setup.exe';     Title='NocVault Suite Setup';       Desc='NocVault Network Intelligence Suite - Installer' },
    @{ Src='Uninstall-NocVault-Suite-GUI.ps1'; Out='NocVault-Suite-Uninstall.exe'; Title='NocVault Suite Uninstaller';  Desc='NocVault Network Intelligence Suite - Uninstaller' },
    @{ Src='Test-NocVault-Suite-GUI.ps1';      Out='NocVault-Suite-Test.exe';      Title='NocVault Suite Test';        Desc='NocVault Network Intelligence Suite - Post-Install Test' },
    @{ Src='NocVault-Demo-Seed-GUI.ps1';       Out='NocVault-Demo-Seed.exe';       Title='NocVault Demo Data Seeder';  Desc='NocVault Network Intelligence Suite - Demo Data Seeder' }
)

# ensure ps2exe is available
if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host "Installing ps2exe module (CurrentUser)..." -ForegroundColor Cyan
    try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue } catch {}
    Install-Module -Name ps2exe -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe -Force

# optional signing cert
$signCert = $null
if ($CertPfx) {
    if (-not (Test-Path $CertPfx)) { throw "CertPfx not found: $CertPfx" }
    $signCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertPfx, $CertPassword)
}

foreach ($t in $targets) {
    $src = Join-Path $here $t.Src
    $out = Join-Path $here $t.Out
    if (-not (Test-Path $src)) { Write-Warning "Skip: $($t.Src) not found"; continue }

    $p = @{
        InputFile    = $src
        OutputFile   = $out
        NoConsole    = $true
        STA          = $true          # WPF requires STA - without it, input/focus break
        RequireAdmin = $true
        Title        = $t.Title
        Product      = 'NocVault Suite'
        Description  = $t.Desc
        Company      = 'NocVault'
        Version      = '1.5.0.0'
    }
    if ($IconFile -and (Test-Path $IconFile)) { $p.IconFile = $IconFile }

    Write-Host "Compiling $($t.Src) -> $($t.Out) ..." -ForegroundColor Cyan
    Invoke-ps2exe @p
    if (-not (Test-Path $out)) { throw "ps2exe did not produce $out" }

    if ($signCert) {
        Write-Host "  Signing $($t.Out) ..." -ForegroundColor Cyan
        $r = Set-AuthenticodeSignature -FilePath $out -Certificate $signCert -TimestampServer $TimestampUrl -HashAlgorithm SHA256
        Write-Host "    signature: $($r.Status)" -ForegroundColor Gray
    }
    Write-Host "  Built: $out" -ForegroundColor Green
}

Write-Host "`nDone. Ship the three .exe files together with their .ps1 scripts (same installer\ folder)." -ForegroundColor Gray
if (-not $signCert) {
    Write-Host "Note: exes are UNSIGNED - Windows SmartScreen may warn on first run (More info -> Run anyway," -ForegroundColor Yellow
    Write-Host "      or Unblock-File the exe). Pass -CertPfx to sign and avoid the warning." -ForegroundColor Yellow
}
