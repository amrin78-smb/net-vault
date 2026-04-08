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
    created_by         INTEGER,
    updated_by         INTEGER,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
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

-- ── v_devices_flat View ──────────────────────────────────────────
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
    mv.name AS ma_vendor
FROM devices d
LEFT JOIN brands       b  ON b.id  = d.brand_id
LEFT JOIN device_types dt ON dt.id = d.device_type_id
LEFT JOIN sites        s  ON s.id  = d.site_id
LEFT JOIN countries    c  ON c.id  = s.country_id
LEFT JOIN regions      r  ON r.id  = c.region_id
LEFT JOIN vendors      pv ON pv.id = d.purchase_vendor_id
LEFT JOIN vendors      mv ON mv.id = d.ma_vendor_id;

-- ── Safe migrations for existing installs ────────────────────────
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS purchase_vendor_id INTEGER REFERENCES vendors(id);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS ma_vendor_id       INTEGER REFERENCES vendors(id);
ALTER TABLE devices  ADD COLUMN IF NOT EXISTS purchase_date      DATE;
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

-- Fix role constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'super_admin', 'site_admin', 'viewer'));

-- ── Permissions ──────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'netvault') THEN
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO netvault;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO netvault;
        GRANT SELECT ON v_devices_flat TO netvault;
    END IF;
END
$$;
