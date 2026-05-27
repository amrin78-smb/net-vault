#Requires -RunAsAdministrator
<#
.SYNOPSIS
    NetVault - Uninstall Script
.PARAMETER InstallDir
    Root installation directory (default: C:\Apps\NetVault)
#>
param(
    [string]$InstallDir = "C:\Apps\NetVault"
)

$NssmExe = "$InstallDir\nssm\nssm-2.24\win64\nssm.exe"

Write-Host "Uninstalling NetVault..." -ForegroundColor Yellow

if (Test-Path $NssmExe) {
    & $NssmExe stop NetVault
    & $NssmExe remove NetVault confirm
}

Remove-NetFirewallRule -DisplayName "NetVault App Port 3000" -ErrorAction SilentlyContinue
Remove-Item "$env:PUBLIC\Desktop\NetVault.lnk" -ErrorAction SilentlyContinue

Write-Host "NetVault service removed." -ForegroundColor Green
Write-Host "Note: PostgreSQL and app files at $InstallDir were kept." -ForegroundColor Gray
Write-Host "To remove data: drop the 'netvault' database and delete $InstallDir" -ForegroundColor Gray
