# NetVault Page Tree

## Layouts
server layout — app/layout.tsx — RootLayout: root HTML shell, theme-init script, wraps Providers
client layout — app/(app)/layout.tsx — AppLayout: sidebar/header/nav chrome for all authenticated app pages

## Pages — root
server /  — Home — redirects to /launcher (suite entry point)

## Pages — (auth) route group (no sidebar chrome)
client /login — LoginPage — suite login screen (NextAuth credentials sign-in)
client /launcher — LauncherPage — NocVault Hub: app tiles, suite health, cross-app search, Asset 360 drawer

## Pages — (app) route group / Devices
client /devices — DevicesPage — device inventory: list, filter, import/export, bulk actions, duplicates
server /devices/new — NewDevicePage — thin wrapper rendering <DeviceForm/> (add device)
client /devices/[id] — DeviceDetailPage — device detail fields + change-history timeline
client /devices/[id]/edit — EditDevicePage — edit device form (wraps DeviceForm)

## Pages — (app) route group / Sites
client /sites — SitesPage — sites list grouped by region/country, stats, import
client /sites/[id] — SiteDetailPage — site detail: devices/circuits tabs, decommission toggle

## Pages — (app) route group / Circuits
client /circuits — CircuitsPage — WAN circuit inventory list/filter
client /circuits/new — NewCircuitPage — add new circuit form
client /circuits/[id] — CircuitDetailPage — view/edit single circuit

## Pages — (app) route group / EOL & Compliance
client /eol — EolPage — hardware EOL by site + software OS-EOL tracking (tabs)
client /compliance — CompliancePage — risk/compliance score + data completeness dashboard
client /audit — AuditPage — audit log table with action/user/date filters

## Pages — (app) route group / Agents
client /agents — AgentsPage — NocVault agent fleet management (super_admin only): fleet table (status/modules/version/last-seen/buffer), expandable per-agent detail with module enable/disable toggles + revoke, and an "Add agent" modal that mints a one-time enrollment token (POST /api/agents/enroll-tokens). Nav item gated `superAdminOnly` in layout.tsx; renders an inline "Access restricted" card for non-super_admins.

## Pages — (app) route group / Settings
client /settings — SettingsPage — admin tabs: general, users, sites, license, updates, about
server /settings/license — SettingsLicenseRedirect — redirects to /settings?tab=license (suite deep-link)
client /settings/eol-intelligence — EolIntelligencePage — EOL seed catalog, enrichment jobs, coverage, discrepancies (super_admin, licensed add-on)

## Pages — (app) route group / Dashboard & legacy
client /dashboard — DashboardPage — main infrastructure overview: health gauge, fleet charts, stats, activity
client /users — UsersPage — user management UI; NOT in sidebar nav (dead-ish route, redirects to /settings on load) — edit settings/page.tsx instead for user-form changes
