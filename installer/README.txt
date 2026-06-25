===============================================================
  NocVault Network Intelligence Suite
  On-Premises Installation Guide  (Suite Installer v1.1)
===============================================================

CONTENTS
--------
  1. Overview
  2. System Requirements
  3. Package Contents
  4. Installation (one-click .cmd, or PowerShell)
  5. Advanced Installation Options
  6. Post-Installation Setup
  7. Accessing the Applications
  8. Default Credentials & Roles
  9. Services & Scheduled Tasks
 10. File Locations
 11. Updating
 12. Uninstalling
 13. Troubleshooting
 14. Support


---------------------------------------------------------------
1. OVERVIEW
---------------------------------------------------------------
NocVault is installed as a single integrated SUITE of four
applications that share one login (Single Sign-On via the
NocVault Hub):

  NetVault   - Network Asset Management            (port 3000)
               Devices, sites, WAN circuits, EOL/EOS
               intelligence and technical-debt assessment.
               Also hosts the NocVault Hub / launcher.

  LogVault   - Syslog Collection & Analysis        (port 3004)
               Real-time syslog collection, parsing, alerting,
               risk scoring and asset enrichment.

  DDIVault   - DNS / DHCP / IPAM Monitoring        (port 3006)
               Monitors Windows DHCP/DNS via PowerShell
               remoting (WinRM) and manages IP address space.

  SpanVault  - Network Monitoring (NMS)            (port 3008)
               ICMP/SNMP monitoring, availability and
               performance spans.

IMPORTANT - this is a SUITE installation:
  * There is NO separate per-app installer. All four apps are
    installed (and later updated) through the one suite installer
    in this folder.
  * NetVault is the hub and is ALWAYS installed. LogVault,
    DDIVault and SpanVault are optional add-ons that are
    installed by default and may be excluded with flags
    (see section 5). They are not standalone products - they
    depend on NetVault for login/SSO and shared site data.
  * Users log in once at the NocVault Hub (port 3000) and reach
    every installed app via SSO.


---------------------------------------------------------------
2. SYSTEM REQUIREMENTS
---------------------------------------------------------------
  Operating System : Windows Server 2019 or 2022 (64-bit)
  RAM              : 8 GB minimum, 16 GB recommended (full suite)
  Disk Space       : 20 GB minimum free
  CPU              : 4 cores minimum
  PowerShell       : 5.1 or later
  Privileges       : Administrator (the installer self-elevates)
  Network          : Static IP address recommended
  Internet         : Required during installation - application
                     code is cloned from GitHub.

  Ports:
    3000  - NetVault / NocVault Hub        (opened in firewall)
    3004  - LogVault app                   (opened in firewall)
    3005  - LogVault API                   (internal only)
    3006  - DDIVault app                   (opened in firewall)
    3007  - DDIVault API                   (internal only)
    3008  - SpanVault app                  (opened in firewall)
    3009  - SpanVault API                  (internal / loopback)
    3010  - SpanVault remote polling-agent WebSocket
            (opened in firewall; only needed if you deploy
             off-box polling agents)
     514  - Syslog UDP+TCP  (LogVault)     (opened in firewall)
    1514  - Syslog UDP+TCP  (LogVault)     (opened in firewall)
    5432  - PostgreSQL                     (internal - do NOT open)


---------------------------------------------------------------
3. PACKAGE CONTENTS
---------------------------------------------------------------
  NocVault-Suite/
  |
  +-- Install-NocVault.cmd            <- One-click installer (start here)
  +-- Install-NocVault-Suite.ps1      <- The installer it runs
  +-- Uninstall-NocVault.cmd          <- One-click uninstaller
  +-- Uninstall-NocVault-Suite.ps1    <- The uninstaller it runs
  +-- README.txt                      <- This file
  |
  +-- dependencies/
        node-v20.19.0-x64.msi         <- Node.js runtime    (required)
        postgresql-16.x-x64.exe       <- PostgreSQL 16      (required)
        nssm-2.24.zip                 <- Windows service mgr (required)
        Git-2.54.0-64-bit.exe         <- Git (used if Git not present)
        VC_redist.x64.exe             <- Visual C++ runtime (installed if present)

  NOTE: Application code for all four apps is downloaded from
  GitHub during installation - internet access is required.


---------------------------------------------------------------
4. INSTALLATION
---------------------------------------------------------------

OPTION A - One-click (recommended)
  1. Copy the entire suite folder to the server (e.g. C:\NocVault-Suite).
  2. Double-click  Install-NocVault.cmd
       - It requests Administrator elevation (UAC prompt).
       - It unblocks the script (clears Mark-of-the-Web).
       - It runs the installer with ExecutionPolicy bypass, so
         you do NOT need to change the execution policy yourself.
  3. Enter (and confirm) a PostgreSQL admin password when prompted,
     and a password for the read-only reporting role.
  4. Press Enter at the confirmation prompt to begin.

OPTION B - From PowerShell (Administrator)
  1. Copy the suite folder to the server.
  2. Open "Windows PowerShell (Admin)".
  3. (If needed) allow scripts for this session:
       Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  4. Navigate to the folder and run the installer:
       cd C:\NocVault-Suite
       .\Install-NocVault-Suite.ps1

WHAT THE INSTALLER DOES
  - Installs Node.js, PostgreSQL 16, NSSM (and Git/VC++ if needed)
  - Creates a database + role for each app, plus a cross-DB
    read-only role for the Hub's suite-wide reads
  - Clones each app from GitHub and applies its schema
  - Builds each app and registers Windows services (via NSSM)
  - Adds firewall rules and NetVault scheduled tasks
  - Starts all services and prints a status summary

  Estimated time: 15-20 minutes (depends on server + connection).
  At the end, all services should show "Running" and the access
  URLs are displayed.


---------------------------------------------------------------
5. ADVANCED INSTALLATION OPTIONS
---------------------------------------------------------------
All options are parameters to Install-NocVault-Suite.ps1 (Option B),
or can be added to the powershell line inside Install-NocVault.cmd.

  Custom install directory (default C:\Apps):
    .\Install-NocVault-Suite.ps1 -InstallDir "D:\Apps"

  Specify the server IP (if auto-detection is wrong):
    .\Install-NocVault-Suite.ps1 -ServerIP "10.10.1.50"

  Exclude optional add-ons (NetVault is always installed):
    .\Install-NocVault-Suite.ps1 -InstallLogVault $false
    .\Install-NocVault-Suite.ps1 -InstallDDIVault $false -InstallSpanVault $false

  Fully unattended (no prompts) - uses default passwords that are
  printed at the end so you can change them:
    .\Install-NocVault-Suite.ps1 -Unattended


---------------------------------------------------------------
6. POST-INSTALLATION SETUP
---------------------------------------------------------------
  ALL INSTALLATIONS:
  [1] Change the default admin password immediately
      Top-right avatar -> Change Password
  [2] Add company branding (optional): Settings -> Branding
  [3] Add your team: Settings -> Users -> Add User

  LOGVAULT:
  [4] Point your network devices' syslog to  <server-ip>:514
      (Cisco, Fortinet, Palo Alto, Aruba, SonicWall, etc.)

  DDIVAULT:
  [5] Add DHCP/DNS servers: DDIVault -> Known Servers -> Add
  [6] Enable WinRM on each monitored server:
        Enable-PSRemoting -Force
        Set-Item WSMan:\localhost\Client\TrustedHosts -Value "<server-ip>" -Force

  SPANVAULT:
  [7] Add devices: SpanVault -> Devices
  [8] Set SNMP community strings per device: SpanVault -> Settings


---------------------------------------------------------------
7. ACCESSING THE APPLICATIONS
---------------------------------------------------------------
  Open a browser to the NocVault Hub and log in once:

    NocVault Hub / NetVault : http://<server-ip>:3000   (log in here)
    LogVault                : http://<server-ip>:3004
    DDIVault                : http://<server-ip>:3006
    SpanVault               : http://<server-ip>:3008

  LogVault/DDIVault/SpanVault redirect to the Hub for login and
  return via SSO. Replace <server-ip> with the server's actual IP
  (e.g. http://192.168.1.100:3000).


---------------------------------------------------------------
8. DEFAULT CREDENTIALS & ROLES
---------------------------------------------------------------
  Email    : admin@yourcompany.com
  Password : Admin1234!

  IMPORTANT: Change this password immediately after first login.

  All apps share the same user accounts (SSO). Roles:
    super_admin - Full access to all settings and data
    admin       - Full CRUD; no branding / user deletion
    site_admin  - Access to assigned sites only
    viewer      - Read-only access


---------------------------------------------------------------
9. SERVICES & SCHEDULED TASKS
---------------------------------------------------------------
  Windows services (managed via NSSM / sc.exe):
    NetVault
    LogVault-Collector   LogVault-API     LogVault-App
    DDIVault-API         DDIVault-App     DDIVault-Collector
    SpanVault-API        SpanVault-App    SpanVault-Collector

  Manage a service:
    sc.exe query NetVault
    sc.exe stop  NetVault
    sc.exe start NetVault

  NetVault scheduled tasks (registered by the installer):
    NetVault-HealthSnapshot  - daily 00:00  (fleet health trend)
    NetVault-EnrichEol       - daily 01:00  (EOL/EOS enrichment)
    NetVault-SyncEol         - weekly Sun 00:15 (pull central EOL feed)

  (LogVault/DDIVault/SpanVault run their periodic work in-process;
   they register no scheduled tasks.)


---------------------------------------------------------------
10. FILE LOCATIONS  (default install dir C:\Apps)
---------------------------------------------------------------
  Application code:
    NetVault  : C:\Apps\NetVault\app\
    LogVault  : C:\Apps\LogVault\app\
    DDIVault  : C:\Apps\DDIVault\app\
    SpanVault : C:\Apps\SpanVault\app\

  Logs:
    NetVault  : C:\Apps\NetVault\logs\
    LogVault  : C:\Apps\LogVault\app\logs\
    DDIVault  : C:\Apps\DDIVault\app\logs\
    SpanVault : C:\Apps\SpanVault\app\logs\

  Configuration:
    NetVault  : C:\Apps\NetVault\app\.env
                (and .next\standalone\.env.local for the runtime)
    LogVault  : C:\Apps\LogVault\app\.env.local  (+ frontend\.env.local)
    DDIVault  : C:\Apps\DDIVault\app\.env.local  (+ frontend\.env.local)
    SpanVault : C:\Apps\SpanVault\app\.env.local (+ frontend\.env.local)

  Database:
    PostgreSQL data : C:\Program Files\PostgreSQL\16\data\


---------------------------------------------------------------
11. UPDATING
---------------------------------------------------------------
Each app updates in place from its own updater script (run as
Administrator). After a fresh install they live under each app:

    C:\Apps\NetVault\app\installer\Update-NetVault.ps1
    C:\Apps\LogVault\app\installer\Update-LogVault.ps1
    C:\Apps\DDIVault\app\installer\Update-DDIVault.ps1
    C:\Apps\SpanVault\app\installer\Update-SpanVault.ps1

The updater pulls the latest code, applies any schema changes,
rebuilds, and restarts the service(s). Databases and your .env
settings are preserved. (NetVault can also be updated from the
in-app Settings -> Updates page.)


---------------------------------------------------------------
12. UNINSTALLING
---------------------------------------------------------------
  One-click:  double-click  Uninstall-NocVault.cmd
  Or PowerShell (Admin):     .\Uninstall-NocVault-Suite.ps1

  The uninstaller removes all suite services, scheduled tasks,
  firewall rules and application files. By default it also DROPS
  the databases - it asks you to type REMOVE to confirm and
  prompts for the PostgreSQL password first.

  Options:
    -KeepDatabases       keep the databases / data
    -RemoveDependencies  also uninstall Node / Git / PostgreSQL
    -Force               skip the REMOVE confirmation (DANGEROUS)


---------------------------------------------------------------
13. TROUBLESHOOTING
---------------------------------------------------------------
Can't reach an app in the browser:
  Get-Service NetVault, LogVault-App, DDIVault-App, SpanVault-App
  netstat -ano | findstr "3000"
  Get-NetFirewallRule | Where-Object { $_.DisplayName -like "NocVault*" }

A service is Stopped / Paused - check its error log, then restart:
  Get-Content "C:\Apps\NetVault\logs\netvault-error.log" -Tail 30
  Get-Content "C:\Apps\LogVault\app\logs\api-err.log" -Tail 30
  sc.exe stop NetVault ; sc.exe start NetVault

Login redirect loops / SSO sends you to the wrong address:
  NEXTAUTH_URL (and SERVER_IP) must match the IP you browse to.
  Inspect a service's environment:
    C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe get NetVault AppEnvironmentExtra

LogVault shows 0 logs:
  Confirm devices send syslog to <server-ip>:514, the collector is
  running (Get-Service LogVault-Collector), and the 514 firewall
  rule exists (Get-NetFirewallRule -DisplayName "NocVault Syslog*").

DDIVault can't reach a DHCP/DNS server:
  Enable-PSRemoting -Force        (on the target)
  Test-WSMan -ComputerName <target-ip>

Database connection error:
  Get-Service | Where-Object { $_.Name -like "postgresql*" }

Installation failed partway through:
  Re-run the installer - it safely removes and re-registers existing
  services before reinstalling. Check C:\Apps\<App>\...\logs\ for the
  npm-install / npm-build logs.


---------------------------------------------------------------
14. SUPPORT
---------------------------------------------------------------
  NocVault Support
    Email   : support@nocvault.io
    Website : www.nocvault.io

  When contacting support, please include:
    - Windows Server version (winver)
    - The relevant error log output
    - A screenshot of the issue

===============================================================
  NocVault Network Intelligence Suite - Installer v1.1
  (c) 2026 NocVault. All rights reserved.
===============================================================
