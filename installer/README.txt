NocVault Suite - Network Intelligence Platform
On-Premises Installation Guide
========================================

OVERVIEW
--------
The NocVault Suite consists of four integrated applications:

  NetVault   - Network Asset Management          (port 3000)
  LogVault   - Syslog Collection & Analysis      (port 3004)
  DDIVault   - DHCP/DNS/IPAM Management          (port 3006)
  SpanVault  - Network Monitoring & Spans        (port 3008)

NetVault is the hub and is always installed. LogVault, DDIVault and
SpanVault are optional but recommended for the full suite experience.

REQUIREMENTS
------------
- Windows Server 2019 or 2022
- 8GB RAM minimum (16GB recommended for full suite)
- 20GB free disk space
- Internet access during installation (clones from GitHub)
- PowerShell 5.1 or later
- Administrator privileges

PORTS USED
----------
  3000  - NetVault (hub)
  3004  - LogVault App
  3005  - LogVault API
  3006  - DDIVault App
  3007  - DDIVault API
  3008  - SpanVault App
  3009  - SpanVault API
   514  - Syslog UDP/TCP (LogVault)
  1514  - Syslog UDP/TCP (LogVault)

INSTALLATION STEPS
------------------
1. Copy this entire folder to the Windows Server

2. Open PowerShell as Administrator

3. Navigate to this folder:
   cd C:\path\to\installer

4. Allow script execution (if needed):
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

5. Run the suite installer:
   .\Install-NocVault-Suite.ps1

6. Follow the prompts to set the PostgreSQL admin password

7. When complete, open browser to:
   http://<server-ip>:3000

   (All apps are accessible from the launcher on this page)

SELECTIVE INSTALLATION
----------------------
To install only specific apps, use the parameters:
   .\Install-NocVault-Suite.ps1 -InstallLogVault $false
   .\Install-NocVault-Suite.ps1 -InstallDDIVault $false -InstallSpanVault $false

DEFAULT LOGIN
-------------
  admin@yourcompany.com / Admin1234!
  IMPORTANT: Change the default password immediately after first login.

MANAGING SERVICES
-----------------
NetVault:
  sc start NetVault  /  sc stop NetVault  /  sc query NetVault

LogVault:
  sc start LogVault-Collector  /  sc stop LogVault-Collector
  sc start LogVault-API        /  sc stop LogVault-API
  sc start LogVault-App        /  sc stop LogVault-App

DDIVault:
  sc start DDIVault-API        /  sc stop DDIVault-API
  sc start DDIVault-App        /  sc stop DDIVault-App
  sc start DDIVault-Collector  /  sc stop DDIVault-Collector

SpanVault:
  sc start SpanVault-API       /  sc stop SpanVault-API
  sc start SpanVault-App       /  sc stop SpanVault-App
  sc start SpanVault-Collector /  sc stop SpanVault-Collector

LOGS
----
  NetVault  : C:\Apps\NetVault\logs\
  LogVault  : C:\Apps\LogVault\app\logs\
  DDIVault  : C:\Apps\DDIVault\app\logs\
  SpanVault : C:\Apps\SpanVault\app\logs\

POST-INSTALL CHECKLIST
----------------------
[1] Change default admin password in Settings
[2] Update company branding in Settings > Branding
[3] Configure network devices to send syslog to <server-ip>:514  (LogVault)
[4] Add DHCP/DNS servers in DDIVault > Known Servers             (DDIVault)
[5] Run Enable-PSRemoting -Force on each DHCP/DNS server         (DDIVault)
[6] Add devices for monitoring in SpanVault > Devices            (SpanVault)
[7] Configure SNMP community strings per device in SpanVault > Settings

UNINSTALL
---------
Run as Administrator: .\Uninstall-NetVault.ps1
(Manual removal of LogVault/DDIVault/SpanVault services via sc.exe delete)
