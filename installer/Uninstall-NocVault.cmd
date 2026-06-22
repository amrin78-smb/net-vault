@echo off
REM ============================================================
REM  NocVault Suite - One-Click Uninstaller Launcher
REM  Double-click this file. It will:
REM    1. Request Administrator elevation (UAC prompt)
REM    2. Unblock the PowerShell script (clears Mark-of-the-Web)
REM    3. Run the uninstaller with ExecutionPolicy bypass
REM
REM  SAFETY: the uninstaller will ask you to type REMOVE to
REM  confirm, and will prompt for the PostgreSQL password before
REM  dropping databases. This is intentional - it deletes all
REM  services, files and (by default) databases.
REM
REM  Options (add to the powershell line below):
REM    -KeepDatabases        keep the databases / data
REM    -RemoveDependencies   also uninstall Node/Git/PostgreSQL
REM    -Force                skip the REMOVE confirmation (DANGER)
REM ============================================================
setlocal
set "PS1=%~dp0Uninstall-NocVault-Suite.ps1"

REM --- Re-launch elevated if not already running as Administrator ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%PS1%" (
    echo ERROR: Uninstall-NocVault-Suite.ps1 not found next to this launcher.
    echo Expected at: "%PS1%"
    pause
    exit /b 1
)

REM --- Clear Mark-of-the-Web so the script is not blocked ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%PS1%' -ErrorAction SilentlyContinue"

REM --- Run the uninstaller (prompts for REMOVE confirmation + password) ---
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
echo Uninstaller finished. Review the output above.
pause
endlocal
