<!--
RELEASE PROCESS:
1. Update version in package.json
2. Add new section to CHANGELOG.md:
   ## v1.x.x — YYYY-MM-DD
   ### What's New
   - Feature 1
   - Feature 2
3. git add package.json CHANGELOG.md
4. git commit -m "chore: bump version to v1.x.x"
5. git push
6. Users see update available in Settings → Updates
-->

# Changelog

## v1.0.0 — 2026-06-08
### Initial Release
- Network asset management and CMDB for enterprise infrastructure
- Device inventory with lifecycle, EOL/EOS and risk tracking
- Support contract tracking with expiry monitoring
- Compliance dashboard with 9 data quality checks
- Site-scoped RBAC (super_admin, admin, site_admin, viewer)
- Circuit and vendor management
- Bulk import via Excel/CSV
- SSO hub for NocVault suite (DDIVault, SpanVault, LogVault)
- In-app updates via Windows Task Scheduler
