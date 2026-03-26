NetVault - IT Asset Management Platform
On-Premises Installation Guide
========================================

REQUIREMENTS
------------
- Windows Server 2019 or 2022
- 4GB RAM minimum (8GB recommended)
- 10GB free disk space
- Internet access during installation (for Node.js and PostgreSQL downloads)
- PowerShell 5.1 or later
- Administrator privileges

INSTALLATION STEPS
------------------
1. Copy this entire folder to the Windows Server

2. Copy netvault_export.sql into this folder (same location as Install-NetVault.ps1)

3. Open PowerShell as Administrator

4. Navigate to this folder:
   cd C:\path\to\installer

5. Allow script execution (if needed):
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

6. Run the installer:
   .\Install-NetVault.ps1

7. Follow the prompts to set passwords

8. When complete, open browser to:
   http://localhost:3000

DEFAULT LOGIN
-------------
Use the credentials from your existing NetVault account
(imported from the database export)

MANAGING THE SERVICE
--------------------
Start:   sc start NetVault
Stop:    sc stop NetVault
Restart: sc stop NetVault && sc start NetVault
Status:  sc query NetVault

LOGS
----
Application log : C:\NetVault\logs\netvault.log
Error log       : C:\NetVault\logs\netvault-error.log

UNINSTALL
---------
Run as Administrator: .\Uninstall-NetVault.ps1

SUPPORT
-------
Logs location: C:\NetVault\logs\
Config file  : C:\NetVault\app\.env
