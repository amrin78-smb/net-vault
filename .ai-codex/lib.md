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

suiteDb.ts
  SuiteDb (type) — 'netvault' | 'logvault' | 'ddivault' | 'spanvault'
  suiteReadConfigured() — whether cross-DB readonly credentials are set [SENSITIVE]
  queryDb(db, sql, params) — SELECT-only query against a sibling suite DB via nocvault_readonly role [SENSITIVE]
  queryOne(db, sql, params) — scalar convenience wrapper over queryDb (first row or null) [SENSITIVE]

techDebt.ts
  calcTechnicalDebt(lifecycleStatus, deviceStatus, deviceType) — estimate $ replacement cost for an active EOL device

theme.ts
  Theme (type) — 'light' | 'dark'
  THEME_KEY — const localStorage key
  getTheme() — read current theme from document data-theme attribute
  applyTheme(theme) — set data-theme, persist to localStorage, dispatch sync event
  toggleTheme() — flip and apply light/dark theme
  THEME_INIT_SCRIPT — const inline <script> body for no-flash theme init before paint
