# NetVault Gotchas — non-obvious behaviours

## Framework / build
- AGENTS.md warns Next.js version here has breaking changes vs training data — check `node_modules/next/dist/docs/` before assuming API shape.
- No `next/font/google` — Inter loads via `@import` in `app/globals.css`. Reintroducing `next/font/google` breaks offline/restricted-network installs (fixed 1.20.4).
- Next 16 removed the `eslint` key from `next.config.ts` — do not re-add `eslint: { ignoreDuringBuilds: true }`, it breaks the build. ESLint already doesn't run during `next build`.
- Do NOT disable `typescript.ignoreBuildErrors` — the build type-check is the deploy safety gate.
- Updater build is slow (~82 endpoints, full type-check) and this is INHERENT — no safe speed knob remains; don't re-litigate.
- No Tailwind — custom CSS design system (`app/globals.css` CSS vars + inline `style={{}}`). Never hardcode font-size/color hex that duplicates a `--text-*`/`--bg-*`/`--border-*` token (breaks theming). Login/launcher pages are exempt (intentional hero typography).

## Auth / access control
- No `middleware.ts` — API gating is per-route (`getServerSession` + inline role checks), unlike SpanVault which proxies all `/api/*` through one middleware. Don't assume a centralized gate exists.
- Every `GET /api/<thing>/:id` detail route must reuse its list route's site-scoping (missed 3x: sites/:id, circuits/:id, audit/device/:id — fixed 1.23.2-1.23.3). Reference impl: `app/api/devices/[id]/route.ts`.
- Return 404 (not 403) for out-of-scope by-id reads — 403 confirms the row exists and lets scope be probed.
- A page-navigation gate is NOT a security boundary — every gate (role/site-scope/app-access/license) must also be enforced on the API/proxy path reachable with the same session (per-user app-access was UI-only at first; fixed 1.23.3 across all 3 SSO handoff routes).
- Fixing one instance of an access-control bug is not fixing the class — grep every sibling route touching the same resource type when you add a guard.
- `lib/appAccess.ts` `getUserApps()`: DB error must FAIL CLOSED (`[]`), but `[]` (explicit deny-all) and "no `user_apps` rows" (legacy = all apps) are different states — never conflate them.
- `canAccessApp()` — netvault itself is always allowed regardless of the apps set; the NetVault launcher tile is never greyed.
- Users tab lives in `app/(app)/settings/page.tsx` (Settings -> Users), NOT `app/(app)/users/page.tsx` — that route exists, is reachable by URL, but is absent from the sidebar nav (`app/(app)/layout.tsx`). Anything added to `users/page.tsx` is invisible in normal use (bit NetVault app team already got burned by this in 1.23.0/1.23.1).
- `TRUST_PROXY_HEADERS` KIV gap: `x-forwarded-host` in `lib/publicUrl.ts` `resolveOrigin()` is only shape-validated, not identity/allowlist-checked — spoofable if the app is ever put behind an untrusted proxy. Fine today (LAN/direct-IP).

## Cross-app / suite
- Server-side cross-app fetches MUST use `127.0.0.1`, never `localhost` — on Windows `localhost` resolves `::1` first and the suite apps are IPv4-only, adding ~1s stall per probe (fixed 1.23.6).
- `resolveOrigin()` pattern (SSO/launcher URL resolution) is intentionally duplicated per-repo across all 4 apps, not shared — no shared-code mechanism exists today.
- A fix that works in one sibling app does not necessarily work in another — DDIVault proxies `/api/*` via `next.config.js` rewrite allow-list, SpanVault proxies ALL `/api/*` via `middleware.ts` to Express (a route under SpanVault's own `app/api/**` is dead code). Porting a fix between them broke SpanVault login once (2026-07-12).
- No DB-backed "Suite URLs" settings page — deliberately rejected; request-derived origin resolution already covers the common case.
- `nocvault_readonly` (Hub cross-DB read role) grant is re-applied in `schema.sql` itself (not just the one-time installer grant) because the app creates EOL tables at runtime as `netvault` — a table the installer's one-time grant never covered otherwise.

## EOL Intelligence
- `syncFromFeed()` (`lib/eolFeed.ts`) writes ONLY `eol_seed`, NEVER `devices` — enrichment is a separate step. Same for `POST /api/admin/eol-seed/sync` and the weekly `/api/system/sync-eol` cron.
- Enrichment NEVER overwrites a row that already carries a curated/manual date — conflicts go to `eol_discrepancies` for human review instead.
- Status-change recommendations (`eol_recommendations`) are NEVER auto-applied — human accept/ignore only, and only high-confidence exact/alias seed matches generate them (never fuzzy/medium).
- `normalizeForMatch` in `lib/eolEnrich.ts` is a CONTRACT — must stay byte-identical to `nocvault-eol/lib/match-normalize.ts` (tracked via `NORMALIZER_VERSION`). Changing one without the other silently breaks matching.
- `lib/eolSeed.ts` is a GENERATED file (949 entries) — regenerate via `node scripts/gen-eol-seed.cjs`, never hand-edit.
- Aruba AP bare-number aliases (e.g. "AP-615" -> "615") are scoped strictly to Aruba-branded devices — a plain HP/HPE device must never cross-match by number alone.
- `eol_seed.lifecycle` column is added by `lib/eolEnrich.ts` runtime `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, NOT present in `schema.sql` — a DB provisioned by `psql -f schema.sql` alone (no app boot) will lack it. See `.ai-codex/schema.md` Known schema debt.
- Purging "dateless" seed placeholders never touches feed-sourced (`added_by='feed'`) rows — those are never dateless by construction.

## Data integrity / imports
- Sites/device import only overwrites fields actually present in the uploaded file — a sparse re-import must never wipe existing good data (blank cells don't null out known values).
- `eol_discrepancies.device_id` / `eol_recommendations.device_id` are INTEGER with NO real FK constraint (comment: "enforced at runtime") — deleting a device manually cleans these tables in `app/api/devices/[id]/route.ts`; any other deletion path must repeat that cleanup or rows orphan silently.

## Installer / ops (see CLAUDE.md "Installer parity" for full detail)
- ANY change affecting provisioning (env var, scheduled task, schema/grant, service, port, build step) MUST update both `installer/Install-NocVault-Suite.ps1` AND `installer/Update-NetVault.ps1` in the same change — fresh installs and upgrades diverge otherwise.
- `installer/Install-NetVault.ps1` (the older standalone, non-suite installer) does NOT run `schema.sql` — it has its own smaller hardcoded schema block, missing several tables/columns. Treat it as legacy/divergent, not authoritative.
- PowerShell "is tool X installed" checks must use `try/catch` around the direct invocation (`& node --version`), never bare `2>$null` — `2>$null` only redirects a native command's OWN stderr; if the command itself fails to resolve, PowerShell throws before that redirect applies, crashing a truly clean machine's install silently-until-tested.
- Installer `.exe`s are gitignored build artifacts, UNSIGNED (SmartScreen warns) — a GUI-wrapper (.ps1) code change ships via git clone at install time, no exe rebuild needed; only a `param()` surface change on the wrapped `.ps1` needs a rebuilt exe.
- DB passwords/secrets are auto-generated per install (no shared hardcoded defaults) and persisted in `C:\ProgramData\NocVault\secrets.env` — never re-introduce shared/hardcoded credentials.
- Demo data seeder (`NocVault-Demo-Seed.exe` / `installer/seeds/*.js`) is optional tooling, deliberately NOT wired into `Test-NocVault-Suite.ps1`.

## License / entitlements
- `lib/license.ts` `LICENSE_SECRET` is a hardcoded shared AES key baked into every install (reviewed 2026-07-14 trade-off, kept as-is intentionally) — do not "fix" this into an env var without reading the comment first; it validates every customer's license key.
- Module gating (`lib/entitlements.ts`) is lenient by design — never locks a tile out by mistake; a tile is only marked unlicensed when an active license explicitly lists modules AND omits that app. Trial/grace/expired/unreachable states leave everything open.

## Versioning (mandatory workflow, see CLAUDE.md "Versioning Policy")
- Every commit that changes runtime behavior (however small) MUST bump `package.json` version (patch/minor/major per the rules) in the SAME commit, and update the `releaseNotes` object in the update-status API with 3-5 bullets. No CHANGELOG.md.
- Pure doc/comment-only changes are the ONLY exception to the version bump.
- Run `npm version` BEFORE `npm run build`.

## Diagnostics
- Read-only Postgres role `claude_readonly` exists for direct live-DB queries (host 192.168.6.111) — use the `pg` Node module directly, no psql needed. SELECT only.
- Unauthenticated `curl` of a session-gated endpoint returning empty/401/redirect does NOT prove the endpoint is broken — verify data via the read-only DB or the logged-in UI instead.
- Deploys are manual (Amrin runs the updater) — Claude never deploys; verify only AFTER a deploy by checking `/api/health` version first.
