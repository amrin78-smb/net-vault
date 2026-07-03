<#
================================================================
  Build the NocVault Suite GUI executables from the WPF wrappers.
  Compiles each *-GUI.ps1 into a no-console, self-elevating .exe
  using the ps2exe module:

      Install-NocVault-Suite-GUI.ps1   -> NocVault-Suite-Setup.exe
      Uninstall-NocVault-Suite-GUI.ps1 -> NocVault-Suite-Uninstall.exe
      Test-NocVault-Suite-GUI.ps1      -> NocVault-Suite-Test.exe

  Run once on the BUILD machine (needs internet the first time to
  fetch the ps2exe module):
      powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-Setup-Exe.ps1

  Each .exe is only a GUI SHELL - it still needs its matching .ps1
  (and the rest of the installer\ folder) beside it at run time, so
  ship the whole folder together.
================================================================
#>
[CmdletBinding()]
param(
    [string]$IconFile = ""   # optional .ico applied to all three exes
)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }

$targets = @(
    @{ Src='Install-NocVault-Suite-GUI.ps1';   Out='NocVault-Suite-Setup.exe';     Title='NocVault Suite Setup';       Desc='NocVault Network Intelligence Suite - Installer' },
    @{ Src='Uninstall-NocVault-Suite-GUI.ps1'; Out='NocVault-Suite-Uninstall.exe'; Title='NocVault Suite Uninstaller';  Desc='NocVault Network Intelligence Suite - Uninstaller' },
    @{ Src='Test-NocVault-Suite-GUI.ps1';      Out='NocVault-Suite-Test.exe';      Title='NocVault Suite Test';        Desc='NocVault Network Intelligence Suite - Post-Install Test' }
)

# ensure ps2exe is available
if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host "Installing ps2exe module (CurrentUser)..." -ForegroundColor Cyan
    try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue } catch {}
    Install-Module -Name ps2exe -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe -Force

foreach ($t in $targets) {
    $src = Join-Path $here $t.Src
    $out = Join-Path $here $t.Out
    if (-not (Test-Path $src)) { Write-Warning "Skip: $($t.Src) not found"; continue }

    $p = @{
        InputFile    = $src
        OutputFile   = $out
        NoConsole    = $true
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
    if (Test-Path $out) { Write-Host "  Built: $out" -ForegroundColor Green }
    else { throw "ps2exe did not produce $out" }
}

Write-Host "`nDone. Ship the three .exe files together with their .ps1 scripts (same installer\ folder)." -ForegroundColor Gray
