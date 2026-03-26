#Requires -RunAsAdministrator
Write-Host "Uninstalling NetVault..." -ForegroundColor Yellow

$nssmExe = "C:\NetVault\nssm\nssm-2.24\win64\nssm.exe"
if (Test-Path $nssmExe) {
    & $nssmExe stop NetVault
    & $nssmExe remove NetVault confirm
}

Remove-NetFirewallRule -DisplayName "NetVault App Port 3000" -ErrorAction SilentlyContinue
Remove-Item "$env:PUBLIC\Desktop\NetVault.lnk" -ErrorAction SilentlyContinue

Write-Host "NetVault service removed." -ForegroundColor Green
Write-Host "Note: PostgreSQL and app files at C:\NetVault were kept." -ForegroundColor Gray
Write-Host "To remove data: drop the 'netvault' database and delete C:\NetVault" -ForegroundColor Gray
