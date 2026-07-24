@AGENTS.md

---

## Codebase Index — READ FIRST

Pre-built index files live in `.ai-codex/`. Read these BEFORE exploring the codebase:
- `.ai-codex/routes.md`      — all API routes
- `.ai-codex/pages.md`       — page tree
- `.ai-codex/lib.md`         — library exports
- `.ai-codex/schema.md`      — database schema + known debt
- `.ai-codex/components.md`  — component index
- `.ai-codex/gotchas.md`     — non-obvious behaviours

### Maintaining the index — MANDATORY

The index is only useful if it is accurate. A stale index is worse than none: it
sends sessions confidently to the wrong place.

Any commit that changes the shape of the codebase MUST update the matching index
file in the SAME commit. Specifically:
- Add / remove / rename an API route, or change its method or auth   -> routes.md
- Add / remove / rename a page, or flip client<->server              -> pages.md
- Add / remove / rename a lib export, or change a signature          -> lib.md
- Any change to schema.sql or a migration script                     -> schema.md
- Add / remove a component, or change its props                      -> components.md
- Discover a new non-obvious behaviour or footgun                    -> gotchas.md

This runs at the same point as the version bump. If you are bumping the version,
check whether the index needs updating. Do not defer it to "later" — later never
comes and the index rots.

---

## Installer parity (IMPORTANT — read before any deploy-affecting change)

NetVault ships the shared **suite installer** `installer/Install-NocVault-Suite.ps1`
(fresh install of the whole NocVault suite, all 4 apps) alongside the per-app updater
`installer/Update-NetVault.ps1` (upgrades). Any change — even a small one — that affects
how the app is provisioned MUST be reflected in BOTH, in the same change, or fresh
installs silently break. This includes: a new/renamed env var the app reads, a new
scheduled task, a new or changed schema file (or required DB extension/grant), a new
NSSM service or changed entrypoint/port, a new firewall port, a new cross-DB grant, or a
new build step. The suite installer also provisions LogVault/DDIVault/SpanVault — so a
change in any of those apps must be mirrored here too. If you can't update the installer
in the same change, flag it explicitly so it isn't missed.

**Post-install test script (keep in sync too):** the suite ships a fresh-install smoke
tester at `installer/Test-NocVault-Suite.ps1` (it verifies services, ports, health/versions,
schema, the 3 collectors end-to-end, the tamper model and cross-DB grants). If you build a
feature that a fresh install should be verified for — a new NSSM service or port, a new DB
table/column/seed/extension/grant, a new collector data path, a new scheduled task, or a new
health/endpoint contract — update BOTH the installer AND this test script in the same change,
so fresh installs stay verifiable.

**Graphical installer/uninstaller/tester (GUI `.exe` wrappers) — IMPORTANT.** The suite ships
Windows GUI wrappers in `installer/` (`Install-`/`Uninstall-`/`Test-NocVault-Suite-GUI.ps1`,
compiled to `NocVault-Suite-Setup.exe` / `-Uninstall.exe` / `-Test.exe` via
`installer/Build-Setup-Exe.ps1` with ps2exe). **These `.exe`s are thin GUI shells only — all
the real logic lives in the `.ps1` scripts they drive** (`Install-`/`Uninstall-`/
`Test-NocVault-Suite.ps1`, launched with `-Unattended`/`-Force`). So for normal
install/uninstall/test changes (a new step, schema, service, grant, env var, port, task) you
just edit the `.ps1` — **no exe rebuild needed**. The ONE exception: if you add or rename a
`param()` on one of those `.ps1` scripts, the matching `*-GUI.ps1` must be updated to pass the
new argument AND the exe rebuilt (`Build-Setup-Exe.ps1`). Always check the parameter surface
when editing an installer script.

**GUI wrapper design (WPF + ps2exe) — each of these was a real bug; do NOT re-break:**
- **Build with `-STA`** (in `Build-Setup-Exe.ps1`). WPF needs a single-threaded apartment or
  the window renders but text/password fields can't be clicked. ps2exe defaults to MTA.
- **Compiled exe has EMPTY `$PSScriptRoot`/`$PSCommandPath`.** Resolve the app's own folder
  from the process image (`[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName`),
  never `Split-Path $PSCommandPath` (crashes: "Cannot bind argument to parameter 'Path'").
- **Launch the engine with the REAL `powershell.exe`** (`$PSHOME\powershell.exe`), NOT
  `(Get-Process -Id $PID).Path` — that is the exe itself when compiled (fails with "A
  parameter cannot be found that matches parameter name 'NoProfile'").
- **`[bool]` params can't bind through `powershell -File`** (`Cannot convert String to
  Boolean`). The GUI writes a tiny **wrapper `.ps1`** that calls the engine with real
  `$true`/`$false` and single-quoted (‘’-escaped) string args, then runs it with `-File`.
  This also makes passwords with spaces/quotes safe.
- **Success/failure comes from a STATUS FILE, not the process exit code.** `Start-Process
  -PassThru` (no `-Wait`, redirected stdout/stderr) returns a **null `ExitCode`**, so the
  GUI can't read it. The wrapper writes `OK`/`FAIL` to a temp file the GUI reads. (The
  engine `.ps1` also ends without a clean `exit 0` and native tools like npm/nssm/sc leave a
  non-zero `$LASTEXITCODE` even on success — another reason not to trust the exit code.)
- **stderr is filtered from the pane** (psql `NOTICE … already exists`, npm deprecation
  warnings, PowerShell `NativeCommandError` framing are all noise) — shown as a one-line
  count; the FULL output (stdout + stderr) is written to `Desktop\NocVault-Suite-*.log`,
  which the GUI auto-opens in Notepad on failure. Real failures surface as a `FATAL:` line
  on stdout.
- **Offline build:** the suite install must build with no internet beyond the GitHub clone.
  NetVault used `next/font/google` (Inter), which fetched from `fonts.googleapis.com` at
  build time and failed the whole install on restricted/offline networks — Inter now loads
  via the `@import` in `globals.css` (fixed 1.20.4). Don't reintroduce `next/font/google`.

**Known gotcha — "is tool X installed?" checks must use try/catch, not bare `2>$null`.**
`Install-NocVault-Suite.ps1`/`Uninstall-NocVault-Suite.ps1` check for Node/Git with
`try { & node --version 2>$null } catch { $null }` (see the comments right above those
lines). This is NOT redundant belt-and-suspenders — on a machine where the tool is
genuinely absent, `& node ...` throws a terminating PowerShell "the term 'node' is not
recognized" error, because `2>$null` only redirects a native command's OWN stderr stream;
there is no process to redirect from when PowerShell's own command-resolution fails first.
Without the `try/catch`, this crashes a fresh install stone dead on a truly clean machine —
and any box that already had Node/Git installed never hits the crash path, which is why it
can ship unnoticed for a while. Any future PowerShell "is tool X installed" check that
invokes the tool directly via `&` must be wrapped in `try/catch`, never bare `2>$null`.

**Distribution.** The `.exe`s are **gitignored build artifacts** (`installer/*.exe`) — built
on the dev PC with `Build-Setup-Exe.ps1`. To update a target machine, either rebuild there
(ps2exe installs on first run) or ship the packaged `NocVault-Suite-Installer-latest.zip`
(exes + `.ps1` engines together — the exe needs its sibling engine `.ps1`). **A GUI-wrapper
change needs a new exe; an engine/app-code change flows in via the GitHub clone at install
time (no new exe).** This is why "it still fails" after a fix is almost always a **stale exe**
on the target machine.

**Signing.** The exes are UNSIGNED → SmartScreen "unknown publisher" ("More info → Run anyway",
or `Unblock-File`). `Build-Setup-Exe.ps1 -CertPfx` is wired for Authenticode signing (SHA-256 +
timestamp). Since NocVault is sold to external customers, a public **EV** cert or **Azure
Trusted Signing** (instant SmartScreen trust, issued to the selling entity) is the right
answer — self-signed only works where the cert is deployed (GPO). No cert yet as of 2026-07-03.

**DB passwords / secrets are auto-generated per install — NO prompts, NO shared defaults.**
The installer no longer ships hardcoded credentials (it used to bake identical
`NocV@ult_Pg#2026` / `NVAdmin@2026` / a shared `NEXTAUTH_SECRET` into every customer's
copy — a real vulnerability). On install it generates unique random alphanumeric secrets
(`New-Pass`; alnum-only so they're safe inside SQL literals, the `postgresql://…` URL, and
`KEY=VALUE` .env files) and persists them machine-level in **`C:\ProgramData\NocVault\secrets.env`**
(`POSTGRES_PASSWORD`, `NEXTAUTH_SECRET`, `NOCVAULT_RO_PASS`, `NV/LV/DDI/SV_DB_PASS`). Each run
**loads-or-generates** from that file, so re-installs are idempotent (existing DBs/services keep
working). The **uninstaller and tester auto-read** `POSTGRES_PASSWORD` from `secrets.env` (then
the app `.env`/`.env.local`) — no prompt, no default. `-PgAdminPassword`/`-PgPassword`/
`-NocReadOnlyPass` remain as explicit overrides; the GUI password fields were removed. Apps are
unaffected — they read creds from env vars (`DATABASE_URL`/`*_DB_PASS`/`NEXTAUTH_SECRET`) whose
**names are unchanged**; only the values became random. If PostgreSQL pre-exists with an unknown
password (a dirty box) the installer throws a clear message to remove PG (or pass
`-PgAdminPassword`) rather than failing cryptically. `secrets.env` survives an uninstall unless
`-RemoveDependencies` is used (so a re-install still matches the retained PostgreSQL).

**Demo data seeder (bundled tool — NOT part of a fresh install).** The zip also ships
`NocVault-Demo-Seed.exe` (built from `installer/NocVault-Demo-Seed-GUI.ps1`) + the seed scripts
`installer/seeds/<app>-seed.js`. It's a standalone GUI for populating demo data on a demo/test
install: pick a history window (7/14/30/90 days), a volume (light/normal/heavy), which apps, and
whether to clear existing demo data first. It reads `POSTGRES_PASSWORD` from `secrets.env`,
resolves `node` + the installed `pg` module (via `NODE_PATH` to an app's `node_modules`), and runs
each `seeds/<app>-seed.js` **as postgres** against that app's DB. **Seed contract** (all four scripts
honor it): env `DAYS`/`VOLUME`/`RESET`/`PG*`/`PGDATABASE`; time-series spans the last `DAYS`; `VOLUME`
scales counts (light 0.4 / normal 1 / heavy 2.5); `RESET=1` removes ONLY demo-tagged rows (never
users/settings/auth); `process.exit(0/1)`; no hardcoded DB password. These `seeds/` scripts are the
tool's own copies (in the netvault repo, bundled in the zip) — the older per-app `demo-seed.js` in
each product repo is a local-only version and is not shipped. This tool is optional demo tooling, so
it is deliberately NOT wired into `Test-NocVault-Suite.ps1`.

---

## Performance notes (already investigated — don't re-litigate)

**The NetVault updater is slow, and that is INHERENT — there is no safe knob to speed it
up.** Investigated 2026-06-26. `Update-NetVault.ps1` rebuilds the whole app — a Next.js 16
(Turbopack, `output: 'standalone'`) build of ~82 endpoints (~20 pages + ~62 API routes)
with full TypeScript type-checking, static-page generation, and standalone dependency
tracing. The other suite apps build only a small Next frontend (4–16 pages) and their roots
are no-build Express, which is why they finish far faster. The updater script itself is
already well-tuned: incremental `npm install` (does NOT wipe `node_modules`), the Next build
cache is preserved across runs (`git clean -fd` has no `-x`, so `.next/cache` survives), a
health-poll instead of long fixed sleeps.
- **ESLint-during-build is NOT a lever:** Next.js 16 **removed** the `eslint` key from
  `next.config.ts` (`eslint` is "no longer supported"; the key fails the build). Next 16
  already does not run ESLint during `next build`, so there is nothing to disable. Do not
  re-add `eslint: { ignoreDuringBuilds: true }` — it breaks the build.
- **Do NOT disable the TypeScript check** (`typescript.ignoreBuildErrors`) to save time —
  the `next build` type-check is the deploy safety gate; the time it costs buys correctness.
- Net: if asked again to "speed up the slow updater," the answer is the build is the cost of
  shipping the largest app in the suite; no safe change remains.

**Known gotcha — the in-app "Update Now" trigger runs the build at BelowNormal CPU
priority unless the script corrects it (fixed 1.23.26).** `app/api/system/update/route.ts`
schedules the update via a bare `schtasks /create ... /ru SYSTEM` with no priority
specified — Windows Task Scheduler's default task priority is level 7, which maps to the
`BelowNormal` process priority class. A manually-run script from an interactive PowerShell
window gets the normal `Normal` priority class instead. This starves the CPU-bound
`npm run build` step (see above — it's already the slowest, heaviest part of the update)
under any contention from the rest of the suite (Postgres, the other 3 apps, their
collectors) running at Normal-or-higher, making an in-app-triggered update look "stuck" at
the build step compared to the same update run manually. `Update-NetVault.ps1` now resets
its own process priority to `Normal` at startup, regardless of how it was invoked — Windows
child processes inherit their parent's priority class by default, so this also covers the
npm/node/Turbopack children it spawns. A no-op when already `Normal` (the manual-run case).
Don't "fix" this at the `schtasks /create` call site instead (e.g. hunting for a `/priority`
flag) — `schtasks.exe` doesn't expose one on the classic command-line syntax; resetting the
script's own priority is the simpler fix and works for both invocation paths at once.

**Launcher load speed (fixed in 1.19.8).** The launcher's slowness was mainly the suite
cross-app probes (`app/api/suite/health` + `app/api/suite/stats`), not the license check —
they fan out to sibling apps and a slow/offline sibling could stall the tiles. They now use
a 1.5s per-app timeout + ~20s in-memory cache. The license check was a secondary cost
(`getServerId()` ran a synchronous `execSync` reg-query every call) and is now memoized in
`lib/license.ts`. The license-aware launcher tiles add no network cost (client-side only).

**Server-side cross-app fetches must use `127.0.0.1`, never `localhost`
(fixed 1.23.6; the installer health checks already use 127.0.0.1 for the same
reason).** On Windows `localhost` resolves to `::1` (IPv6) first; the suite apps
listen on IPv4 only, so every probe stalls ~1s on the dead `::1` connect before
falling back — enough to trip tight timeouts intermittently (the launcher's Suite
Health / stat tiles showed "Unavailable" until refresh; LogVault's heavy
`/api/stats` was the usual casualty). The suite health + stats aggregators
(`app/api/suite/{health,stats}`) now hardcode `127.0.0.1` defaults and use a
3000ms per-probe timeout (was 1500). Applies to ANY new server-side fetch of a
sibling app or local service — use `127.0.0.1`. Env overrides
(`*_HEALTH_URL`/`*_STATS_URL`) still win for proxied deployments.

---

## Versioning Policy

This app follows semantic versioning. Baseline: 1.2.0 (Jun 2026)

Every commit must include a version bump:
- Bug fix, UI tweak, copy change, config fix → PATCH (x.x.+1)
  Run: npm version patch --no-git-tag-version
- New feature, new page, new API, new chart → MINOR (x.+1.0)
  Run: npm version minor --no-git-tag-version
- Breaking change, DB migration, architecture overhaul → MAJOR (+1.0.0)
  Run: npm version major --no-git-tag-version

Examples of what counts as each type:
- Login page overhaul → Minor
- New dashboard with charts → Minor
- Health score tracking → Minor
- Bug fix (hardcoded IP, broken link, wrong email) → Patch
- New EOL intelligence integration → Minor
- Schema breaking change → Major

Rules:
- ALWAYS bump version as part of the same commit as the changes
- NEVER skip the version bump
- Run npm version BEFORE npm run build
- The app reads version from package.json via /api/health
- NocVault suite itself has no version number — only the 4 apps
- When bumping version, also update the releaseNotes object in the update status API with 3-5 bullets describing what changed. No CHANGELOG.md — release notes live in the update status API only.

**Exception — pure documentation changes need no version bump.** A CLAUDE.md-only edit,
or a source change that touches ONLY a code comment with no logic change, does not bump
`package.json`. Reasoning: the version exists to tell an admin "did the running app's
behavior change" (surfaced via `/api/health` and the update-status release notes) — bumping
it for a doc/comment-only edit would falsely claim a functional change occurred. Everything
else — any change to actual runtime behavior, however small (a hardcoded IP, a copy tweak,
a one-line config fix) — still requires a bump per the rules above. If a commit mixes a
real code change with doc updates, it still needs the bump (the exception is only for
commits that touch nothing but docs/comments).

---

## UI design

The sidebar uses suite-standard colored nav icon chips (28×28, radius 8, per-route tint,
only the active item is colored), 14px nav labels, and a 34px circular avatar — shared
across the NocVault suite.

Styling is a custom CSS design system in `app/globals.css` (CSS custom properties in
`:root` + theme) plus inline `style={{ ... }}` on components — NOT Tailwind. Inter is the
body font (loaded via a CSS `@import` in `app/globals.css`, NOT `next/font/google` — see
"Installer parity" above for why). `--radius: 8px` / `--radius-sm: 6px`.

### Typography & design tokens (suite standard)

- **Body font:** Inter (via the `@import` in `app/globals.css`, not `next/font`).
- **Monospace:** `var(--font-mono)` = `'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace`. One mono stack everywhere — never hardcode a mono font-family.

**7-step type scale** (defined once in `:root`; sizes do NOT change per theme):

| Token         | px   | Use |
|---------------|------|-----|
| `--text-xs`   | 11px | table headers, badges, micro-labels |
| `--text-sm`   | 12px | secondary labels, captions |
| `--text-base` | 13px | buttons, inputs, table body |
| `--text-md`   | 14px | body text, card titles (base body size) |
| `--text-lg`   | 16px | section / panel headings |
| `--text-xl`   | 20px | page titles |
| `--text-2xl`  | 28px | stat numbers / display |

**Rule:** On app surfaces (`app/(app)/...` and shared components) NEVER hardcode font
sizes or colors that duplicate a token. Always use `var(--text-*)` for type and the color
tokens (`--text-primary/-secondary/-muted`, `--bg-primary/-card`, `--border`,
`--border-light`, `--primary`, `--primary-dark`, etc.). Hardcoded hex that duplicates a
token breaks theming (hex doesn't flip themes). Display/hero sizes >= 34px (e.g. the
settings update-status glyphs ~44px, the compliance score ~52px) may stay literal — they
are intentional display sizes, not body type.

**Exception:** the animated **login** (`app/(auth)/login/`) and **launcher**
(`app/(auth)/launcher/`) pages use intentional hero/marketing typography (40px headlines,
Rubik logo, condensed letter-spacing). They are EXEMPT from the scale — leave their font
sizes, the Rubik logo, and hero styling as-is.

This is the **NocVault SUITE-WIDE standard** — the same scale and rule apply to spanvault,
ddivault, and logvault. SpanVault is the reference implementation; copy this pattern exactly.

---

## Access control (RBAC, site-scoping, app-access) — read before touching any guard

**A fixed access-control bug is a fixed INSTANCE, not a fixed CLASS — audit siblings.**
The `site_admin`-can-only-see-their-own-sites check (`user.siteIds?.includes(...)` →
404 if not) was added to `app/api/sites/[id]/route.ts` and `app/api/circuits/[id]/route.ts`,
but the identical missing check sat untouched on the sibling `app/api/audit/device/[id]/route.ts`
until a separate audit caught it later (fixed together in 1.23.3). All three now carry the
same guard shape — compare them if you need the pattern. The rule: when you add a
site-scope/role/ownership check to one route, grep for every OTHER route touching the same
resource type (or a resource that hangs off the same site_id-bearing entity) and confirm
they ALL have the equivalent guard. Closing one instance of a bug class is not the same as
closing the class — don't stop at the route that was reported.

**A new access-control gate must cover BOTH the page-navigation path AND the API path, in
the same change.** The per-user app-access feature (`lib/appAccess.ts` — `getUserApps()` /
`canAccessApp()`) governs which of the 4 suite apps a user may reach; the launcher page
(`app/(auth)/launcher/page.tsx`) filters which tiles render using `session.user.apps`, but
that's cosmetic — the actual enforcement for reaching a sibling app happens in the SSO
handoff routes (`app/api/sso/{logvault,ddivault,spanvault}/route.ts`), which call
`getUserApps()` + `canAccessApp()` before minting the cross-app JWT. Early versions of this
feature only gated the UI; a denied user's still-valid session could hit the SSO route (or
any other API) directly and get through. Now fixed — all three SSO routes check
`canAccessApp` before issuing a token (1.23.3). The general rule for ANY future gate (role,
site-scope, app-access, license-state, etc.): a page redirect is not a security boundary by
itself — verify the check also runs on every API route/proxy path reachable with the same
session, not just the page that renders the denial.

**NetVault's own API gating is per-route, not centralized — there is no `middleware.ts`
here.** Unlike SpanVault (whose `middleware.ts` proxies every `/api/*` request to Express),
NetVault has no global request gate; each route does its own `getServerSession` check, its
own inline role check where needed (e.g. the admin/super_admin split in
`app/api/settings/route.ts`), and — on routes that write data while the license is
unlicensed/expired — an explicit `checkWriteAllowed()` call (`app/api/license/route.ts`;
`sites/[id]` and `circuits/[id]`'s PUT/DELETE both call it). If you add a new intentionally
public route (must work without a session, like the SSO handoffs above), there's only this
one layer to reason about here — just don't skip a `checkWriteAllowed()` a sibling write
route relies on if you're refactoring near one. This is simpler than SpanVault/DDIVault,
where an unlisted route can silently fall through a proxy allow-list — see each app's own
CLAUDE.md for their gate structure before assuming NetVault's shape applies there.

---

## Database Access (Read-Only Diagnostics)

A read-only PostgreSQL user exists for Claude Code to query the live production
database directly during development. No psql installation needed — use the
Node.js `pg` module directly.

Connection details:

```
Host:      192.168.6.111
Port:      5432
User:      claude_readonly
Password:  [stored in Claude project memory — ask Amrin]
Databases: logvault, netvault, ddivault, spanvault
```

Usage in Claude Code:

```js
const { Client } = require('pg');
const client = new Client({
  host: '192.168.6.111',
  port: 5432,
  user: 'claude_readonly',
  password: process.env.DB_READONLY_PASS,
  database: 'netvault',  // change per app
  ssl: false
});
await client.connect();
const { rows } = await client.query('SELECT ...');
await client.end();
```

Permissions: SELECT only — cannot INSERT, UPDATE, DELETE, or modify schema.

Use it to:
- Check actual DB schema before writing queries
- Verify data exists before writing display code
- Diagnose query performance issues
- Confirm migrations worked correctly
- Inspect app_settings, devices, circuits, eol_seed, etc.

The password is **never** stored in this repo — it lives in Claude Code's project
memory and is provided at the start of each session. Never log it or commit it to
any repo.

## Live Server Verification (Diagnostics)

The suite runs on the production server **192.168.6.111**. Verify the *running*
deployment directly from the dev host over HTTP — no SSH needed — using `curl`
(Bash tool) or `Invoke-WebRequest` (PowerShell). Pair this with the read-only DB
access above: **curl answers "is it up / what version / what HTTP status", the DB
answers "is the data correct".**

**Health / deployed version** (unauthenticated — safe to hit anytime; use it to
confirm a deploy actually landed):

```bash
curl http://192.168.6.111:3000/api/health        # -> { status, version, ... }
```
```powershell
Invoke-WebRequest -Uri "http://192.168.6.111:3000/api/health" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Use each app's **frontend** port (it also serves `/api/*`). The separate backend
API ports (3005/3007/3009) are internal/proxied and not reliably reachable from
outside, so verify via the frontend port:

| App | Health URL |
|---|---|
| netvault  | http://192.168.6.111:3000/api/health |
| logvault  | http://192.168.6.111:3004/api/health |
| ddivault  | http://192.168.6.111:3006/api/health |
| spanvault | http://192.168.6.111:3008/api/health |

**This app: netvault → port 3000.**

**Verifying behaviour & data:**
- Most endpoints require an authenticated session + RBAC. An unauthenticated
  `curl` of them returns empty / 401 / a login redirect — that does **not** prove
  the endpoint is broken. To check the DATA an endpoint should return, query the
  read-only DB (above) or use the logged-in browser UI.
- Use `curl` for: `/api/health` (version), any explicitly public endpoint, and
  HTTP-status/redirect sanity — e.g. `curl -s -o /dev/null -D - http://192.168.6.111:3000/`
  to see the status code and `Location` (the root should 307 → `/launcher`).
- Deploys are **manual** — Amrin runs the app's updater script; Claude never
  deploys. Always verify **after** the deploy: confirm `/api/health` shows the new
  version, then confirm data via the read-only DB, then eyeball the UI.

---

## EOL Intelligence — central feed consumer (Phase 2, shipped 1.14.0)

NetVault's EOL dates come from a local **`eol_seed`** catalog → background **enrichment**
matches device models against it and writes `support_end_date`/`os_eol_date`/`eol_source`
onto `devices` (status-change recommendations are **never** auto-applied — human-gated).

The seed catalog is fed two ways:
1. **Bundled baseline** — `lib/eolSeed.ts` (`EOL_SEED`), migrated into `eol_seed` by
   `migrateLegacySeed` in `lib/eolEnrich.ts`. This is the **offline floor**: a fresh /
   air-gapped install works with NO internet. (949 vendor-confirmed models as of 1.16.0,
   up from an original 32 — see commit `1d24806`. `lib/eolSeed.ts` is a GENERATED file;
   regenerate it from the central nocvault-eol seed with `node scripts/gen-eol-seed.cjs`
   rather than hand-editing.)
2. **Central signed feed** (live updates) — the **"Sync from EOL feed"** button on the
   EOL Intelligence page → `POST /api/admin/eol-seed/sync` (super_admin) → `lib/eolFeed.ts`
   `syncFromFeed()`. It fetches `${NOCVAULT_EOL_FEED_URL || 'https://nocvault-eol.netlify.app'}/api/v1/feed`
   (header `x-license-key` = `NOCVAULT_EOL_LICENSE_KEY || 'netvault'`), **verifies the
   Ed25519 signature + sha256** against the bundled public key, then upserts the feed
   models into `eol_seed` (`added_by='feed'`). **Writes ONLY `eol_seed` — never `devices`;
   enrichment stays a separate step.** Revert a sync with
   `DELETE FROM eol_seed WHERE added_by='feed'`. The feed builder/grower lives in the
   separate **nocvault-eol** repo (its CLAUDE.md documents the grow-the-list loop).
   **Auto-sync (1.17.0):** the same `syncFromFeed()` also runs **weekly** via the
   `NetVault-SyncEol` scheduled task (Sun 00:15) → `POST /api/system/sync-eol` (Bearer
   `CRON_SECRET`, or a super_admin session), scheduled just ahead of the daily 01:00
   `NetVault-EnrichEol` so Sunday's enrichment applies the fresh seed. The endpoint
   soft-skips (200 `{ok:false,skipped:true}`) when the feed is unreachable, so
   offline/air-gapped installs no-op and keep the bundled floor. Both scheduled tasks are
   registered by `installer/Update-NetVault.ps1`.

**Matching (`normalizeForMatch` in `lib/eolEnrich.ts`)** is flexible to product-line naming:
strips curated noise words (Catalyst, NGFW, FlexNetwork, ProCurve, …) + Cisco PID prefixes
(WS-C, AIR-AP), preserves model-defining lines (SonicWave, AirEngine). **This function is a
CONTRACT — it must stay byte-identical to `nocvault-eol/lib/match-normalize.ts`; any change
updates BOTH repos in lockstep** (currently `NORMALIZER_VERSION = 3`). `syncFromFeed`
self-heals via `recomputeSeedKeys()`: re-derives every `eol_seed` row's normalized key +
aliases with the current normalizer and collapses merged duplicates before applying the feed.

Bundled feed **public key** (Ed25519 spki DER b64) in `lib/eolFeed.ts`:
`MCowBQYDK2VwAyEAI+nk9JoWunzPTASALa5PLWwcLe9NNWRrZ72tMY8ZU2k=`.

---

## Auth: by-id detail routes must reuse the list route's site-scoping

A `site_admin` is scoped to assigned sites. **Every `GET /api/<thing>/:id`
detail route must apply the SAME site-scoping its list sibling already does** —
this was missed on three routes in one week (`sites/:id`, `circuits/:id`,
`audit/device/:id`, fixed 1.23.2–1.23.3), letting a site_admin read
out-of-site records (device inventory, circuit cost/subnet/contract, full audit
history) by walking small integer IDs.

- Reference implementation: `app/api/devices/[id]/route.ts` — copy its scoping.
- **Return 404, not 403, outside scope** — a 403 confirms the row exists and
  lets scope be probed; 404 doesn't.
- When you add any by-id read route, check its scoping against the list route in
  the same review; don't assume auth middleware alone covers row-level access.

---

## Cross-app URL resolution (SSO handoff + launcher links, added 2026-07)

**The bug this fixed:** the hub→sibling SSO handoff routes
(`app/api/sso/{logvault,ddivault}/route.ts`) used to build the sibling's URL by
string-replacing a port onto NetVault's own `NEXTAUTH_URL` — an env var baked
to the install-time server IP and never updated. So no matter what hostname a
user actually reached NetVault through (a customer's own local-DNS name, for
instance), the redirect always pointed at the original install IP, which may
not be reachable from wherever the browser is. SpanVault had no
netvault-issued SSO route at all — its launcher tile was a raw client-side
link built from `window.location.hostname`.

**The fix — `lib/publicUrl.ts`** exports `resolveOrigin(req, port,
legacyFallback)`: derives the target origin from the CURRENT request's
`x-forwarded-host`/`host` + `x-forwarded-proto` (preferring the forwarded
headers so this also works behind a reverse proxy/tunnel, where the app
itself only sees the proxy's own local host/scheme), validated against a
hostname-shape regex before use, falling back to today's exact
`NEXTAUTH_URL`-based behavior if the request carries no usable Host — a no-op
for any install that never hits that edge case. `SIBLING_PORTS` maps each
sibling's fixed port (logvault 3004 / ddivault 3006 / spanvault 3008).

- **Known hardening gap (KIV `TRUST_PROXY_HEADERS`):** `x-forwarded-host` is
  trusted after only a **shape check** (`HOSTNAME_RE`), not an identity/allowlist
  check — a client that reaches the app directly could spoof the Host and steer a
  redirect target. Acceptable today (LAN / direct-IP, no proxy in front), but
  note the SSO handoff routes put a short-lived signed token in the redirect URL
  — gate forwarded-header trust behind an explicit `TRUST_PROXY_HEADERS`
  allowlist before relying on it, especially for those token-bearing redirects.

- `app/api/sso/logvault/route.ts` / `.../ddivault/route.ts` — both the
  self-redirects (no-session → login, denied → launcher) and the sibling
  redirect now call this resolver instead of the old port-replace hack.
- **`app/api/sso/spanvault/route.ts`** is NEW — SpanVault never had a proper
  signed handoff before; this mirrors the ddivault route (`getToken`-based)
  exactly. Verified compatible with SpanVault's existing `authorize()` with
  zero SpanVault-side changes to the JWT claim shape.
- `app/(auth)/launcher/page.tsx` — the SpanVault tile now links to
  `/api/sso/spanvault` (relative, server-handled) instead of the old raw
  client-side `window.location.hostname:3008` link.
- Every sibling app (logvault/ddivault/spanvault) has its OWN local copy of
  the identical `resolveOrigin` pattern for the reverse direction (sibling →
  hub redirects) — see each app's own CLAUDE.md. **This is intentionally
  duplicated per-repo, not a shared package** — these are small, independent
  apps with no shared-code mechanism today.

**Deliberately NOT built:** a database-backed, admin-editable "Suite URLs"
Settings page. Considered and rejected — the request-derived resolver already
gives zero-config behavior for the common case (one hostname, different port
per app — covers local-DNS and direct-IP access), and the only case that
needs anything else (a genuinely different hostname per app, e.g. a
Cloudflare Tunnel with per-app subdomains) has no way to be inferred from a
single request no matter what UI sits in front of it — that case is out of
scope for now (see chat history 2026-07-11/12 if revisited).

**A real regression this surfaced (fixed 2026-07-12, spanvault 1.71.3→1.71.4):**
porting a "proxy this call server-side to avoid CORS" fix from DDIVault to
SpanVault broke SpanVault's login, because the two apps proxy `/api/*`
completely differently (DDIVault: `next.config.js` rewrite allow-list, so an
unlisted route like `/api/sso` is handled by Next.js directly; SpanVault:
`middleware.ts` proxies EVERY `/api/*` to Express by default, so a Next.js
route under `frontend/src/app/api/**` is dead code there). See
[[spanvault-api-proxy-architecture]] in memory, and SpanVault's own CLAUDE.md,
before assuming a fix that works in one sibling app will work in another.

---

## Per-user app access (NetVault OWNS this — added 1.23.0)

NetVault is the hub and the source of truth for which of the 4 suite apps a
user may reach. `lib/appAccess.ts`:

- `ALL_APPS = ['netvault','logvault','ddivault','spanvault']`.
- `getUserApps(userId, role)` resolves the allowed set:
  - `super_admin` → **all** apps.
  - **no `user_apps` rows** → all apps (legacy / default-all; deploying the
    feature must not lock anyone out).
  - otherwise → the explicit set stored in `user_apps(user_id, app)`.
  - **DB error → FAIL CLOSED** (returns `[]`, was fail-open until 1.23.3). A
    transient error must never silently grant an app an explicit deny would
    have blocked. Note the asymmetry: because `[]` means "no extra apps" but
    *no rows* means "all apps", a closed failure can only be expressed as the
    empty set — never conflate "no rows" with "query failed".
- `canAccessApp(apps, slug)` → **netvault is always allowed**; any other slug
  must be in the set.

Enforcement is in **two** places and both must carry the apps:
- **NextAuth** injects `session.user.apps` (jwt + session callbacks) at login.
- Each **SSO handoff route** (`app/api/sso/{logvault,ddivault,spanvault}`)
  re-resolves apps live and either **blocks** (redirect `/launcher?denied=<slug>`)
  or stamps `apps[]` into the signed SSO token, so satellites can enforce in
  their own middleware (satellite-side gating is Phase 2-4).

Schema/UI lives in the installer path: `user_apps` table in `schema.sql`
(auto-provisioned on fresh install), checkboxes + "App access" column in the
user form (see the next note for *which* file).

**User management renders in `app/(app)/settings/page.tsx` (Settings → Users
tab) — NOT `app/(app)/users/page.tsx`.** The `users/page.tsx` route exists and
is reachable by URL but is NOT in the sidebar nav (`app/(app)/layout.tsx` lists
`/settings`, not `/users`), so anything added there never appears. 1.23.0 put
the app-access checkboxes in `users/page.tsx` and they were invisible until
1.23.1 ported them into `settings/page.tsx`. Edit the settings file for any
user-form or user-list change.
