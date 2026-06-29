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
        FOR r IN SELECT tablename    FROM pg_tables    WHERE schemaname='public' LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO netvault', r.tablename);
        END LOOP;
        FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
            EXECUTE format('ALTER SEQUENCE public.%I OWNER TO netvault', r.sequencename);
        END LOOP;
        FOR r IN SELECT viewname     FROM pg_views     WHERE schemaname='public' LOOP
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
