@AGENTS.md

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

---

## UI design

The sidebar uses suite-standard colored nav icon chips (28×28, radius 8, per-route tint,
only the active item is colored), 14px nav labels, and a 34px circular avatar — shared
across the NocVault suite.

Styling is a custom CSS design system in `app/globals.css` (CSS custom properties in
`:root` + theme) plus inline `style={{ ... }}` on components — NOT Tailwind. Inter is the
body font (loaded via `next/font` in `app/layout.tsx`). `--radius: 8px` / `--radius-sm: 6px`.

### Typography & design tokens (suite standard)

- **Body font:** Inter (via `next/font`).
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
- Inspect app_settings, known_hosts, alert_rules, etc.

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
   air-gapped install works with NO internet. (Currently ~67 families — smaller than the
   central feed; see KIV in [[nocvault-eol-central-feed]] about refreshing it at build time.)
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
