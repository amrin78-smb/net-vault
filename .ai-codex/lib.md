# NetVault lib/ Exports

agentIdentity.ts
  AgentIdentity (type) — { jwt, expires_at }
  AgentAuth (type) — { agentId, modules }
  PORT_MAP — const module→data-plane ingest port map (spanvault/span:3010, ddivault/ddi:3011 — both real live ingest ports; LogVault agent module was deferred, no log entry)
  KNOWN_MODULE_SLUGS — const ReadonlySet of accepted module slugs (both forms; = Object.keys(PORT_MAP))
  isKnownModule(app) — type-guard: true iff app is a string in KNOWN_MODULE_SLUGS (rejects typo'd/arbitrary slugs before storage)
  issueAgentIdentity(agentId, modules, ttlDays=7) — sign hub JWT {sub,typ:'agent',aud:modules} with NEXTAUTH_SECRET → {jwt, expires_at}
  verifyAgentIdentity(token) — verify sig + typ==='agent' + expiry → {agentId, modules} | null
  hashToken(token) — sha256 hex (stored form of enrollment tokens)
  newEnrollToken() — 'enr_' + 24 random bytes hex
  newAgentId() — 'agt_' + 9 random bytes hex
  deriveIngest(app, req) — build ws(s)://<request-host>:<port>/ for a module, or null for unknown slug
  requireAgentAuth(req) — Bearer-JWT gate: verify sig AND confirm agents row exists & revoked_at IS NULL → {agentId, modules} | null (rejects valid JWT of a revoked agent)

agentBundle.ts
  resolveAgentDir() — locate on-disk agent/ dir (cwd/agent, then ../../agent for standalone build); null if none
  isExcludedBundlePath(relPath) — blocklist guard (deps/state/keys/logs/tests/install.ps1) shared by manifest + per-file server
  listBundleFiles(agentDir) — recursively list servable agent files as sorted fwd-slash relative paths

appAccess.ts
  ALL_APPS — const list of the 4 suite app slugs
  getUserApps(userId, role?) — resolve apps a user can access (fail-closed `[]` on DB error).
    ⛔ **`role` NO LONGER SHORT-CIRCUITS (1.63.0).** It used to answer all four apps for
    `super_admin` BEFORE any query, so an explicit `user_apps` deny was never consulted for the one
    role whose sessions matter most — and combined with a role that was only written at sign-in, a
    demoted-and-restricted super_admin kept satellite tokens for every app. The DB is always asked
    now; `role` stays in the signature (every caller has it, the SSO handoffs stamp it beside the
    result) but cannot decide the answer. The asymmetry is unchanged: NO ROWS = all apps (legacy),
    `[]` = deny-all and the only shape a closed failure can take.
  canAccessApp(apps, slug) — check slug allowed (netvault always true)

localIdentity.ts  (SERVER ONLY — reads `users` + `user_apps`)
  LocalIdentityReading (type) — `{ read, role, apps }`. ⛔ `read: false` is "we could not ask", NOT
    "no such user"; `read: true` with `role: null` is a DELETED account.
  LOCAL_IDENTITY_TTL_MS (15_000) — how long one answer is reused per process.
  readLocalIdentity(userId) — uncached: role from `users`, apps via `getUserApps`.
  resolveLocalIdentity(userId) — memoised form; the `jwt` callback calls this on EVERY token use.
    ⛔ Only a SUCCESSFUL read is cached, so a DB blip is retried on the next request.
  clearLocalIdentityCache(userId?) — for tests, and after changing a user's row.
  ⛔ **THIS IS THE LOCAL HALF OF THE MID-SESSION REVOCATION LAYER (new 1.63.0).** `token.role` was
  set once, inside `if (user)`, and re-resolved per request only for a DIRECTORY account — while the
  comment beside it claimed local users had had the equivalent "since RBAC shipped". They had not.
  ⛔ It is the ONE place in this suite that does not fail closed, and the reasoning is stated in the
  file: the read that fails is `SELECT role FROM users`, so its failure means the hub's own database
  is down and every page is already broken; clearing every live session's role on a pool blip would
  be a product-wide sign-out caused by a hiccup. Bounded by `session.maxAge` instead.

licensePayload.ts
  LicenseFacts / PublicLicensePayload / PrivilegedLicensePayload (types)
  PRIVILEGED_LICENSE_FIELDS — `serverId`, `maxDevices`, `installDate`
  publicLicensePayload(f) / privilegedLicensePayload(f) / licensePayloadFor(role, f)
  ⛔ `GET /api/license` had NO session check (its POST does, which is why grepping the file for auth
  passed) and all three satellites re-publish its answer on their own PUBLIC `license-status`.
  Trimmed rather than authenticated: the satellites poll it server-to-server with no credential and
  FAIL OPEN on any non-2xx, so a session gate would disable licence enforcement in three products
  silently. `customer`/`expiry` stay public deliberately — every satellite re-publishes both anyway.

pagination.ts  (NO IMPORTS — usable from a route, a component or a test)
  DEFAULT_PAGE_SIZE (50), MAX_PAGE_SIZE (200), Paging / ParamSource (types)
  resolvePaging(params, { defaultLimit?, maxLimit?, fixedLimit? }) — clamped `{page, limit, offset}`
  ⛔ **THE ONLY WAY A ROUTE MAY READ `page`/`limit`** (`tests/systemSeams.test.ts` enumerates
  `app/api/**` and requires it). Bare `parseInt` gave three reachable failures to any authenticated
  session: `limit=99999999` (a DoS-sized scan of `v_devices_flat`), `page=0` (negative OFFSET → 500)
  and `limit=abc` (NaN into a query parameter → 500).

runLock.ts  (NO IMPORTS — `fs` and the liveness probe are injected)
  ARM_WINDOW_MS (2 min) — how long a ROUTE's pending claim may sit un-taken-over.
  LOCK_IDLE_MS (30 min) — an IDLE timeout, meaningful only because the wrappers heartbeat the lock.
  LockClaim / LockEnv / LockReading / ClaimResult (types)
  pendingLockBody(pid, runId) / parseLockBody(raw) — a BARE pid still parses (that is what the
    wrappers write); `<pid> pending <runId>` is the route's claim, and the wrapper's takeover
    overwrites it with a bare pid, which IS the handover signal.
  readRunLock(path, env) — ⛔ **A READ THAT WRITES.** Reaps debris, so it can be called from GET;
    reaping used to live on POST while the gate it unblocks is drawn from GET.
  claimRunLock(path, runId, pid, env) — atomic (`flag: 'wx'`), reaps first.
  releaseRunLock(path, env, { onlyIfPending, runId }) — ⛔ may NEVER drop a wrapper-owned lock.
  psArmGuard({runId, taskName, quote}) — the PowerShell lines a wrapper runs FIRST: refuse, delete
    the task and exit unless the lock still carries THIS run's pending claim. The only reliable
    answer to an orphaned `/sc once /st 00:00` task firing the following midnight.
  psLockTakeover() / psLockHeartbeat() — `$PID | Out-File $lock`, as handover and as heartbeat.
  ⛔ Four defects it closes, each written out in the file header: service-restart never claimed the
  lock at all; claiming with the hub's own (permanently alive) pid wedged the panel; `dead || old`
  reaped a LIVE run; and the `/run` catch could delete a live run's lock and task.

ssoHandoff.ts  (NO IMPORTS)
  SatelliteSlug / SsoClaims (types), SSO_CLAIM_KEYS, SSO_TOKEN_TTL ('2m')
  handoffIdentity(sessionUser) — `null` when there is no `id` or no `role`. ⛔ A session whose role
    the `jwt` callback CLEARED (revoked mapping / deleted account) must not be handed to a satellite:
    SpanVault reads `payload.role || 'viewer'`, so a revocation would become a working viewer.
  ssoClaims(user, app, apps) — ⛔ the ONLY place `userId`/`app` are spelled. SpanVault's
    `authorize()` REQUIRES `userId` and `app === 'spanvault'`; renaming either breaks SpanVault
    sign-in entirely and nothing in this repo fails.

compliance.ts
  MIN_POP_PCT — const threshold % for a check to count toward risk score
  ComplianceCheck (type) — per-check result shape
  ComplianceResult (type) — overall compliance computation shape
  computeCompliance(activeBase) — weighted risk/compliance + data-completeness scores from device checks

cronAuth.ts
  isCronAuthorized(req) — constant-time check of the `Authorization: Bearer $CRON_SECRET` header used by the Windows scheduled-task endpoints; fails closed when CRON_SECRET is unset [SENSITIVE]

db.ts
  query(text, params) — run pooled SQL query, releases client after
  withTransaction(fn) — run fn atomically inside BEGIN/COMMIT/ROLLBACK on one connection
  default export: pg Pool instance

entitlements.ts
  hasEolModule() — check install is entitled to the 'eol' licensed add-on [SENSITIVE]
  requireEol() — 403 NextResponse gate for EOL API routes when not entitled [SENSITIVE]

eolEnrich.ts
  EolInitResult (type) — { fuzzyAvailable }
  ensureEolSchema() — idempotent create/self-heal of eol_seed/jobs/discrepancies/recommendations tables + migrate legacy seed
  normalizeForMatch(vendor, model) — aggressive flat key for fuzzy/alias device-model matching
  SeedRow (type) — loaded eol_seed row shape
  MatchResult (type) — match outcome shape (seed/via/confidence/score or possible-match)
  loadSeedRows() — load all eol_seed rows + synthesize Aruba AP bare-number aliases
  canonVendor(name) — canonicalize vendor name into match-scoping bucket (folds HP/HPE/Aruba together)
  apModelAliases(vendor, modelRaw) — synthesize bare-number alias for Aruba AP model names
  matchDevice(deviceNormalized, seeds, fuzzyAvailable, deviceVendor) — exact/alias/fuzzy match a device against seed rows
  trigramSimilarity(a, b) — pure-JS trigram similarity mirroring pg_trgm
  DeviceRow (type) — device fields loaded for EOL matching
  loadDevices() — load all devices (brand/model/lifecycle/EOL fields) for matching
  previewMatch(vendor, modelRaw, opts) — read-only preview of how many devices a candidate seed entry would match
  diffDays(aIso, bIso) — days between two ISO date strings
  runEnrichment(jobId, fuzzyAvailable) — full EOL enrichment pass: matches devices, writes dates/discrepancies/recommendations onto DB

eolFeed.ts
  FeedSyncResult (type) — sync outcome counts
  syncFromFeed() — fetch central EOL feed over HTTPS, verify sha256+Ed25519 signature, upsert into eol_seed [SENSITIVE]

eolSeed.ts
  EolConfidence (type) — 'exact' | 'family' | 'inferred'
  EolSeedEntry (type) — bundled seed entry shape
  normalizeModel(brand, model) — legacy uppercase deterministic join-key normalizer
  EOL_SEED — const array of ~949 bundled vendor-confirmed EOL/EOS seed entries (generated data, offline floor)
  resolveEol(brand, model) — exact raw-model lookup against EOL_SEED

gitRoot.ts
  findGitRoot(start) — walk up from start to the nearest ancestor dir containing .git, skipping any .git found inside a .next build-output path; shared by app/api/system/update/route.ts + app/api/system/update-status/route.ts (extracted 2026-07-23 — was two independently-maintained copies whose .next-path guard had drifted between them)

healthScore.ts
  HealthResult (type) — health score/grade/status/metrics shape
  computeHealthScore(opts) — compute live infra health score/grade from compliance score + EOL/site metrics

license.ts
  getServerId() — derive stable per-machine license server ID from hostname+MachineGuid (memoized) [SENSITIVE]
  LicensePayload (type) — decrypted license contents shape
  validateLicenseKey(key, serverId) — AES-256-CBC decrypt + validate a license key against hardcoded shared secret [SENSITIVE]
  getTrialDaysRemaining(installDate) — days left in the 30-day trial
  LicenseStatus (type) — 'trial' | 'active' | 'expired' | 'grace'
  getLicenseStatus(installDate, licenseKey, serverId) — resolve overall license/trial status incl. key validation [SENSITIVE]
  isWriteAllowed(status) — whether mutations are allowed for a given license status

model.ts
  normaliseBrand(b) — canonicalize known brand spelling variants (CSV import)
  stripBrandFromModel(brand, model) — strip redundant leading brand token from a model string

publicUrl.ts
  resolveOrigin(req, port, legacyFallback, env?) — derive request origin (host/proto/PORT) for cross-app SSO redirect targets
  SIBLING_PORTS — const port map for logvault/ddivault/spanvault

rateLimit.ts
  RateLimitResult (type) — { limited, retryAfterSec }
  checkRateLimit(key, {maxAttempts, windowMs}) — in-memory per-key fixed-window rate limiter; fails open on any error. First use: POST /api/agents/enroll
  getClientIp(req) — best-effort source IP from x-forwarded-for/x-real-ip (rate-limit/logging only, not an auth signal)

suiteDb.ts
  SuiteDb (type) — 'netvault' | 'logvault' | 'ddivault' | 'spanvault'
  suiteReadConfigured() — whether cross-DB readonly credentials are set [SENSITIVE]
  queryDb(db, sql, params) — SELECT-only query against a sibling suite DB via nocvault_readonly role [SENSITIVE]
  queryOne(db, sql, params) — scalar convenience wrapper over queryDb (first row or null) [SENSITIVE]

techDebt.ts
  calcTechnicalDebt(lifecycleStatus, deviceStatus, deviceType) — estimate $ replacement cost for an active EOL device. DERIVED ONLY: both device write routes call this and ignore any client-supplied technical_debt; DeviceForm renders it read-only from the same function.

theme.ts
  Theme (type) — 'light' | 'dark'
  THEME_KEY — const localStorage key
  getTheme() — read current theme from document data-theme attribute
  applyTheme(theme) — set data-theme, persist to localStorage, dispatch sync event
  toggleTheme() — flip and apply light/dark theme
  THEME_INIT_SCRIPT — const inline <script> body for no-flash theme init before paint

(lib) lib/corners.ts — rounded/square corner switch. getCorners/applyCorners/toggleCorners/CORNERS_INIT_SCRIPT. Key netvault-corners, event netvault:corners, attribute data-corners="square" on <html> (rounded = ABSENCE of the attribute; there is deliberately no [data-corners="rounded"] rule). Works by overriding --radius/--radius-sm/--radius-pill ONLY, so any hardcoded numeric borderRadius opts that component out SILENTLY — always use the token.

(lib) lib/mfa.ts — TOTP (RFC 6238) primitives. generateSecret/verifyTotp/currentStep/otpauthUri/base32Encode/base32Decode/encryptSecret/decryptSecret/generateBackupCodes/hashBackupCode/backupCodeMatches + TOTP_STEP_SECONDS, TOTP_WINDOW, MFA_MAX_ATTEMPTS, MFA_LOCKOUT_MINUTES. Hand-rolled on node:crypto rather than a package — short, fully specified, and verified against the RFCs' own vectors by scripts/test-mfa.cjs (run it after ANY change here). mfa_secret is AES-256-GCM encrypted with a key HKDF-derived from NEXTAUTH_SECRET — so rotating that secret makes existing secrets undecryptable and those users must re-enrol; backup codes are bcrypt-HASHED, not encrypted, precisely so they survive that. decryptSecret returns null on any failure and callers must treat that as "no secret", never as verified.

(lib) lib/mfaGate.ts — verifySecondFactor(user, submitted) / mfaRequiredForRole(role). The ONE second-factor state machine, shared by NextAuth authorize() and /api/auth/mfa/precheck: lockout, TOTP replay rejection via users.mfa_last_step, backup-code consumption, attempt counting. Do not inline a second copy of this logic — attempt counting and replay defence only work if every path shares the state.

## Entra ID SSO + HTTPS foundation (1.54.0)

Eight modules, all added together. Six are PURE (no I/O, no env read, no DB) so
every branch is reachable from a test; `directoryStore.ts` is the only one that
talks to PostgreSQL and `envFile`/`envTargets` are the only ones that touch disk.
80 mutations were run across the pure six with zero survivors — if you change a
guard here, re-run its mutation, don't trust a green suite.

(lib) lib/envFile.ts — parseEnv/readEnvFile/setEnvValue/LINE_RE + types. Changes ONE key in an env file by LINE EDIT: comments, ordering and every untouched value survive byte for byte. Refuses a file over 1 MB BEFORE taking a backup (a corrupt file must not be duplicated into a second secret-bearing copy), refuses a DUPLICATED key rather than guessing which copy the loader honours, backs up → writes → reads back → verifies every OTHER key is unchanged → restores on mismatch → removes the backup only once the write is proven. ⛔ Writes IN PLACE, never by rename, so an ACL on the file is not silently replaced. ⛔ `LINE_RE` is exported and matched against RAW lines by entraSettings, which is the only reason its trailing `\r?` is load-bearing — setEnvValue/parseEnv pre-split on /\r?\n/ and the real CRLF guard there is the SPLIT pattern (mutate it to split('\n') and every untouched line comes back as \r\r\n).

(lib) lib/envTargets.ts — MANAGED_KEYS/isManagedKey/resolveEnvTargets/writeManagedKey/shadowVerdict/serviceEnvPins/parseServiceEnvKeys/rootEnvPath/standaloneEnvPath/repoRoot. ⛔ ONE LOGICAL SETTING LIVES IN THREE PLACES ON NETVAULT and all three matter: the NSSM service environment (read at runtime and it WINS over any file — set by Install-NocVault-Suite.ps1, never removed by the updater), `<repo>/.env` (not read at runtime but the source Update-NetVault.ps1 copies from on every deploy), and `.next/standalone/.env.local` (what the process actually reads). Write only the runtime file and the setting reverts on the next deploy; write only the deploy source and nothing changes until one; leave the service env in place and NEITHER file is read, because dotenv does not override an existing process.env value. So a managed key is written to both files and the service env is REPORTED via a three-state `shadowVerdict` — `shadowed`/`clear`/`unknown`, where ⛔ `unknown` is never `clear` (off Windows, or without permission to read the registry, it says so). `parseServiceEnvKeys` returns KEY NAMES ONLY; AppEnvironmentExtra carries DATABASE_URL and NEXTAUTH_SECRET and a test asserts no value fragment can escape. MANAGED_KEYS is an allow-list so an HTTP route can never rewrite NEXTAUTH_SECRET or DATABASE_URL.

(lib) lib/consoleUrl.ts — validateConsoleUrl/hostPointsHere/decideConsoleUrl/isIpv4 + WARN_*/CONFIRM_* constants. The Settings → Console address decision layer (writes NEXTAUTH_URL). REFUSES, never warns about: a missing scheme (caught BEFORE `new URL()`, which otherwise parses `host:3000` as a protocol and complains about the hostname), a non-http(s) scheme, an unparseable address, a trailing path, a query or fragment, embedded credentials, a bad hostname shape, a port outside 1–65535, and a scheme that disagrees with the transport. ⛔ THE LOCKOUT GUARD: a hostname resolving somewhere other than this server requires explicit confirmation (the route turns that into 409 + needsConfirmation) — that typo is the one way to make the console unreachable by the person who made it. ⛔ `pointsHere: null` is NEITHER a pass NOR a refusal and has THREE sources: a resolver error, an empty answer, and an unenumerable local address list. An internal name may resolve from every workstation and not from this host, so refusing it is its own lockout; and treating an unenumerable local list as "doesn't point here" would send every CORRECT address to the prompt and turn the guard into a rubber stamp. ⛔ `tlsActive` is TRI-STATE — `undefined` refuses neither scheme, so a caller that forgets to pass it silently disables the strongest refusal in the file.

(lib) lib/tlsConfig.ts — resolveTlsConfig/describeTlsStatus/expectedOrigin/nextAuthUrlMismatch/portFrom + DEFAULT_HTTPS_PORT/DEFAULT_HTTP_REDIRECT_PORT. ⛔ THREE TRANSPORT STATES, NEVER TWO: `active`, `disabled` (no certs configured — how the whole suite has shipped for its entire life, NOT an error), `failed` (certs WERE configured and could not be loaded). ⛔ `failed` must never read like `disabled` — the operator asked for TLS and is not getting it, and a reader concluding "we're encrypted" is the failed-read-as-a-fact rule at its most dangerous. Half-configured (one of cert/key) is `failed`, not `disabled`. ⛔ IT ACTUALLY BUILDS A SecureContext rather than checking two files exist: https.createServer builds one SYNCHRONOUSLY and THROWS on anything OpenSSL cannot parse, so the process exits and the service manager restarts it for ever — the classes that happen in the field (a DER .cer saved over a .crt, a truncated download, a mismatched restored pair) all take the console down permanently otherwise. Keeps the OpenSSL err.code (ERR_OSSL_PEM_NO_START_LINE = not PEM; ERR_OSSL_X509_KEY_VALUES_MISMATCH = wrong key). Ports come from env with caller-supplied per-app defaults — nothing is nailed to one app, because one terminator fronts all four.

(lib) lib/entraSettings.ts — ENTRA_KEYS/ENTRA_FIELD_LABELS/normaliseEntraInput/isEntraConfigured/duplicateEntraKeys/planEntraWrite/applyEntraWrites/entraWriteFailureAnswer/entraRestartPending. Plans the Settings → Single sign-on write; the writer is INJECTED (the route passes writeManagedKey). ⛔ THE ORDER IS OFF → CHANGE → ON AND IT IS THE WHOLE SAFETY PROPERTY: blank ENTRA_TENANT_ID first (the feature is now definitively off), then the secret (only if the body supplied one), then the client id, then restore the tenant LAST. For EVERY failure point either nothing changed or SSO is off — there is no third state, and that is asserted across the whole sequence rather than per step. ⛔ THE SECRET IS WRITE-ONLY AND NEVER TRAVELS: a read reports only whether one is SET, the saved-vs-running comparison happens server-side and only the FIELD LABEL of a difference may appear in a response. The route must NOT forward writeManagedKey's `previous` (top level or inside results[]) — for ENTRA_CLIENT_SECRET that IS the old secret. `withoutValue()` redacts the written value out of any forwarded writer error for ALL THREE keys, because the commonest misconfiguration is pasting the secret into an id box. ⛔ A BLANK SECRET BOX KEEPS THE STORED ONE (it is write-only, so a blank box and a cleared one look identical); absent / blank / explicitly-cleared are three different instructions. ⛔ ALL THREE REQUIRED TOGETHER — any one blank means not configured, no sign-in button, nothing logged as a fault; turning SSO off is clearing all three. Reuses envFile's LINE_RE for the duplicate scan rather than declaring a second regex for one grammar.

(lib) lib/directoryUser.ts — decideDirectoryUser/isDirectoryPermitted/canUsePassword/isDirectoryAccount/mfaPolicyApplies/isRole + OUTCOME/ASSIGNABLE_ROLES/DIRECTORY_PROVISIONABLE_ROLES. What a verified directory identity may become in `users`. ⛔ THE SUITE NEEDS SHADOW ROWS ON DAY ONE, unlike SecVault which deferred them: all three satellites resolve identity from the hub's `users` table — logvault (`WHERE id = $1`) and ddivault (via /api/auth/sso-verify, 404 "User not found") HARD-FAIL without a row, and spanvault falls through to `payload.role || 'viewer'`, which is worse because it does not fail (a directory super_admin silently becomes a SpanVault viewer). ⛔ AN EMAIL COLLISION WITH A LOCAL ACCOUNT IS REFUSED, NEVER AUTO-LINKED, and refused EVEN WHEN THE ROLES AGREE — linking on email means whoever obtains a directory account bearing that address inherits that local account's role, and a UPN is a MUTABLE attribute a tenant admin can change. Policy (2026-11-05): a local account must not use a directory address at all, so there is no "link these two" action and none is coming; the fix is to remove or re-address the local account. ⛔ site_admin IS NOT PROVISIONABLE — a site admin's visible sites come from user_sites, which a fresh row has none of, so they would sign in successfully and see NOTHING (the exact refusal-that-misdescribes-its-own-cause SecVault had to reverse). Enforced here AND by a schema CHECK; lifting it means provisioning user_sites in the SAME change. ⛔ `canUsePassword` exists because bcryptjs THROWS on a null hash (measured: `Illegal arguments: string, object`) and users.password_hash is nullable — without it a directory-only account typing a password gets an exception, not "invalid credentials". ⛔ `isDirectoryAccount` decides on `auth_provider`, NEVER on the shape of a value, and an UNRECOGNISED provider is not local — SecVault's Phase 0 fail-open was exactly that mistake (an Entra oid is a GUID that passed its local-UUID test). ⛔ `mfaPolicyApplies` is false for a directory account: without it, the day someone adds super_admin to app_settings.mfa_required_roles every directory super_admin stops being able to sign in, since they have no local TOTP secret and cannot enrol one.

(lib) lib/directoryRoles.ts — resolveDirectoryRole/groupsFromClaims/hasGroupOverage/isDirectoryRole/isDirectoryRolePermitted + OUTCOME/ROLE_PRECEDENCE. Group → role, pure. ⛔ THE WHOLE FILE IS ABOUT TELLING THREE KINDS OF "NO" APART: no mappings exist / no mapping matched / the groups could not be read. Each needs a different fix and the third must never render as either of the first two. ⛔ ZERO MAPPINGS REFUSES EVERYONE — the OPPOSITE of user_apps' "no rows means default-all", because that pattern exists to protect an INSTALLED BASE on the deploy that delivers a feature and there is no installed base of directory sign-ins; failing open could only create a hole. ⛔ THE GROUP-CLAIM OVERAGE IS THE DANGEROUS CASE AND LOOKS EXACTLY LIKE INNOCENCE: Entra drops the `groups` claim past ~200 memberships and sends a `_claim_names`/`_claim_sources` pointer instead, so unhandled the token simply has no groups and reads as "in no groups". A user in 201 groups is not a user in zero, and it hits the most group-heavy accounts in a directory — usually the administrators. REFUSED BY NAME; the pointer is deliberately NOT followed (that needs GroupMember.Read.All, which the setup instructions ask the tenant admin NOT to grant, plus a second outbound dependency on the login path). Overage wins even over a groups array that would otherwise MATCH — a truncated claim is still truncated and the privileged group may be the one dropped. ⛔ MOST PRIVILEGED MATCH WINS, so adding a group can only ever ADD access. ⛔ A mapping load that FAILED is MAPPINGS_UNREADABLE and says the fault is ours — SecVault collapsed this into the group-claim outcome and told administrators to check the app registration while the database was down. ⛔ Rows with no usable key are MAPPINGS_MALFORMED, not NO_MATCHING_GROUP — otherwise a renamed column is a code defect wearing a configuration error's clothes, debugged in the customer's tenant.

(lib) lib/directoryRefusals.ts — DIRECTORY_REFUSAL_KEEP/refusalCode/explainRefusal (pure) + recordDirectoryRefusal/listDirectoryRefusals. The other half of a deliberate split: the login page tells a refused person nothing because it is reachable unauthenticated, which left the ADMINISTRATOR with nothing too. ⛔ recordDirectoryRefusal NEVER THROWS — it runs inside NextAuth's signIn callback, where a throw becomes `/api/auth/error?error=<message>`, publishing the exception text on an unauthenticated page. ⛔ THE WRITER TRIMS. This is the only table whose row count is driven by a failure loop (a misconfigured directory refuses every attempt and people retry), and nothing in a customer install runs a cleanup job. ⛔ explainRefusal keeps SIX CAUSES SIX THINGS: three of them look identical from the login page and need different fixes, and SecVault collapsed `mappings_unreadable` into `groups_unreadable`, telling administrators to check their app registration while its own database was the fault. ⛔ GROUP OBJECT IDS ONLY, never names — the ids are what the mapping table matches on; names would be a record of the customer's internal group structure.
(lib) lib/directoryStore.ts — loadDirectoryMappings/findUserByEntraOid/findUserByEmail/createDirectoryUser/refreshDirectoryUserRole/loadDirectoryContext, plus listDirectoryMappings/createDirectoryMapping/deleteDirectoryMapping for Settings. ⛔ THE THREE ADMIN FUNCTIONS ARE SEPARATE FROM loadDirectoryMappings ON PURPOSE: that one is on the SIGN-IN path and its SELECT list, its throw-don't-return-[] contract and its tests are load-bearing, while the panel needs a column it does not select (the row id). ⛔ createDirectoryMapping's `ON CONFLICT (provider, lower(group_key))` must match uq_directory_mapping EXACTLY — the bare columns raise 42P10, but only when a duplicate is actually attempted, so every test that inserts distinct rows still passes; the same mistake shipped once on createDirectoryUser. It returns `null` for a duplicate and THROWS for a fault, and the caller must not collapse the two. The DB half; the judgements live in the two pure modules beside it. ⛔ EVERY FUNCTION EITHER RETURNS REAL DATA OR THROWS. None returns `[]`, `null` or `false` to paper over a database error, because on this path those are INSTRUCTIONS: `loadDirectoryMappings() -> []` means "nobody may sign in" and `findUserByEntraOid() -> null` means "provision a new account", so swallowing an error locks everyone out or creates a duplicate account for someone who already has one. ⛔ `ON CONFLICT (entra_oid) WHERE entra_oid IS NOT NULL` — THE PREDICATE MUST BE REPEATED, because uq_users_entra_oid is PARTIAL and PostgreSQL only infers a partial index for conflict resolution when the statement restates its predicate. Without the WHERE it fails at runtime with 42P10 on the FIRST directory sign-in and nowhere earlier; caught by the integration test, which is why that test runs against a real database instead of a mocked pool. ⛔ password_hash is left NULL — inventing a random one creates a credential nobody holds and nobody can rotate. ⛔ refreshDirectoryUserRole's UPDATE carries `AND auth_provider = 'entra'` so a bug upstream that matched a local row cannot rewrite a local administrator's role from a directory group — enforced in SQL, not trusted to the caller. ⛔ loadDirectoryContext ALWAYS runs both lookups: skipping the email one after an oid hit hides the AMBIGUOUS case (a row linked to this identity while a DIFFERENT row holds the same email, i.e. a UPN changed in the directory to an address another account has) and then collides on the next write.

## Entra SSO + HTTPS, wave 2 (1.55.0)

(lib) lib/certImport.ts — importCertificate/pfxToPem/derCertToPem/certificateBlocks/orderChain/looksLikePem/findOpenSsl. Normalises whatever a Windows administrator actually has (pasted PEM, .cer/.der + key, .pfx + passphrase) into the PEM pair node wants. ⛔ **IT EXISTS BECAUSE SECVAULT'S VERSION SILENTLY DROPS THE INTERMEDIATE, TWICE, AND THIS DEPLOYMENT USES A REAL CA WILDCARD WHOSE CHAIN NEEDS IT.** Measured against a fixture .pfx: `openssl pkcs12 -nokeys -clcerts` emits ONE certificate, `-nokeys` alone emits THREE — so `-clcerts` is gone. And its single-PEM path used a non-greedy `match(/BEGIN CERTIFICATE[\s\S]*?END CERTIFICATE/)` which keeps only the FIRST block; that is now `certificateBlocks` (global, non-greedy WITHIN a block — both halves matter, removing `g` or making the body greedy each kill 10 tests). A DER `.cer` holds exactly one certificate, so a separate chain bundle can be supplied and is merged. `orderChain` walks leaf→issuer (PKCS#12 bag order is arbitrary), de-duplicates, and APPENDS anything it cannot reach rather than deleting it. ⛔ A leaf-only chain validates in browsers that happen to have the intermediate cached and fails in strict clients — so the failure is intermittent and gets misattributed, which is why all three paths assert a chain length.

(installer) installer/terminator/{start.mjs,nocvault-tls-terminator.ts,tlsTerminator.ts} — the suite's shared TLS terminator: ONE process fronting all four consoles (3000/3004/3006/3008 → 127.0.0.1:1300X), rather than a custom server per app. ⛔ **NETVAULT IS `output: 'standalone'` AND NSSM RUNS NEXT'S OWN GENERATED server.js, so SecVault's per-app wrapper cannot be used here**; at four apps it would also mean four certificate installs and four renewals. Reuses `lib/tlsConfig.ts` unchanged for the three transport states. ⛔ THE SAME-PORT DEMUX: a plaintext request into a TLS listener is a protocol failure, not a redirect, so an old `http://host:3000` bookmark would give an unexplained connection error — it peeks byte 1, routes `0x16` to TLS and anything else to a 301. `socket.unshift` is load-bearing (deleting it breaks 9 of 19 tests; the byte is already consumed and every request loses its first character). ⛔ **IT OVERWRITES EVERY CLIENT `x-forwarded-*`, NEVER APPENDS** — `resolveOrigin` takes `.split(',')[0]` for the proto, so a client's `http` would win and silently downgrade every URL the app builds over a genuinely-TLS connection; and a two-value host fails `HOSTNAME_RE` and falls back to the install-time `NEXTAUTH_URL`, reintroducing the exact bug `resolveOrigin` was written to fix. Those redirects carry a short-lived signed SSO token. ⛔ **BLOCKED ON NODE: it cannot run on the Node 20.19.0 the installer bundles**, which cannot execute TypeScript (22.6 flagged / 22.18 unflagged) — and Node 20 LTS has been end-of-life since April 2026. `start.mjs` detects this by ATTEMPTING the import, never from a version table, and REFUSES with a named error rather than serving plaintext: with the decision layer unloadable it cannot tell a configured certificate from an unconfigured one, and plaintext there is indistinguishable from a deliberate `disabled` install — SecVault's 2026-09-24 outage shape exactly.

(lib) lib/localAccountPolicy.ts — decideLocalAccountEmail/decideDirectoryAccountEdit/sameRow + LOCAL_EMAIL_OUTCOME/DIRECTORY_EDIT_OUTCOME. Who may write what to `users`. ⛔ **A LOCAL ACCOUNT MUST NOT USE A DIRECTORY EMAIL ADDRESS** (policy, 2026-11-05) — this is the symmetric half of `directoryUser.ts`'s EMAIL_COLLISION, so the refusal lands in front of whoever typed it instead of surfacing later as a failed sign-in for someone else. There is deliberately NO "link these two accounts" action and none is planned; the fix is to remove or re-address the local account. ⛔ `decideDirectoryAccountEdit` refuses a password, a role CHANGE or an email CHANGE on a directory row. The password case closes a real hole: `PUT /api/users/[id]` wrote `password_hash` from the body regardless of whose row it was, and a hash on an `entra` row makes `canUsePassword()` true. ⛔ CHANGES are compared, not mere presence — the Users form posts every field on every save, so refusing any request CONTAINING `role` would make a directory account's name and app access unsavable, which is the blanket refusal this avoids. The password is the exception: there is no "unchanged password" to compare against. Provenance comes from the shared `isDirectoryAccount`, so an unrecognised provider gets the stricter treatment.

### lib/publicUrl.ts — where the PORT comes from (1.63.1, 1.63.2)

⛔ **`port: null` MEANS "KEEP THE PORT WE WERE REACHED ON", NOT "NO PORT".** It meant the
latter until 1.63.1, and the three `ownOrigin` call sites in the SSO handoffs pass `null`
precisely because they mean *this host, this port* — so a sessionless user was redirected to
`https://host/login`, i.e. port 443, on a suite whose public ports are 3000/3004/3006/3008
and which listens on neither 443 nor 80. MEASURED on production 2026-11-07. It survived
because only the no-session and access-denied branches build `ownOrigin`: a signed-in user
clicking a launcher tile never does. 1.63.0's cut from a 30-day session to 12 hours would
have turned it from rare into daily, so the session hardening and this fix belong together.

⛔ **THE PORT HAS THREE SOURCES, AND `x-forwarded-port` IS NOT BELT-AND-BRACES (1.63.2).**
Precedence: an explicitly requested `port`, then a port carried in the host being used, then
`x-forwarded-port`. The third exists because keeping the inbound port works only while the
forwarded host CARRIES one — and it carries one only while `TLS_PUBLIC_HOST` is unset, which
makes the terminator echo the browser's own `Host` (`…:3000`). **Setting that variable pins
`x-forwarded-host` to a bare hostname, so 1.63.1's fix would have silently stopped working
the moment the TLS hardening it was written alongside actually landed.** The terminator
already sends the correct per-app port in `x-forwarded-port` (`forwardedHeaders()`), so that
is where the port comes from once the host no longer has one. Order these two the other way
round and the suite ships a hardening step that re-opens the bug it just closed.

⛔ `x-forwarded-port` is consulted ONLY when `x-forwarded-host` was itself trusted — the same
header set, so the same trust decision. If the allow-list sent us back to the request's own
`Host`, that `Host`'s own port is the only honest answer; taking a port from a header we just
declined to believe would be worse than having no port at all. `usablePort()` additionally
drops the scheme's default port (so an install genuinely fronted on 443 keeps a clean origin)
and anything outside 1–65535 (so junk is dropped, never concatenated into a URL).

⛔ The three satellites' own `resolveOrigin` copies do NOT need this and must not be "kept in
sync" reflexively: every satellite call site passes an explicit `3000` (the hub's port), which
wins over both carried sources, so they are unaffected by `port: null` and by `TLS_PUBLIC_HOST`
alike. NetVault is the only app with `null` call sites.

### lib/publicUrl.ts — `TRUST_PROXY_HEADERS` (1.56.0)

`resolveOrigin` gained an optional allow-list and an injectable `env` (typed `EnvLike`, NOT
`NodeJS.ProcessEnv` — this repo declares `NODE_ENV` as required there, so every test passing a
small literal fails to compile and the workaround is a cast at each call site, which is how a
test ends up asserting against a shape the function never sees).

`TRUST_PROXY_HEADERS` is a comma-separated host allow-list. When SET, an `x-forwarded-host`
that is not on it is **discarded** (falling back to the request's own `Host`) rather than
refused — a misconfigured allow-list must not become an outage on every page that builds a
cross-app link. ⛔ **UNSET MEANS EXACTLY TODAY'S BEHAVIOUR, AND THAT IS DELIBERATE.** The
tempting default — ignore proxy headers unless a proxy is declared — is wrong here: behind the
TLS terminator the app is reached over plain HTTP on loopback, so with `x-forwarded-proto`
ignored it would conclude `http`, build `http://` cross-app URLs over a genuinely TLS
deployment, and bounce every sign-in with no error anywhere. A hardening default that breaks
sign-in the moment TLS is switched on is one that gets turned off again.

⛔ **A SECOND HARDENING WAS BUILT, THEN REMOVED BEFORE COMMIT — the reasoning is in the file
and is worth reading before anyone proposes it again.** Pinning the token-bearing `/api/sso/*`
handoffs to `NEXTAUTH_URL` instead of the request origin looks obviously right (those redirects
carry a signed JWT, so a header should not choose who receives it) and is a REGRESSION: on every
install that has not yet used Settings → Console address, `NEXTAUTH_URL` is still the
install-time baked IP, which is the precise bug `resolveOrigin` was written in 2026-07 to escape.
Correct on a configured install, broken on all the others, with nothing in the code able to tell
them apart. The risk it closed is also thinner than it looks: those routes require a valid
session and a browser never sends `x-forwarded-host`, so steering the redirect means making the
request yourself — which means already holding the session whose token you would receive.
Revisiting it needs an explicit "the operator declared this address" key, not an inference about
`NEXTAUTH_URL`'s contents.

### components/settings/* — the three Settings panels (1.56.0)

`systemPanelHelpers.ts` (pure, no JSX — every three-state judgement lives here so it is
testable), `panelChrome.tsx` (PanelCard/Callout/StatePill/FactTable/CopyValue/SavedRunningRows),
and `ConsoleAddressPanel` / `CertificatePanel` / `SingleSignOnPanel`.
`app/(app)/settings/page.tsx` only imports and renders them.

⛔ **SEPARATE FILES BECAUSE OF THE NO-NESTED-COMPONENTS RULE.** The page already nests several
components at the top and is 1,600+ lines; three fetch-driven forms added there would lose input
focus on every keystroke. Every component in these files is at module top level.

⛔ **BOTH CONFIRMATION FLOWS BRANCH ON `needsConfirmation === true`, NEVER ON THE STATUS CODE.**
The console-address lockout prompt and the certificate-replace prompt are both 409 — and so is
the duplicate-key refusal, which is a plain error. Branching on `res.status === 409` would turn
a refusal into a "proceed anyway?" button. Editing the input WITHDRAWS a pending confirmation,
so a confirm can never be carried onto a value the operator was never shown.

⛔ **THE CLIENT SECRET IS OMITTED FROM THE BODY ENTIRELY WHEN THE BOX IS BLANK, not sent as
`''`.** `normaliseEntraInput` distinguishes keep (absent) from clear (empty string) by the body's
SHAPE, so sending `''` would silently wipe the stored secret on every unrelated save.

⛔ `shadowPresentation()` keeps three states and `clear` is the only one the panel is silent
about; anything missing or unrecognised fails closed to `unknown`, which is rendered as
unchecked and never as ok. `savedVsRunning()` compares VALUES, not configured-ness, so a secret
ROTATION is detected. Entra's pending-field sentence uses the API's own labels verbatim — the
field that matters is the secret, and that comparison happens server-side precisely so only its
label travels.

⛔ **`license` WAS GATED IN ONE PLACE AND NOT THE OTHER, and is now gated in both.** Its nav
button was filtered by `isSuperAdmin` while the `?tab=` allow-list admitted any admin, so
`/settings?tab=license` rendered the licence panel for someone who could never see the button —
the exact split that effect's own comment warns about, left behind on one tab. Found while
adding `sso`. A new super_admin-only tab belongs in BOTH the allow-list and its content block.
(lib) lib/redirectUri.ts — classifyRedirectUri. ⛔ ZERO IMPORTS, AND THAT IS THE POINT: it is shared by an API route and by a 'use client' Settings panel, and it lived in `lib/entraSettings.ts` first, which reaches `node:fs` through `envFile.ts`. A client component importing that drags the Node fs shim into the browser bundle — the same failure as importing `lib/directoryRefusals.ts` into a client component, which pulled in the whole pg driver and failed the Turbopack build with 6 errors. ⛔ ENTRA WILL NOT ACCEPT AN IP ADDRESS AS A REDIRECT URI AND EVERY INSTALL STARTS ON ONE (`NEXTAUTH_URL` is baked to the server address at install time), so the derived URI the panel shows is unregisterable until a hostname is set. ⛔ It also refuses non-loopback `http` (Entra requires https, with loopback the only exception — so a correct hostname still fails before the TLS cutover) and a single-label host. ⛔ It CLASSIFIES, it does not block: refusing to save a tenant id because the hostname is not ready would be an obstacle, not a guard.

## lib/tlsTransport.ts
Turning HTTPS on and off from Settings. `lib/tlsConfig.ts` answers "is this console encrypted"; this
answers "can I change that, and what happened when I did". Nothing here reimplements the cutover —
`installer/Enable-NocVaultTls.ps1` owns the work, gates and automatic revert.

- `TransportAction` / `TRANSPORT_ACTIONS` / `isTransportAction()` — `preview` | `enable` | `disable`.
- `TRANSPORT_TASK_NAME` — `NocVault-TlsTransport`. Its OWN task, never `NetVaultUpdate`: that one is
  registered permanently and deleting it as cleanup would remove a job the install must keep.
- `transportPaths(repoRoot)` — `logs/tls-transport.{log,lock}`, `logs/tls-transport-run.ps1`,
  `installer/Enable-NocVaultTls.ps1`. Beside the updater's own log, not a second convention.
- `validatePublicHost(raw)` — hostname allow-list; blank is valid and means "echo the browser's Host".
  ⛔ **AN IP IS REFUSED**: Entra will not accept one in a Redirect URI, so it can never be useful here.
  ⛔ The value is interpolated into a script a scheduled task runs **as SYSTEM**, so a character class
  wide enough to admit a quote or a semicolon is RCE as SYSTEM from a settings form.
- `psLiteral(v)` — PowerShell single-quoted literal, doubling quotes. Belt and braces behind the validator.
- `engineArgs(action, publicHost)` — the engine switches. `-TlsPublicHost` is never passed to `-Disable`.
- `buildWrapperScript(...)` — the file the task runs. A FILE, not a longer `schtasks /tr`: capturing the
  engine's output needs a redirect, which would mean three levels of quoting around a path with spaces.
  ⛔ The sentinel is written in `finally` **before** the lock removal and the task self-delete, so a
  failed cleanup can never cost us the verdict.
- `parseRunLog(text)` → `RunReport` with `outcome`: `none` | `running` | `previewed` | `enabled` |
  `disabled` | `reverted` | `unknown`.
  ⛔ **THE BANNER IS THE VERDICT, NOT THE EXIT CODE.** MEASURED on production twice on 2026-11-06:
  `Enable-NocVaultTls.ps1` exits **0** on a run that moved all four consoles, failed gate 3 and reverted
  everything. Reading the exit code reports "HTTPS enabled" to an administrator still on plain HTTP.
  ⛔ `reverted` is matched BEFORE `enabled`: "HTTPS was NOT enabled" contains "HTTPS".
  ⛔ `parseRunLog(null)` is `none` (no run ever happened); a READ ERROR is reported separately by the
  route and must never arrive here disguised as "nothing has happened".
- `transportCapability({platform, scriptPresent, terminator, runInProgress})` — which buttons are legal.
  ⛔ `terminator: 'unknown'` blocks BOTH directions; non-Windows blocks everything.
- `SUITE_PUBLIC_PORTS` — the four ports, NAMED in the confirmation. "This will move 4 consoles" is not
  something an administrator can check against their own install; the ports are.
- `destinationUrl({action, browserHost, publicHost, port})` — where to send the operator afterwards.
  The browser's own host by default, because a blank `TLS_PUBLIC_HOST` means the terminator echoes Host.

## lib/serviceRestart.ts
"Apply it now" for the settings that are inert until a service restarts (NEXTAUTH_URL, the
`ENTRA_*` values, a replaced certificate).
- `resolveRestartTarget(purpose, terminatorPresent)` — ⛔ **A CERTIFICATE IS NOT APPLIED BY RESTARTING
  THE APP.** NetVault never terminates TLS on this product; `NocVault-Tls` holds the certificate and
  reads it at ITS startup. The Certificate panel said "Restart the NetVault service to begin serving
  it" — text from before the terminator existed. Caught when a real wildcard certificate was installed
  on production 2026-11-06. With no terminator the answer is `service: null` — nothing to restart.
- `buildRestartWrapper({service, dependents, runId, ...})` — ⛔ **`dependents` IS WHAT MAKES A HUB
  RESTART RESTART ANYTHING** (the 1051 trap above). Captures the PID either side; the verdict is
  `running && changed && depsBack`. It RETRIES the start until the service runs, skipping a pending
  transition — not "even if the stop timed out", which is what the header used to claim and the loop
  has never done (a start fired at STOP_PENDING is rejected 1056/1061). An ABSENT service now ends
  the loop with one log line instead of 150 `sc.exe start` calls over 150 s. `runId` is the arm token
  (`lib/runLock.ts` `psArmGuard`) without which an orphaned task re-runs this unattended.
- `parseRestartLog(text)` — ⛔ `running=True` ALONE IS NOT SUCCESS; `changed=True` is the load-bearing
  half. Same family as `lib/tlsTransport.ts`: on this codebase a PowerShell exit code is evidence of
  nothing.

## lib/terminatorState.ts  (SERVER ONLY — spawns sc.exe)
One shared answer to "is the TLS front door there, and running", used by four routes.
- ⛔ `sc.exe` exit **1060** means the service does not exist — an ANSWER. Every other failure is
  `unknown`, with `present`/`running` as `null`, **never `false`**.
- `HUB_PUBLIC_PORT` (3000) — ⛔ **NOT `process.env.PORT`**: behind the terminator that is the LOOPBACK
  port, and reporting it as the address anyone connects to is the bug this module exists to stop.

### `lib/terminatorState.ts` (server only)
- `TERMINATOR_SERVICE`, `HUB_PUBLIC_PORT` — the front-door service name and the hub's PUBLIC port (never `process.env.PORT`, which is the loopback port behind a cutover).
- `readTerminatorState(): Promise<TerminatorReading>` — tri-state (`running`/`stopped`/`absent`/`unknown`); `present`/`running` are `null` on every unknown, NEVER `false`.
- `parseScQcDependencies(stdout): string[] | null` — reads `sc qc`'s dependency list INCLUDING its unlabelled continuation lines. `null` means no label was found at all (e.g. a localised Windows), which is not an empty list.
- `readingFromScQuery(stdout): TerminatorReading` — the stdout→reading mapping, split out of the spawn so it can be exercised. ⛔ `readTerminatorState` is now `return readingFromScQuery(stdout)` and nothing else: testing `parseScQueryState` alone would have repeated this codebase's worst regression of the family (a route COMPUTED `fronted`/`publicPort` while no panel read either, with five PASSING tests over the dead branch because they called the helper directly).
- `parseScQueryState(stdout): number | null` — the numeric service state (1 STOPPED … 4 RUNNING … 7 PAUSED) taken as the SECOND `<number> <WORD>` field in `sc query` output. ⛔ **ADDED 1.63.0 BECAUSE THE WHOLE HTTPS TAB WAS DEAD ON A NON-ENGLISH HOST.** `readTerminatorState` keyed on the English state WORDS while `parseScQcDependencies` twenty lines below was hardened against localised field names in the same commit — so on a German or French Windows every reading was `unknown`, and `transportCapability` turns `unknown` into "blocked in both directions", disabling enable, disable AND Preview permanently. The English regexes are kept as a fast path so nothing changes where they already worked.
- `terminatorDependsOn(service): Promise<DependencyReading>` — `dependsOn: boolean | null`. ⛔ The two callers resolve `null` OPPOSITELY on purpose: an updater assumes it DOES depend (guessing wrong there corrupts a build), the restart button assumes it does NOT (guessing wrong there is a four-console outage).
- `serviceExists(name): Promise<boolean | null>` — tri-state. Replaced a boolean version that returned `false` for non-Windows and for ANY exception.

### `lib/serviceRestart.ts` additions
- `RESTART_RUN_PREFIX`, `buildRestartHeader(runId, service)` — the ROUTE writes this header and truncates the log before scheduling, so a panel can never read the previous run's verdict as this run's.
- `parseRestartLog` now returns `runId`, and requires `running=True` AND `changed=True` AND no `dependent <x> back: False`. ⛔ That `depsFailed` term was UNREACHABLE on the only path where dependents exist until 1.63.0, because `RestartControl` reached `done` on a bare uptime proof before the wrapper had brought the front door back — see components.md.
- `RESTART_SERVICE` was REMOVED: an alias of `HUB_SERVICE` "kept for callers that only ever meant the hub", with none — i.e. an inviting second name for the one fact `resolveRestartTarget` exists to be careful about.

### `lib/tlsTransport.ts` changes
- `RunOutcome` gained `refused` — the engine stopped BEFORE moving anything, distinct from `reverted` (moved, then put back). Conflating them made a failing Preview claim a cutover-and-rollback that never happened.
- ⛔ **`HTTPS was NOT enabled` NOW MAPS TO `refused`, NOT `reverted` (1.63.0).** That closing banner is printed whenever `$script:TlsCutoverApplied` is false — INCLUDING when the gates never passed and nothing was touched (`NocVault-TlsCutover.ps1`'s `if (-not $TlsGateOk)` branch) — and `Gates did NOT pass` only ever appears on the `-DryRun` branch. So a REAL enable with failing gates could not reach `refused` at all: every one of them rendered `reverted`'s copy, which promises the engine "put every console back the way it found it". `REVERTING the TLS cutover` (written only by `Undo-TlsCutover`) promotes `refused` → `reverted`, which is the only evidence consoles were actually moved.
- `buildWrapperScript` now takes `runId` and emits `psArmGuard` + a per-line lock heartbeat.
- `parseRunLog` scans banners from the END of the log (the documented rule; the old loop let pattern order outrank chronology) and disqualifies a `disabled` verdict on a non-zero exit.

### `lib/suiteProbe.ts` (NEW, 1.64.2)
- `probeStatus(url, fetchImpl?, timeoutMs?)` → `'Healthy' | 'Warning' | 'Unavailable'`, and
  `probeJson(url, fetchImpl?, timeoutMs?)` → parsed body or `null`. Plus `PROBE_TIMEOUT_MS`,
  `PROBE_ATTEMPTS`, `AppStatus`, `FetchLike`.
- Extracted so `app/api/suite/health` and `app/api/suite/stats` cannot drift apart: both had
  their own copy of a 3000 ms single-shot probe whose `catch` returned one value for every
  kind of failure.
- ⛔ **A TIMEOUT IS NOT A DEAD APP.** `probeStatus` reports a timeout as `Warning` and only a
  real connection failure as `Unavailable` — the launcher escalates any `Unavailable` to
  overall "Critical". Measured 2026-11-09: SpanVault's own request log showed the probe
  arriving and being answered in 7-8 ms at the exact second the launcher drew it
  "Unavailable". The discriminator is `controller.signal.aborted`, **not** `err.name`, which
  is not consistent across runtimes.
- A non-2xx is an ANSWER and is never retried; only the failure to get one is.
- `timeoutMs` exists for the tests (`tests/suiteProbe.test.ts`) — production callers omit it.
