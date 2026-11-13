# NetVault Components

## components/
StatusBadge  status — colored badge for device_status (Active/Decommed/Faulty/Spare) [components/Badges.tsx]
LifecycleBadge  status — colored badge for lifecycle_status (EOL/EOS vs Supported) [components/Badges.tsx]
RoleBadge  role — colored badge for user role (super_admin/admin/site_admin/viewer) [components/Badges.tsx]
Breadcrumb  crumbs — page breadcrumb trail, default export [components/Breadcrumb.tsx]
(c) DeviceForm  initialData, deviceId — full add/edit device form (identity, network, location, lifecycle, procurement, support contract, software), default export [components/DeviceForm.tsx]. "Technical debt" is a READ-ONLY derived display computed via calcTechnicalDebt() — never an input; the write routes ignore any client-supplied value.
  (internal, module-level, not exported) Field  label, required, span, children — labeled form field wrapper
  (internal, module-level, not exported) Section  title, children — card-wrapped form section w/ grid
(c) GlobalSearch  (none) — navy-bar omnibox search across devices/sites/circuits w/ keyboard nav (/, arrows, Enter, Esc), default export [components/GlobalSearch.tsx]. Mounted by components/shell/HeaderSearch.tsx. Was DEAD CODE until 1.39.0 — fully built, imported by nothing, while the header carried its own input that only pushed /devices?search=<q>.
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

(c) CornersToggle — Rounded/Square segmented ROW rendered inside the avatar dropdown in app/(app)/layout.tsx (moved out of the top bar in 1.31.1 — it looked wrong there). Deliberately NOT on /settings: that page redirects non-admins to /dashboard, and this is a per-browser preference every role must be able to set. Reads its value in useEffect, never at render (the <html> attribute does not exist during SSR — reading at render is a hydration mismatch).

- (c) `MfaCard` (no props) — `app/(app)/settings/MfaCard.tsx`, rendered by Settings → Security / 2FA (the ONE tab a non-admin may see; `/security` is now just a redirect there). Self-service TOTP enrolment: setup → verify a code → enable + show backup codes once. Available to EVERY role (two-factor is not an admin privilege), and hides the disable control when policy requires MFA for the user's role.

## app/(app)/eol-intelligence/page.tsx (page-local, module-level)
CoverageDonut  dated, total — two-segment SVG coverage ring. REPLACED a recharts <PieChart>: recharts was imported into this route for this one 120x120 graphic and cost ~386 KB across two chunks vs the page's own ~50 KB, and was the main reason the page felt slow to open. Geometry mirrors the old chart (r=48 + 16px stroke == innerRadius 40/outerRadius 56; rotate(-90) == startAngle 90). Do NOT reintroduce a charting library here for a single shape.
QuickEolLookup  (none) — debounced model/vendor search over /api/admin/eol-seed?search=, rendered high on the page. Deliberately self-contained (own state + fetch) so it does not collide with the seed-catalog accordion search further down, which drives a different view. 2-character minimum: one character matches most of a ~7,900-row catalog.


## components/system/ — shared UI primitives (added 1.39.0)
Build pages out of these rather than new inline-style one-offs. They render the
classes defined in app/globals.css; see that file for the token vocabulary.
(c) Button  variant(default|primary|navy|secondary|destructive), icon, ...button — standard button [components/system/index.tsx]
(c) IconButton  label(REQUIRED — becomes the accessible name), icon, ...button — icon-only button [components/system/index.tsx]
(c) PageHead  title, description, breadcrumbs, updatedAt, status, actions, titleId — standard page header. `updatedAt` renders ONLY when passed; a page that does not know its data age must not pass one [components/system/index.tsx]
(c) Breadcrumbs  items[{label,href}] — ordered crumb trail, last is aria-current [components/system/index.tsx]
(c) Section  title, description, actions, children, id — titled page section [components/system/index.tsx]
(c) Card  title, actions, children, padded, className — bordered card [components/system/index.tsx]
(c) StatusPill  tone(success|warn|danger|info|neutral), children, icon — status badge; ALWAYS renders text, the dot is a second cue only [components/system/index.tsx]
(c) Alert  tone, title, children, action, icon — inline alert/banner; role=alert for danger, else status [components/system/index.tsx]
(c) Stat  label, value, sub, tone, href, loading — one metric. value null/undefined renders an em dash + "Unavailable", which is deliberately NOT the same as a real 0 [components/system/index.tsx]
(c) DescriptionList  items[{label,value,mono}] — responsive dl, collapses to one column under 620px [components/system/index.tsx]
(c) EmptyBox / ErrorBox / NoAccessBox  — empty, error (role=alert, optional retry) and permission-denied states [components/system/index.tsx]
(c) Toolbar  children — filter/action bar wrapper [components/system/index.tsx]
(c) FilterChips  filters[{key,label,value}], onClear, onClearAll — removable active-filter chips [components/system/index.tsx]
(c) Tabs  tabs[{id,label,count}], active, onChange, label — ARIA tablist w/ arrow-key roving focus [components/system/index.tsx]
(c) Pager  page, limit, total, onPage, onLimit, loading — THE pagination. Computes its range from the real page size [components/system/index.tsx]
(c) Dialog  open, onClose, title, description, children, footer, variant(dialog|drawer), dismissible, initialFocus, maxWidth — modal with role=dialog, aria-modal, focus trap, Escape, scroll lock and focus restoration [components/system/Dialog.tsx]
(c) DropdownMenu  trigger({open,toggle,ref}), children, align, label — menu w/ roving arrow-key focus, Escape, outside-click [components/system/Menu.tsx]
(c) MenuItem / MenuLabel / MenuSeparator  — menu contents; MenuItem takes href or onSelect, plus destructive/disabled/icon [components/system/Menu.tsx]
Icon  — local inline SVG set (Icon.device, Icon.site, …), 24x24 viewBox, currentColor, aria-hidden [components/system/icons.tsx]

## components/shell/ — application shell (added 1.39.0)
(c) SuiteHeader  productName, productSubtitle, userName, userRole, userApps, version, collapsed, onToggleCollapsed, onToggleSidebar, onChangePassword, sidebarTriggerRef — navy suite bar: brand, app switcher, product identity, search, theme, help, account menu [components/shell/SuiteHeader.tsx]
  SUITE_APPS — the 4 apps with their REAL launch hrefs (/dashboard, /api/sso/<app>)
  canAccessApp(slug, apps) — mirrors the launcher rule exactly: netvault always allowed; empty/absent list means all
(c) Sidebar  role, collapsed, mobileOpen, onCloseMobile, triggerRef — grouped role-aware nav; mobile drawer is a focus-trapped role=dialog [components/shell/Sidebar.tsx]
(c) HeaderSearch  (none) — mounts GlobalSearch + binds Ctrl/Cmd+K [components/shell/HeaderSearch.tsx]
(c) HelpMenu  version — real help menu (shortcuts dialog, security, about). Replaced a Help link that pointed at /compliance [components/shell/HelpMenu.tsx]
nav.ts — NAV_GROUPS, canSee(), visibleGroups(), isCurrent(). Role gates live HERE now; they are carried over verbatim from the old flat list and each is commented with why.

### `components/settings/DirectoryMappingsCard.tsx`

`<DirectoryMappingsCard ssoConfigured={boolean} />` — the group → role table, rendered by
`SingleSignOnPanel` as a sibling card rather than wired into the Settings page, so the two always
appear together. The tenant card decides WHICH directory is trusted; this one decides what an
identity from it becomes.

⛔ **ITS MAIN JOB IS THE EMPTY-TABLE WARNING.** Zero mappings refuses every directory sign-in
(`lib/directoryRoles.ts`, `OUTCOME.NO_MAPPINGS`) and that is the state a fresh install is in. Shown
as a `warn` Callout when single sign-on is configured and as `neutral` when it is not — only in the
first case is somebody about to authenticate successfully at Microsoft and be refused here.

⛔ **IT MUST NEVER OFFER A DEFAULT MAPPING.** "Map all directory users to viewer" would grant a role
to every member of a directory this product does not administer. The refusal is the safe state.

⛔ **A FAILED READ RENDERS AN ERROR, NOT AN EMPTY LIST** — otherwise a database fault shows the
empty-table warning and tells an administrator their mappings are gone when they are not.

The group's display name is shown but labelled a label: it is never matched on and does not follow a
rename in Entra. `site_admin` is absent from the role select by construction (it comes from
`DIRECTORY_PROVISIONABLE_ROLES` via the API), and choosing `super_admin` raises a warning that
anyone who can add members to that group in Entra can grant themselves full control.

### components/settings/TransportPanel.tsx — Settings → HTTPS (super_admin)
The Certificate panel manages the certificate; this one manages whether the suite USES it. Reads
`/api/system/tls-transport`, offers Preview / Turn HTTPS on / Turn HTTPS off, polls while a run is in
flight, and shows the engine's gate lines verbatim.
- ⛔ **IT DELIBERATELY DOES NOT AUTO-REDIRECT AFTER ENABLING.** HTTPS moves this console from http to
  https on the SAME port — a different origin whose self-signed certificate the browser has not
  accepted yet. A scripted redirect or cross-origin poll fails indistinguishably from "the cutover
  broke". Only a human can click through a certificate warning, so the panel hands over a link and says
  so. An auto-redirect here would be a worse lie than none.
- ⛔ **A LOST POLL DURING A RUN IS EXPECTED, NOT AN ERROR.** The console is changing ports; rendering it
  as a fault sends an operator chasing the feature working.
- ⛔ The engine's exit code is shown as a FACT, labelled "not the verdict" — it is 0 for a successful
  run and for one that undid itself.
- The confirmation NAMES the four ports, warns that each console restarts, and states that a failed
  gate undoes everything automatically. Turning HTTPS off says plainly that credentials will then cross
  the network unencrypted.

### components/settings/RestartControl.tsx — "apply it now" (shared by three panels)
Console address, Certificate and Single sign-on all end with a saved-but-inert value. Each said
"restart the NetVault service", which only somebody with a console on the server can do — so the
product could save a change it could not apply.
- ⛔ **ONE COMPONENT FOR ALL THREE.** Fixing one would leave the other two telling a customer to use
  PowerShell (CLAUDE.md: a fixed instance is not a fixed class).
- ⛔ **IT NEVER NAMES A SERVICE.** It sends a `purpose`; the server decides. That is what stops the
  Certificate panel pointing at NetVault again.
- ⛔ **THE RUN'S OWN VERDICT IS THE PROOF; A LOWER UPTIME IS ONLY PROGRESS (changed 1.63.0).** "The
  page loaded again" is not evidence a restart happened — a refused stop leaves the original process
  answering this very poll — but a lower uptime is not evidence the restart FINISHED either. On an
  install where `NocVault-Tls` really declares `DependOnService NetVault`, the wrapper's order is:
  stop the terminator → stop/start the hub → START THE TERMINATOR AGAIN (up to 90 s) → write
  `dependent … back:` → write the sentinel. The hub answers HTTP before `Get-Service` reports it
  Running, so the first poll gave a lower uptime with `finished: false` and the panel went green with
  "Restarted — the change is now in force" while the front door was stopped and **all four consoles'
  public ports were dead**. Polling stops at `done`, so a terminator that never came back left it
  green forever — and it made `parseRestartLog`'s `depsFailed` term, added specifically to refuse
  this, unreachable on the only path where dependents exist. `done` now requires
  `mine && finished && outcome === 'succeeded'`; `uptimeProof` sets `backOnline`, which is how the
  panel says "this console is answering, the front door is still coming back".
- `WAIT_LIMIT_MS` is 7 minutes, because the wrapper's own bounds add to 345 s (45 s per dependent
  stop + 60 s stop poll + 150 s of start attempts + 90 s per dependent returning). At 4 minutes the
  new verdict-based rule would have reported "could not confirm" for restarts that were working.
- `canRestart?: boolean` (default true) — ⛔ `POST /api/system/service-restart` is super_admin and
  both call sites rendered this with NO role prop, so an `admin` met an enabled "Restart NetVault
  now" that answered a bare 403 — in the same commit that correctly gated `CertificatePanel`'s
  install button 20 lines below it. `ConsoleAddressPanel` gained `canRestart` for the same reason
  (the panel is admin+, the restart is not).
- `dependencyDetail` — `terminatorDependsOn` returns a REASON when it cannot tell, and `null` is
  precisely the branch where the restart is guaranteed to fail with 1051 (the front door is left
  running, Windows refuses the stop). The route computed it and threw it away; the panel now names
  it in both the `failed` and `unconfirmed` callouts.
- Losing contact mid-restart is rendered as expected, not as a fault.

### Changed 1.62.0
- `CertificatePanel` takes `canInstall?: boolean` (default true). Settings passes `isSuperAdmin`; a plain admin sees the tab read-only rather than a button the server will 403.
- `RestartControl` gained the `unconfirmed` phase (a restart it cannot prove, instead of an endless spinner) and reports the server's reason when there is nothing to restart.
- `TransportPanel` renders the log-read error and a died-run notice OUTSIDE the "Last change" card — the card is skipped in exactly the case those messages describe.

### Changed 1.63.0
- `RestartControl` takes `canRestart?`; `ConsoleAddressPanel` takes `canRestart?`; both default to
  `true` so an un-updated call site keeps today's behaviour. `app/(app)/settings/page.tsx` passes
  `isSuperAdmin` to both, beside the `canInstall={isSuperAdmin}` it already passed.
- `CertificatePanel`'s "Replace the installed certificate" confirmation is `disabled={busy ||
  !canInstall}`; it was `disabled={busy}` only, which contradicted the read-only notice in the same
  panel.
- `TransportPanel`'s `reverted` copy is now only reachable when the engine really moved the consoles
  (`parseRunLog` requires `REVERTING the TLS cutover`, written only by `Undo-TlsCutover`). Before,
  the closing banner "HTTPS was NOT enabled" mapped straight to `reverted`, so EVERY real enable
  with a failing gate rendered a paragraph asserting a four-console cutover and rollback that had
  not happened — and `refused` was unreachable outside Preview.

### `NotificationsPanel` — Settings → Notifications (super_admin, 1.65.0)
⛔ **Defined INSIDE `app/(app)/settings/page.tsx`, not under `components/settings/`** — unlike
`TransportPanel`/`SingleSignOnPanel`. It borrows that directory's chrome (`Callout`, `PanelCard`,
`PanelLoading`, `StatePill` from `@/components/settings/panelChrome`) but lives in the page file.
Helpers `SmtpField` / `SmtpCheckbox` sit beside it at MODULE level — never nested inside the panel,
per the suite-wide rule (a component defined in another component's body remounts on every keystroke
and loses input focus).

The one form that configures the SMTP transport for all four consoles. The hub owns
host/port/secure/username/password; each satellite keeps its own recipients, alert filters and From
identity — the panel copy says so, because an admin who thinks this replaces everything will go
looking for the per-app settings and not find them.

Behaviours worth keeping:
- **The password is never fetched.** `password_set` drives a masked placeholder plus a "Stored" pill;
  the field is sent on PUT only when actually touched AND non-empty AND not the mask, so clicking in
  and out changes nothing.
- **`secret_configured === false`** raises a `--tint-warn` banner and DISABLES saving — the server has
  no `NEXTAUTH_SECRET`, so a password could not be encrypted. Note a `{ data: null }` response carries
  no such field, and "unknown" deliberately does NOT lock the form.
- **429 is read before `res.json()`** — a rate limiter may answer with no body — and the message says
  the limit is on the button, not on the settings.
- **"Allow self-signed certificate" is never pre-checked** (`=== true` on load) and carries its own
  warning. It disables certificate verification; the point of surfacing it is that DDIVault does the
  same thing invisibly and unconditionally.
- The implicit-TLS hint names 465 vs 587/25-STARTTLS explicitly and says that leaving it off does not
  mean unencrypted — admins get this wrong constantly.
