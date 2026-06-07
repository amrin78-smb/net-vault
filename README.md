# NetVault — Network Asset Management Platform

NetVault is an IT Asset Management (CMDB) platform built to manage network devices, sites, and circuits across global locations. Part of the **NocVault Network Intelligence Suite**.

## Stack

- **Frontend/Backend:** Next.js 16 (App Router, standalone build)
- **Database:** PostgreSQL (Neon cloud + on-premises Windows Server)
- **Auth:** NextAuth.js (JWT, credentials)
- **Service:** NSSM Windows Service

## Roles

| Role | Permissions |
|---|---|
| `super_admin` | Full access including branding, delete users/sites |
| `admin` | Full CRUD, cannot delete users/sites or change branding |
| `site_admin` | Assigned sites only — view, add, edit devices |
| `viewer` | Read only |

## Development Setup

### Prerequisites
- Node.js v20.19.0+
- PostgreSQL (Neon cloud or local)

### Environment variables
Copy `.env.example` to `.env` and fill in:
DATABASE_URL=postgresql://user:password@host/dbname
NEXTAUTH_SECRET=your-secret-here
NEXTAUTH_URL=http://localhost:3000
SSL_DISABLED=false

### Run locally
```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Deploy to on-premises server
```bash
git push
```
Then on the server:
```powershell
& "C:\Apps\NetVault\app\installer\Update-NetVault.ps1"
```

## On-Premises Installation

See `installer/README.txt` for full installation instructions.

**Quick start:**
1. Copy the `installer/` folder to the Windows Server
2. Optionally add `netvault_export.sql` to the installer folder
3. Open PowerShell as Administrator and run:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
.\Install-NetVault.ps1
```

Default install path: `C:\Apps\NetVault`

To install to a custom path:
```powershell
.\Install-NetVault.ps1 -InstallDir "D:\Apps\NetVault"
```

## Database

- Main table: `devices` (references `sites`, `brands`, `device_types`, `vendors`)
- View: `v_devices_flat` — joins all lookup tables, strips `/32` from IP
- Technical debt auto-calculated for EOL/EOS + Active devices

| Device Type | Technical Debt (THB) |
|---|---|
| Access Point | 35,000 |
| Core Switch | 1,000,000 |
| Firewall | 300,000 |
| Router | 25,000 |
| Switch | 120,000 |
| Wireless Controller | 300,000 |

## Key Features

- Device CMDB with lifecycle tracking (Active Supported / EOL / EOS / Unknown)
- Site management with decommission support
- Circuit management (ISP, usage, cost, technology)
- EOL / Risk report with % exposure per site
- Bulk device edit (status, lifecycle, site)
- Import from Excel/CSV with dry run validation and upsert by serial
- Export to PowerBI-friendly CSV
- Duplicate device detection (IP + serial)
- Global search across devices, sites, circuits
- Audit log with filters (action, user, date range)
- Role-based access control with site scoping
- NocVault SSO — single login for NetVault, LogVault, DDIVault

## NocVault Suite

NetVault is part of the NocVault Network Intelligence Suite:

| App | Description | Port |
|---|---|---|
| NetVault | Network Asset Management (this app) | 3000 |
| LogVault | Syslog & Log Analysis | 3004 |
| DDIVault | DNS, DHCP & IPAM | 3006 |

All apps share the same login via the NocVault hub at port 3000.
# test
# test
