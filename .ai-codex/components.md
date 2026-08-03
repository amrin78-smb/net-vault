# NetVault Components

## components/
StatusBadge  status — colored badge for device_status (Active/Decommed/Faulty/Spare) [components/Badges.tsx]
LifecycleBadge  status — colored badge for lifecycle_status (EOL/EOS vs Supported) [components/Badges.tsx]
RoleBadge  role — colored badge for user role (super_admin/admin/site_admin/viewer) [components/Badges.tsx]
Breadcrumb  crumbs — page breadcrumb trail, default export [components/Breadcrumb.tsx]
(c) DeviceForm  initialData, deviceId — full add/edit device form (identity, network, location, lifecycle, procurement, support contract, software), default export [components/DeviceForm.tsx]. "Technical debt" is a READ-ONLY derived display computed via calcTechnicalDebt() — never an input; the write routes ignore any client-supplied value.
  (internal, module-level, not exported) Field  label, required, span, children — labeled form field wrapper
  (internal, module-level, not exported) Section  title, children — card-wrapped form section w/ grid
(c) GlobalSearch  (none) — navy-bar omnibox search across devices/sites/circuits w/ keyboard nav (/, arrows, Enter, Esc), default export [components/GlobalSearch.tsx]
(c) IdleTimeout  (none) — session idle-timeout watcher + "stay logged in" warning modal, signs out via next-auth, default export [components/IdleTimeout.tsx]
(c) LicenseBanner  (none) — reads own GET /api/license, shows trial/grace/expired/expiring banner, display-only (no enforcement), default export [components/LicenseBanner.tsx]
(c) ThemeToggle  (none) — sun/moon theme switcher for navy top bar, default export [components/ThemeToggle.tsx]
  (internal, module-level, not exported) SunIcon  (none) — icon
  (internal, module-level, not exported) MoonIcon  (none) — icon
(c) Skeleton  width, height, radius, style — generic loading placeholder span [components/ui.tsx]
(c) TableSkeleton  rows, cols — loading placeholder for tables [components/ui.tsx]
(c) CardSkeleton  count — loading placeholder for card grids [components/ui.tsx]
(c) EmptyState  icon, title, message, actionLabel, onAction — empty-state block w/ optional CTA [components/ui.tsx]
(c) PageHeader  title, subtitle, children — standard page title + subtitle + right-aligned actions [components/ui.tsx]
(c) Spinner  size, color — small inline loading spinner [components/ui.tsx]
(c) useEscape  cb — hook (not a component): fires cb on Escape keydown [components/ui.tsx]

## app/(app)/agents/ (page-local, module-level — not exported/shared)
These live in `app/(app)/agents/page.tsx`, defined at module scope (not inside the page component). Page-specific, so not promoted to `components/`; listed here for discoverability.
StatusPill  status — colored status pill+dot for an agent (online/degraded/offline/revoked), token-driven tints
ModuleChip  appKey, enabled — colored module chip (ddi=purple, span=success/green); muted+dashed when disabled
ToggleSwitch  on, busy, onChange — small crimson on/off switch (used for per-module enable/disable)
CopyBox  label, value, mono — labeled value box with copy-to-clipboard button (one-time token + install command)
AgentRow  agent, expanded, onToggleExpand, onToggleModule, onRevoke, busy — fleet table row + expandable detail panel (host facts, module toggles, revoke)

## app/components/
Real, actively-imported second location — not dead code: UpdateNotifier and UpdateFailureBanner are imported by app/(app)/layout.tsx (the main app shell, every app page) and app/(auth)/launcher/page.tsx. Both are suite-standard top-bar banners about the update mechanism itself, not route-colocated glue for a single route — treat this as a small, deliberate exception to the components/ convention rather than a parallel pattern to keep extending.
(c) UpdateNotifier  (none) — polls /api/system/update-status every 6h, shows dismissible "update available" bar linking to Settings → Updates, default export [app/components/UpdateNotifier.tsx]
(c) UpdateFailureBanner  (none) — polls /api/system/last-update-status every 5min, shows a dismissible red/amber banner: dark-red "rollback also failed" (CRITICAL, bold/larger, most urgent) vs amber "rolled back OK" vs amber non-fatal schema-apply warning — visually distinct severities, not just different text (2026-07-24); also appends a schema-mismatch warning line when the status carries `schemaAppliedButRolledBack`; rendered only for admin/super_admin (layout.tsx and launcher/page.tsx each gate it on session role); default export PLUS a named export `STAGE_LABELS` (stage-id → readable label) reused by the settings page's update overlay so the two don't drift [app/components/UpdateFailureBanner.tsx]

## Violations
(c) OsStatus — defined inside EolPage in app/(app)/eol/page.tsx:55 (component body starts line 8; OsStatus declared after component state/effects, closes line 60), rendered per-row at app/(app)/eol/page.tsx:168 as `<OsStatus date={row.os_eol_date} />` inside the Software EOL table's row map. Redefined on every EolPage render (any state change: tab switch, region filter, data reload) so every row instance gets a new component identity — remounts every row on every render. Must hoist to module scope (it only needs `date`, `now`, `in90` — pass `now`/`in90` as props or compute them inline from `date` instead of closing over page state).
