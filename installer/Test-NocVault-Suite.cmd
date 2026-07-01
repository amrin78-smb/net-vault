@echo off
REM ================================================================
REM  NocVault Suite - Post-Install Smoke Test  (double-click launcher)
REM  Just run this .cmd - no need to open PowerShell.
REM  It self-elevates to Administrator and runs Test-NocVault-Suite.ps1
REM  from the same folder. Any arguments are passed through
REM  (e.g. Test-NocVault-Suite.cmd -SkipDb).
REM ================================================================
setlocal EnableExtensions
set "PS1=%~dp0Test-NocVault-Suite.ps1"

if not exist "%PS1%" ( echo [ERROR] Test-NocVault-Suite.ps1 was not found next to this file. & echo    Expected: "%PS1%" & echo. & pause & exit /b 1 )

REM --- self-elevate: the tester needs Administrator for firewall/task/log checks ---
net session >nul 2>&1
if not "%errorlevel%"=="0" ( echo Requesting administrator privileges... & powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs" & exit /b )

echo ================================================================
echo   NocVault Suite - Post-Install Smoke Test  (Administrator)
echo ================================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
echo ================================================================
echo   Test finished - review the results above.
echo ================================================================
pause
