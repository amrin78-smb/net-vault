-- ================================================================
-- NetVault — Complete Schema
-- Run this on a fresh database before importing data
-- Safe to re-run — all statements use IF NOT EXISTS / IF EXISTS
-- ================================================================

-- ── Regions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS regions (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- ── Countries ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS countries (
    id        SERIAL PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    iso_code  TEXT,
    region_id INTEGER REFERENCES regions(id)
);

-- ── Sites ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    code          TEXT,
    country_id    INTEGER REFERENCES countries(id),
    address       TEXT,
    city          TEXT,
    postal_code   TEXT,
    coordinates   TEXT,
    site_type     TEXT,
    phone         TEXT,
    contact_name  TEXT,
    contact_email TEXT,
    site_status   TEXT NOT NULL DEFAULT 'Active'
);

-- ── Brands ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- ── Device Types ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_types (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- ── Vendors ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT
);

-- ── Devices ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id                 SERIAL PRIMARY KEY,
    name               TEXT,
    brand_id           INTEGER REFERENCES brands(id),
    model              TEXT,
    serial_number      TEXT,
    device_type_id     INTEGER REFERENCES device_types(id),
    ip_address         INET,
    mgmt_protocol      TEXT,
    mgmt_url           TEXT,
    site_id            INTEGER REFERENCES sites(id),
    location_detail    TEXT,
    lifecycle_status   TEXT DEFAULT 'Unknown',
    device_status      TEXT DEFAULT 'Active',
    risk_score         INTEGER,
    technical_debt     NUMERIC(12,2),
    remark             TEXT,
    cost               NUMERIC(12,2),
    purchase_date      DATE,
    purchase_vendor_id INTEGER REFERENCES vendors(id),
    ma_vendor_id       INTEGER REFERENCES vendors(id),
    support_vendor_id  INTEGER REFERENCES vendors(id),
    created_by         INTEGER,
    updated_by         INTEGER,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    os_type            TEXT,
    os_version         TEXT,
    os_eol_date        DATE
);

-- Partial unique index on serial number (allows NULLs and empty strings)
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_serial_unique
    ON devices (serial_number)
    WHERE serial_number IS NOT NULL AND serial_number != '';

-- ── Users ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'super_admin', 'site_admin', 'viewer')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── User Site Assignments ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sites (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
);

-- ── User App Access ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_apps (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app     TEXT    NOT NULL,
    PRIMARY KEY (user_id, app)
);

-- ── Circuits ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS circuits (
    id               SERIAL PRIMARY KEY,
    site_id          INTEGER REFERENCES sites(id),
    site_name_raw    TEXT,
    it_owner         TEXT,
    city             TEXT,
    address          TEXT,
    isp              TEXT,
    usage            TEXT,
    circuit_id       TEXT,
    product          TEXT,
    technology       TEXT,
    circuit_type     TEXT,
    interface        TEXT,
    max_speed        TEXT,
    guaranteed_speed TEXT,
    public_subnet    TEXT,
    currency         TEXT DEFAULT 'THB',
    cost_month       NUMERIC(12,2),
    contract_term    TEXT,
    comment          TEXT,
    pingable         TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Audit Log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          SERIAL PRIMARY KEY,
    device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    field_name  TEXT,
    old_value   TEXT,
    new_value   TEXT,
    changed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Health Score History ─────────────────────────────────────────
-- Daily snapshots of the infrastructure health score, powering the
-- month-over-month trend on the dashboard. Pruned to the last 90 days
-- by the snapshot job (/api/system/health-snapshot).
CREATE TABLE IF NOT EXISTS health_score_history (
    id               SERIAL PRIMARY KEY,
    score            INTEGER NOT NULL,
    grade            CHAR(1) NOT NULL,
    healthy_devices  INTEGER,
    eol_assets       INTEGER,
    sites_at_risk    INTEGER,
    compliance_score INTEGER,
    calculated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_score_history_date
    ON health_score_history (calculated_at DESC);

-- ── EOL Intelligence ─────────────────────────────────────────────
-- Backs the "EOL Intelligence" admin feature. These mirror the runtime
-- self-heal in lib/eolEnrich.ts (ensureEolSchema) so a fresh install and an
-- existing install converge on the same shape.

-- Curated EOL/EOS seed (migrated from the legacy hardcoded lib/eolSeed.ts
-- array on first run; grows by curation via the admin UI).
CREATE TABLE IF NOT EXISTS eol_seed (
    id               SERIAL PRIMARY KEY,
    vendor           TEXT NOT NULL,
    model_raw        TEXT NOT NULL,
    model_normalized TEXT NOT NULL,
    aliases          TEXT[] DEFAULT '{}',
    eol_date         DATE,
    eos_date         DATE,
    source_url       TEXT,
    confidence       TEXT DEFAULT 'high',
    added_by         TEXT DEFAULT 'system',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eol_seed_normalized ON eol_seed (model_normalized);

-- Background enrichment job runs (one row per run; status + progress + summary).
CREATE TABLE IF NOT EXISTS eol_enrichment_jobs (
    id            SERIAL PRIMARY KEY,
    status        TEXT DEFAULT 'pending',
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    scanned       INT DEFAULT 0,
    matched       INT DEFAULT 0,
    written       INT DEFAULT 0,
    discrepancies INT DEFAULT 0,
    unmatched_top JSONB,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_eol_jobs_status ON eol_enrichment_jobs (status);
CREATE INDEX IF NOT EXISTS idx_eol_jobs_id_desc ON eol_enrichment_jobs (id DESC);
-- At most ONE running job at a time. Guards the check-then-insert race in the
-- enrich-eol POST handler (a concurrent insert raises 23505, which the handler
-- catches and treats as a reuse of the in-flight job).
CREATE UNIQUE INDEX IF NOT EXISTS eol_jobs_one_running ON eol_enrichment_jobs (status) WHERE status = 'running';

-- Conflicts between a manually-set EOL/EOS date and the curated seed date.
CREATE TABLE IF NOT EXISTS eol_discrepancies (
    id              SERIAL PRIMARY KEY,
    device_id       INTEGER,  -- FK to devices(id) enforced at runtime (lib/eolEnrich); INTEGER to match this schema's SERIAL devices.id
    device_name     TEXT,
    model           TEXT,
    manual_date     DATE,
    seed_date       DATE,
    difference_days INT,
    seed_entry_id   INT REFERENCES eol_seed(id),
    status          TEXT DEFAULT 'pending',
    resolved_by     TEXT,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eol_discrepancies_status ON eol_discrepancies (status);

-- Status recommendations: high-confidence lifecycle_status corrections the
-- enrichment engine derives from the curated seed (e.g. an active device whose
-- vendor EOL date has passed, or an EOL device the vendor still supports).
CREATE TABLE IF NOT EXISTS eol_recommendations (
    id                 SERIAL PRIMARY KEY,
    device_id          INTEGER,  -- FK to devices(id) enforced at runtime (lib/eolEnrich); INTEGER to match this schema's SERIAL devices.id
    device_name        TEXT,
    model              TEXT,
    current_status     TEXT,
    recommended_status TEXT,
    reason             TEXT,
    seed_eol_date      DATE,
    seed_eos_date      DATE,
    seed_entry_id      INT REFERENCES eol_seed(id),
    confidence         TEXT DEFAULT 'high',
    status             TEXT DEFAULT 'pending',
    reviewed_by        TEXT,
    reviewed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eol_recommendations_status ON eol_recommendations (status);

-- pg_trgm powers fuzzy (similarity) matching in the enrichment engine. If the
-- DB role lacks CREATE EXTENSION the engine degrades to exact+alias matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── App Settings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Seed default branding settings
INSERT INTO app_settings (key, value) VALUES ('app_name',          'NetVault')                     ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('app_subtitle',      'Network Intelligence Platform') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('app_logo_url',      '')                              ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('app_primary_color', '#C8102E')                       ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('app_navy_color',    '#1a2744')                       ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('idle_timeout_minutes', '30')                          ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('install_date',   NOW()::date::text)                   ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('license_key',    '')                                  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('license_status', 'trial')                             ON CONFLICT (key) DO NOTHING;

-- ── Agent registry (NocVault Agents Phase 2 — hub control plane) ──
-- The hub owns the canonical fleet registry; the data plane never touches
-- these tables. `agents` MUST be created before the tables that reference it.
-- NOTE: agents.site_id is a PLAIN INT soft-reference to sites.id (resolve via
-- join at read time) — deliberately NOT a hard FK, to avoid fresh-install DDL
-- ordering coupling to the sites table. These tables hold no secret columns
-- (token_hash is a sha256 hash, cert_fpr a fingerprint), so they are readable
-- by the diagnostic readonly roles with no column exclusion.
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,             -- agt_… (opaque)
    name          TEXT NOT NULL,
    hostname      TEXT,
    os            TEXT,
    local_ip      TEXT,
    site_id       INT,                          -- soft ref → sites.id (no FK)
    status        TEXT NOT NULL DEFAULT 'pending', -- pending|online|degraded|offline|revoked
    agent_version TEXT,
    cert_fpr      TEXT,                          -- pinned identity fingerprint
    enrolled_at   TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ,
    created_by    INT,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_enrollment_tokens (
    token_hash    TEXT PRIMARY KEY,             -- sha256 hash of the one-time token, never the token
    created_by    INT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    preset        JSONB NOT NULL DEFAULT '{}',  -- {site_id, modules:[…]} applied on redeem
    used_at       TIMESTAMPTZ,
    used_by       TEXT REFERENCES agents(id) ON DELETE SET NULL,
    note          TEXT
);

CREATE TABLE IF NOT EXISTS agent_modules (
    agent_id      TEXT REFERENCES agents(id) ON DELETE CASCADE,
    app           TEXT NOT NULL,                -- module slug; SHORT form is canonical ('span'/'ddi'), long form ('spanvault'/'ddivault') also accepted
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    config        JSONB NOT NULL DEFAULT '{}',  -- module work-plan
    PRIMARY KEY (agent_id, app)
);

CREATE TABLE IF NOT EXISTS agent_health (       -- small rolling history for the fleet view
    id            BIGSERIAL PRIMARY KEY,
    agent_id      TEXT REFERENCES agents(id) ON DELETE CASCADE,
    ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_pct       REAL,
    mem_pct       REAL,
    buffer_depth  INT,
    module_status JSONB                          -- {spanvault:'ok', ddivault:'auth_error', …}
);
CREATE INDEX IF NOT EXISTS idx_agent_health_agent_ts ON agent_health(agent_id, ts DESC);

-- Log return-path columns on `agents` (Phase 4a). The hub has no server→agent
-- socket, so a get_logs command's result comes back as a POST from the agent to
-- /api/agents/[id]/logs, which stashes the tail here for the fleet page to read.
-- ALTER … IF NOT EXISTS is idempotent: adds the columns on existing installs and
-- is a no-op on a fresh one (agents is created just above). Neither is secret.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_logs    JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_logs_at TIMESTAMPTZ;

-- Poll-carried command channel (Phase 4a). The hub↔agent link is an HTTP poll
-- with NO server→agent socket, so a command is QUEUED here (status='pending'),
-- carried back in the agent's next heartbeat RESPONSE (then 'delivered'), and the
-- agent executes it — restart implicitly acks on its next beat, get_logs acks by
-- POSTing its tail (which marks the row 'done'). References agents(id), created
-- just above, so no fresh-install forward-ref.
CREATE TABLE IF NOT EXISTS agent_commands (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,                   -- 'restart' | 'get_logs'
    args         JSONB NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|done
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    done_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_commands_agent_status ON agent_commands(agent_id, status);

-- Grant the diagnostic read role explicitly. The netvault app role and
-- nocvault_readonly are covered by the blanket grants in the Permissions
-- block at the tail (GRANT ALL / GRANT SELECT ON ALL TABLES), but
-- claude_readonly has no blanket grant there — only per-table REVOKEs on the
-- secret tables — so it needs an explicit SELECT here. No-op if the role is
-- absent (standalone / non-diagnostic installs). agent_commands holds no secret
-- columns (queued instruction type + args), so it is granted alongside the rest.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
        GRANT SELECT ON agents, agent_enrollment_tokens, agent_modules, agent_health, agent_commands TO claude_readonly;
    END IF;
END
$$;

-- ── Safe migrations for existing installs ────────────────────────
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS purchase_vendor_id      INTEGER REFERENCES vendors(id);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS ma_vendor_id            INTEGER REFERENCES vendors(id);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS purchase_date           DATE;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS support_contract_number TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS support_start_date      DATE;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS support_end_date        DATE;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS support_vendor_id       INTEGER REFERENCES vendors(id);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS support_cost            NUMERIC(12,2);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS support_currency        TEXT DEFAULT 'THB';
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS cost               NUMERIC(12,2);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS mgmt_protocol      TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS mgmt_url           TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS location_detail    TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS risk_score         INTEGER;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS technical_debt     NUMERIC(12,2);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS remark             TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE sites    ADD COLUMN IF NOT EXISTS site_status        TEXT NOT NULL DEFAULT 'Active';
ALTER TABLE circuits ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE users    ADD COLUMN IF NOT EXISTS password_hash      TEXT;
-- ── MFA (TOTP second factor) ─────────────────────────────────────
-- The hub is the only place in the suite that verifies a password (the
-- satellites redeem a hub-signed SSO token and have no password path of their
-- own since logvault 2.31.11 / ddivault 1.30.1), so these columns cover all
-- four apps.
--
-- mfa_secret is ENCRYPTED (AES-256-GCM, key derived from NEXTAUTH_SECRET — see
-- lib/mfa.ts). It is also invisible to claude_readonly/nocvault_readonly without
-- any extra grant here, because users_public further down is an explicit COLUMN
-- ALLOWLIST — a new users column is hidden by default. Do not "helpfully" widen
-- that view to SELECT *.
--
-- mfa_last_step stores the last TOTP step accepted for this account: a code is
-- valid across a ±1-step drift window (~90s), so without recording it a code
-- seen once can be replayed inside that window.
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mfa_secret          TEXT;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mfa_enrolled_at     TIMESTAMPTZ;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mfa_last_step       BIGINT;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mfa_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mfa_locked_until    TIMESTAMPTZ;

-- Backup codes: the recovery path when the authenticator device is lost.
-- Deliberately placed AFTER the users table exists (created near the top of this
-- file) — a FK naming a table defined later aborts a fresh install under
-- ON_ERROR_STOP while re-running against an existing DB looks fine.
--
-- HASHED with bcrypt, not encrypted: we only ever compare, never read them back,
-- and hashing means they survive a NEXTAUTH_SECRET rotation that would render
-- every encrypted mfa_secret unreadable. That keeps a real way back in.
CREATE TABLE IF NOT EXISTS user_mfa_backup_codes (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON user_mfa_backup_codes(user_id) WHERE used_at IS NULL;

-- Which roles MUST have MFA. JSON array of role names, e.g. ["super_admin"].
-- Empty (the default) = nobody is forced, everyone may still opt in. Enforcing a
-- role before anyone in it has enrolled locks those users out, and the only way
-- back is psql — so this ships empty and is turned on deliberately.
INSERT INTO app_settings (key, value) VALUES ('mfa_required_roles', '[]') ON CONFLICT (key) DO NOTHING;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS os_type            TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS os_version         TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS os_eol_date        DATE;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS eol_source         TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS eol_confidence     TEXT;
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS eol_enriched_at    TIMESTAMPTZ;

-- Retype eol_* device_id from UUID -> INTEGER on existing SERIAL installs (empty/unused there).
-- Guarded so it ONLY runs when this DB's devices.id is integer (never touches a true UUID-variant DB).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='id' AND data_type IN ('integer','bigint')) THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eol_discrepancies' AND column_name='device_id' AND data_type='uuid') THEN
      ALTER TABLE eol_discrepancies   ALTER COLUMN device_id TYPE INTEGER USING NULL::integer;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eol_recommendations' AND column_name='device_id' AND data_type='uuid') THEN
      ALTER TABLE eol_recommendations ALTER COLUMN device_id TYPE INTEGER USING NULL::integer;
    END IF;
  END IF;
END
$$;

-- Fix role constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'super_admin', 'site_admin', 'viewer'));

-- ── v_devices_flat View ──────────────────────────────────────────
-- Created AFTER the safe-migration ALTERs above so every column it selects
-- (mgmt_*, location_detail, risk_score, technical_debt, remark, cost,
-- support_*, os_*) exists on a fresh DB before the view is defined.
CREATE OR REPLACE VIEW v_devices_flat AS
SELECT
    d.id,
    d.name,
    d.model,
    d.serial_number,
    SPLIT_PART(d.ip_address::text, '/', 1) AS ip_address,
    d.mgmt_protocol,
    d.mgmt_url,
    d.location_detail,
    d.lifecycle_status,
    d.device_status,
    d.risk_score,
    d.technical_debt,
    d.remark,
    d.cost,
    d.purchase_date,
    d.created_at,
    d.updated_at,
    d.site_id,
    b.name  AS brand,
    dt.name AS device_type,
    s.name  AS site,
    s.code  AS site_code,
    c.name  AS country,
    c.iso_code,
    r.name  AS region,
    pv.name AS purchase_vendor,
    mv.name AS ma_vendor,
    sv.name AS support_vendor,
    d.support_contract_number,
    d.support_start_date,
    d.support_end_date,
    d.support_cost,
    d.support_currency,
    d.os_type,
    d.os_version,
    d.os_eol_date
FROM devices d
LEFT JOIN brands       b  ON b.id  = d.brand_id
LEFT JOIN device_types dt ON dt.id = d.device_type_id
LEFT JOIN sites        s  ON s.id  = d.site_id
LEFT JOIN countries    c  ON c.id  = s.country_id
LEFT JOIN regions      r  ON r.id  = c.region_id
LEFT JOIN vendors      pv ON pv.id = d.purchase_vendor_id
LEFT JOIN vendors      mv ON mv.id = d.ma_vendor_id
LEFT JOIN vendors      sv ON sv.id = d.support_vendor_id;

-- ── Permissions ──────────────────────────────────────────────────
-- Runs AFTER the view block so the view is reassigned to netvault too.
-- The installer applies this file as the postgres superuser, so without
-- this every object would be owned by postgres and the app's runtime DDL
-- ("must be owner of table devices") would fail.
DO $$
DECLARE r RECORD;
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'netvault') THEN
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO netvault;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO netvault;
        GRANT SELECT ON v_devices_flat TO netvault;
        -- Only reassign objects not already owned by netvault. This skips
        -- already-correct objects on a re-apply and, crucially, never tries to
        -- reassign a foreign (non-app / non-extension) object that may land in
        -- public — which would otherwise abort the whole schema re-apply.
        FOR r IN SELECT tablename    FROM pg_tables    WHERE schemaname='public' AND tableowner    <> 'netvault' LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO netvault', r.tablename);
        END LOOP;
        FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' AND sequenceowner <> 'netvault' LOOP
            EXECUTE format('ALTER SEQUENCE public.%I OWNER TO netvault', r.sequencename);
        END LOOP;
        FOR r IN SELECT viewname     FROM pg_views     WHERE schemaname='public' AND viewowner     <> 'netvault' LOOP
            EXECUTE format('ALTER VIEW public.%I OWNER TO netvault', r.viewname);
        END LOOP;
        GRANT CREATE ON SCHEMA public TO netvault;
    END IF;
END
$$;

-- ── Hub cross-DB read role ───────────────────────────────────────
-- The Hub reads across all suite DBs via the shared `nocvault_readonly`
-- role. The installer grants it SELECT once, but the app creates tables
-- at RUNTIME as the netvault role (e.g. eolEnrich's eol_seed,
-- eol_enrichment_jobs, eol_discrepancies, eol_recommendations) which that
-- one-time grant never covers — and the updater re-applies this file but
-- not the installer's grant. Re-granting here makes both installer and
-- updater converge, and ALTER DEFAULT PRIVILEGES auto-covers future
-- netvault-created tables. No-op on a standalone netvault (no role).
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
        GRANT USAGE ON SCHEMA public TO nocvault_readonly;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocvault_readonly;
        ALTER DEFAULT PRIVILEGES FOR ROLE netvault IN SCHEMA public GRANT SELECT ON TABLES TO nocvault_readonly;
    END IF;
END
$$;

-- ── Secret-bearing table row/column-level exclusion (security pass, 2026-07;
--    CORRECTED 2026-07-23 — see below) ──────────────────────────────────────
-- The blanket grant above previously gave nocvault_readonly/claude_readonly
-- unrestricted table-level SELECT on `users` (password_hash) and
-- `app_settings` (value holds license_key alongside plain cosmetic settings)
-- — live-verified readable. `users_public`/`app_settings_public` are
-- ALLOWLIST views: a newly added users column or app_settings key defaults
-- to HIDDEN from these two roles until deliberately added below, so a future
-- secret can never leak by omission. Placed AFTER the blanket grant block —
-- order matters, the LAST statement touching a privilege wins (see LogVault/
-- SpanVault CLAUDE.md for the incident that made this ordering rule explicit).
--
-- CORRECTED 2026-07-23: the original 2026-07 fix was broken and never
-- actually took effect. `app_settings_public` selected an `updated_at` column
-- that does not exist on NetVault's `app_settings` table (`key TEXT PRIMARY
-- KEY, value TEXT` — copy-pasted from LogVault/DDIVault, whose app_settings
-- genuinely has that column). That CREATE VIEW failed at apply time, and
-- because `psql -f schema.sql` was not run with ON_ERROR_STOP, the script
-- printed the error and kept going into the REVOKE/GRANT DO block below —
-- which ALSO referenced the never-created app_settings_public, so its own
-- GRANT failed, which aborted the ENTIRE DO block atomically (both the
-- users AND app_settings REVOKE/GRANT, and both roles) — silently leaving
-- BOTH tables fully exposed to nocvault_readonly/claude_readonly exactly as
-- before, live-verified via `information_schema.role_table_grants`. Fixed by
-- (a) dropping the nonexistent `updated_at` column from the view, and
-- (b) splitting the single two-table DO block into one independent DO block
-- PER TABLE, each with its own EXCEPTION handler that RAISE WARNINGs loudly
-- instead of silently swallowing a failure — so a future mistake in one
-- table's block can no longer take down the other table's fix, and can no
-- longer vanish unnoticed even without ON_ERROR_STOP (which the invoking
-- scripts now also pass — see installer/Update-NetVault.ps1).
CREATE OR REPLACE VIEW users_public AS
SELECT id, name, email, role, created_at FROM users;

CREATE OR REPLACE VIEW app_settings_public AS
SELECT key, value FROM app_settings
WHERE key IN ('app_name', 'app_subtitle', 'app_logo_url', 'app_navy_color', 'app_primary_color');

-- users: independent of app_settings' block below — a failure here cannot
-- prevent (or be prevented by) app_settings' REVOKE/GRANT.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    REVOKE SELECT ON users FROM nocvault_readonly;
    GRANT SELECT ON users_public TO nocvault_readonly;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE SELECT ON users FROM claude_readonly;
    GRANT SELECT ON users_public TO claude_readonly;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'SECURITY: users_public REVOKE/GRANT for nocvault_readonly/claude_readonly FAILED (%). users.password_hash may still be exposed to those roles — investigate and re-run this schema file immediately.', SQLERRM;
END
$$;

-- user_mfa_backup_codes: independent of the blocks around it.
--
-- code_hash is a CREDENTIAL hash, the same category as users.password_hash
-- immediately above, and the blanket GRANT SELECT ON ALL TABLES earlier in the
-- Permissions section covers this table (it is created well before that grant
-- runs). Without this REVOKE both diagnostic roles can read every backup-code
-- hash — verified readable on the live DB and on a from-scratch install before
-- this block existed.
--
-- Practical risk is lower than password_hash (codes are 56 bits of
-- crypto.randomBytes under bcrypt, not user-chosen), which is exactly why it
-- was easy to miss. It is excluded anyway: the rule is that a new
-- secret-bearing column is never covered by precedent, and one credential-hash
-- column readable while the one beside it is revoked is the inconsistency that
-- makes the model unreviewable.
--
-- No _public view counterpart: nothing reads this table diagnostically, so a
-- plain REVOKE is the whole fix.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    REVOKE SELECT ON user_mfa_backup_codes FROM nocvault_readonly;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE SELECT ON user_mfa_backup_codes FROM claude_readonly;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'SECURITY: user_mfa_backup_codes REVOKE for nocvault_readonly/claude_readonly FAILED (%). MFA backup-code hashes may still be exposed to those roles — investigate and re-run this schema file immediately.', SQLERRM;
END
$$;

-- app_settings: independent of users' block above.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    REVOKE SELECT ON app_settings FROM nocvault_readonly;
    GRANT SELECT ON app_settings_public TO nocvault_readonly;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE SELECT ON app_settings FROM claude_readonly;
    GRANT SELECT ON app_settings_public TO claude_readonly;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'SECURITY: app_settings_public REVOKE/GRANT for nocvault_readonly/claude_readonly FAILED (%). app_settings.value (incl. license_key) may still be exposed to those roles — investigate and re-run this schema file immediately.', SQLERRM;
END
$$;

-- ── OS EOL de-duplication (2026-08, one-time but idempotent) ────────────────
-- devices.os_eol_date is meant to hold a SOFTWARE/OS end-of-life that a vendor
-- publishes SEPARATELY from hardware support-end (lib/eolFeed.ts: "eol_seed.
-- eol_date = software/OS EOL; eol_seed.eos_date = hardware support-end").
--
-- Two catalog rows had the hardware Last-Date-of-Support written into BOTH
-- fields, so enrichment stamped an "OS EOL" onto 39 devices that have no OS
-- type and no OS version recorded — NetVault collects neither today (0 of 2482
-- devices carry either). Those devices then appeared on the EOL report's
-- "Software EOL" tab AND the Hardware tab, double-counting the same expiry.
--
-- Both statements are deliberately SELF-LIMITING rather than a blanket wipe:
-- they only clear a date that DUPLICATES the hardware date, so a genuinely
-- distinct OS EOL (the 34 Allied Telesis models in the catalog carry real
-- 3-year gaps) is never touched. Safe to re-run on every deploy, which is the
-- point — enrichment only ever writes os_eol_date, never clears it, so without
-- this the stale values would survive the catalog fix indefinitely.
UPDATE devices
   SET os_eol_date = NULL
 WHERE os_eol_date IS NOT NULL
   AND eol_source = 'seed'
   AND support_end_date IS NOT NULL
   AND os_eol_date = support_end_date
   AND (os_version IS NULL OR os_version = '')
   AND (os_type IS NULL OR os_type = '');

-- Same rule at the source, so re-enrichment cannot re-apply it. Scoped to rows
-- where the two dates are identical; a curator entering a real, distinct OS EOL
-- is unaffected.
UPDATE eol_seed
   SET eol_date = NULL
 WHERE eol_date IS NOT NULL
   AND eos_date IS NOT NULL
   AND eol_date = eos_date;

-- ── AIR-CAP2602E support-end correction (2026-08, idempotent) ──────────────
-- The bundled catalog carried support_end_date 2022-09-30 for this SKU with NO
-- source. Cisco's own bulletin for the series (EOL11045 / c51-737512) prints
-- Last Date of Support 2021-12-31, and 2022-09-30 appears nowhere in it. Two
-- other catalog entries covering the same hardware already said 2021-12-31;
-- the wrong one won because it matches the full SKU exactly while the sourced
-- series entry matches the shorter PID.
--
-- Fixed upstream in nocvault-eol and regenerated into lib/eolSeed.ts, but that
-- alone does NOT reach an existing install: migrateLegacySeed only fills rows
-- whose dates are BOTH null, so a row already carrying the wrong date is never
-- updated by it. Hence this statement.
--
-- Guarded on the exact wrong value, so it fires once and is a no-op forever
-- after — and cannot touch a row a curator has since set to anything else.
-- Devices pick the corrected date up on the next enrichment run, because
-- enrichDevices overwrites a value whose eol_source is already 'seed'.
UPDATE eol_seed
   SET eos_date   = DATE '2021-12-31',
       source_url = COALESCE(source_url, 'https://www.cisco.com/c/en/us/products/collateral/wireless/aironet-2600-series/eos-eol-notice-c51-737512.html'),
       updated_at = NOW()
 WHERE model_raw = 'AIR-CAP2602E-E-K9'
   AND eos_date = DATE '2022-09-30';
