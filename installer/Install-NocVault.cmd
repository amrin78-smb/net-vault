@echo off
REM ============================================================
REM  NocVault Suite - One-Click Installer Launcher
REM  Double-click this file. It will:
REM    1. Request Administrator elevation (UAC prompt)
REM    2. Unblock the PowerShell script (clears Mark-of-the-Web)
REM    3. Run the installer with ExecutionPolicy bypass
REM  The installer will PROMPT you to set the PostgreSQL admin
REM  password (and confirm before installing).
REM
REM  Advanced / fully hands-off: add  -Unattended  to the
REM  powershell line below to skip the prompt and use a default
REM  PostgreSQL password instead.
REM ============================================================
setlocal
set "PS1=%~dp0Install-NocVault-Suite.ps1"

REM --- Re-launch elevated if not already running as Administrator ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%PS1%" (
    echo ERROR: Install-NocVault-Suite.ps1 not found next to this launcher.
    echo Expected at: "%PS1%"
    pause
    exit /b 1
)

REM --- Clear Mark-of-the-Web so the script is not blocked ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%PS1%' -ErrorAction SilentlyContinue"

REM --- Run the installer (prompts for the PostgreSQL password) ---
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

echo.
echo Installer finished. Review the output above.
pause
endlocal
