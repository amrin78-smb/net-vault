# NetVault Gotchas — non-obvious behaviours

## Redacting a field is only half a fix — check what was READING it
- ⛔ **`app/api/system/tls/route.ts`'s GET must never return `keyPath`, and `CertificatePanel` must never branch on one.** 1.62.0 claimed the private key's location was no longer disclosed; it had been removed from `tls-transport` (the route nothing read it from) and left on `tls` — the route the panel actually renders. Removing it there in 1.62.2 then broke the panel the other way: the "Private key file" row branched on `state.keyPath`, so with the field gone it reported **"Not configured" for a key that was configured and present**. A redaction that silently changes what the page *claims* is a new bug, not a fix. The row now reads `keyConfigured` + `keyPresent` — two booleans that separate "none configured" from "configured but the file is gone" — and `tests/systemSeams.test.ts` pins the seam in BOTH directions (the panel must not reference a key path; the route must send `keyConfigured`; the panel must branch on it). Both halves were mutation-tested.
- The lesson generalises: when you remove a field from a payload, grep every consumer for it in the same change. A `doesNotMatch` assertion on the payload alone will pass while the UI quietly starts lying.

## The hub's own session was the weakest link in its access control (1.63.0)

⛔ **A STALE `role` ON A JWT WITH NO `maxAge` DEFEATED THE ENTIRE APP-ACCESS FEATURE FOR UP TO
THIRTY DAYS.** Four separate things had to be true at once, and they all were:
1. `session: { strategy: 'jwt' }` with no `maxAge` — NextAuth v4 then issues a **30-day** session
   (`core/init.js`: `const maxAge = 30 * 24 * 60 * 60`).
2. The `jwt` callback set `token.role` only inside `if (user)`, i.e. once at sign-in, and re-resolved
   it per request ONLY for `token.provider === ENTRA_PROVIDER_ID` — while the comment beside it
   claimed local users' roles were "re-read from `users` on every token use". They were not.
3. Hub routes read `session.user.role` straight off that token, and nothing invalidated a JWT on a
   role change or a user deletion.
4. `getUserApps` answered `[...ALL_APPS]` for `super_admin` **before any DB read**.
The scenario: Alice is `super_admin` and signs in. An operator demotes her to `viewer` and grants
her only `netvault` in `user_apps`. Her browser still holds a JWT saying `super_admin`.
`GET /api/sso/spanvault` → `getUserApps(id, 'super_admin')` short-circuits to all four apps WITHOUT
querying `user_apps` at all → a satellite token is minted with `role: super_admin, apps: [all]`. The
explicit deny is never consulted on any hop.
Fixed: `maxAge` + `jwt.maxAge` (both — see below), per-request re-resolution for LOCAL users too
(`lib/localIdentity.ts`), and the short-circuit removed.

⛔ **SETTING `session.maxAge` ALONE IS NOT ENOUGH.** `session.maxAge` governs the cookie's expiry and
the `exp` written by `/api/auth/session`; the SIGN-IN callback signs with `options.jwt.maxAge`, which
`core/init.js` builds from the 30-day constant rather than from `session`. Set only the first and the
freshly-minted token still verifies for 30 days under `getToken()` — the browser drops the cookie on
time while a copy replayed anywhere else does not. Also: **`updateAge` does nothing on the jwt
strategy** (`core/routes/session.js` consults it only in the database branch; the jwt branch
re-encodes on every call), so the window already rolls — setting it would read as the thing keeping
that true.

⛔ **`getToken()` RUNS NO CALLBACKS, SO IT SKIPS EVERY REVOCATION LAYER.** `app/api/sso/logvault`
used `getServerSession`; `ddivault` and `spanvault` used `getToken({ req, secret })`, which only
decodes the cookie. A directory user whose group→role mapping an administrator had revoked was
refused by logvault's handoff and handed a token carrying the old mapped role by the other two — the
exact layer whose own header says "a mapping an administrator revokes must stop working at once".
All three now use `getServerSession`, and `tests/systemSeams.test.ts` ENUMERATES `app/api/sso/*`
rather than naming the two that were fixed.

⛔ **A SESSION WHOSE ROLE WAS CLEARED IS STILL A SESSION.** The jwt callback nulls `token.role` on a
revoked mapping or a deleted account, but the handoffs carried on from there and would have minted a
satellite token with `role: null` — which SpanVault's `authorize()` reads as
`payload.role || 'viewer'`. A revocation that silently becomes "viewer on SpanVault" is not a
revocation. `lib/ssoHandoff.ts`'s `handoffIdentity` returns `null` for that, and the routes treat it
like no session at all.

⛔ **`GET /api/license` HAD NO SESSION CHECK AND ITS `POST` DID**, which is why grepping that file
for auth passed. It returned `serverId` (this machine's fingerprint — hostname + MachineGuid hashed,
the value a licence key is ISSUED against), `maxDevices` and `installDate` to anyone who could reach
port 3000, and all three satellites re-publish the whole object on their OWN unauthenticated
`license-status`. **It is TRIMMED, not authenticated**, and that choice is load-bearing: the
satellites poll it server-to-server with no credential and every one of them does
`if (!res.ok) return null` → `{ mode: 'unreachable', canWrite: true }`, so a session gate would turn
licence enforcement OFF in three products, silently, with nothing logged. `customer`/`expiry` stay
public because every satellite re-publishes them anyway.

⛔ **UNCLAMPED `page`/`limit` IS A CLASS, AND THE CORRECT VERSION EXISTED BUT WAS INLINE.**
`app/api/admin/eol-seed` clamped its pair properly; `app/api/devices` and `app/api/audit` used bare
`parseInt`, which gave any authenticated session `limit=99999999` (a DoS-sized scan of
`v_devices_flat`), `page=0` (negative OFFSET → PostgreSQL refuses → 500) and `limit=abc` (NaN into a
query parameter → 500). `lib/pagination.ts` is now the only way a route may read them, and the test
walks `app/api/**` to find the next one instead of listing the two that were fixed.

⛔ **`sc.exe` LOCALISES ITS STATE WORDS TOO, NOT JUST ITS FIELD NAMES — AND THE HTTPS TAB WAS DEAD
ON EVERY NON-ENGLISH HOST.** `parseScQcDependencies` was hardened against localised field names in
the same commit that left `readTerminatorState` twenty lines above keying on `RUNNING`/`STOPPED`/
`START_PENDING`. On a German or French Windows every reading was `unknown`, and
`transportCapability` turns `unknown` into "blocked in both directions" — disabling enable, disable
AND Preview permanently, while the panel reported it as an unchecked condition rather than a parser
failure. `parseScQueryState` reads the NUMERIC state code (the second `<number> <WORD>` field in
`sc query` output, which is TYPE then STATE in every locale); the English regexes stay as a fast
path so nothing changes where they already worked.

⛔ **A LOCK THE ROUTE CLAIMS WITH ITS OWN PID CAN NEVER GO STALE, AND A REAP ON THE WRITE PATH
CANNOT CLEAR WHAT THE READ PATH BLOCKS.** Four lock defects across the two SYSTEM-task routes, now
all in `lib/runLock.ts` with the reasoning attached: `service-restart` never claimed the lock at all
(two tabs, two admins, one truncated log and a verdict assembled from both runs); `tls-transport`
claimed with the hub's permanently-alive pid (so a wrapper that never started wedged the panel
forever, with the only clearing code behind the button the panel had hidden); `dead || old` against
an mtime written once at wrapper start reaped a LIVE run at 30 minutes; and the catch around
`/delete`+`/create`+`/run` deleted the task and dropped the lock of a wrapper that WAS running,
because `schtasks /run` can succeed and still exceed its timeout. The wrappers now heartbeat the
lock (so age is an idle timeout), GET reaps, and cleanup may only ever withdraw a PENDING claim.

⛔ **NOTHING DELETED THE SCHEDULED TASK WHEN THE WRAPPER STARTED AND THEN DIED.** Both routes delete
it when `schtasks /run` FAILS. A host reboot mid-run, a terminated task or a PowerShell crash leaves
`NocVault-TlsTransport` / `NocVault-ServiceRestart` registered with a `/sc once /st 00:00` trigger
and the wrapper still on disk holding the last requested action — and by those same files' stated
reasoning a `once` trigger whose start time has passed fires THE FOLLOWING DAY. A reboot during a
cutover at 14:00 therefore re-ran `-Disable` unattended at **midnight**, dropping the whole suite to
plain HTTP. Only the next POST reaped the task, and midnight comes first. The real fix is in the
WRAPPER: `psArmGuard` refuses to touch anything unless the lock still carries THIS run's pending
claim, and deletes the task on its way out — its one unauthorised fire is the only moment anything
is running that can remove the orphan.

⛔ **A CLOSING BANNER THAT IS PRINTED ON TWO DIFFERENT PATHS CANNOT BE THE VERDICT FOR EITHER.**
`HTTPS was NOT enabled - the suite is unchanged` is printed whenever `$script:TlsCutoverApplied` is
false — including when the gates never passed and nothing was touched at all. Mapped to `reverted`,
every REAL enable with a failing gate rendered "a gate did not pass after the move had started, so
the engine put every console back the way it found it": a four-console cutover and rollback that
never happened. And `Gates did NOT pass` only ever appears on the `-DryRun` branch, so `refused`
could not be reached by a real run at all. `REVERTING the TLS cutover` (written only by
`Undo-TlsCutover`) is the single line that proves consoles moved, and it promotes `refused` →
`reverted`.

⛔ **A LOWER UPTIME PROVES A RESTART STARTED, NEVER THAT IT FINISHED.** See
`.ai-codex/components.md`'s `RestartControl` entry: the hub answers HTTP before the wrapper has
brought `NocVault-Tls` back, so an uptime-only `done` went green while all four public ports were
dead — and polling stops at `done`, so it stayed green forever. It also made
`parseRestartLog`'s `depsFailed` term unreachable on the only path where dependents exist.

## Framework / build
- AGENTS.md warns Next.js version here has breaking changes vs training data — check `node_modules/next/dist/docs/` before assuming API shape.
- No `next/font/google` — Inter loads via `@import` in `app/globals.css`. Reintroducing `next/font/google` breaks offline/restricted-network installs (fixed 1.20.4).
- Next 16 removed the `eslint` key from `next.config.ts` — do not re-add `eslint: { ignoreDuringBuilds: true }`, it breaks the build. ESLint already doesn't run during `next build`.
- Do NOT disable `typescript.ignoreBuildErrors` — the build type-check is the deploy safety gate.
- Updater build is slow (~82 endpoints, full type-check) and this is INHERENT — no safe speed knob remains; don't re-litigate.
- No Tailwind — custom CSS design system (`app/globals.css` CSS vars + inline `style={{}}`). Never hardcode font-size/color hex that duplicates a `--text-*`/`--bg-*`/`--border-*` token (breaks theming). Login/launcher pages are exempt (intentional hero typography).
- `findGitRoot()` is now a single shared function in `lib/gitRoot.ts` (extracted 2026-07-23) — imported by both `app/api/system/update/route.ts` and `app/api/system/update-status/route.ts`. It was previously two independent copies and their `.next`-build-output guard (never trust a `.git` nested inside `.next/standalone`) drifted between them. Any future hardening of this function only needs to happen once — don't re-fork it.

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
- ⛔ **The hub's enrollment module preset does NOT by itself decide which modules an agent runs.** `agent_enrollment_tokens.preset` → `agent_modules` is what the fleet page DISPLAYS (and what the JWT `aud` carries); the agent decides what to LOAD purely from `config.json`'s `modules` key (`nocvault-agent.js` `moduleEnabled()`). Until 1.29.6 `install.ps1` wrote only `{hubUrl, enrollToken}`, so a "ddi enabled" agent silently never loaded ddi — DDIVault's Remote Agents page stayed empty forever and `agent_health.module_status` reported `{span:'ok'}` only, with no error on any side. The minted one-liner now passes `-Modules`. **When adding a module, wire it through BOTH places** — hub preset AND the installer's config.json — or it will look enabled and do nothing.
- ⛔ **`agent/**` is pinned to LF by `.gitattributes` (`text eol=lf`) and must stay that way.** The bundle is served byte-for-byte by `/api/agents/bundle/*` and each file's sha256 is Ed25519-signed into `agent/update-manifest.json` on a dev machine. Git's default eol conversion checks the same files out as CRLF on Windows, so every text file hashes differently and the agent aborts with `sha256 mismatch` after verifying the signature — meaning **the signed self-update could never succeed on any install** (found in production 2026-08-03; README.md alone differed by 104 CRLF pairs). If a binary file is ever added under `agent/`, exclude it with `-text` rather than relaxing the rule. Re-signing does NOT fix this — the manifest and the served bytes must agree, not just the manifest and the dev tree.
- ⛔ **`agent_modules.app` stores the SHORT slug ('span','ddi') — normalize with `toAppSlug()` before matching it against an app name.** Both the revoke and delete fan-outs mapped span only, so `apps.has('ddivault')` was permanently false and the DDIVault half of each was dead code the day it shipped (1.30.3 → fixed 1.30.5). One shared helper in `lib/agentIdentity.ts` so they can't drift again.
- ⛔ **Agent-ingest TLS has TWO halves that must move together, and each lives in a different repo.** The app-side updater mints the cert and sets `SV_WS_TLS_CERT`/`DDI_WS_TLS_CERT` — that flips the LISTENER *exclusively*, because `ws-server.js` swaps in `https.createServer` and then speaks `wss://` and nothing else, with no plaintext fallback. Which URL an agent is TOLD to dial is decided here on the hub by `deriveIngest()`, and since the hub is served over plain HTTP the request-derived scheme is always `ws://`. So flipping only the app side leaves the hub advertising `ws://` at a TLS-only listener and the whole fleet fails the handshake. The hub half is `SPANVAULT_WS_TLS` / `DDIVAULT_WS_TLS` (+ `*_WS_FINGERPRINT` for the pin baked into the printed install command). Both installers now set them in the same run that mints the cert: the suite installer writes them alongside the certs, and `Update-NetVault.ps1` re-derives them from the cert files on disk (`C:\ProgramData\NocVault\certs\<app>-ws.crt`) so it self-heals whatever order the per-app updaters ran in. A JWT-mode agent has NO fallback URL at all (its config carries only `hubUrl`/`enrollToken`), so it follows the hub and recovers on its own; an `apiKey`-mode agent derives `ws://` from its own `config.serverUrl` and would strand permanently instead.
- `deriveIngest()` derives the ingest host from the HUB's own request host — correct only when the satellite is co-located with the hub. It does not solve split deployments on its own; `SPANVAULT_PUBLIC_HOST` / `DDIVAULT_PUBLIC_HOST` override it when a satellite has its own server. Don't describe request-derivation as a split-deployment fix (1.30.3's note did, and was wrong).
- Revoke fans out an ACTIVE kick to BOTH satellites (1.30.3): SpanVault `POST /api/internal/agents/disconnect` (:3009) and DDIVault `POST /api/internal/ddi-agents/disconnect` (:3007) — different paths because each app named its own internal namespace. Each target is tried independently so one being down can't skip the other. Without the kick a revoke only took effect on the agent's NEXT connect, which for a healthy agent may never come.
- The agent gets each module's ingest URL FROM THE HUB (`deriveIngest` → enroll/policy `modules[].ingest` → `onModuleIngests`). Resolution order in `resolveDdiIngest`: explicit `config.modules.ddi.ingest` → hub-advertised → port-swap on the span ingest host → `serverUrl` host. The port-swap fallback is only correct when DDIVault and SpanVault are co-located; it fails as a silent reconnect loop when they aren't, which is why the hub value now wins over it.
- Hub policy IS now applied, but only for the MODULE SET and only by RESTARTING (agent 2.6.0 / app 1.30.0). Modules, transports and buffers are all built during module load, so `core/hub.js` hands the enabled slugs to the entrypoint's `applyPolicyModules()`, which rewrites `config.json` and exits — NSSM restarts it into the new set. **Two guards that must not be removed:** an empty enabled set is IGNORED (a truncated/empty response would otherwise disable every data plane — stopping an agent is what Revoke is for), and `span` is force-added to the desired set because the runtime loads it unconditionally, so a hub with span disabled would diff forever and restart on every policy tick. It also reconfigures at most once per process. Per-device WORK config still arrives over the app WS, not the hub.
- Server-side cross-app fetches MUST use `127.0.0.1`, never `localhost` — on Windows `localhost` resolves `::1` first and the suite apps are IPv4-only, adding ~1s stall per probe (fixed 1.23.6).
- `resolveOrigin()` pattern (SSO/launcher URL resolution) is intentionally duplicated per-repo across all 4 apps, not shared — no shared-code mechanism exists today. ⛔ And the 1.63.1/1.63.2 PORT fixes do NOT belong in the satellite copies: every satellite call site passes an explicit `3000`, which wins over any carried port, so only NetVault (whose SSO handoffs pass `port: null`) was ever affected.
- ⛔ **Setting `TLS_PUBLIC_HOST` re-opens the 1.63.1 dead-login-redirect bug unless `lib/publicUrl.ts` reads `x-forwarded-port` first (fixed 1.63.2).** A blank `TLS_PUBLIC_HOST` makes the terminator echo the browser's `Host`, which carries `:3000`; pinning it makes `x-forwarded-host` a bare hostname, leaving "keep the inbound port" nothing to keep and sending every sessionless SSO redirect back to the dead port 443. The two changes are one change — ship the env var without the port source and the hardening breaks sign-in on exactly the path it was meant to protect.
- A fix that works in one sibling app does not necessarily work in another — DDIVault proxies `/api/*` via `next.config.js` rewrite allow-list, SpanVault proxies ALL `/api/*` via `middleware.ts` to Express (a route under SpanVault's own `app/api/**` is dead code). Porting a fix between them broke SpanVault login once (2026-07-12).
- No DB-backed "Suite URLs" settings page — deliberately rejected; request-derived origin resolution already covers the common case.
- `nocvault_readonly` (Hub cross-DB read role) grant is re-applied in `schema.sql` itself (not just the one-time installer grant) because the app creates EOL tables at runtime as `netvault` — a table the installer's one-time grant never covered otherwise.

## EOL Intelligence
- `syncFromFeed()` (`lib/eolFeed.ts`) writes ONLY `eol_seed`, NEVER `devices` — enrichment is a separate step. Same for `POST /api/admin/eol-seed/sync` and the weekly `/api/system/sync-eol` cron.
- Enrichment NEVER overwrites a row that already carries a curated/manual date — conflicts go to `eol_discrepancies` for human review instead.
- Status-change recommendations (`eol_recommendations`) are NEVER auto-applied — human accept/ignore only, and only high-confidence exact/alias seed matches generate them (never fuzzy/medium).
- `normalizeForMatch` in `lib/eolEnrich.ts` is a CONTRACT — must stay byte-identical to `nocvault-eol/lib/match-normalize.ts` (tracked via `NORMALIZER_VERSION`, now **4**). Changing one without the other silently breaks matching.
- The Cisco PID strip inside `normalizeForMatch` is `/\b(?:ws-c|air-cap|air-ap|air-)(?=[a-z]{0,4}\d)/`. **The digit lookahead is load-bearing and vendor-independent by design** — it is what separates a Cisco PID (`AIR-CT2504`, `WS-C2960X`) from an ordinary product name with the same leading letters (`air-fiber-5XHD`, `air-cube`, `ws-comm-…`). Do NOT "simplify" it back to a bare prefix strip (that mangled non-Cisco models into false matches, fixed 1.29.5) and do NOT gate it on the vendor argument instead — the feed's core principle is that an inaccurate brand must never block a match, so the seed side and the device side have to normalize identically even when the brand is wrong or blank.
- `lib/eolSeed.ts` is a GENERATED file (949 entries) — regenerate via `node scripts/gen-eol-seed.cjs`, never hand-edit.
- Aruba AP bare-number aliases (e.g. "AP-615" -> "615") are scoped strictly to Aruba-branded devices — a plain HP/HPE device must never cross-match by number alone.
- `eol_seed.lifecycle` column is added by `lib/eolEnrich.ts` runtime `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, NOT present in `schema.sql` — a DB provisioned by `psql -f schema.sql` alone (no app boot) will lack it. See `.ai-codex/schema.md` Known schema debt.
- Purging "dateless" seed placeholders never touches feed-sourced (`added_by='feed'`) rows — those are never dateless by construction.

## Data integrity / imports
- Sites/device import only overwrites fields actually present in the uploaded file — a sparse re-import must never wipe existing good data (blank cells don't null out known values).
- `eol_discrepancies.device_id` / `eol_recommendations.device_id` are INTEGER with NO real FK constraint (comment: "enforced at runtime") — deleting a device manually cleans these tables in `app/api/devices/[id]/route.ts`; any other deletion path must repeat that cleanup or rows orphan silently.

## Installer / ops (see CLAUDE.md "Installer parity" for full detail)
- ANY change affecting provisioning (env var, scheduled task, schema/grant, service, port, build step) MUST update both `installer/Install-NocVault-Suite.ps1` AND `installer/Update-NetVault.ps1` in the same change — fresh installs and upgrades diverge otherwise.
- `installer/Install-NetVault.ps1` (the older standalone, non-suite installer) does NOT run `schema.sql` — it has its own smaller hardcoded schema block, missing several tables/columns. Treat it as legacy/divergent, not authoritative. **As of 1.64.1 it says so on screen** (a yellow banner naming the missing tables and pointing at `Install-NocVault-Suite.ps1`) rather than only in this index, because the consequence shows up later as missing features, never as an error. It also no longer seeds the published default admin password — same per-install generation as the suite installer, written to `secrets.env`, reported by location only.
- PowerShell "is tool X installed" checks must use `try/catch` around the direct invocation (`& node --version`), never bare `2>$null` — `2>$null` only redirects a native command's OWN stderr; if the command itself fails to resolve, PowerShell throws before that redirect applies, crashing a truly clean machine's install silently-until-tested.
- Installer `.exe`s are gitignored build artifacts, UNSIGNED (SmartScreen warns) — a GUI-wrapper (.ps1) code change ships via git clone at install time, no exe rebuild needed; only a `param()` surface change on the wrapped `.ps1` needs a rebuilt exe.
- DB passwords/secrets are auto-generated per install (no shared hardcoded defaults) and persisted in `C:\ProgramData\NocVault\secrets.env` — never re-introduce shared/hardcoded credentials.
- Demo data seeder (`NocVault-Demo-Seed.exe` / `installer/seeds/*.js`) is optional tooling, deliberately NOT wired into `Test-NocVault-Suite.ps1`.
- `psql -f schema.sql` invocations (`installer/Update-NetVault.ps1` and `installer/Install-NocVault-Suite.ps1`'s NetVault step) now pass `-v ON_ERROR_STOP=1` (added 2026-07-23) — without it, a genuine SQL error (e.g. a view referencing a nonexistent column) just prints and psql exits 0 anyway, which is exactly how a security-relevant REVOKE/GRANT fix shipped silently un-applied for a full release. schema.sql's idempotent statements (`IF NOT EXISTS`/`IF EXISTS`/`OR REPLACE`/`ON CONFLICT`) are unaffected — they don't error on a re-run. Any future top-level statement added to schema.sql must stay idempotent or it will now correctly halt the apply.
- A `DO $$ ... $$` block with no `EXCEPTION` handler fails ATOMICALLY — one failing statement inside it (e.g. a `GRANT` on a view that failed to create) rolls back every other statement in that same block, including unrelated tables/roles. Keep independent fixes (e.g. one table's REVOKE/GRANT vs another's) in SEPARATE `DO $$` blocks, and add an `EXCEPTION WHEN OTHERS THEN RAISE WARNING ...` to any block whose failure must stay visible instead of silently rolling back (see schema.sql's `users_public`/`app_settings_public` blocks, corrected 2026-07-23 after exactly this bug).
- `Update-NetVault.ps1` resilience system (2026-07-24 adversarial review, 10 fixes): (1) the initial service stop now always issues `sc.exe stop` regardless of the sampled status — skipping it when not exactly "Running" left a crash-looping service's NSSM auto-restart armed for the whole update window; (2) `Invoke-Rollback`'s "no `$prevCommit`" branch now sets `$ok = $false`; (3) `$standaloneSwapped` (set true only right after the pre-flight step's OWN `Rename-Item` swap succeeds) is checked BEFORE `Test-Path $standaloneBackup` in `Invoke-Rollback`, not as its `else` — if pre-flight fails before ever swapping the live build out, `$standaloneBackup` can still be occupied by an unrelated stale leftover from a PRIOR run, and checking Test-Path first would wrongly restore that stale leftover over the still-good live build; (4) the status JSON now carries `schemaAppliedButRolledBack` (schema.sql runs before the stages that can trigger a rollback, so a rollback never reverts a schema change already applied this run — `UpdateFailureBanner`/the overlay surface this as an extra warning line); (5) `Wait-Healthy` takes an optional `-ExpectedVersion` gating on `/api/health`'s `version` field (main flow expects the NEW version, `Invoke-Rollback` expects the PREVIOUS one) so a stale NSSM-relaunched build answering 200 is no longer mistaken for the real target version; (6) a `$InstallDir\logs\update.lock` PID file (checked before ANY service/file mutation, released in an outer `finally` even across the inner catch's `exit 1`) blocks overlapping runs, and `POST /api/system/update` returns 409 if it's live; (7) the `UpdatingOverlay` (settings page) now fetches `/api/system/last-update-status` once services answer healthy again, BEFORE showing any success UI, to tell a clean update apart from a silent auto-rollback (new `rolled_back`/`rollback_failed` phases, neither auto-reloads); (8) the success-path `.next\standalone.lastgood` cleanup reuses the same `Clear-StaleBackup` function as the pre-flight snapshot (retries, renames aside, warns loudly) instead of a silent best-effort delete; (9) `Write-StatusJson` writes to a temp file then `Move-Item -Force`s it onto the real path (atomic rename); (10) `update-status`/`last-update-status` routes gained session checks (any session / admin+ respectively) — see routes.md, they were `[public]` before.

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

- ⛔ **Settings is NOT admin-only any more (1.33.3) — and filtering the tab STRIP is not enough on its own.** Each tab's body renders from its own `activeTab === '<name>'` block, so hiding a button leaves the content reachable via `/settings?tab=users`. The deep-link effect therefore role-checks the requested tab as well, and depends on `user` rather than `[]` because the session resolves after first paint. A non-admin gets exactly one tab: Security / 2FA. The reason the page opened up at all: two-factor enrolment lives there now, and a role named in `mfa_required_roles` whose members cannot self-enrol is locked out permanently — refused at login for having no factor, with the only page that could give them one closed to them.

---

## UI shell / design system (1.39.0)

**`useSearchParams` in a Client Component needs a Suspense boundary or the
production BUILD FAILS.** Not a warning — `next build` errors with "Missing
Suspense boundary with useSearchParams". `components/shell/Sidebar.tsx` calls it
to work out which Settings tab is active, which is why `app/(app)/layout.tsx`
wraps it in `<Suspense>`. Same applies to any new client component that reads
search params.

**Custom properties: `:root` and `[data-theme="dark"]` have EQUAL specificity,
so source order decides.** Appending a new `:root { --x }` block at the END of
globals.css silently overrides the dark-theme value of `--x` and breaks dark
mode in a way that looks like the token "just doesn't work". New tokens must be
inserted INTO the existing `:root` and `[data-theme="dark"]` blocks, never
appended after them.

**Inline `style` beats a className, including a media query.** The mobile
drawer's close button had both `className="sidebar-mobile-close"` (display:none
on desktop) and an inline `display:'flex'`. The inline rule won and the X showed
on every desktop page. If an element must respond to a breakpoint, ALL of its
layout rules have to live in CSS — not half in a style prop.

**Status badge fills must use the `--tint-*` tokens, never literal hex.** The
`.badge-*` classes hardcoded light-mode values (`#dcfce7`/`#15803d`), so in dark
mode every status badge kept a pale pastel fill against a dark card. Fixed in
1.39.0. The tint tokens already existed for exactly this.

**The base `td` rule clamps every cell to `max-width:220px` + nowrap +
ellipsis.** Right for a description, wrong for an identifier — a truncated
circuit ID or serial is useless and is usually the value someone came to copy.
Opt a column out with `className="ident"` (mono, no clamp) or `"wrap"` (wraps).

**A destructive confirmation must render `.btn-destructive`, not
`.btn-primary`.** Those were the same red, so a delete and a save looked
identical at the moment of confirmation. `useConfirm({ danger: true })` now
picks the destructive style automatically.

**Don't generate ids with `Math.random()` during render.** It is impure and
differs between the server and client passes — a hydration mismatch, and in the
Dialog's case on the very attribute that names the dialog. Use `useId()`.

**Nav chips are a SUITE-WIDE standard, not a NetVault choice.** 28x28, radius 8
(tokenized so the square-corner style flattens it), per-route tint, and only the
active row is coloured — the other three NocVault apps do the same. Tints live
with the route in `components/shell/nav.ts`. See CLAUDE.md "UI design".


**`table-layout: fixed` means content can NEVER widen a column.** The circuits
table used it with percentage widths summing to 100%, so a long identifier
could only be clipped or - with `overflow: visible` - painted straight over
the neighbouring columns, which looks far worse. An identifier column needs
`table-layout: auto`, a `minWidth` on the table, and the container's
`overflow-x: auto` to take over. Use `className="ident"`; do not reach for
`overflow: visible` inside a width-constrained table.

**Dashboard endpoints answer 503, not a zero payload, when they fail.**
`/api/dashboard/overview` and `/api/dashboard/fleet-health` used to catch
their own errors and return 200 with every count at zero (overview's included
`compliance_score: 100`), which the page rendered as a real, healthy fleet.
The page's `safeFetch` now returns null on a non-ok response and the page
tracks an `unavailable` set. If you add a dashboard section, fail it loudly -
never into zeros.

**Fleet-health buckets are a strict partition in a fixed precedence**
(EOL/EOS > Decommed > Spare > Faulty > Healthy) so the donut's Healthy and
EOL equal the hero KPIs exactly. Before, "Healthy" meant `NOT IN (Decommed,
Spare)` and so counted faulty hardware as healthy, and the two halves of the
page disagreed. If you change a bucket, change `lib/healthScore.ts` with it or
the dashboard starts contradicting itself again.


## Responsive / theming (1.45.x)

**`repeat(N, 1fr)` bursts its container.** `1fr` means `minmax(auto, 1fr)`,
and the `auto` MINIMUM refuses to shrink below the track's content - so a
grid of cards overflows its own box on a narrow screen instead of squeezing.
16 grids across the app had this. Use `repeat(N, minmax(0, 1fr))`; it is
identical at desktop widths.

**An inline style beats a stylesheet rule, including `:focus-visible`.**
`components/GlobalSearch.tsx` set `outline: 'none'` inline, which made the
header search the only control in the tab order with no visible focus ring.
Never set `outline: none` inline; if a control needs a custom ring, define it
in globals.css where the focus-visible rule can be overridden deliberately.

**Chart legends and fixed-width donuts need an explicit wrap.** The fleet
donut is a hard 190px; paired with its legend on one non-wrapping row it put
the dashboard 70px past a 360px viewport. Long series labels also need to be
able to shrink - a label change alone ("Decommissioned" -> "Decommed") moved
the overflow by 33px.

**Sweep method that found all of this:** load every page at
1440/1280/1024/768/390/360 and compare
`documentElement.scrollWidth` with `clientWidth`. Then, for any page that
overflows, walk the DOM for elements whose right edge exceeds the viewport
AND that have no ancestor with a non-visible `overflow-x` - that filters out
the legitimate table scrollers and names the real culprit.

**A JSX comment cannot be the first child of `{cond && ( ... )}`.** Inside a
JSX *expression container* a `{/* ... */}` is a nested expression, not a
comment node, and the parse fails with "Expected corresponding closing tag".
Put the comment on the line ABOVE the conditional. This has bitten twice in
one pass (agents Dialog, audit Pager) — it looks completely ordinary.


**Sites is deliberately NOT paginated.** It groups by region/country and the
brief asks for that grouping to be retained; slicing a flat list would split
a country across two pages. 52 grouped cards browse fine. Devices, Circuits
and Audit all use the shared Pager; Sites is the documented exception.

## Shared primitives (1.54.0 sweep)

⛔ **A `Dialog`/drawer focus effect must key on `open` ALONE — never on a callback prop.**
`components/system/Dialog.tsx`'s focus effect depended on `close`, which depended on the
`onClose` prop. Every call site passes an inline arrow (`onClose={() => setShowUserForm(false)}`),
so `onClose` is a new function on each parent render — and when the dialog's form state lives in
that same parent (the Add/Edit user drawer, the change-password modal), **every keystroke is a
parent render**. The effect then tore down and re-ran mid-typing: the cleanup fired the
focus-restore, sending focus back to the trigger, and the re-run's rAF focused the FIRST field.
Measured on production: typing `abc` into the Add-user drawer's email field produced
name=`bc`, email=`a` — the form could not be filled in at all. The live callbacks now sit in refs
(`onCloseRef`/`dismissibleRef`/`initialFocusRef`) so the effect keys on `open`. `components/shell/Sidebar.tsx`'s
mobile-drawer trap had the same shape (the layout's own polling re-rendered it and threw focus
back to the first nav link) and got the same treatment. **This is the "input loses focus on every
keystroke" bug arriving by a different route than the nested-component rule — a clean build, a
clean type-check and a screenshot all pass it. Type into a dialog before calling it done.**

- **A LIMIT-ed list's `.length` is a page size, never a count.** The dashboard's "Sites Requiring
  Attention" badge was `topEol.length || overview.sites_at_risk`; `/api/dashboard/top-eol-sites`
  is `LIMIT 5`, so it rendered a red **5** directly beneath a hero tile reading **32 Sites at
  Risk**. The `||` was wrong in the other direction too — both reads failing gave `0 || 0`, a
  confident zero on data nobody managed to read.
- **`<>`/`NOT IN` against a nullable column silently drops rows from a partition.** The
  fleet-health donut bucketed on `lifecycle_status <> 'EOL / EOS'`; the column is nullable, so a
  device with no lifecycle recorded would match NO bucket and vanish from both the donut and its
  `total` — the exact invariant that partition exists to hold. Use `IS DISTINCT FROM`.
- **Clearing an error flag only on success makes the retry button look dead.** `/eol`, `/circuits`
  and `/sites` render `loadError` BEFORE `loading`, so a retry kept the error box on screen for the
  whole request (three `limit=3000` fetches on /eol) with no sign the click registered. The retry
  call sites clear the flag; `/devices` is the counter-example — it checks `loading` first.
- **Focus must FOLLOW selection in an automatic tablist.** The shared `Tabs` arrow-key handler
  changed `active` but never moved DOM focus, so the focus ring sat on the tab the user arrowed
  away from and a screen reader never announced the move.
- **No `<button>` inside `<Link>`.** Interactive content nested in an anchor is invalid HTML and
  gives every row action two tab stops. `/devices` shipped 101 instances and `/circuits` 51; they
  are now styled `<Link>`s. Use `className="btn ..."` or the same inline style on the Link itself.
- **`\uXXXX` is a JavaScript STRING escape, not a JSX TEXT escape.** `<span>a · b</span>`
  renders the six literal characters; `join(' · ')` inside quotes renders the dot. The
  licence banner shown on every page read "Licence expires in 4 days · Licensed to …" in
  production, and the dashboard clock read "ICT · Asia/Bangkok". Put the character itself in
  JSX text, or wrap it in an expression (`{'·'}`). Checked across all four suite apps —
  netvault was the only one affected.

## The TLS cutover, and the sibling updater that would have undone it (1.56.0)

⛔ **MOVING THE FOUR CONSOLES TO LOOPBACK IS THE CHANGE THAT CAN BRICK A SUITE.** It is what
makes the terminator a boundary, and if the terminator then does not start, all four web UIs are
unreachable with nothing but console access to the box to recover. So the installer gates it
behind three proofs — a certificate PAIR exists, the Node that will run the service actually
executes TypeScript (proved by RUNNING a throwaway `.ts`, never read off a version table), and
the terminator answers HTTPS `/api/health` on every console's public port with no
"NOT STARTED" banner — and `Undo-TlsCutover` runs from EVERY failure path, restoring each
console's whole env file from a pre-change snapshot and REMOVING the service so no auto-start
entry is left to fight for port 3000 at the next reboot. Fail any gate and the suite installs
exactly as it ships today.

⛔ **`Update-SpanVault.ps1` WOULD HAVE SILENTLY UNDONE THE CUTOVER ON EVERY RUN.** Its `$Services`
table hardcodes `next start -p 3008` and the script RE-APPLIES `AppParameters` on each update —
so a routine SpanVault update would have put that console back on `0.0.0.0:3008`, the port the
terminator holds, with no error. It now preserves the live parameters when they already name
`-H 127.0.0.1`. ⛔ The general rule: an updater that rewrites a service's `AppParameters` from a
table will overwrite any deployment-time change to those parameters. LogVault's and DDIVault's
updaters do not rewrite them, which is the only reason they did not have the same bug — check
before assuming a sibling is safe.

⛔ **`Update-NetVault.ps1` HAD TWO `Get-NetTCPConnection -LocalPort 3000` KILLS.** Behind the
terminator, 3000 is the TERMINATOR's port — those would have killed all four consoles mid-update.
Both now use the real app port read from the live service environment.

⛔ **`NocVault-Tls` MUST BE STOPPED AND REMOVED FIRST ON UNINSTALL.** Its `DependOnService` makes
Windows refuse `sc stop` on a console while it is running (1051), which cascades into `sc delete`
against live processes and a failed directory removal.

⛔ **ITS `AppEnvironmentExtra` CARRIES ONLY `NODE_ENV`, DELIBERATELY.** `TLS_CERT_PATH` and
`TLS_KEY_PATH` are `MANAGED_KEYS`: the service environment beats any file, so pinning them would
make every certificate change from Settings a silent no-op for the one process that actually
terminates TLS — wave one's `NEXTAUTH_URL` bug, one process over. The terminator's own
`loadEnvironment()` already reads the two files `resolveEnvTargets()` writes.

## Uninstall / install parity — found by running the real uninstaller on a real box (1.57.2)

⛔ **`secrets.env`'s `POSTGRES_PASSWORD` WAS NOT NECESSARILY THE CLUSTER'S PASSWORD.** The
installer generated one unconditionally and wrote it there, but an install onto a PostgreSQL that
already exists takes the real password from `-PgAdminPassword`, and only that value reached the
cluster and the app `.env` files. `Uninstall-NocVault-Suite.ps1` and `Test-NocVault-Suite.ps1`
both read `secrets.env` FIRST, so on such a box the uninstaller authenticated with a password that
works against nothing. Fixed on both sides: the installer records the password actually in use, and
both consumers now TEST each candidate (`Test-PgSuperuserPassword`) and take the first that
authenticates, not the first file that contains the key.

⛔ **THE UNINSTALLER PRINTED `[OK] Dropped database:` WITHOUT LOOKING AT THE EXIT CODE.** psql's
stderr went to `$null` and nothing read `$LASTEXITCODE`. Measured: nine consecutive `[OK]`s over
nine failures, then a green "Uninstall Complete". Any uninstaller/installer step that shells out
must read the exit code before it claims the step worked — and the closing banner must be able to
say INCOMPLETE.

⛔ **THE "LEFTOVER NODE PROCESS" KILL MATCHED `$InstallDir`, THE SHARED PARENT.** `C:\Apps` is not
a NocVault-specific path. Measured: a NocVault uninstall killed CertVault's `server.js` and
`engine-worker.js` (both launched from `C:\Apps\CertVault\runtime\node\node.exe`) and reported them
as "2 leftover NocVault node process(es)". It now matches the four app directories, with `IndexOf`
rather than `-like` so a `[` in a path is not read as a character class. Note what saved the other
product on the same box: SecVaultTest is launched with a RELATIVE path, so the substring never
matched it — escaping this was luck, not narrowing.

⛔ **A FULL UNINSTALL LEFT THREE PRIVATE KEYS ON DISK.** `C:\ProgramData\NocVault\certs` is outside
`$InstallDir`, so the directory-removal step never reached it: `nocvault.key` (on a customer
install, their uploaded wildcard key) plus the `spanvault-ws` / `ddivault-ws` agent-ingest keys.
Removed by default now, `-KeepCertificates` to retain. `secrets.env` is still deliberately kept.

⛔ **`New-NetFirewallRule` ADDS A SECOND RULE WITH THE SAME `DisplayName`** — it does not replace.
Two installs left two identical `NocVault DDIVault WS 3011` rules. All 11 call sites now go through
`Add-NocFirewallRule`, which returns early if the rule exists. That rule was also missing from the
uninstaller's removal list, so it survived a full uninstall; `Remove-NetFirewallRule -DisplayName`
does remove every duplicate at once, so the removal side needed only the missing name.

⛔ **`DROP ROLE` REFUSING IS THE SAFE OUTCOME, NOT A FAILURE TO WORK AROUND.** `nocvault_readonly`
could not be dropped because 23 objects in an unrelated `certvault` database depend on it. Forcing
it would revoke grants another product is using. The uninstaller reports the dependency, prints the
`REASSIGN OWNED` / `DROP OWNED` remedy, and leaves the role alone.

⛔ **THE INSTALLER PRINTED GENERATED SECRETS TO THE CONSOLE.** The unattended path echoed
`POSTGRES_PASSWORD` and the `nocvault_readonly` password in full — into the GUI's
`Desktop\NocVault-Suite-*.log` and into whatever session drove a remote install. It now prints the
LOCATION of `secrets.env` only.

⛔ **A WRONG `-PgAdminPassword` USED TO RUN ALL THE WAY TO A GREEN BANNER.** The pre-existing-
PostgreSQL probe threw only when the password had just been generated AND `-PgAdminPassword` was
absent. Every psql call below it ends in `2>$null`, so a bad password produced no database, no role
and no schema, and four services restart-looping. It now throws on any authentication failure.

## Re-install over a running suite (1.57.3)

⛔ **`Remove-Item -Recurse -Force` ON A HELD DIRECTORY EMPTIES IT AND THEN FAILS.** Measured with
a node process holding a tree the way NSSM holds these (relative entrypoint, working directory
inside): **all 22 files deleted**, then the call failed on the directory itself — `tree still
present: True, files remaining: 0 of 22`. And `git clone` into what was left **succeeded**, because
an empty directory is a valid clone target. So STEPs 8-11's old `if (Test-Path) { Remove-Item }`
did not fail safely OR loudly: it emptied a live installation, cloned over the top, and carried on
with the running process serving from deleted handles. Each app step's own `nssm stop` sits ~100
lines AFTER its delete.

⛔ **THE REPLACEMENT IS A RENAME, NOT A DELETE, AND THAT IS THE WHOLE POINT.** `Move-NocAppDirAside`
renames `<app>` to `<app>.replaced-<timestamp>`. A rename either succeeds whole or changes nothing,
and it fails for exactly the same reasons a delete would — so it is simultaneously the pre-flight
(it cannot half-work) and the rollback (the old tree survives intact under its new name if a later
step fails). STEP 12 removes the aside copies only after the new services are up; `Test-NocVault-Suite.ps1`
section 8b flags any that survive.

⛔ **STEP 7.5 IS THE REFUSAL BOUNDARY.** Everything before it is idempotent and non-destructive, so
refusing there costs nothing and leaves the existing install startable. It stops all 11 services
(`NocVault-Tls` FIRST — 1051), polls for `Stopped` rather than sleeping (the terminator's
`AppStopMethodConsole` is 15s because it drains live sockets), then kills orphaned node processes
matched against the FOUR APP DIRECTORIES, never `$InstallDir`.

⛔ **A SERVICE STOPPED ONLY TO SATISFY THE DEPENDENCY ORDER MUST BE STARTED AGAIN.** `NocVault-Tls`'s
`DependOnService` forces all four console services to stop even when `-InstallLogVault $false` means
this run will not re-register one of them. STEP 12 restarts anything in `$script:StoppedNotReinstalled`.

⛔ **AN EMPTY `Get-NocDirHolders` RESULT DOES NOT MEAN NOTHING HOLDS THE DIRECTORY.** It matches
command lines, and a process started with a relative entrypoint — which is how several of these NSSM
services are registered — has nothing matchable even though its working directory is inside.
Confirmed in the isolated test: the holder was correctly NOT identified, and the message says so
instead of claiming the folder is free.

## Directory sign-in: the two things that made it unusable (1.57.4)

⛔ **EVERY PIECE OF THE FEATURE WORKED AND NOBODY COULD SIGN IN.** Two gaps, both outside the
libraries that had the tests:
1. the login page only ever called `signIn('credentials')` — there was no way to START an Entra
   sign-in, so the provider, the callbacks and the JIT provisioning were unreachable from the UI;
2. `directory_role_mappings` had no API and no UI, and zero rows refuses everyone
   (`OUTCOME.NO_MAPPINGS`), so raw SQL was the only way to let anybody in.
Neither is visible from a unit test of the sign-in path, because both are about what the product
does not offer. When a feature's parts are all green, check that a person can reach them.

⛔ **THE LOGIN BUTTON IS DRIVEN BY `getProviders()`, NOT BY "IS A TENANT SAVED".** `entraProviders()`
registers the provider only when all three `ENTRA_*` values are present, so the provider list is the
answer to "can anyone actually sign in this way" — including the half-configured case, where a
button driven by a saved tenant id would appear and fail at Microsoft with an error the login page
cannot explain. It also must not come from a route of ours: that page is reachable without
authenticating, and `/api/auth/providers` is NextAuth's own public endpoint returning provider ids
only, whereas `isEntraConfigured` sits behind a super_admin gate for exactly that reason.

⛔ **THAT BUTTON IS OUTSIDE THE `<form>` AND IS `type="button"`.** Inside it, a click runs
`handleSubmit` and posts empty credentials before the redirect. It is also hidden during `mfaStage`:
someone part-way through a local two-factor challenge who clicks it abandons that challenge for a
different identity, and the code they were sent becomes a mystery.

⛔ **`entraAvailable` STARTS `null`, NOT `false`.** `false` renders the credentials form alone and
then pushes it down as the button appears, under the hands of someone already typing.

⛔ **A PANEL'S EARLY RETURN CAN HIDE AN UNRELATED, HEALTHY FEATURE (1.57.5).** `DirectoryMappingsCard`
was rendered only from `SingleSignOnPanel`'s success branch. `/api/system/entra` reads ENV FILES and
500s when it cannot (a missing `.env`, a permissions problem, a half-finished deploy) — and the
mappings are in the DATABASE, entirely unaffected. So an env fault took the group → role table away
from the administrator at the exact moment they were most likely trying to fix a sign-in problem.
Found by opening the page, not by any test: every unit test passed, and the panel's own error branch
looked correct in isolation. The card now renders on all three branches (loading, error, success),
and `ssoConfigured` is TRI-STATE so that `null` ("could not read the other setting") states the
consequence of an empty list without asserting anything about the tenant.

⛔ **ENTRA WILL NOT ACCEPT AN IP ADDRESS AS A REDIRECT URI (1.57.8).** Every NocVault install starts
on one — `NEXTAUTH_URL` is baked to the server's address at install time — so the Redirect URI the
SSO panel derives and presents as "register this" could not be registered at all. The failure is the
worst possible shape: it happens on **Microsoft's side**, the portal refuses the paste, and nothing
about it reaches this server, so there is no log line and no audit row and the administrator
concludes they copied it wrong. `classifyRedirectUri` now flags it, along with non-loopback `http`
(Entra requires https, loopback excepted — so a correct hostname still fails before the TLS cutover)
and a single-label host. Reported from SecVault's field experience, not from the docs.

⛔ **A 'use client' COMPONENT CANNOT IMPORT A MODULE THAT REACHES NODE BUILT-INS.** Twice in one
session: `lib/directoryRefusals.ts` pulled the whole `pg` driver into the browser bundle (6 Turbopack
errors from `pg/lib/connection-parameters.js`), and `lib/entraSettings.ts` reaches `node:fs` through
`envFile.ts`. A *constant* a client needs travels as data from the API; a pure *function* it shares
with a route goes in its own zero-import module. `tsc` is happy either way — only the build catches it.

⛔ **AN APPLY AND ITS REVERT ARE TWO HALVES OF ONE FACT (1.58.5).** `Set-ConsoleTransport` wrote
`AppEnvironmentExtra` only for `standalone` mode, so `Restore-ConsoleTransport` restored it only for
`standalone`. When the apply was widened to rewrite a service-pinned `NEXTAUTH_URL` for EVERY
console, the restore was not widened to match. On production the cutover then failed at the loopback
check and reverted — and the revert put the AppParameters back while leaving LogVault and DDIVault
pinned to `https://…` in their service environment with the consoles serving plain HTTP again. Both
reported `/api/health` 200. Both had broken sign-in. **A revert that leaves a worse state than the
failure it was recovering from is the one thing a revert may never do.** The restore is now
unconditional over everything the apply can write, so widening the apply again cannot desynchronise
it.

⛔ **NSSM'S `AppDirectory` IS THE SERVICE'S WORKING DIRECTORY, NOT THE INSTALL ROOT**, and on
production the four consoles run from four different depths (`.next\standalone`, `frontend`, the
repo root). Worse, Next's standalone build output is a near-complete COPY of the repo — it carries
`.git`, `package.json` and `installer\terminator\start.mjs` — so any single marker identifies it
just as well as the real root. Resolve by walking to the OUTERMOST checkout, bounded by
`$InstallDir`, and reject any `\.next\` path structurally.

⛔ **CONSOLE SERVICES IN THE FIELD ARE NOT ALL REGISTERED THE SAME WAY.** Measured on one server:
`node server.js` (standalone), `cmd.exe /c next.cmd start --port 3004`, `next.cmd start -p 3006`,
and `node .../next start -p 3008` — four shapes from four installer eras on one box. Anything that
rewrites a command line must accept `-p` and `--port`, and must refuse rather than guess at a third.

## A PowerShell installer's exit code is not its verdict
`installer/Enable-NocVaultTls.ps1` exits **0** whether it enabled HTTPS or moved all four consoles,
failed a gate, and put everything back. MEASURED on production twice on 2026-11-06: the successful run
and the reverted run both ended `exit: 0`. Anything deciding "did that work" from `$LASTEXITCODE` or
`r.status_code` will report success to an administrator whose suite is still on plain HTTP.

Read the script's own closing banner instead — `lib/tlsTransport.ts`'s `parseRunLog` does, and
`tests/tlsTransport.test.ts` asserts the two exit codes are identical precisely so the "simplification"
of reading the exit code cannot land unnoticed. This is the same family as the GUI installer's
status-file rule in CLAUDE.md (npm/nssm/sc leave a non-zero `$LASTEXITCODE` even on success), and the
two together mean: on this codebase a PowerShell exit code is evidence of nothing in either direction.

## A gate that gives up must say what it saw
The TLS cutover's health probe was `catch {}` — every attempt's failure reason discarded — so a failing
gate could only report "<console> did NOT answer". That one missing string cost two production evenings
and **five** measured-and-disproved hypotheses (registration shape, a rejected `sc start` after a fixed
4 s sleep, a slow cold `/api/health`, contention from four simultaneous restarts, the port move itself).
The console was healthy every time; the probe was wrong, and nothing recorded how. Fixed in 1.59.2 by
tallying every attempt's outcome and printing it.

Related: a per-attempt timeout that differs wildly between things being checked is a gate with a
hidden bias. The probe allowed 3 s while logvault's `/api/health` legitimately takes 1.2-1.9 s (it is a
middleware rewrite to the Express API on :3005) and the other three take ~0.1 s — the slowest console
had 2x headroom and the others 30x, for no stated reason.

## Gate 1 checked the filesystem; the terminator reads the configuration
`Enable-NocVaultTls.ps1` verified a certificate pair existed ON DISK and never wrote `TLS_CERT_PATH` /
`TLS_KEY_PATH` anywhere. `Install-NocVault-Suite.ps1` writes them via `$NVEnvTail` while composing a new
`.env`; the enable-on-an-existing-install path has an empty tail on purpose (it must not duplicate keys
in a file that already exists) and nothing replaced them. So `resolveTlsConfig()` returned `disabled`,
the terminator bound all four public ports in **plaintext**, logged `TLS: not configured - serving plain
HTTP on port 3000`, and gate 3 failed honestly against a listener doing exactly what it was configured
to do. **Enabling HTTPS on an already-installed suite could not have worked on any box.** Fixed in
1.59.3. The lesson generalises: a gate that proves a FILE exists has not proved the process that needs
it can find it.

## `sc stop` is refused while a dependent service is running (1051)
`NocVault-Tls` declares `DependOnService` on all four consoles, so Windows REFUSES `sc.exe stop
NetVault` (or any console) with **1051** while the terminator is running. What makes this dangerous is
how it fails: the stop is refused, a following `sc start` returns 1056 (already running), and the
service is `Running` the whole time — so any check of the form "is it running afterwards" reports a
restart that never happened as a success, and the operator is told their new setting is live while the
old process serves on.

Stop the dependents first and start them after, and make the verdict a **changed PID**. Restarting a
console by hand needs the same order.

## A server-side call between two apps on the same box must not go through the front door
Each satellite verifies an SSO handover by calling `<hub>/api/auth/sso-verify` **server side**. Those
URLs pointed at `http://<server-ip>:3000`. Once the TLS terminator owns :3000 that is answered with a
301 to https, node's fetch follows it, and the handshake then fails `ERR_TLS_CERT_ALTNAME_INVALID`
because a REAL certificate names the site, not the server's IP. DDIVault sign-in broke with
"CredentialsSignin" on a suite whose health checks were all green (2026-11-06); LogVault and SpanVault
were fine because neither makes that call.

Server-to-server on one box uses the **loopback** (`http://127.0.0.1:13000`): no redirect, no DNS, no
certificate. `NEXT_PUBLIC_*` hub URLs are the opposite — a browser reads those and they must stay
public. The cutover now repoints the first and leaves the second alone.

### Seams, not parts (the 2026-11-06 sweep)

A four-agent review of the HTTPS and restart features found 20 defects. **Every
serious one was at a SEAM**, and every pure function involved was already well
covered by tests:

- **Route computed, panel never read it.** `fronted`/`publicPort` shipped in
  1.60.1; no panel passed them, so the helper's whole fronted branch was dead
  code — with five PASSING tests over it, because they called the helper
  directly. `console-url/route.ts` received only the import line. Net effect:
  both tabs reported the loopback port as the public address for weeks.
  **A type that does not declare the field is why nothing could consume it** —
  the panels' prop types had no `fronted`, so wiring it was a type error.
- **A lib's tri-state collapsed at its caller.** `terminatorState.ts` returns
  `null` for "could not read" precisely so nobody states a guess; both callers
  wrote `=== true`, turning it into `false`.
- **The engine printed a banner the parser never saw.** The disable path's
  FAILURE wording contains the success substring. Only the enable path's logs
  had been harvested into fixtures.
- **The panel's verdict watched the wrong thing.** Hub uptime cannot prove a
  `NocVault-Tls` restart, and the baseline was fetched at mount rather than
  taken from the POST response.

**The rule:** when a feature spans a lib, a route and a panel, write at least
one test that crosses each join — see `tests/systemSeams.test.ts`, which
asserts the panels actually pass the props the routes compute, and which caught
a second un-fixed `examplePort` in the PUT handler the moment it was written.
Testing each layer in isolation is what let all of this ship.

### A leftover `.lastgood` snapshot can be the only path back

Each updater deletes any existing `.lastgood` directory before snapshotting the
live install, on the reasoning that it is debris from an interrupted run. It is
not always: if a PRIOR run failed **and its own rollback also failed**, that
snapshot is the last intact copy of a working install — and the next attempt
deleted all of it before snapshotting its own, already-broken tree.

All four updaters now refuse in that case, using the heuristic DDIVault's had
from the start: `last-update-status.json` recording `success:false` AND
`rolledBack:false` is exactly the "ROLLBACK ALSO FAILED" state. They restart the
services and the TLS front door first, so aborting does not also leave the app
down on top of the bad state being reported.

### `Enable-NocVaultTls.ps1 -Disable` must not remove the terminator early

The stop has to come first — it is what releases the public ports, so the
consoles cannot rebind them until it happens. The REMOVAL does not. Deleting the
service before the consoles were verified back left no way out: if a console's
rewrite then failed (a locked env file, an `nssm get` returning `''`, whose
return value was being discarded), that console stayed on `127.0.0.1:1300X` with
nothing in front of it, permanently unreachable — and `-Disable` could not be
re-run to repair it, because the terminator was already gone.

It is now stopped, the consoles are restored and verified, and only then is it
removed. On a failed verification it is left **stopped but installed**, which is
recoverable: `sc.exe start NocVault-Tls` puts the suite back on HTTPS exactly as
it was. `NocVault-TlsCutover.ps1`'s `Undo-TlsCutover` already had this ordering;
`-Disable` did not.

## Installer / updater secrets + log-path traps (1.64.0)

- ⛔ **`LOG_INTEGRITY_KEY` and `CRON_SECRET` were the only two secrets drawn fresh on EVERY
  installer run and never persisted to `secrets.env`.** For `LOG_INTEGRITY_KEY` that silently
  destroyed LogVault's tamper chain on any re-install (`collector.js` resumes from the last
  `entry_hash` regardless of key), and a LogVault that was only ever UPDATED never got a key
  at all. Both are now in the load-or-generate block. The updater half lives in
  `logvault/installer/Update-LogVault.ps1`, and its resolution order is **NSSM collector env →
  `.env.local` → `secrets.env` → mint**, because `collector.js` loads dotenv with
  `override:false` — a pinned service value is the runtime authority, so the files must not
  contradict it. An existing key is NEVER replaced.
- ⛔ **A per-install seeded admin password breaks `-TestLogin` unless the tester is changed in
  the SAME release.** `Test-NocVault-Suite.ps1` posted the shipped literal as a constant; once
  the installer randomises it, that smoke test fails on every fresh install and looks like a
  broken auth stack. It now reads `NV_ADMIN_PASSWORD` from `secrets.env` and falls back to the
  shipped default — and *reaching the fallback is itself reported*, because it means the
  shipped default is still live. It stays a warning, not a failure: this script cannot tell
  "password deliberately changed" from "install predates per-install passwords".
- ⛔ **`TLS_PUBLIC_HOST` was missing from `Update-NetVault.ps1`'s `$RuntimeSettableEnvKeys`**
  while `TLS_CERT_PATH`/`TLS_KEY_PATH` were present. `Clear-NssmEnvKeys` is only ever handed
  keys from that list, so a value pinned in `AppEnvironmentExtra` could never be removed — and
  a pin beats both env files forever (`loadEnvironment()` merges `<root>\.env`, then
  `.next\standalone\.env.local`, then `process.env`, least significant first). Added in
  1.64.0 along with the four `*_WS_TLS`/`*_WS_FINGERPRINT` keys, which the installer stopped
  pinning but which field boxes still carry. See [[tls-public-host-port-ordering]].
- ⛔ **SpanVault's NSSM stdout/stderr paths diverged between installer and updater in BOTH
  folder and filename.** The installer registers `<AppRoot>\logs\api|app|collector{,-err}.log`;
  the updater re-pointed them at `<InstallDir>\logs\<ServiceName>{,.err}.log` — and on a suite
  install `$InstallDir` is the PARENT of `$AppRoot`, so those are two different folders.
  Measured on a live box: `C:\Apps\SpanVault\app\logs` did not exist at all, so the tester's
  section 10d crash scan reported a crash-looping collector as a benign "clean start". Fixed in
  the updater (the installer and tester already agreed). ⛔ The same `$InstallDir`-vs-`$AppRoot`
  split is why `last-update-status.json` is at `<InstallDir>\logs`, NOT beside the service logs
  — look in both before concluding a status file is missing.
- ⛔ **A dangling-`else` check must target the ORPHANED shape.** A blank line or a comment
  between `}` and `else`/`elseif` is legal PowerShell 5.1 and runs correctly. The shape that
  parses clean and dies at runtime is a block keyword with no preceding construct at all,
  which becomes a `CommandAst`. See [[dev-and-staging-machines]] for the working gate.
- ⛔ **A PowerShell function that returns an EMPTY ARRAY hands the caller `$null`.** Measured
  on PS 5.1.26100: `function f { return @() }; $null -eq (f)` is `True`, and the same is true
  for `return @($list | Select-Object -Unique)` when the list is empty. So the natural shape
  for "here is what I found, or `$null` if I could not look" makes **"found nothing" and
  "could not look" the same value** — which inverts any guard that refuses on "could not
  look". This bit the `-RemoveDependencies` Node/Git guard while it was being written (1.64.1):
  a clean server would have reported an enumeration failure that never happened and the switch
  would have silently stopped removing anything, for ever. Return `@{ Looked = $bool; Items =
  @(...) }` instead. ⛔ Note `ParseFile` and the AST gate CANNOT see this — it is a runtime
  value semantic, not a syntax error.
- ⛔ **An alias outranks a function of the same name**, so a single-letter test helper is not
  safe: `function h { ... }` is shadowed by the built-in `h` (→ `Get-History`), and the call
  returns history, not your value. Cost a wrong conclusion while measuring the above. Also
  `$null.Anything.Count` is `0`, not an error, so a null result can look like a real empty one.
- ⛔ **`CRON_SECRET`'s authority is the NSSM service environment, NOT `<AppDir>\.env`.** The
  suite installer pins it in `AppEnvironmentExtra`, and it is deliberately **absent** from
  `$RuntimeSettableEnvKeys`, so `Clear-NssmEnvKeys` never removes it and the pin wins forever
  (`lib/cronAuth.ts` reads `process.env.CRON_SECRET`). Until 1.64.1 both WRITERS read the file
  alone: `Update-NetVault.ps1` would mint a brand-new secret when the file lacked the key even
  though the service env already had one, and `Enable-NocVaultTls.ps1 -Disable` re-registered
  all three tasks from the file. Either way the tasks carry a token the route rejects — and a
  401 is indistinguishable from success in Task Scheduler (`curl -s` discards the body, so the
  task records `0x0 completed successfully`). The only symptom is a health trend that stops
  gaining points. `Resolve-CronSecret` in the updater is now the one shape, matching
  `Test-NocVault-Suite.ps1` section 7's `$cronLive`, which already did it correctly — **the
  tester was right and the writers were wrong**, which is why the assertion existed and the
  bug survived anyway.
- ⛔ **`-RemoveDependencies` must not assume "we installed it, so we remove it".** The
  installer's Node and Git steps both DETECT a pre-existing copy and skip installing, so that
  assumption is false exactly where it does damage. `C:\ProgramData\NocVault\install-state.env`
  (`NODE_OWNED_BY_NOCVAULT` / `GIT_OWNED_BY_NOCVAULT`, written at the moment the installer
  decides) records it instead; an **in-place upgrade of a too-old Node is NOT ownership** and
  records `0`. It is a separate file from `secrets.env` on purpose — `-RemoveSecrets` deletes
  that one and this record has to outlive it. Boxes installed before 1.64.1 have no record, so
  the uninstaller also scans services, scheduled tasks and running processes for foreign
  references; the process scan matches on **CommandLine, not image path**, because the suite's
  own consoles run the shared `C:\Program Files\nodejs\node.exe` and an image-path test would
  call our own leftovers foreign and block every run.
- ⛔ **The suite installer uses `npm ci`; the per-app updaters deliberately keep `npm install`.**
  A fresh install must reproduce the locked tree the release was tested against (and fail loudly
  if lock and `package.json` disagree) — all four repos track `package-lock.json`, root and
  `frontend/`. `npm ci` deletes `node_modules` first, which is exactly why the updaters must NOT
  adopt it: they rely on an incremental install plus a preserved `.next/cache` (see CLAUDE.md's
  performance notes). Don't "unify" these two.

## ⛔ "Unavailable" on the launcher is a verdict about the HUB, not about the app

Measured 2026-11-09, from a report that the hub "cannot check health for logvault and
spanvault". **Both apps were healthy throughout.** Two independent defects combined:

**1. The probe could not tell slow from dead.** `app/api/suite/{health,stats}` each gave a
sibling ONE `fetch` with a 3000 ms `AbortController` and a `catch` that returned a single
value for every outcome. A refused connection, a TLS failure and a slow-but-correct answer
were indistinguishable, and `app/(auth)/launcher/page.tsx` maps any `Unavailable` to an
overall **Critical**. Now in `lib/suiteProbe.ts`: longer budget, one retry, and a timeout
reports `Warning` while only a genuine connection failure reports `Unavailable`.

**2. `now() - INTERVAL` on a partitioned table costs ~2 s of PLANNING per call.** `now()`
is STABLE, not constant, so the planner cannot prune at plan time: it opens every partition
and lets the executor discard them. On `logvault.syslog_entries` (~99 daily partitions):
`received_at > now() - INTERVAL '24 hours'` planned in **1611-1963 ms** and executed in
0.3 ms; the same instant as a parameter planned in **2.4 ms**. Warm was no faster than cold
— it is planner CPU, not I/O, so it never caches away. `app/api/hub/alerts/route.ts` ran
that shape against logvault on every launcher load, concurrently with the probes above.

**⛔ How it was proven, because this is the transferable part.** SpanVault logs every
request to `logs/api.log`. At the exact timestamp of the user's screenshot it shows
`GET /api/stats` and `GET /api/health` arriving — and its `/api/health` is `SELECT 1`, 7-8 ms.
The app answered; the hub threw the answer away. **A request log on the callee is the
cheapest way to split "the app is down" from "the caller gave up", and it inverted the
whole diagnosis in one line.** The second tell was in the screenshot itself: LogVault's
tiles read `0 / 0 / 0` while SpanVault's read `—`, and `num(null)` renders `—` — so
LogVault's stats probe had SUCCEEDED and only its health probe had failed. Zeros are data.

Do not re-chase: probe URLs were correct (`127.0.0.1:1300X` in both hub env files, absent
from NSSM), all 11 services Running, nothing restarted since the previous deploy. It was
not deploy fallout, and the satellite updaters ARE TLS-aware.

## ⛔ Port conflicts were invisible to the installer until 1.64.4

Measured on staging 2026-11-09: another product held UDP+TCP 1514, so LogVault's
collector bound 2 of its 4 syslog listeners — and the installer still printed a full
success banner that never mentioned 1514. Only `/api/health` and the suite tester showed
it. On a customer box running any other syslog receiver, every device pointed at that port
is discarded by the OS from the moment of install.

`Install-NocVault-Suite.ps1` now checks before installing: a console/API port held by
something else is FATAL (the service would be created and then fail to bind), a syslog
port is a warning that is **repeated in the closing banner** — a warning printed 1,700
lines earlier in a multi-minute install has not been communicated.

**⛔ "Is this port ours?" cannot be answered by reading the command line.** The first
version matched `$InstallDir` / app names against `Win32_Process.CommandLine`, and two of
our own services failed it: NSSM sets an AppDirectory, so SpanVault-API's command line is
the relative `"...node.exe" api\server.js` with neither the path nor the app name in it.
Since a console-port conflict is fatal, that would have **refused every re-install**.
Second attempt — `Win32_Service.ProcessId` — also failed: NSSM is the service process and
the listener is its CHILD. The working answer is to walk the PID's parent chain up to a
known service PID. Verified on a live install: 0 false positives across all 13 suite
ports, while the genuine foreign holder of 1514 was still caught.

## ⛔ nodemailer is PINNED TO 7.x BY next-auth — and a local install will not tell you (1.65.1)

`next-auth@4.24.x` declares `peerOptional nodemailer@"^7.0.7"` (true of 4.24.12 through
4.24.15; 4.24.11 wanted `^6.6.5`, and even next-auth 5 beta allows only `^7 || ^8`). NetVault
is a SINGLE package.json holding both, so **nodemailer 8 or 9 here is an unresolvable peer
conflict**. 1.65.0 shipped `nodemailer@^9.1.1`, and the production updater died at
`npm install` with `ERESOLVE ... Conflicting peer dependency: nodemailer@7.0.13`, then
auto-rolled back.

⛔ **IT BUILT AND TESTED CLEAN LOCALLY FIRST.** The dev box runs **node 24 / npm 11**; the
server runs **node 22 / npm 10**, and npm 11 is more permissive — it warns and overrides a peer
conflict that npm 10 refuses outright. A green local `npm install`, `npm test` and
`npm run build` therefore prove NOTHING about whether the deploy will resolve.

**Before adding or bumping ANY dependency here:**
1. Check the declared peer ranges of what is already installed - `npm view <pkg> peerDependencies`
   on the packages that might care. A version inside every declared range needs no resolver
   luck and is immune to the npm-major difference above.
2. Do not reach for `--force` or `--legacy-peer-deps` to get past it. The installer runs a
   plain install on a customer's machine; a flag the dev box needed is a flag that machine
   will not have.

**The satellites are NOT subject to this.** `next-auth` lives in their `frontend/`
package.json, while nodemailer lives in the ROOT one - so logvault/ddivault (8.0.10) and
spanvault (6.9.13) have no such constraint and can move to 9 independently. "One nodemailer
version across the suite" is therefore NOT achievable while NetVault is on next-auth 4.x.

**The GHSA this leaves open is not reachable here.** `GHSA-p6gq-j5cr-w38f` is the message-level
`raw` option bypassing `disableFileAccess`/`disableUrlAccess`. `lib/mailer.ts` never uses `raw`
and says so in a comment - the same reasoning all three satellites' CLAUDE.md already record for
their own deferred upgrades.

## ⛔ Settings → About showed `v1.0.0` on every install (fixed 1.65.2)

`{ label: 'Version', value: \`v${updateStatus?.current_version || '1.0.0'}\` }` — but `updateStatus`
is populated ONLY by the Updates tab's own effect (`if (activeTab === 'updates' && !updateStatus …)`).
On the About tab it is always `null`, so the panel whose entire job is telling an operator what they
are running printed the fallback literal as though it were the answer. A production server on 1.65.1
reported itself as **v1.0.0**. Reported from a screenshot 2026-11-13; wrong since the tab was
standardised in `2a75cd8`.

Same class as LogVault's version-display bug (its `page.tsx` imported `frontend/package.json`, a file
nothing in the release process bumps) — which was mistaken for a caching bug and chased for DAYS
across two releases before anyone checked where the number came from.

**The rules this leaves:**
- A version, build or environment string must come from the thing it describes — `/api/health` reads
  the real `package.json` server-side — never from a literal and never from state another tab owns.
- ⛔ **Never default a factual field to a plausible-looking literal.** `|| '1.0.0'` is indistinguishable
  from a real answer; `|| '—'` is not. A fallback that can be mistaken for data is worse than a gap.
- The same panel hardcoded `Node.js 20`, which the installer actively REFUSES to run on
  (`$NodeRequired = 22.18.0`). It now reports `process.version` via `/api/server-stats` — the
  admin-gated route, deliberately NOT `/api/health`, because an exact Node build number on a public
  endpoint is a free CVE-matching gift.

## ⛔ nodemailer here is 10.x via an `overrides` entry, NOT by next-auth's leave (1.65.3)

`next-auth@4.24.x` declares `peerOptional nodemailer@"^7.0.7"` and NetVault is a single
package.json holding both, so a plain bump to 8/9/10 is an unresolvable peer conflict — that is
what killed the 1.65.0 deploy at `npm install` with ERESOLVE. 1.65.1 settled on `^7.0.13`, inside
next-auth's range.

**That turned out not to be good enough.** `npm audit` flags every nodemailer `<=10.1.3`, with
`fixAvailable: 10.5.0`. On 7.x the hub carried SMTP command injection via `envelope.size`, CRLF
injection in the transport name (EHLO/HELO), CRLF in `List-*` headers, the jsonTransport
file/URL-access bypass AND the `raw` advisory the bump was meant to close. Stopping at 9.x would
have left a dozen of them.

So `package.json` now carries:

```json
"dependencies": { "nodemailer": "^10.5.0" },
"overrides":    { "nodemailer": "$nodemailer" }
```

- `$nodemailer` means "whatever this package's own dependency range says", so the override cannot
  drift away from the dependency.
- ⛔ **An override, NOT `--legacy-peer-deps`.** It lives in package.json, travels with the repo and
  is honoured by the plain `npm install`/`npm ci` that runs on a customer's server. A CLI flag is
  not: the installer will not pass it, which is precisely how a locally-green bump becomes a failed
  deploy.
- It is semantically safe because **NetVault does not use next-auth's Email provider at all** —
  verified, no `EmailProvider` import anywhere — so the peer it declares is for a code path that
  never executes here. Re-check that before assuming the override stays safe.
- Verified before shipping: clean-tree `npx npm@10 ci --dry-run` → **0 ERESOLVE, 0 peer warnings**,
  `npm ls nodemailer` shows next-auth deduped onto 10.5.0, `npm audit` reports nodemailer CLEAR,
  and 542 tests pass (nodemailer 10 is a dual ESM/CJS TypeScript build — confirmed it still
  imports under Node's type stripping in `node --test`).
- 10.0.0's only breaking change is **Node.js >= 20**. The installer floor is already 22.18.0.

## ⛔ The licence gate goes on PRODUCT VALUE, never on administration (1.65.5)

⛔ **CORRECTED 2026-11-14 — THERE IS NO 30-DAY GRACE, AND A PAID LICENCE GETS NONE AT ALL.**
`lib/license.ts` sets `TRIAL_DAYS = 30` and `GRACE_DAYS = **7**`, and grace is computed from
INSTALL AGE, not from licence expiry. A purchased licence that lapses is rejected by
`validateLicenseKey`, control falls through to the trial arithmetic, and any install older than
~37 days is `expired` IMMEDIATELY — measured: a licence that lapsed yesterday on a 900-day-old
install returns `{ status: 'expired', daysRemaining: -870 }`. So a real customer gets **zero**
warning window. The satellites make it worse: all three test `daysRemaining > -30` for grace, so
-870 sends every one of them straight to `disabled` (blanket 402 outside `/api/health`). Their
documented 30-day grace is dead code for any paid licence — it only ever fires for a trial
install between days 31 and 60. An earlier version of this entry said "past the 30-day grace",
which was wrong in both the number and the mechanism.

`checkWriteAllowed()` 403s once a licence is `expired`. It belongs on routes that produce the
thing the licence sells and nowhere else.

**`app/api/users` was gated and should never have been.** Three reasons, in increasing order of
seriousness:

1. **It enforced no licence term.** `LicensePayload` is `{ customer, serverId, expiry, modules,
   maxDevices, issuedAt }` — there is no seat or user limit anywhere in this codebase. The block
   restricted something the licence never sold.
2. **NetVault is the hub.** `users` is suite-wide identity — LogVault, DDIVault and SpanVault all
   authenticate against this table. A NetVault licence lapsing took user management away from the
   whole suite, which the expiry banner ("NetVault dropping into read-only") never said.
3. ⛔ **It blocked the two recovery paths that must never be blocked** — adding an administrator to
   repair the installation, and DELETING A COMPROMISED ACCOUNT. A lapsed licence must never be the
   reason someone keeps access they should have lost: that turns a commercial dispute into a
   security incident.

**The policy is now a test, asserted in BOTH directions** (`tests/systemSeams.test.ts`). A test
that only checked "product routes are gated" would have passed happily while `users` was gated
too; one that only checked "users is ungated" would not notice someone ungating `devices`. A
second test walks `app/api/**` and fails on any NEW caller that has not been deliberately
classified, so the gate cannot be inherited by accident.

⛔ **Do not build these lists from `grep -l checkWriteAllowed`.** Writing them that way put two
wrong entries in on the first attempt: `sites/route.ts` is GET-only (nothing to gate) and
`agents/enroll` matched a COMMENT explaining its own deliberate exemption — token-gated
infrastructure provisioning is not licensed data entry. The test strips comments before matching
for exactly this reason.


## ⛔ THE LICENCE GATE HAS TWO SIDES AND 1.65.5 FIXED ONLY ONE (corrected 1.65.7)

1.65.5 removed `checkWriteAllowed()` from the user-management API so a lapsed licence could not
block adding an administrator or **deleting a compromised account**, and shipped a release note
saying exactly that. The note was **false as shipped.**

`app/(app)/layout.tsx` sets `body[data-readonly="true"]` when the licence is expired, and
`app/globals.css` puts `opacity:.4; pointer-events:none` on every `.btn-primary`,
`button[type="submit"]`, `.btn-danger` and `.btn-destructive` that is not exempt. Exactly ONE
button in the repo carried the exemption: "Activate License". So the Delete button the release
note promised was unblocked stayed literally unclickable, as did every Save in Settings —
including the Mail server panel the same day's work added.

⛔ **The CSS block records the IDENTICAL bug from the previous occurrence**, when the Activate
License button itself was frozen: *"The API side was always correct … so only the UI was locked."*
Second time, same gate, opposite half. If you change licence enforcement, change BOTH sides in the
same commit and say which you changed.

Fixed by a second exemption, `.readonly-allowed`, with an honest meaning — `.license-action`
restores the LICENCE, `.readonly-allowed` administers or REPAIRS the INSTALLATION, product-data
entry carries neither. `tests/systemSeams.test.ts` now asserts all three in both directions,
including that site controls stay frozen.

⛔ The CSS rule is **cosmetic; the API is the boundary.** Every product-data write still calls
`checkWriteAllowed()`. An exemption here can at worst turn a dead button into an honest error — do
not reason about it as a permission.

---

## ⛔ A hand-maintained guard list cannot find the route that never imported the guard

`tests/systemSeams.test.ts` had two assertions about `checkWriteAllowed()`: a GATED/UNGATED list,
and a walk that catches a route gating without being classified. Both are blind to the same thing
— a route that writes product data and simply **never mentions the gate**. That is how three
shipped ungated: `admin/eol-recommendations/bulk`, `.../[id]/resolve` and
`admin/eol-discrepancies/[id]/resolve`. The first two were found by a sweep; the third was found
by the test added to close the class, on its first run, *after* the sweep had finished.

The test now works the other way round: it matches the **SQL shape**
(`UPDATE|INSERT INTO|DELETE FROM devices|sites|circuits`) across every `app/api/**/route.{ts,tsx,js}`
and requires each hit to gate or be in an `EXEMPT` set with a written reason. A SQL statement in a
route file cannot be refactored out of sight the way an import can. Mutation-verified: removing the
gate from `devices/bulk` fails it.

⛔ Two narrower traps it also fixed. The walk keyed on the literal filename `'route.ts'`, so
`route.tsx` and `route.js` — both valid Next.js handlers — were invisible to it. And `lib/`
writes are **not** seen by a route-level walk at all: the one real case,
`lib/eolEnrich.ts`, is deliberately ungated (it runs from a scheduled task, has no caller to
hand a 403 to, and only copies vendor dates onto existing inventory) and that reasoning is
written at the top of that file. If background enrichment ever must be gated, gate
`/api/system/enrich-eol`, not the lib — a lib that silently no-ops is the worse failure.

## ⛔ A super_admin-only setting has more than one read path — the audit log is one

`PUT /api/suite/smtp` is super_admin, and correctly records the mail password as a presence
sentinel rather than a value. But it records `host`, `username` and `from_email` **verbatim**, by
design — "somebody repointed the suite at a different relay" is the event an auditor needs. And
`GET /api/audit` gates at **admin**. So an admin who could not open the Mail server panel could
read the whole configuration out of the audit log one field at a time, and watch every future
change to it. `/api/audit` now replaces `old_value`/`new_value` on `smtp:*` rows with
`(hidden — super admin only)` for a non-super_admin; the event stays visible, because hiding "the
mail server was changed" from an administrator is its own kind of dishonesty.

Checked for the class, not the instance: the other three `audit_log` readers are safe, and for a
reason worth knowing — `recordSystemChanges` writes `device_id = NULL`, and
`audit/device/[id]` filters `WHERE a.device_id = $1`, so system rows can never match it. The
launcher's recent-activity feed selects `field_name` only, no values.

## ⛔ `||` erases the difference between "not supplied" and "deliberately blank"

`PUT /api/suite/smtp` merges: `str()` returns `null` for "the body did not say" and `''` for "the
admin cleared the field". `const fromName = str(body.from_name) ?? (existing?.from_name || 'NocVault')`
got the first half right and threw it away in the second: clearing the From name saved `''`
correctly, and then the **next** save of any other field read that `''` as falsy and put
`'NocVault'` back. The only way to keep a blank From name was to never touch the form again. A
default belongs on the row that does not exist yet, not as a floor under one that does — so the
stored value needs `??` too.

## ⛔ A rate-limit bucket keyed on anything the caller controls is not a rate limit

`lib/rateLimit.ts`'s `getClientIp()` reads `x-forwarded-for` first, and NetVault is reachable
directly. So `checkRateLimit(\`suite-smtp-test:${ip}\`, ...)` handed out a fresh bucket per
request for the cost of one header. Keyed on the session user id now — it comes out of the signed
cookie the gate already verified, and it is the honest unit anyway (the throttle exists to stop
one super admin becoming a mail cannon, not to stop a host).

⛔ And the IP is **not** in the key as a second term either. Anything caller-controlled in the key
is an escape from the bucket, because varying it varies the key; "the actor id is still in there"
buys nothing.

⛔ **The two remaining `getClientIp` buckets are UNAUTHENTICATED and therefore still bypassable**
— `app/api/auth/mfa/precheck` and `app/api/agents/enroll`. They have no actor to key on. The
precheck one accepts a password guess, and `authorize()` in `app/api/auth/[...nextauth]/route.ts`
has **no rate limit and no per-account password lockout at all**, so NetVault currently has no
effective password brute-force protection. (The MFA *code* path is fine — `lib/mfaGate.ts` keeps a
per-user `mfa_locked_until` in the database, which cannot be spoofed.) Not fixed here because the
fix is a real design decision, not a key change: either gate forwarded-header trust behind the
`TRUST_PROXY_HEADERS` allowlist already KIV'd in CLAUDE.md, or add a per-account lockout — and a
naive fallback to one shared bucket turns the limiter into a lockout lever anybody can pull.
