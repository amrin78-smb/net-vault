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
  getUserApps(userId, role) — resolve apps a user can access (fail-closed on DB error)
  canAccessApp(apps, slug) — check slug allowed (netvault always true)

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
  resolveOrigin(req, port, legacyFallback) — derive request origin (host/proto) for cross-app SSO redirect targets
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
