# NetVault API Routes

## admin
GET /api/admin/eol-coverage [auth] [db] — EOL inventory/seed coverage aggregates (super_admin)
POST /api/admin/eol-discrepancies/[id]/resolve [auth] [db] — resolve manual-vs-seed EOL date conflict
GET /api/admin/eol-discrepancies [auth] [db] — list pending EOL date discrepancies (super_admin)
POST /api/admin/eol-recommendations/[id]/resolve [auth] [db] — accept/ignore one status recommendation
POST /api/admin/eol-recommendations/bulk [auth] [db] — bulk accept/ignore status recommendations
GET /api/admin/eol-recommendations [auth] [db] — list pending EOL status recommendations (super_admin)
PUT /api/admin/eol-seed/[id] [auth] [db] — edit a seed catalog entry
DELETE /api/admin/eol-seed/[id] [auth] [db] — delete a seed catalog entry
GET /api/admin/eol-seed/preview [auth] [db] — preview device match count for vendor/model
POST /api/admin/eol-seed/purge-dateless [auth] [db] — purge dateless placeholder seed rows
GET /api/admin/eol-seed [auth] [db] — list/search/group EOL seed catalog (super_admin)
POST /api/admin/eol-seed [auth] [db] — add a seed catalog entry
POST /api/admin/eol-seed/sync [auth] [db,external] — pull central signed EOL feed into eol_seed

## agents (NocVault Agents Phase 2 — hub control plane)
GET /api/agents/install.ps1 [public] [none] — PowerShell agent installer, hub origin baked in (resolveOrigin); public (remote runs `irm` pre-credential). Takes -Modules "span,ddi" and writes it into the agent's config.json `modules` — the agent loads modules from that file ONLY, so the hub's enrollment preset alone never reaches it (1.29.6)
GET /api/agents/bundle [public] [none] — agent bundle manifest {files:[]} walked from on-disk agent/ dir (excludes deps/state/keys/tests); 503 if unavailable; public
GET /api/agents/bundle/[...path] [public] [none] — serve ONE agent file's bytes; path-traversal confined to agent/ (403 escape, 404 missing/excluded); public
GET /api/agents/update-manifest [public] [none] — serve the committed, offline-signed self-update manifest {version,files:[{path,sha256}],sig} from agent/update-manifest.json; 503 if missing/unparseable (fresh install advertises no update); public (Phase 3 Workstream B)
DELETE /api/agents/[id] [auth] [db] — permanently delete a REVOKED agent (super_admin); 409 while not revoked (a live agent would re-provision itself); cascades agent_modules/health/commands and fans a 'forget' out to the satellites' loopback /api/internal/agents/forget so no orphan row is left
POST /api/agents/enroll-tokens [auth] [db] — mint one-time enrollment token + install one-liner (super_admin); the one-liner carries -Modules from the preset so the choice reaches the agent's config.json
POST /api/agents/enroll [public] [db] — token-authed (NO session): agent redeems token+host facts → agent_id, signed identity, module policy. Intentionally public write; NO checkWriteAllowed (token-gated infra); rate-limited 10 attempts/10min per source IP (lib/rateLimit.ts, in-memory fixed-window, fail-open) → 429 + Retry-After beyond that
POST /api/agents/[id]/heartbeat [agent-auth] [db] — agent-authed (requireAgentAuth, JWT sub must == [id]): liveness + health sample + 7d health prune; then RETURNS {ok:true, commands:[{id,type,args}]} — atomically claims this agent's status='pending' agent_commands (UPDATE…RETURNING → 'delivered'), carrying them back in the poll response exactly once (Phase 4a command channel)
POST /api/agents/[id]/commands [auth] [db] — enqueue a poll-carried command for the agent (super_admin); body {type} ∈ {restart,get_logs} (else 400), 404 if agent absent; INSERTs a pending agent_commands row → {id,type,status:'pending'}. Hub analog of SpanVault's sendToAgentId (no server→agent socket — delivered via the heartbeat response)
POST /api/agents/[id]/logs [agent-auth] [db] — agent-authed (requireAgentAuth, sub must == [id]): get_logs return path — body {lines:string[], command_id?}; stores agents.last_logs + last_logs_at, and if command_id given marks that agent_commands row status='done'. → {ok:true}
GET /api/agents/[id]/logs [auth] [db] — read the last log tail the agent returned (super_admin) → {lines, ts} (both null until the agent first answers a get_logs)
POST /api/agents/[id]/refresh [agent-auth] [db] — agent-authed (sub must == [id]): re-issue identity from CURRENT enabled modules, bump last_seen_at, return {jwt,expires_at}; revoked agent → 401 (stop). Default TTL 7d
GET /api/agents/[id]/policy [agent-auth] [db] — agent-authed (sub must == [id]): module assignment + config + data-plane ingest URLs
GET /api/agents [auth] [db] — fleet list, agents+site+modules+latest buffer_depth, derived status (super_admin)
GET /api/agents/[id] [auth] [db] — agent detail + last ~20 health rows (super_admin)
PATCH /api/agents/[id] [auth] [db] — update name/site_id + upsert/toggle modules (super_admin)
POST /api/agents/[id]/revoke [auth] [db] — set revoked_at, status='revoked' (super_admin); then best-effort fans out an active-kick to each covered app's data plane (Phase 3: SpanVault only, POST 127.0.0.1:3009/api/internal/agents/disconnect, non-fatal) so a LIVE session drops now, not just on next connect

## audit
GET /api/audit/device/[id] [auth] [db] — device audit log, site-scoped
GET /api/audit [auth] [db] — recent-activity feed (?limit=) or full paginated audit log (admin)

## auth
GET /api/auth/[...nextauth] [public] [db] — NextAuth credentials login/session handler
POST /api/auth/[...nextauth] [public] [db] — NextAuth credentials login/session handler
POST /api/auth/sso-verify [public] [db] — verify a sibling-app SSO JWT, confirm user exists

## circuits
GET /api/circuits/[id] [auth] [db] — get circuit by id, site-scoped
PUT /api/circuits/[id] [auth] [db] — update circuit (admin+)
DELETE /api/circuits/[id] [auth] [db] — delete circuit (admin+)
GET /api/circuits [auth] [db] — list/filter circuits, site-scoped
GET /api/circuits/export?format=csv|xlsx [auth] [db] — circuit export (CSV default, xlsx via SheetJS), same filters AND same site scoping as the list route (keep the two in lockstep)
POST /api/circuits [auth] [db] — create circuit

## compliance
GET /api/compliance [auth] [db] — compute fleet compliance score

## countries
GET /api/countries [auth] [db] — list countries with region

## dashboard
GET /api/dashboard/devices-by-region [auth] [db] — device totals bucketed by region
GET /api/dashboard/devices-by-type [auth] [db] — top device types by count
GET /api/dashboard/fleet-health [auth] [db] — fleet health donut segments
GET /api/dashboard/overview [auth] [db] — health score overview + 30-day trend
GET /api/dashboard/recent-activity [auth] [db] — recent audit activity, formatted feed
GET /api/dashboard [auth] [db] — full dashboard summary bundle (all widgets)
GET /api/dashboard/stats-row [auth] [db] — top KPI stat row counts
GET /api/dashboard/top-eol-sites [auth] [db] — top 5 sites by EOL device count

## devices
GET /api/devices/[id] [auth] [db] — get device detail, site-scoped
PUT /api/devices/[id] [auth] [db] — update device + write audit_log
DELETE /api/devices/[id] [auth] [db] — delete device, cascades EOL rows + audit_log
PUT /api/devices/bulk [auth] [db] — bulk-update one field across devices + audit_log
GET /api/devices/duplicates [auth] [db] — find duplicate-IP/serial devices with classification
GET /api/devices [auth] [db] — list/filter/paginate devices, site-scoped
POST /api/devices [auth] [db] — create device

## export
GET /api/export [auth] [db] — CSV export of device inventory (PowerBI columns)

## health
GET /api/health [public] [none] — liveness + version check

## hub
GET /api/hub/alerts [auth] [db] — cross-app correlated alerts (EOL/monitoring/security/IPAM)
GET /api/hub/asset360 [auth] [db] — one device's full story across all 4 suite apps
GET /api/hub/kpis [auth] [db] — suite-wide KPI rollup (fleet/availability/logs/IPAM/alerts)
GET /api/hub/search [auth] [db] — unified suite search by IP/hostname/name across 4 apps

## import
POST /api/import/preview [auth] [none] — preview parsed device import file (first 5 rows)
POST /api/import [auth] [db] — bulk import/upsert devices from CSV/XLSX

## license
GET /api/license [public] [db] — license/trial status, server ID, entitled modules
POST /api/license [auth] [db] — activate a license key (super_admin)

## lookup
GET /api/lookup [auth] [db] — filter option lists (regions/sites/types/brands/vendors)

## netvault-stats
GET /api/netvault-stats [public] [db] — public device/site/EOL counts widget

## search
GET /api/search [auth] [db] — global search across devices/sites/circuits

## server-stats
GET /api/server-stats [auth] [none] — live OS server metrics (disk/CPU/mem/uptime)
  ROLE-GATED 1.40.0: admin/super_admin only (403 otherwise). Host infra detail is operator-only; the launcher panel that consumes it is admin-only and collapsed, and a UI gate alone would leave the data one fetch away.

## settings
POST /api/settings/logo [auth] [db] — upload branding logo (super_admin)
GET /api/settings [public] [db] — get app settings, redacts secrets for non-admin
PUT /api/settings [auth] [db] — update app settings (admin; branding is super_admin-only)

## sites
GET /api/sites/[id] [auth] [db] — site detail + its devices, site-scoped
PUT /api/sites/[id] [auth] [db] — update site (admin+)
POST /api/sites/import/preview [auth] [db] — preview sites-import plan (create/fill/skip)
POST /api/sites/import [auth] [db] — transactional sites import (create + fill-empty-only)
GET /api/sites/import/template [auth] [none] — download XLSX sites-import template
POST /api/sites/manage [auth] [db] — create site (admin+)
PATCH /api/sites/manage [auth] [db] — update site status, blocks decommission w/ active devices
DELETE /api/sites/manage [auth] [db] — delete site (super_admin), blocked if devices/circuits exist
GET /api/sites [auth] [db] — list sites with device/EOL/circuit counts

## sso
GET /api/sso/ddivault [auth] [db] — mint SSO JWT, redirect to DDIVault
GET /api/sso/logvault [auth] [db] — mint SSO JWT, redirect to LogVault
GET /api/sso/spanvault [auth] [db] — mint SSO JWT, redirect to SpanVault

## suite
GET /api/suite/health [public] [external] — aggregate sibling apps' /api/health (cached 20s)
GET /api/suite/stats [public] [external] — aggregate sibling apps' /api/stats (cached 20s)

## system
GET /api/system/enrich-eol/latest [auth] [db] — most recent completed EOL enrichment job summary
POST /api/system/enrich-eol [auth] [db] — start EOL enrichment background job (cron or super_admin)
GET /api/system/enrich-eol/status [auth] [db] — poll an EOL enrichment job's live progress
POST /api/system/health-snapshot [auth] [db] — cron: snapshot + persist fleet health score
POST /api/system/sync-eol [auth] [db,external] — cron: weekly pull of central EOL feed
GET /api/system/update-status [auth] [external] — check origin/main for a newer git commit (any session; gated 2026-07-24, was public)
GET /api/system/last-update-status [auth] — reads logs\last-update-status.json written by Update-NetVault.ps1 (stage/error code/rollback outcome/schemaAppliedButRolledBack of the last update run); {exists:false} if none yet (admin+; gated 2026-07-24, was public)
POST /api/system/update [auth] [db] — schedule self-update task (admin+); 409 if Update-NetVault.ps1's update.lock shows another run still in progress

## users
PUT /api/users/[id] [auth] [db] — update user: role/sites/app-access (admin+)
DELETE /api/users/[id] [auth] [db] — delete user (super_admin)
PUT /api/users/me [auth] [db] — change own password
GET /api/users [auth] [db] — list users with sites + app access (admin+)
POST /api/users [auth] [db] — create user (admin+)

## Needs force-dynamic
GET /api/admin/eol-coverage — missing force-dynamic
POST /api/admin/eol-discrepancies/[id]/resolve — missing force-dynamic
GET /api/admin/eol-discrepancies — missing force-dynamic
POST /api/admin/eol-recommendations/[id]/resolve — missing force-dynamic
POST /api/admin/eol-recommendations/bulk — missing force-dynamic
GET /api/admin/eol-recommendations — missing force-dynamic
PUT /api/admin/eol-seed/[id] — missing force-dynamic
DELETE /api/admin/eol-seed/[id] — missing force-dynamic
GET /api/admin/eol-seed/preview — missing force-dynamic
POST /api/admin/eol-seed/purge-dateless — missing force-dynamic
GET /api/admin/eol-seed — missing force-dynamic
POST /api/admin/eol-seed — missing force-dynamic
GET /api/audit/device/[id] — missing force-dynamic
GET /api/audit — missing force-dynamic
GET /api/auth/[...nextauth] — missing force-dynamic
POST /api/auth/[...nextauth] — missing force-dynamic
POST /api/auth/sso-verify — missing force-dynamic
GET /api/circuits/[id] — missing force-dynamic
PUT /api/circuits/[id] — missing force-dynamic
DELETE /api/circuits/[id] — missing force-dynamic
GET /api/circuits — missing force-dynamic
POST /api/circuits — missing force-dynamic
GET /api/compliance — missing force-dynamic
GET /api/countries — missing force-dynamic
GET /api/dashboard/devices-by-region — missing force-dynamic
GET /api/dashboard/devices-by-type — missing force-dynamic
GET /api/dashboard/fleet-health — missing force-dynamic
GET /api/dashboard/overview — missing force-dynamic
GET /api/dashboard/recent-activity — missing force-dynamic
GET /api/dashboard — missing force-dynamic
GET /api/dashboard/stats-row — missing force-dynamic
GET /api/dashboard/top-eol-sites — missing force-dynamic
GET /api/devices/[id] — missing force-dynamic
PUT /api/devices/[id] — missing force-dynamic
DELETE /api/devices/[id] — missing force-dynamic
PUT /api/devices/bulk — missing force-dynamic
GET /api/devices/duplicates — missing force-dynamic
GET /api/devices — missing force-dynamic
POST /api/devices — missing force-dynamic
GET /api/export — missing force-dynamic
POST /api/import — missing force-dynamic
GET /api/license — missing force-dynamic
POST /api/license — missing force-dynamic
GET /api/lookup — missing force-dynamic
GET /api/netvault-stats — missing force-dynamic
GET /api/search — missing force-dynamic
POST /api/settings/logo — missing force-dynamic
GET /api/settings — missing force-dynamic
PUT /api/settings — missing force-dynamic
GET /api/sites/[id] — missing force-dynamic
PUT /api/sites/[id] — missing force-dynamic
POST /api/sites/import/preview — missing force-dynamic
POST /api/sites/import — missing force-dynamic
POST /api/sites/manage — missing force-dynamic
PATCH /api/sites/manage — missing force-dynamic
DELETE /api/sites/manage — missing force-dynamic
GET /api/sites — missing force-dynamic
GET /api/sso/ddivault — missing force-dynamic
GET /api/sso/logvault — missing force-dynamic
GET /api/sso/spanvault — missing force-dynamic
GET /api/system/enrich-eol/latest — missing force-dynamic
POST /api/system/enrich-eol — missing force-dynamic
GET /api/system/enrich-eol/status — missing force-dynamic
POST /api/system/health-snapshot — missing force-dynamic
POST /api/system/sync-eol — missing force-dynamic
POST /api/system/update — missing force-dynamic
PUT /api/users/[id] — missing force-dynamic
DELETE /api/users/[id] — missing force-dynamic
PUT /api/users/me — missing force-dynamic
GET /api/users — missing force-dynamic
POST /api/users — missing force-dynamic

## MFA (TOTP second factor, 1.33.0)
- `POST /api/auth/mfa/precheck` [public] [db] — login step 1. `{email,password}` → `{ok, mfaRequired?, enrolmentRequired?}`. Verifies the password before answering (so it cannot enumerate who has MFA) and rate-limited 20/5min per IP. GRANTS NOTHING — no session, token or cookie; authorize() re-checks password AND code independently, so skipping or faking this call gains nothing. It only decides whether the form shows a code field.
- `GET /api/mfa` [auth] [db] — current user's MFA state (enabled, enrolled_at, backup codes remaining, whether their role requires it).
- `POST /api/mfa` [auth] [db] — `{action:'setup'}` mints a secret + QR data URI but does NOT enable (a mis-scanned QR must not lock the user out); `{action:'enable',token}` verifies a code then enables and returns backup codes ONCE; `{action:'disable',password}` re-confirms the password (a hijacked session must not be able to silently remove the factor) and is refused when policy requires MFA for that role. Always acts on the SESSION's user id — never one from the body.
- `POST /api/admin/users/[id]/mfa-reset` [super_admin] [db] — clears a user's factor so they can re-enrol (lost phone + spent backup codes). This is an auth-bypass capability by design, so it is super_admin-only and written to `audit_log`.

## Entra ID SSO + HTTPS settings (1.55.0)

All three are configuration surfaces for things that must NOT be baked in at install: this
product ships to customers whose hostname, certificate and directory tenant are not ours.
They write to env files through `lib/envTargets.ts`'s `writeManagedKey`, which is an
ALLOW-LIST (`NEXTAUTH_SECRET` and `DATABASE_URL` are unreachable from any request).

⛔ **ALL THREE REPORT `shadowVerdict`'s THREE STATES AND MUST NOT COLLAPSE THEM.** `shadowed`
means the NSSM service environment pins that key, so the write is durable but inert until an
upgrade clears it; `unknown` means we could not read the service environment (off Windows, or
no permission) and is NOT `clear`. A route that rendered `unknown` as `clear` would promise an
operator a change that silently never takes effect.

⛔ **ALL THREE REQUIRE A RESTART, AND SAY SO IN THE RESPONSE BODY, not only in the UI.** NextAuth
builds its provider array once at module load and node reads the certificate once at startup, so
a saved value and a running value are genuinely different things until the service restarts.

- `GET /api/system/console-url` [admin|super_admin] [env] — saved vs running `NEXTAUTH_URL`, per-file state, shadow verdict, transport, scheme mismatch. An unreadable target file reports an `error` for that file, never an empty value (an unreadable file is not an unconfigured one).
- `PUT /api/system/console-url` [admin|super_admin] [env] — `{url, confirmed?}`. ⛔ **THE LOCKOUT GUARD IS A 409 + `needsConfirmation`, NOT A SILENT ACCEPT**: a hostname resolving somewhere other than this server is the one typo that makes the console unreachable by the person who made it, so it needs a second, deliberate submit. An UNRESOLVABLE host is accepted with a warning — an internal name may resolve from every workstation and not from the server, and refusing it is its own lockout. `tlsActive` is passed EXPLICITLY (it is tri-state; omitting it silently disables the scheme-disagreement refusal). Deliberately only `admin`-gated, unlike the entra route: a bad console address is an outage, not a privilege escalation. Refuses a duplicate `NEXTAUTH_URL` in EITHER target file before writing, because the key goes to two files and a late refusal would split them.
- `GET /api/system/entra` [**super_admin**] [env] — whether each of the three values is set, saved-vs-running by FIELD LABEL, and the exact Redirect URI to register. ⛔ **THE CLIENT SECRET IS NEVER RETURNED IN ANY SHAPE.** ⛔ The Redirect URI is DERIVED from the console address (`<console>/api/auth/callback/entra`), never typed — it must match byte for byte and a mismatch fails on Microsoft's side with an error that never reaches our logs. When a console-address change is pending, `redirectUriAfterRestart` is reported separately: registering only one of the two breaks sign-in on one side of the restart.
- `PUT /api/system/entra` [**super_admin**] [env] — writes the three `ENTRA_*` values in `lib/entraSettings.ts`'s OFF → CHANGE → ON order, so for every failure point either nothing changed or SSO is off. ⛔ **GATED ON super_admin, STRICTER THAN THE CONSOLE-ADDRESS ROUTE ON PURPOSE**: whoever sets the tenant decides WHICH DIRECTORY IS TRUSTED to issue identities, and an `admin` who could point it at a tenant they control, map a group they own to super_admin and sign in would have escalated past every other guard without touching the Users page. ⛔ `writeManagedKey`'s `previous` is stripped at a single named-field boundary — for `ENTRA_CLIENT_SECRET` that value IS the old secret.
- `GET /api/system/tls` [admin|super_admin] [env] — transport state, certificate subject/SANs/expiry/chain length, `nextAuthUrlMismatch`. Key PATHS travel; key BYTES never do.
- `POST /api/system/tls` [admin|super_admin] [env] — accepts pasted PEM, `.cer`/`.der` + key, or `.pfx` + passphrase. ⛔ **VALIDATES THE PAIR WITH `checkPrivateKey()` BEFORE WRITING ANYTHING** — a mismatched certificate and key both parse perfectly and fail only at the next restart, weeks later, during an unrelated upgrade. Refuses to overwrite an existing pair without `replace: true` (an operator's real corporate certificate must survive); backs up the previous pair beside each original; writes the key 0600.
- `GET /api/system/service-restart` [admin|super_admin] — what a restart would do for each PURPOSE, whether one is in flight, and this process's `uptimeSeconds`. ⛔ The uptime is how the panel PROVES a restart happened: "the page loaded again" is not evidence, because a refused stop leaves the ORIGINAL process answering. A lower uptime than the recorded baseline cannot be produced by the old process.
- `POST /api/system/service-restart` [**super_admin**] — `{purpose: 'console-address'|'certificate'|'sso'}`. ⛔ **A PURPOSE, NEVER A SERVICE NAME FROM THE BODY** — a route that restarts whatever service a caller names is a denial-of-service primitive. ⛔ **THE SERVICE DIFFERS BY PURPOSE**: a certificate is served by `NocVault-Tls`, NEVER by NetVault, and with no terminator installed a certificate needs NO restart at all (the route says so instead of bouncing a service for no effect). ⛔ **DEPENDENTS ARE STOPPED FIRST**: `NocVault-Tls` declares `DependOnService NetVault`, so `sc stop NetVault` is refused with 1051 while it runs — the stop fails, the start returns 1056, the service is Running throughout, and a "is it running" verdict reads a restart that never happened as success. The verdict requires the **PID to have changed**. Audited BEFORE `schtasks /run`, because after it this process can be killed at any instant.
- `GET /api/system/tls-transport` [admin|super_admin] [env] — which way the HTTPS switch is facing and what the last run did: `lib/tlsConfig.ts`'s status for THIS PROCESS, the live `NocVault-Tls` service state, this console's bound port, and the parsed run log. ⛔ **THE SERVICE STATE AND `status` ARE REPORTED SEPARATELY, NEVER RECONCILED**: the hub read its environment at startup, so `status` can be stale with respect to a terminator started or removed since. ⛔ `sc.exe` exit **1060** means the service does not exist (a real answer); ANY other failure is `terminator: 'unknown'`, which blocks BOTH directions rather than offering to "turn on" a suite that may already be on.
- `POST /api/system/tls-transport` [**super_admin**] [env] — `{action: 'preview'|'enable'|'disable', publicHost?}`. Writes `logs/tls-transport-run.ps1` and runs `installer/Enable-NocVaultTls.ps1` through a SYSTEM scheduled task (`NocVault-TlsTransport`), the same shape as `POST /api/system/update` and for the same reason: **the cutover restarts the service handling this request**, moving the hub off :3000 onto 127.0.0.1:13000, so there is no socket left to answer on. ⛔ **super_admin, STRICTER THAN THE CERTIFICATE ROUTE**: this is the only Settings action that restarts all four consoles. ⛔ `publicHost` is the feature's ONLY input and it reaches a SYSTEM command line — `validatePublicHost` is a hostname allow-list (an IP is refused, because Entra refuses an IP in a Redirect URI) and `psLiteral` quotes it anyway, so the quoting does not depend on the validator staying right. ⛔ **AUDITED AS AN INTENT, NOT AN OUTCOME** (`tls_transport:action`): the verdict lands in the log minutes later, and the engine exits 0 whether it succeeded or undid itself.
- `GET /api/system/directory-mappings` [**super_admin**] [db] — the group → role table plus the roles that may be granted (`DIRECTORY_PROVISIONABLE_ROLES`). ⛔ **A FAILED READ IS A 500, NEVER `mappings: []`.** An empty list is the real configuration "no group is mapped, so every directory sign-in is refused"; reporting a database fault as that state sends an administrator to re-add mappings they already have, and the obvious next move hits the duplicate path.
- `POST /api/system/directory-mappings` [**super_admin**] [db] — adds one mapping. ⛔ **super_admin FOR THE REASON THE ENTRA ROUTE'S HEADER ALREADY NAMES**: that comment describes the escalation as an `admin` who could point the tenant at a directory they control, "map a group they own to super_admin and sign in" — this route is the second half of that sentence, so gating the tenant on super_admin and the mappings on `admin` leaves the escalation intact on any box whose tenant is already set. ⛔ The role is validated against `DIRECTORY_PROVISIONABLE_ROLES` BEFORE the insert: `directory_role_mappings_role_check` would also refuse `site_admin`, but as a 500 carrying a Postgres string instead of the reason (a directory-provisioned site_admin has no `user_sites` rows and would see nothing). 409 + `duplicate: true` for a group already mapped — deliberately distinct from the 500, so a connection blip is not reported as a duplicate. Audited under `directory_mapping:<group id>`.
- `DELETE /api/system/directory-mappings?id=<n>` [**super_admin**] [db] — removes one and returns `remaining` + `lockedOut`. ⛔ **`lockedOut` IS NOT COSMETIC**: an empty table refuses EVERY directory sign-in, and an administrator tidying a list has no reason to know that removing the final row locks the whole directory out. Uses `RETURNING` because after the DELETE there is nowhere left to read the group key and role for the audit entry.
- `GET /api/system/directory-refusals` [**super_admin**] [db] — the last `DIRECTORY_REFUSAL_KEEP` refused directory sign-ins: when, who, a derived explanation, and the GROUP OBJECT IDS the token carried. ⛔ **THE RAW `cause` IS NOT RETURNED.** It is `"<code>: <free text written for a log>"`; only the code is interpreted (`explainRefusal`), so nothing written for an operator's log can be rendered in a page by accident. ⛔ **super_admin, AND NOT MERELY FOR CONSISTENCY**: this answers "who tried to sign in and which directory groups were they in" — an account inventory of the customer's directory assembled from tokens, and the inputs to a decision only a super_admin may make. ⛔ **A FAILED READ IS A 500, NEVER AN EMPTY LIST** — "nothing has been refused" is the answer an administrator acts on by concluding sign-in works. Read-only by design: the table is capped by its writer, and a “clear” button would let whoever is causing refusals erase the evidence.

### Changed by this feature
- `GET /api/users` now returns `auth_provider`, so the Users page can tell a local account from a directory one. ⛔ `users_public` is an ALLOWLIST view and `entra_oid` is deliberately NOT in it — see `.ai-codex/schema.md`.
- `PUT /api/users/[id]` now refuses, with 409 and a named `field`, a password / role change / email change on a DIRECTORY account (`lib/localAccountPolicy.ts`). ⛔ The password case is the one that matters: this route wrote `password_hash` from the body regardless of whose row it was, and a hash on an `entra` row makes `canUsePassword()` true — a local credential path for an identity whose credentials belong to the customer's directory. `name`, sites and app access still go through, because `user_apps`/`user_sites` are hub-owned data the directory cannot supply and this is the only route that sets them.
- `POST /api/users` and `PUT /api/users/[id]` refuse an email already held by a DIRECTORY account (409). Policy: a local account must not use a directory address. There is deliberately no "link these two accounts" action.
- `DELETE /api/users/[id]` gained two things it never had: a **last-super_admin guard** (only that role can manage users or the licence, so losing the last one leaves an installation nobody can administer), and a `23503` handler that answers 409 naming the blocking table instead of an uncaught 500. ⛔ Measured on the live database: three FKs into `users` were ON DELETE NO ACTION and the oldest account was referenced by 2,482 devices, so deleting any account that had ever done anything was impossible — and the Users page discarded the reason. See `.ai-codex/schema.md`.
- `app/api/auth/[...nextauth]` registers the `entra` provider ONLY when all three `ENTRA_*` keys are set, refuses a directory sign-in in the `signIn` callback (⛔ a refusal expressed only in `jwt()` is NOT a refusal — NextAuth's default `signIn` returns true), re-resolves the directory role on EVERY token use, and never lets the named cause of a refusal reach the login page.
