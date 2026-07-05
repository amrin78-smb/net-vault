#!/usr/bin/env node
/*
 * NetVault — DEMO DATA seed script  (shared-contract edition)
 * -----------------------------------------------------------
 * Populates realistic demo inventory for the NocVault shared demo scenario
 * (org "Cahaya Teknologi Sdn Bhd", sites KL-HQ / PEN / JB) so the NetVault
 * dashboards, devices table, and EOL / Risk report all render with data —
 * plus a per-day health-score trend so the dashboard month-over-month chart
 * renders too.
 *
 * This is the installer-bundled seed that follows the SHARED SEED CONTRACT
 * used by all four NocVault app seeds. It is adapted from the original
 * netvault/demo-seed.js (same inventory + upsert logic).
 *
 * SAFETY
 *  - Only touches inventory/reference tables: regions, countries, sites,
 *    brands, device_types, vendors, devices, circuits — plus the demo
 *    health-score trend table health_score_history.
 *  - NEVER touches users / user_sites / app_settings / audit_log / session
 *    or any auth table — login + settings stay intact.
 *  - Idempotent: re-running upserts (lookup tables by their UNIQUE key,
 *    devices by serial_number, sites/circuits by their demo natural key);
 *    the health trend rows for the seeded window are replaced, not duplicated.
 *  - RESET=1 (default) deletes ONLY the demo tables above before reseeding.
 *
 * CONFIG (env vars — names + defaults):
 *   PGHOST=localhost  PGPORT=5432  PGUSER=postgres  PGPASSWORD=(required, no default)
 *   PGDATABASE=netvault
 *   DAYS=14      history window in days (health trend + device created/updated spread)
 *   VOLUME=normal   light x0.4 | normal x1 | heavy x2.5  (scales variable-volume data)
 *   RESET=1      wipe demo tables before reseeding
 *
 * NOTE: `pg` is resolved at runtime via NODE_PATH set by the installer launcher —
 * do NOT hardcode a module path.
 */

const { Client } = require('pg');

// ── Config from env ────────────────────────────────────────────────────────
// PGPASSWORD intentionally has NO baked default/literal — if unset we let pg try
// (it may pick up ~/.pgpass / peer auth) but we never ship a hardcoded secret.
const client = new Client({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD, // required — no default
  database: process.env.PGDATABASE || 'netvault',
  ssl: false,
});

const DAYS = Math.max(1, parseInt(process.env.DAYS || '14', 10) || 14);
const RESET = (process.env.RESET ?? '1') === '1';

const VOLUME = (process.env.VOLUME || 'normal').toLowerCase();
const VOLUME_FACTOR = VOLUME === 'light' ? 0.4 : VOLUME === 'heavy' ? 2.5 : 1;
// Scale a naturally-variable count by VOLUME (Math.round, min 1).
// NOTE: NetVault's demo inventory is a FIXED, realistic set (a specific fleet of
// named devices/sites/circuits) — it is deliberately NOT scaled by VOLUME. The
// only time-dimension / generated data here is the per-day health-score trend,
// which is driven by DAYS (one row per day), not VOLUME. `scaled()` is provided
// for contract parity and used defensively if any variable-count data is added.
const scaled = (n) => Math.max(1, Math.round(n * VOLUME_FACTOR));

const counts = {};
const bump = (t, n = 1) => { counts[t] = (counts[t] || 0) + n; };

// ── Time helpers ───────────────────────────────────────────────────────────
const NOW = Date.now();
const DAY_MS = 86400000;
/** ISO timestamp `n` days before now (n may be fractional). */
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

// ── Reference / lookup data ──────────────────────────────────────────────
const REGIONS = ['APAC'];

const COUNTRIES = [
  { name: 'Malaysia', iso_code: 'MY', region: 'APAC' },
];

// Sites — keyed for idempotency by `code` (the demo natural key).
const SITES = [
  { code: 'KL-HQ', name: 'Kuala Lumpur HQ', country: 'Malaysia', city: 'Kuala Lumpur',
    address: 'Level 18, Menara Cahaya, Jalan Tun Razak', postal_code: '50400',
    coordinates: '3.1390,101.6869', site_type: 'Head Office', phone: '+60 3-2168 8000',
    contact_name: 'Faizal Rahman', contact_email: 'faizal.rahman@cahayatek.com.my' },
  { code: 'PEN', name: 'Penang Branch', country: 'Malaysia', city: 'George Town',
    address: 'Suite 12-3, Menara Boustead Penang, Jalan Sultan Ahmad Shah', postal_code: '10050',
    coordinates: '5.4164,100.3327', site_type: 'Branch Office', phone: '+60 4-226 5000',
    contact_name: 'Lim Wei Ming', contact_email: 'lim.weiming@cahayatek.com.my' },
  { code: 'JB', name: 'Johor Bahru Branch', country: 'Malaysia', city: 'Johor Bahru',
    address: 'Unit 8-2, Menara MSC Cyberport, Jalan Wong Ah Fook', postal_code: '80000',
    coordinates: '1.4927,103.7414', site_type: 'Branch Office', phone: '+60 7-222 3000',
    contact_name: 'Nurul Aina', contact_email: 'nurul.aina@cahayatek.com.my' },
];

const BRANDS = ['Fortinet', 'Cisco', 'Aruba', 'Dell'];

const DEVICE_TYPES = ['Firewall', 'Core Switch', 'Access Switch', 'Router', 'Wireless AP', 'Server'];

// Vendors — type is free-text; used as purchase / MA / support vendor refs.
const VENDORS = [
  { name: 'VSTECS Malaysia', type: 'Distributor' },
  { name: 'Fortinet', type: 'Manufacturer' },
  { name: 'Cisco Systems', type: 'Manufacturer' },
  { name: 'HPE Aruba', type: 'Manufacturer' },
  { name: 'Dell Technologies', type: 'Manufacturer' },
];

// Map a brand to the vendor that provides its maintenance/support.
const SUPPORT_VENDOR_BY_BRAND = {
  Fortinet: 'Fortinet',
  Cisco: 'Cisco Systems',
  Aruba: 'HPE Aruba',
  Dell: 'Dell Technologies',
};

const A = 'Active, Supported';
const EOL = 'EOL / EOS';

// Devices — drives the inventory table, dashboards and the EOL / Risk report.
//   lifecycle: 'Active, Supported' | 'EOL / EOS' | 'Unknown'
//   os_eol_date  -> Software EOL tab (red if past, amber if < 90 days, else green)
//   support_end  -> support-contract expiry (expired / expiring-90d badges)
const DEVICES = [
  // ── KL-HQ (10.10.x) ────────────────────────────────────────────────────
  { host: 'FG-KLHQ-01',      ip: '10.10.0.1',   brand: 'Fortinet', model: 'FortiGate-100F', type: 'Firewall',      site: 'KL-HQ', serial: 'FG100F0KLHQ001',
    lifecycle: A,   os_type: 'FortiOS', os_version: '7.4.4', os_eol: '2027-06-30', support_end: '2027-03-31', loc: 'Server Room A — Rack R1', risk: 12,
    remark: 'Primary perimeter firewall (HA active)' },
  { host: 'SW-KLHQ-CORE-01', ip: '10.10.0.2',   brand: 'Cisco', model: 'C9300-48P', type: 'Core Switch',          site: 'KL-HQ', serial: 'FCW2540CORE01',
    lifecycle: A,   os_type: 'Cisco IOS-XE', os_version: '17.9.4', os_eol: '2028-04-30', support_end: '2027-12-31', loc: 'Server Room A — Rack R2', risk: 10,
    remark: 'Core stack member 1' },
  { host: 'SW-KLHQ-CORE-02', ip: '10.10.0.3',   brand: 'Cisco', model: 'C9300-48P', type: 'Core Switch',          site: 'KL-HQ', serial: 'FCW2540CORE02',
    lifecycle: A,   os_type: 'Cisco IOS-XE', os_version: '17.9.4', os_eol: '2028-04-30', support_end: '2027-12-31', loc: 'Server Room A — Rack R2', risk: 10,
    remark: 'Core stack member 2' },
  { host: 'SW-KLHQ-ACC-01',  ip: '10.10.0.10',  brand: 'Cisco', model: 'C9200-24P', type: 'Access Switch',        site: 'KL-HQ', serial: 'JAE25100ACC01',
    lifecycle: EOL, os_type: 'Cisco IOS-XE', os_version: '17.3.5', os_eol: '2026-04-30', support_end: '2026-05-31', loc: 'Level 17 IDF — Rack A', risk: 72,
    remark: 'Past vendor EOL — replacement budgeted Q4' },
  { host: 'SW-KLHQ-ACC-02',  ip: '10.10.0.11',  brand: 'Cisco', model: 'C9200-24P', type: 'Access Switch',        site: 'KL-HQ', serial: 'JAE25100ACC02',
    lifecycle: EOL, os_type: 'Cisco IOS-XE', os_version: '17.3.5', os_eol: '2026-04-30', support_end: '2026-05-31', loc: 'Level 16 IDF — Rack A', risk: 72,
    remark: 'Past vendor EOL — replacement budgeted Q4' },
  { host: 'RTR-WAN-01',      ip: '10.10.0.254', brand: 'Cisco', model: 'ISR4331', type: 'Router',                 site: 'KL-HQ', serial: 'FDO24110WAN01',
    lifecycle: EOL, os_type: 'Cisco IOS-XE', os_version: '16.12.4', os_eol: '2025-12-31', support_end: '2026-01-31', loc: 'Server Room A — Rack R1', risk: 80,
    remark: 'WAN aggregation router — end of support reached' },
  { host: 'AP-KLHQ-01',      ip: '10.10.5.11',  brand: 'Aruba', model: 'AP-515', type: 'Wireless AP',             site: 'KL-HQ', serial: 'CN25AP51501',
    lifecycle: A,   os_type: 'ArubaOS', os_version: '8.10.0.7', os_eol: '2026-08-25', support_end: '2027-01-31', loc: 'Level 18 — Ceiling Zone A', risk: 30,
    remark: 'OS version approaching EOL' },
  { host: 'AP-KLHQ-02',      ip: '10.10.5.12',  brand: 'Aruba', model: 'AP-515', type: 'Wireless AP',             site: 'KL-HQ', serial: 'CN25AP51502',
    lifecycle: A,   os_type: 'ArubaOS', os_version: '8.10.0.7', os_eol: '2026-08-25', support_end: '2027-01-31', loc: 'Level 17 — Ceiling Zone B', risk: 30,
    remark: 'OS version approaching EOL' },
  { host: 'AP-KLHQ-03',      ip: '10.10.5.13',  brand: 'Aruba', model: 'AP-515', type: 'Wireless AP',             site: 'KL-HQ', serial: 'CN25AP51503',
    lifecycle: A,   os_type: 'ArubaOS', os_version: '8.10.0.7', os_eol: '2026-08-25', support_end: '2027-01-31', loc: 'Level 16 — Ceiling Zone A', risk: 30,
    remark: 'OS version approaching EOL' },
  { host: 'SRV-DC01',        ip: '10.10.1.10',  brand: 'Dell', model: 'PowerEdge-R650', type: 'Server',           site: 'KL-HQ', serial: 'CTSRVDC01650',
    lifecycle: A,   os_type: 'Windows Server', os_version: '2022', os_eol: '2031-10-14', support_end: '2027-06-30', loc: 'Server Room A — Rack R3', risk: 8,
    remark: 'Active Directory / DNS / DHCP' },
  { host: 'SRV-FILE01',      ip: '10.10.1.11',  brand: 'Dell', model: 'PowerEdge-R640', type: 'Server',           site: 'KL-HQ', serial: 'CTSRVFL01640',
    lifecycle: EOL, os_type: 'Windows Server', os_version: '2012 R2', os_eol: '2023-10-10', support_end: '2024-06-30', loc: 'Server Room A — Rack R3', risk: 88,
    remark: 'File server on out-of-support OS — migration pending' },
  { host: 'SRV-WEB01',       ip: '10.10.1.20',  brand: 'Dell', model: 'PowerEdge-R650', type: 'Server',           site: 'KL-HQ', serial: 'CTSRVWB01650',
    lifecycle: A,   os_type: 'Ubuntu', os_version: '22.04 LTS', os_eol: '2032-04-30', support_end: '2027-06-30', loc: 'Server Room A — Rack R4', risk: 10,
    remark: 'Internal web / app server' },
  { host: 'SRV-DB01',        ip: '10.10.1.30',  brand: 'Dell', model: 'PowerEdge-R750', type: 'Server',           site: 'KL-HQ', serial: 'CTSRVDB01750',
    lifecycle: A,   os_type: 'Ubuntu', os_version: '22.04 LTS', os_eol: '2032-04-30', support_end: '2027-06-30', loc: 'Server Room A — Rack R4', risk: 10,
    remark: 'PostgreSQL database server' },

  // ── PEN (10.20.x) ──────────────────────────────────────────────────────
  { host: 'FG-PEN-01',       ip: '10.20.0.1',   brand: 'Fortinet', model: 'FortiGate-60F', type: 'Firewall',     site: 'PEN', serial: 'FG60F0PEN0001',
    lifecycle: A,   os_type: 'FortiOS', os_version: '7.4.4', os_eol: '2027-06-30', support_end: '2026-08-31', loc: 'Comms Room — Rack 1', risk: 22,
    remark: 'Branch firewall — support renewal due soon' },
  { host: 'SW-PEN-CORE-01',  ip: '10.20.0.2',   brand: 'Aruba', model: '6300M', type: 'Core Switch',             site: 'PEN', serial: 'SG25PENCORE01',
    lifecycle: A,   os_type: 'ArubaOS-CX', os_version: '10.11.1010', os_eol: '2028-12-31', support_end: '2027-06-30', loc: 'Comms Room — Rack 1', risk: 12,
    remark: 'Branch core switch' },
  { host: 'SW-PEN-ACC-01',   ip: '10.20.0.10',  brand: 'Aruba', model: '6100', type: 'Access Switch',            site: 'PEN', serial: 'SG25PENACC01',
    lifecycle: A,   os_type: 'ArubaOS-CX', os_version: '10.09.1000', os_eol: '2026-09-15', support_end: '2026-12-31', loc: 'Floor 3 — IDF', risk: 34,
    remark: 'OS version approaching EOL' },

  // ── JB (10.30.x) ───────────────────────────────────────────────────────
  { host: 'FG-JB-01',        ip: '10.30.0.1',   brand: 'Fortinet', model: 'FortiGate-40F', type: 'Firewall',     site: 'JB', serial: 'FG40F0JB00001',
    lifecycle: A,   os_type: 'FortiOS', os_version: '7.2.8', os_eol: '2026-09-20', support_end: '2026-03-31', loc: 'Comms Room — Rack 1', risk: 58,
    remark: 'Branch firewall — support contract expired, renewal in progress' },
  { host: 'SW-JB-CORE-01',   ip: '10.30.0.2',   brand: 'Aruba', model: '6300M', type: 'Core Switch',             site: 'JB', serial: 'SG25JBCORE01',
    lifecycle: A,   os_type: 'ArubaOS-CX', os_version: '10.11.1010', os_eol: '2028-12-31', support_end: '2027-06-30', loc: 'Comms Room — Rack 1', risk: 12,
    remark: 'Branch core switch' },
  { host: 'SW-JB-ACC-01',    ip: '10.30.0.10',  brand: 'Aruba', model: '6100', type: 'Access Switch',            site: 'JB', serial: 'SG25JBACC01',
    lifecycle: A,   os_type: 'ArubaOS-CX', os_version: '10.09.1000', os_eol: '2026-09-15', support_end: '2026-12-31', loc: 'Floor 2 — IDF', risk: 34,
    remark: 'OS version approaching EOL' },
];

// WAN circuits — one primary internet link per site. Keyed by circuit_id.
const CIRCUITS = [
  { code: 'KL-HQ', circuit_id: 'TIME-KL-100021', isp: 'TIME dotCom', usage: 'Primary Internet',
    product: 'TIME Fibre Business', technology: 'Fibre', circuit_type: 'Dedicated', interface: 'GE',
    max_speed: '500 Mbps', guaranteed_speed: '500 Mbps', public_subnet: '203.115.10.0/29',
    cost_month: 1850.00, contract_term: '24 months', it_owner: 'Faizal Rahman', pingable: 'Yes',
    comment: 'HQ primary internet (BGP)' },
  { code: 'PEN', circuit_id: 'TM-PEN-200045', isp: 'TM (Unifi Business)', usage: 'Primary Internet',
    product: 'Unifi Business Fibre', technology: 'Fibre', circuit_type: 'Shared', interface: 'GE',
    max_speed: '300 Mbps', guaranteed_speed: '150 Mbps', public_subnet: '175.139.20.0/30',
    cost_month: 699.00, contract_term: '24 months', it_owner: 'Lim Wei Ming', pingable: 'Yes',
    comment: 'Penang branch primary internet' },
  { code: 'JB', circuit_id: 'MAXIS-JB-300078', isp: 'Maxis Business', usage: 'Primary Internet',
    product: 'Maxis Fibre Enterprise', technology: 'Fibre', circuit_type: 'Shared', interface: 'GE',
    max_speed: '200 Mbps', guaranteed_speed: '100 Mbps', public_subnet: '202.188.30.0/30',
    cost_month: 599.00, contract_term: '12 months', it_owner: 'Nurul Aina', pingable: 'Yes',
    comment: 'Johor Bahru branch primary internet' },
];

// ── Helpers ──────────────────────────────────────────────────────────────
async function q(text, params) {
  return client.query(text, params);
}

/** Upsert a row keyed by a single UNIQUE column; returns its id. */
async function upsertLookup(table, uniqueCol, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols
    .filter((c) => c !== uniqueCol)
    .map((c) => `${c} = EXCLUDED.${c}`);
  const setClause = updates.length ? updates.join(', ') : `${uniqueCol} = EXCLUDED.${uniqueCol}`;
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT (${uniqueCol}) DO UPDATE SET ${setClause}
               RETURNING id`;
  const { rows } = await q(sql, cols.map((c) => row[c]));
  bump(table);
  return rows[0].id;
}

/** Whether the health_score_history table exists (may be absent on old installs). */
async function tableExists(name) {
  try {
    const { rows } = await q('SELECT to_regclass($1) AS t', [name]);
    return !!rows[0].t;
  } catch (_) {
    return false;
  }
}

async function main() {
  await client.connect();
  console.log(`[seed] netvault: connected to ${client.database} @ ${client.host}:${client.port}`);
  console.log(`[seed] netvault: DAYS=${DAYS} VOLUME=${VOLUME} (x${VOLUME_FACTOR}) RESET=${RESET ? 1 : 0}`);

  if (RESET) {
    console.log('[seed] netvault: RESET — clearing demo tables (auth/settings untouched)…');
    // FK-safe order. devices -> circuits -> sites -> countries -> regions,
    // then the lookup tables devices referenced.
    await q('DELETE FROM devices');
    await q('DELETE FROM circuits');
    await q('DELETE FROM sites');       // user_sites rows cascade
    await q('DELETE FROM countries');
    await q('DELETE FROM regions');
    await q('DELETE FROM vendors');
    await q('DELETE FROM brands');
    await q('DELETE FROM device_types');
    if (await tableExists('health_score_history')) {
      await q('DELETE FROM health_score_history');
    }
  }

  // Attribute created_by/updated_by to an existing admin user if one exists.
  let actorId = null;
  try {
    const { rows } = await q('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (rows.length) actorId = rows[0].id;
  } catch (_) { /* users table absent — leave null */ }

  // 1) Regions
  const regionId = {};
  for (const name of REGIONS) regionId[name] = await upsertLookup('regions', 'name', { name });

  // 2) Countries
  const countryId = {};
  for (const c of COUNTRIES) {
    countryId[c.name] = await upsertLookup('countries', 'name', {
      name: c.name, iso_code: c.iso_code, region_id: regionId[c.region],
    });
  }

  // 3) Sites — no UNIQUE key, so key by `code` manually for idempotency.
  const siteId = {};
  for (const s of SITES) {
    const fields = {
      name: s.name, code: s.code, country_id: countryId[s.country], address: s.address,
      city: s.city, postal_code: s.postal_code, coordinates: s.coordinates,
      site_type: s.site_type, phone: s.phone, contact_name: s.contact_name,
      contact_email: s.contact_email, site_status: 'Active',
    };
    const existing = await q('SELECT id FROM sites WHERE code = $1', [s.code]);
    if (existing.rows.length) {
      const id = existing.rows[0].id;
      const cols = Object.keys(fields);
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await q(`UPDATE sites SET ${set} WHERE id = $${cols.length + 1}`,
        [...cols.map((c) => fields[c]), id]);
      siteId[s.code] = id;
    } else {
      const cols = Object.keys(fields);
      const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await q(
        `INSERT INTO sites (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
        cols.map((c) => fields[c]));
      siteId[s.code] = rows[0].id;
    }
    bump('sites');
  }

  // 4) Brands
  const brandId = {};
  for (const name of BRANDS) brandId[name] = await upsertLookup('brands', 'name', { name });

  // 5) Device types
  const typeId = {};
  for (const name of DEVICE_TYPES) typeId[name] = await upsertLookup('device_types', 'name', { name });

  // 6) Vendors
  const vendorId = {};
  for (const v of VENDORS) vendorId[v.name] = await upsertLookup('vendors', 'name', { name: v.name, type: v.type });

  // 7) Devices — upsert on the partial unique index on serial_number.
  //    created_at / updated_at are spread across the last DAYS days so
  //    "recent activity" looks realistic instead of every row being NOW().
  const deviceCols = [
    'name', 'brand_id', 'model', 'serial_number', 'device_type_id', 'ip_address',
    'mgmt_protocol', 'mgmt_url', 'site_id', 'location_detail', 'lifecycle_status',
    'device_status', 'risk_score', 'technical_debt', 'remark', 'cost', 'purchase_date',
    'purchase_vendor_id', 'ma_vendor_id', 'support_vendor_id', 'created_by', 'updated_by',
    'os_type', 'os_version', 'os_eol_date', 'support_contract_number', 'support_start_date',
    'support_end_date', 'support_cost', 'support_currency', 'created_at', 'updated_at',
  ];
  // On conflict, refresh everything EXCEPT the identity/lineage columns
  // (serial_number, created_by, created_at stay as first seeded).
  const deviceSet = deviceCols
    .filter((c) => c !== 'serial_number' && c !== 'created_by' && c !== 'created_at')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  const devicePh = deviceCols.map((_, i) => `$${i + 1}`).join(', ');
  const deviceSql =
    `INSERT INTO devices (${deviceCols.join(', ')}) VALUES (${devicePh})
     ON CONFLICT (serial_number) WHERE serial_number IS NOT NULL AND serial_number <> ''
     DO UPDATE SET ${deviceSet}`;

  DEVICES.forEach((d, i) => { d._idx = i; });
  const N = DEVICES.length;
  for (const d of DEVICES) {
    const supVendor = vendorId[SUPPORT_VENDOR_BY_BRAND[d.brand]] || null;
    // Crude but plausible technical-debt figure: EOL gear carries the most.
    const techDebt = d.lifecycle === EOL ? 18000 : (d.risk >= 30 ? 4500 : 1200);
    const cost = d.type === 'Server' ? 32000
      : d.type === 'Firewall' ? 14000
      : d.type === 'Core Switch' ? 22000
      : d.type === 'Router' ? 9000
      : d.type === 'Access Switch' ? 6000
      : 1800; // Wireless AP

    // Spread activity across the window. updated_at scatters over the last DAYS
    // days (deterministic, so re-runs are stable); created_at sits at the start
    // of the window so it is always <= updated_at.
    const updOffset = (d._idx * 7) % DAYS;         // 0 .. DAYS-1 days ago
    const hourJitter = (d._idx % 24) / 24;         // sub-day spread
    const updatedAt = daysAgo(updOffset + hourJitter);
    const createdAt = daysAgo(DAYS - 1 + hourJitter);

    const row = {
      name: d.host,
      brand_id: brandId[d.brand],
      model: d.model,
      serial_number: d.serial,
      device_type_id: typeId[d.type],
      ip_address: d.ip,
      mgmt_protocol: d.type === 'Server' ? 'RDP/SSH' : 'HTTPS',
      mgmt_url: `https://${d.ip}`,
      site_id: siteId[d.site],
      location_detail: d.loc,
      lifecycle_status: d.lifecycle,
      device_status: 'Active',
      risk_score: d.risk,
      technical_debt: techDebt,
      remark: d.remark,
      cost,
      purchase_date: '2021-07-15',
      purchase_vendor_id: vendorId['VSTECS Malaysia'] || null,
      ma_vendor_id: supVendor,
      support_vendor_id: supVendor,
      created_by: actorId,
      updated_by: actorId,
      os_type: d.os_type,
      os_version: d.os_version,
      os_eol_date: d.os_eol,
      support_contract_number: `CT-${d.host}`,
      support_start_date: '2024-07-01',
      support_end_date: d.support_end,
      support_cost: Math.round(cost * 0.12),
      support_currency: 'MYR',
      created_at: createdAt,
      updated_at: updatedAt,
    };
    await q(deviceSql, deviceCols.map((c) => row[c]));
    bump('devices');
  }
  console.log(`[seed] netvault: ${counts.devices || 0} devices`);

  // 8) Circuits — key by circuit_id for idempotency (no UNIQUE constraint).
  for (const cr of CIRCUITS) {
    const s = SITES.find((x) => x.code === cr.code);
    const fields = {
      site_id: siteId[cr.code],
      site_name_raw: s ? s.name : cr.code,
      it_owner: cr.it_owner,
      city: s ? s.city : null,
      address: s ? s.address : null,
      isp: cr.isp,
      usage: cr.usage,
      circuit_id: cr.circuit_id,
      product: cr.product,
      technology: cr.technology,
      circuit_type: cr.circuit_type,
      interface: cr.interface,
      max_speed: cr.max_speed,
      guaranteed_speed: cr.guaranteed_speed,
      public_subnet: cr.public_subnet,
      currency: 'MYR',
      cost_month: cr.cost_month,
      contract_term: cr.contract_term,
      comment: cr.comment,
      pingable: cr.pingable,
    };
    const existing = await q('SELECT id FROM circuits WHERE circuit_id = $1', [cr.circuit_id]);
    if (existing.rows.length) {
      const id = existing.rows[0].id;
      const cols = Object.keys(fields);
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await q(`UPDATE circuits SET ${set}, updated_at = NOW() WHERE id = $${cols.length + 1}`,
        [...cols.map((c) => fields[c]), id]);
    } else {
      const cols = Object.keys(fields);
      const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
      await q(`INSERT INTO circuits (${cols.join(', ')}) VALUES (${ph})`,
        cols.map((c) => fields[c]));
    }
    bump('circuits');
  }
  console.log(`[seed] netvault: ${counts.circuits || 0} circuits`);

  // 9) Health-score trend — one snapshot row per day for the last DAYS days so
  //    the dashboard month-over-month chart renders. Values are derived from the
  //    (fixed) inventory just seeded, with a gentle upward drift in the
  //    compliance/health score so the trend line has shape. Skipped cleanly if
  //    the health_score_history table is absent on an old install.
  if (await tableExists('health_score_history')) {
    // Derive the constant fleet metrics from the seeded inventory.
    const totalDevices = DEVICES.length;
    const eolAssets = DEVICES.filter((d) => d.lifecycle === EOL).length;
    const healthyDevices = totalDevices - eolAssets;
    const totalSites = SITES.length;
    const sitesAtRisk = new Set(
      DEVICES.filter((d) => d.lifecycle === EOL).map((d) => d.site)
    ).size;

    // Same formula as lib/healthScore.ts, so the seeded trend is consistent
    // with how the app would recompute today's score.
    const eolPenalty = (eolAssets / totalDevices) * 100 * 0.4;
    const siteRiskPenalty = totalSites > 0 ? (sitesAtRisk / totalSites) * 30 : 0;
    const gradeOf = (score) =>
      score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

    // Replace only this window's rows so re-runs don't duplicate (covers the
    // non-RESET path too).
    await q(
      `DELETE FROM health_score_history WHERE calculated_at >= NOW() - ($1 || ' days')::interval`,
      [DAYS]
    );

    let snapCount = 0;
    // Oldest day first (d = DAYS-1) → today (d = 0); compliance drifts up.
    for (let d = DAYS - 1; d >= 0; d--) {
      const progress = DAYS > 1 ? (DAYS - 1 - d) / (DAYS - 1) : 1; // 0..1 over window
      // Compliance climbs ~68 → ~76 with a small deterministic wobble.
      const wobble = Math.round(Math.sin(d * 1.3) * 2);
      const compliance = Math.max(0, Math.min(100, Math.round(68 + progress * 8 + wobble)));
      const compliancePenalty = ((100 - compliance) / 100) * 30;
      const score = Math.max(0, Math.min(100,
        Math.round(100 - eolPenalty - siteRiskPenalty - compliancePenalty)));
      // Snapshot taken at ~01:00 each day.
      const calcAt = new Date(NOW - d * DAY_MS);
      calcAt.setHours(1, 0, 0, 0);
      await q(
        `INSERT INTO health_score_history
           (score, grade, healthy_devices, eol_assets, sites_at_risk, compliance_score, calculated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [score, gradeOf(score), healthyDevices, eolAssets, sitesAtRisk, compliance, calcAt.toISOString()]
      );
      snapCount++;
    }
    bump('health_score_history', snapCount);
    console.log(`[seed] netvault: ${snapCount} health snapshots (1/day x ${DAYS}d)`);
  } else {
    console.log('[seed] netvault: health_score_history table absent — skipping trend seed');
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('[seed] netvault: done. Rows upserted:');
  for (const t of ['regions', 'countries', 'sites', 'brands', 'device_types',
    'vendors', 'devices', 'circuits', 'health_score_history']) {
    console.log(`  ${t.padEnd(20)} ${counts[t] || 0}`);
  }
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => {
    console.error('[seed] netvault: FAILED:', err.message);
    try { await client.end(); } catch (_) {}
    process.exit(1);
  });
