#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
// DDIVault — DEMO DATA seed script (NocVault suite installer edition)
// ----------------------------------------------------------------------------
// Populates the ddivault Postgres DB with a realistic, self-consistent DDI demo
// dataset for the shared NocVault scenario:
//   Org "Cahaya Teknologi Sdn Bhd" — sites KL-HQ / PEN / JB.
//
// Run where Postgres is reachable:
//   node ddivault-seed.js              # idempotent upsert / reseed
//   RESET=0 node ddivault-seed.js      # keep IPAM demo rows (upsert only)
//
// Shared seed contract (all 4 NocVault app seeds follow this) — env overrides:
//   PGHOST     (localhost)   PGPORT   (5432)      PGUSER   (postgres)
//   PGPASSWORD (REQUIRED — no default)            PGDATABASE (ddivault)
//   DAYS       (14)  — history window: every historical/trend series spans the
//                      LAST DAYS days (scope history, server health history,
//                      IPAM utilization history) instead of a fixed 30.
//   VOLUME     (normal) — scales the variable-count data (leases / addresses /
//                      records): light x0.4, normal x1, heavy x2.5 (round, min 1).
//                      Scopes / zones / subnets stay a fixed realistic set.
//   RESET      (1)   — clear demo-fillable tables first, then reseed.
//
// Idempotency model:
//   * Server-keyed data (DHCP scopes/leases/history, DNS zones/records, server
//     roles, zone-sync, health history) is reseeded by deleting the demo DDI
//     servers first — every child FK is ON DELETE CASCADE — then re-inserting.
//   * IPAM (supernets/subnets/addresses/vlans) and other natural-keyed tables
//     use ON CONFLICT upserts.
//   * Pure dashboard/trend tables with no natural key (ipam_utilization_history,
//     site_health_scores, anomaly_events demo rows) are cleared each run.
//   * RESET=1 additionally wipes the IPAM demo rows before reseeding.
//
// It NEVER touches config/users tables (app_settings, alert_rules,
// alert_rule_config, smtp_config, api_keys, audit_log, ipam_audit, users).
// ============================================================================

const { Client } = require('pg');

// PGPASSWORD is required — there is NO hardcoded default (shared contract).
if (!process.env.PGPASSWORD) {
  console.error('FATAL: PGPASSWORD is required (no default). Set it and re-run.');
  process.exit(1);
}

const client = new Client({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'ddivault',
  ssl: false,
});

// RESET defaults to 1 (clear demo-fillable tables first, then reseed).
const RESET = (process.env.RESET || '1') === '1';

// DAYS — history window (last N days) for every trend/history series.
const DAYS = Math.max(1, parseInt(process.env.DAYS || '14', 10) || 14);

// VOLUME — scale factor for variable-count data (leases / addresses / records).
const VOLUME = (process.env.VOLUME || 'normal').toLowerCase();
const VOL_FACTOR = ({ light: 0.4, normal: 1, heavy: 2.5 })[VOLUME] || 1;
const scaleCount = (n) => Math.max(1, Math.round(n * VOL_FACTOR));

// ── time helpers ────────────────────────────────────────────────────────────
const NOW = new Date();
const daysAgo   = (n) => new Date(NOW.getTime() - n * 86400000);
const daysAhead = (n) => new Date(NOW.getTime() + n * 86400000);
const hoursAgo  = (n) => new Date(NOW.getTime() - n * 3600000);
const pad3 = (n) => String(n).padStart(3, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;

// Deterministic MAC from an OUI prefix + index (uppercase, unique per index).
function mac(prefix, n) {
  const b = (x) => (x & 255).toString(16).padStart(2, '0');
  return `${prefix}:${b(n * 7 + 1)}:${b(n * 13 + 5)}:${b(n)}`.toUpperCase();
}
const OUI = {
  dell:     '00:14:22',
  hp:       '00:21:5A',
  intel:    '00:1B:21',
  apple:    '00:17:AB',
  samsung:  '00:21:19',
  yealink:  '80:5E:0C',
  polycom:  '00:04:F2',
  cisco:    '00:1B:54',
  aruba:    '00:0B:86',
  fortinet: '00:09:0F',
};

// ── reusable counters ───────────────────────────────────────────────────────
const counts = {};
function bump(table, n = 1) { counts[table] = (counts[table] || 0) + n; }

// ── generic insert helpers ──────────────────────────────────────────────────
// Returns id (for parent rows we chain from). Uses ON CONFLICT DO UPDATE so the
// id is always returned even on a re-run conflict.
async function insertId(table, row, conflictCols) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
  let sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph})`;
  if (conflictCols) {
    const upd = cols
      .filter((c) => !conflictCols.includes(c))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');
    sql += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${upd}`;
  }
  sql += ' RETURNING id';
  const r = await client.query(sql, vals);
  bump(table);
  return r.rows[0].id;
}

// Fire-and-forget insert (no id needed). Optional ON CONFLICT DO UPDATE/NOTHING.
async function insert(table, row, conflictCols, doNothing = false) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
  let sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph})`;
  if (conflictCols) {
    if (doNothing) {
      sql += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(', ')}) DO NOTHING`;
    } else {
      const upd = cols
        .filter((c) => !conflictCols.includes(c))
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      sql += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${upd}`;
    }
  }
  await client.query(sql, vals);
  bump(table);
}

// ── scenario data ───────────────────────────────────────────────────────────
const SERVER_HOSTNAMES = ['SRV-DC01', 'SRV-DC02'];

// Sites — site_id values are an ASSUMPTION (see report); real ids live in the
// netvault DB. They are stored as plain INTs here (cross-DB, no FK).
const SITE = { KLHQ: 1, PEN: 2, JB: 3 };

const SUPERNETS = [
  { network: '10.10.0.0', prefix_length: 16, name: 'KL-HQ', site: 'KL-HQ', site_id: SITE.KLHQ, description: 'Kuala Lumpur HQ supernet' },
  { network: '10.20.0.0', prefix_length: 16, name: 'PEN',   site: 'PEN',   site_id: SITE.PEN,  description: 'Penang branch supernet' },
  { network: '10.30.0.0', prefix_length: 16, name: 'JB',    site: 'JB',    site_id: SITE.JB,   description: 'Johor Bahru branch supernet' },
];

// total_hosts/used_hosts drive the IPAM dashboards. Servers subnet is fairly
// full; staff subnets ~40-60%.
const SUBNETS = [
  { network: '10.10.0.0',  prefix_length: 24, name: 'KL-HQ Network Mgmt', role: 'mgmt',     site: 'KL-HQ', site_id: SITE.KLHQ, sup: '10.10.0.0', vlan: 10,  gw: '10.10.0.1',  total: 254, used: 28,  unknown: 0, sensitive: true  },
  { network: '10.10.1.0',  prefix_length: 24, name: 'KL-HQ Servers',      role: 'servers',  site: 'KL-HQ', site_id: SITE.KLHQ, sup: '10.10.0.0', vlan: 11,  gw: '10.10.1.1',  total: 254, used: 208, unknown: 2, sensitive: true  },
  { network: '10.10.5.0',  prefix_length: 24, name: 'KL-HQ Wireless',     role: 'wireless', site: 'KL-HQ', site_id: SITE.KLHQ, sup: '10.10.0.0', vlan: 15,  gw: '10.10.5.1',  total: 254, used: 131, unknown: 4, sensitive: false },
  { network: '10.10.20.0', prefix_length: 24, name: 'KL-HQ Staff',        role: 'staff',    site: 'KL-HQ', site_id: SITE.KLHQ, sup: '10.10.0.0', vlan: 20,  gw: '10.10.20.1', total: 254, used: 124, unknown: 3, sensitive: false },
  { network: '10.10.30.0', prefix_length: 24, name: 'KL-HQ Voice',        role: 'voice',    site: 'KL-HQ', site_id: SITE.KLHQ, sup: '10.10.0.0', vlan: 30,  gw: '10.10.30.1', total: 254, used: 66,  unknown: 0, sensitive: false },
  { network: '10.20.0.0',  prefix_length: 24, name: 'PEN Network Mgmt',   role: 'mgmt',     site: 'PEN',   site_id: SITE.PEN,  sup: '10.20.0.0', vlan: 120, gw: '10.20.0.1',  total: 254, used: 16,  unknown: 0, sensitive: true  },
  { network: '10.20.20.0', prefix_length: 24, name: 'PEN Staff',          role: 'staff',    site: 'PEN',   site_id: SITE.PEN,  sup: '10.20.0.0', vlan: 220, gw: '10.20.20.1', total: 254, used: 96,  unknown: 2, sensitive: false },
  { network: '10.30.0.0',  prefix_length: 24, name: 'JB Network Mgmt',    role: 'mgmt',     site: 'JB',    site_id: SITE.JB,   sup: '10.30.0.0', vlan: 130, gw: '10.30.0.1',  total: 254, used: 13,  unknown: 0, sensitive: true  },
  { network: '10.30.20.0', prefix_length: 24, name: 'JB Staff',           role: 'staff',    site: 'JB',    site_id: SITE.JB,   sup: '10.30.0.0', vlan: 230, gw: '10.30.20.1', total: 254, used: 78,  unknown: 1, sensitive: false },
];

// Static / key infrastructure hosts (also referenced by the other suite apps).
const KEY_HOSTS = [
  { host: 'FG-KLHQ-01',      ip: '10.10.0.1',  subnet: '10.10.0.0',  type: 'firewall', vendor: 'Fortinet', oui: OUI.fortinet, i: 1 },
  { host: 'SW-KLHQ-CORE-01', ip: '10.10.0.2',  subnet: '10.10.0.0',  type: 'switch',   vendor: 'Cisco',    oui: OUI.cisco,    i: 2 },
  { host: 'SRV-DC01',        ip: '10.10.1.10', subnet: '10.10.1.0',  type: 'server',   vendor: 'Dell',     oui: OUI.dell,     i: 10 },
  { host: 'SRV-FILE01',      ip: '10.10.1.11', subnet: '10.10.1.0',  type: 'server',   vendor: 'Dell',     oui: OUI.dell,     i: 11 },
  { host: 'SRV-DC02',        ip: '10.10.1.12', subnet: '10.10.1.0',  type: 'server',   vendor: 'Dell',     oui: OUI.dell,     i: 12 },
  { host: 'SRV-WEB01',       ip: '10.10.1.20', subnet: '10.10.1.0',  type: 'server',   vendor: 'Dell',     oui: OUI.dell,     i: 20 },
  { host: 'SRV-DB01',        ip: '10.10.1.30', subnet: '10.10.1.0',  type: 'server',   vendor: 'Dell',     oui: OUI.dell,     i: 30 },
  { host: 'AP-KLHQ-01',      ip: '10.10.5.11', subnet: '10.10.5.0',  type: 'wireless', vendor: 'Aruba',    oui: OUI.aruba,    i: 11 },
  { host: 'AP-KLHQ-02',      ip: '10.10.5.12', subnet: '10.10.5.0',  type: 'wireless', vendor: 'Aruba',    oui: OUI.aruba,    i: 12 },
  { host: 'AP-KLHQ-03',      ip: '10.10.5.13', subnet: '10.10.5.0',  type: 'wireless', vendor: 'Aruba',    oui: OUI.aruba,    i: 13 },
];

// DHCP scopes — only the dynamic-client subnets (staff / voice / wireless).
// All scopes are served by SRV-DC01. Lease pool .100-.250 (151 addresses).
const SCOPES = [
  { subnet: '10.10.5.0',  name: 'KL-HQ Wireless', in_use: 112 },
  { subnet: '10.10.20.0', name: 'KL-HQ Staff',    in_use: 78  },
  { subnet: '10.10.30.0', name: 'KL-HQ Voice',    in_use: 60  },
  { subnet: '10.20.20.0', name: 'PEN Staff',      in_use: 64  },
  { subnet: '10.30.20.0', name: 'JB Staff',       in_use: 48  },
];

// Staff workstation generators per scope (hostname prefix + count + start octet).
// `count` is scaled by VOLUME at generation time.
const WORKSTATIONS = [
  { scope: '10.10.20.0', prefix: 'PC-KLHQ', count: 20, startOctet: 101, oui: OUI.dell, vendor: 'Dell' },
  { scope: '10.20.20.0', prefix: 'PC-PEN',  count: 10, startOctet: 101, oui: OUI.dell, vendor: 'Dell' },
  { scope: '10.30.20.0', prefix: 'PC-JB',   count: 8,  startOctet: 101, oui: OUI.hp,   vendor: 'HP'   },
];

const FWD_ZONE = 'cahaya.local';
const CORP_ZONE = 'corp.cahaya.com';

function reverseZone(network /* e.g. 10.10.20.0 */) {
  const o = network.split('.');
  return `${o[2]}.${o[1]}.${o[0]}.in-addr.arpa`;
}

// ── cleanup ─────────────────────────────────────────────────────────────────
async function cleanup() {
  // Detach child rows whose server_id FK is NOT ON DELETE CASCADE (alert_events,
  // dhcp_events, lease_history). The DDIVault collector can generate these for the
  // demo servers between runs, so the ddi_servers delete below would otherwise hit
  // a foreign-key violation on a re-run. (Table names are a fixed literal list.)
  for (const t of ['alert_events', 'dhcp_events', 'lease_history']) {
    await client.query(
      `DELETE FROM ${t} WHERE server_id IN (SELECT id FROM ddi_servers WHERE hostname = ANY($1))`,
      [SERVER_HOSTNAMES]
    );
  }

  // Server-keyed DDI data — one cascade per server clears scopes, scope_history,
  // leases, scope_forecasts, device_baselines, dns_zones, dns_records,
  // dns_server_roles, dns_zone_sync, server_health_history, failover pairs, etc.
  await client.query('DELETE FROM ddi_servers WHERE hostname = ANY($1)', [SERVER_HOSTNAMES]);

  // Trend / snapshot tables with no natural key — always cleared so re-runs
  // don't accumulate duplicate rows.
  await client.query('DELETE FROM site_health_scores WHERE site_id = ANY($1)', [[SITE.KLHQ, SITE.PEN, SITE.JB]]);
  await client.query("DELETE FROM anomaly_events WHERE details->>'demo' = 'true'");
  await client.query('DELETE FROM ipam_utilization_history'); // pure demo trend table

  if (RESET) {
    // Wipe the IPAM demo rows so they are rebuilt clean (FK-safe order).
    const subNets = SUBNETS.map((s) => s.network);
    const supNets = SUPERNETS.map((s) => s.network);
    const vlans = SUBNETS.map((s) => s.vlan);
    await client.query(
      'DELETE FROM ipam_addresses WHERE subnet_id IN (SELECT id FROM ipam_subnets WHERE network = ANY($1))',
      [subNets]
    );
    await client.query('DELETE FROM ipam_subnets   WHERE network = ANY($1)', [subNets]);
    await client.query('DELETE FROM ipam_supernets WHERE network = ANY($1)', [supNets]);
    await client.query('DELETE FROM ipam_vlans     WHERE vlan_id = ANY($1)', [vlans]);
  }
}

// ── main seed ───────────────────────────────────────────────────────────────
async function seed() {
  // 1) DDI servers ----------------------------------------------------------
  const serverId = {};
  serverId['SRV-DC01'] = await insertId('ddi_servers', {
    hostname: 'SRV-DC01', ip_address: '10.10.1.10', role: 'both',
    description: 'KL-HQ primary domain controller — DNS + DHCP',
    is_active: true, last_polled: hoursAgo(0.1), poll_status: 'ok',
    site_id: SITE.KLHQ, auth_mode: 'kerberos',
    winrm_test_ok: true, winrm_tested_at: hoursAgo(2),
    is_dns_primary: true, dns_forwarders: ['8.8.8.8', '1.1.1.1'],
    health_score: 97, health_checked_at: hoursAgo(0.1), query_ms: 9,
  });
  serverId['SRV-DC02'] = await insertId('ddi_servers', {
    hostname: 'SRV-DC02', ip_address: '10.10.1.12', role: 'both',
    description: 'KL-HQ secondary domain controller — DNS + DHCP failover',
    is_active: true, last_polled: hoursAgo(0.1), poll_status: 'ok',
    site_id: SITE.KLHQ, auth_mode: 'kerberos',
    winrm_test_ok: true, winrm_tested_at: hoursAgo(2),
    is_dns_primary: false, dns_forwarders: ['8.8.8.8', '1.1.1.1'],
    health_score: 95, health_checked_at: hoursAgo(0.1), query_ms: 12,
  });
  const dc01 = serverId['SRV-DC01'];
  const dc02 = serverId['SRV-DC02'];

  // 2) DHCP scopes + history + forecasts ------------------------------------
  const scopeRowId = {}; // scope network -> dhcp_scopes.id
  for (const sc of SCOPES) {
    const total = 151; // .100-.250
    const inUse = sc.in_use;
    const free = total - inUse;
    const pct = round2((inUse / total) * 100);
    const base = sc.subnet.split('.').slice(0, 3).join('.');
    const id = await insertId('dhcp_scopes', {
      server_id: dc01, scope_id: sc.subnet, name: sc.name,
      start_range: `${base}.100`, end_range: `${base}.250`, subnet_mask: '255.255.255.0',
      state: 'Active', lease_duration: '8.00:00:00',
      total_ips: total, in_use: inUse, free, reserved: 0, pending: 0,
      percent_used: pct, description: `${sc.name} dynamic pool`, last_updated: NOW,
    }, ['server_id', 'scope_id']);
    scopeRowId[sc.subnet] = id;

    // DAYS days of history every 6h, gentle upward trend toward current in_use.
    const spanH = DAYS * 24;
    for (let h = spanH; h >= 0; h -= 6) {
      const frac = 1 - h / spanH;                     // 0 .. 1
      const trend = inUse * (0.62 + 0.38 * frac);
      const jitter = Math.sin(h / 6) * (total * 0.02);
      const iu = clamp(Math.round(trend + jitter), 0, total);
      await insert('dhcp_scope_history', {
        scope_id: id, in_use: iu, free: total - iu, reserved: 0,
        percent_used: round2((iu / total) * 100), recorded_at: hoursAgo(h),
      });
    }

    // Capacity forecast (one per scope, keyed by scope_id).
    const growth = round2(0.15 + (pct / 100) * 0.8);
    const headroom = Math.max(0, 80 - pct);
    await insert('scope_forecasts', {
      scope_id: id, calculated_at: NOW, current_pct: pct,
      growth_rate_per_day: growth,
      days_to_80pct: pct >= 80 ? 0 : Math.round(headroom / Math.max(growth, 0.05)),
      days_to_90pct: pct >= 90 ? 0 : Math.round((90 - pct) / Math.max(growth, 0.05)),
      days_to_full: Math.round((100 - pct) / Math.max(growth, 0.05)),
      confidence: 'medium', data_points: Math.round(spanH / 6),
      recommendation: pct >= 70 ? 'Monitor — approaching capacity' : 'Healthy',
      status: 'ok',
    }, ['scope_id']);
  }

  // 3) DHCP leases ----------------------------------------------------------
  // Workstations (staff scopes) — these IPs are the DNS A records too.
  // Count per generator is scaled by VOLUME.
  const wsRecords = []; // {host, ip, scope}
  for (const w of WORKSTATIONS) {
    const base = w.scope.split('.').slice(0, 3).join('.');
    const wsCount = scaleCount(w.count);
    for (let i = 1; i <= wsCount; i++) {
      const host = `${w.prefix}-${pad3(i)}`;
      const ip = `${base}.${w.startOctet + i - 1}`;
      wsRecords.push({ host, ip, scope: w.scope });
      await insert('dhcp_leases', {
        server_id: dc01, scope_id: w.scope, ip_address: ip,
        hostname: host.toLowerCase(), mac_address: mac(w.oui, i),
        address_state: 'Active', lease_start: daysAgo(2 + (i % 4)),
        lease_expiry: daysAhead(1 + (i % 4)), last_seen: hoursAgo(i % 8),
        device_type: 'workstation', device_vendor: w.vendor, device_os: 'Windows',
        risk_level: 'low', is_mac_randomized: false,
        first_seen: daysAgo(120 + i), last_seen_subnet: w.scope,
      }, ['server_id', 'ip_address']);
    }
  }

  // Voice phones (KL-HQ Voice scope) — count scaled by VOLUME.
  const voiceCount = scaleCount(10);
  for (let i = 1; i <= voiceCount; i++) {
    await insert('dhcp_leases', {
      server_id: dc01, scope_id: '10.10.30.0', ip_address: `10.10.30.${100 + i}`,
      hostname: `ipp-klhq-${pad3(i)}`, mac_address: mac(OUI.yealink, i),
      address_state: 'Active', lease_start: daysAgo(3), lease_expiry: daysAhead(2 + (i % 3)),
      last_seen: hoursAgo(i % 5), device_type: 'voip', device_vendor: 'Yealink',
      device_os: null, risk_level: 'low', is_mac_randomized: false,
      first_seen: daysAgo(200 + i), last_seen_subnet: '10.10.30.0',
    }, ['server_id', 'ip_address']);
  }

  // Wireless clients (KL-HQ Wireless scope) — mix of mobile + laptops, scaled.
  const wifi = [
    { vendor: 'Apple',   oui: OUI.apple,   type: 'mobile',      os: 'iOS',     rand: true  },
    { vendor: 'Samsung', oui: OUI.samsung, type: 'mobile',      os: 'Android', rand: true  },
    { vendor: 'Intel',   oui: OUI.intel,   type: 'workstation', os: 'Windows', rand: false },
  ];
  const wifiCount = scaleCount(15);
  for (let i = 1; i <= wifiCount; i++) {
    const w = wifi[i % wifi.length];
    await insert('dhcp_leases', {
      server_id: dc01, scope_id: '10.10.5.0', ip_address: `10.10.5.${100 + i}`,
      hostname: `wifi-${w.vendor.toLowerCase()}-${pad3(i)}`, mac_address: mac(w.oui, i + 40),
      address_state: 'Active', lease_start: daysAgo(1), lease_expiry: daysAhead(1 + (i % 3)),
      last_seen: hoursAgo(i % 6), device_type: w.type, device_vendor: w.vendor,
      device_os: w.os, risk_level: 'low', is_mac_randomized: w.rand,
      first_seen: daysAgo(10 + i), last_seen_subnet: '10.10.5.0',
    }, ['server_id', 'ip_address']);
  }

  // 4) DNS zones ------------------------------------------------------------
  // Build the record set first so we can set per-zone counts at insert time.
  const records = []; // {zone, hostname, type, data, ttl}
  const addA = (zone, host, ip) => records.push({ zone, hostname: host, type: 'A', data: ip, ttl: 3600 });
  const addCname = (zone, alias, target) => records.push({ zone, hostname: alias, type: 'CNAME', data: target, ttl: 3600 });
  const addPtr = (network, lastOctet, fqdn) =>
    records.push({ zone: reverseZone(network), hostname: String(lastOctet), type: 'PTR', data: fqdn, ttl: 3600 });

  // A records — key infra hosts.
  for (const h of KEY_HOSTS) {
    addA(FWD_ZONE, h.host.toLowerCase(), h.ip);
    addPtr(h.subnet, h.ip.split('.')[3], `${h.host.toLowerCase()}.${FWD_ZONE}`);
  }
  // A records — staff workstations + matching PTRs (count already scaled by VOLUME).
  for (const w of wsRecords) {
    addA(FWD_ZONE, w.host.toLowerCase(), w.ip);
    addPtr(w.scope, w.ip.split('.')[3], `${w.host.toLowerCase()}.${FWD_ZONE}`);
  }
  // Service aliases (CNAME) in the internal zone.
  addCname(FWD_ZONE, 'dc01',  `srv-dc01.${FWD_ZONE}`);
  addCname(FWD_ZONE, 'files', `srv-file01.${FWD_ZONE}`);
  addCname(FWD_ZONE, 'db01',  `srv-db01.${FWD_ZONE}`);
  addCname(FWD_ZONE, 'www',   `srv-web01.${FWD_ZONE}`);
  addCname(FWD_ZONE, 'mail',  `srv-web01.${FWD_ZONE}`);
  addCname(FWD_ZONE, 'vpn',   `fg-klhq-01.${FWD_ZONE}`);
  // Public-facing corp zone.
  addA(CORP_ZONE, 'www',  '10.10.1.20');
  addA(CORP_ZONE, 'mail', '10.10.1.20');
  addA(CORP_ZONE, 'vpn',  '10.10.0.1');

  // Zone definitions: 2 forward + one reverse per /24 subnet.
  const zoneDefs = [
    { name: FWD_ZONE,  reverse: false, ds: true,  type: 'Primary' },
    { name: CORP_ZONE, reverse: false, ds: false, type: 'Primary' },
  ];
  for (const s of SUBNETS) zoneDefs.push({ name: reverseZone(s.network), reverse: true, ds: true, type: 'Primary' });

  const zoneId = {};
  for (const z of zoneDefs) {
    const zr = records.filter((r) => r.zone === z.name);
    const cA = zr.filter((r) => r.type === 'A').length;
    const cPtr = zr.filter((r) => r.type === 'PTR').length;
    const cCname = zr.filter((r) => r.type === 'CNAME').length;
    const soa = 2026010100 + Object.keys(zoneId).length;
    const id = await insertId('dns_zones', {
      server_id: dc01, zone_name: z.name, zone_type: z.type, is_reverse: z.reverse,
      is_ds_integrated: z.ds, is_auto_created: false,
      record_count: zr.length, last_updated: NOW,
      soa_serial: soa, soa_checked_at: hoursAgo(1), replication_lag: false,
      record_count_a: cA, record_count_ptr: cPtr, record_count_cname: cCname,
      record_count_mx: 0, scavenging_enabled: true, aging_enabled: true,
      last_scavenged: daysAgo(3),
    }, ['server_id', 'zone_name']);
    zoneId[z.name] = id;
  }

  // 5) DNS records ----------------------------------------------------------
  for (const r of records) {
    await insert('dns_records', {
      zone_id: zoneId[r.zone], hostname: r.hostname, record_type: r.type,
      record_data: r.data, ttl: r.ttl, last_seen: NOW,
    }, ['zone_id', 'hostname', 'record_type', 'record_data']);
  }

  // 6) DNS server roles + zone sync matrix ----------------------------------
  await insert('dns_server_roles', {
    server_id: dc01, is_primary: true, is_pdc_emulator: true,
    forest_root: FWD_ZONE, domain: FWD_ZONE, replication_type: 'ad-integrated',
  }, ['server_id']);
  await insert('dns_server_roles', {
    server_id: dc02, is_primary: false, is_pdc_emulator: false,
    forest_root: FWD_ZONE, domain: FWD_ZONE, replication_type: 'ad-integrated',
  }, ['server_id']);

  // Per-zone SOA snapshot on BOTH servers — all in sync (sync matrix all green).
  for (const z of zoneDefs) {
    const soa = 2026010100 + zoneDefs.indexOf(z);
    const rc = records.filter((r) => r.zone === z.name).length;
    for (const sid of [dc01, dc02]) {
      await insert('dns_zone_sync', {
        zone_name: z.name, server_id: sid, soa_serial: soa,
        soa_primary: `srv-dc01.${FWD_ZONE}`, soa_email: `hostmaster.${FWD_ZONE}`,
        soa_refresh: 900, soa_retry: 600, soa_expire: 86400, soa_ttl: 3600,
        record_count: rc, is_in_sync: true, lag_seconds: 0, checked_at: hoursAgo(0.5),
      }, ['zone_name', 'server_id']);
    }
  }

  // 7) Per-server health history (uptime trend over DAYS days) --------------
  const healthSpanH = DAYS * 24;
  for (const sid of [dc01, dc02]) {
    for (let h = healthSpanH; h >= 0; h -= 6) {
      await insert('server_health_history', {
        server_id: sid, health_score: 94 + (h % 5), winrm_ok: true,
        scope_count: sid === dc01 ? SCOPES.length : 0,
        lease_count: sid === dc01 ? wsRecords.length + voiceCount + wifiCount : 0,
        zone_count: zoneDefs.length, record_count: records.length,
        query_ms: 8 + (h % 7), soa_in_sync: true, failover_state: 'normal',
        recorded_at: hoursAgo(h),
      });
    }
  }

  // 8) IPAM supernets / subnets / addresses / vlans -------------------------
  const supId = {};
  for (const sup of SUPERNETS) {
    supId[sup.network] = await insertId('ipam_supernets', {
      network: sup.network, prefix_length: sup.prefix_length, name: sup.name,
      description: sup.description, site: sup.site, site_id: sup.site_id,
    }, ['network', 'prefix_length']);
  }

  const subId = {};
  for (const s of SUBNETS) {
    const free = s.total - s.used;
    subId[s.network] = await insertId('ipam_subnets', {
      network: s.network, prefix_length: s.prefix_length, name: s.name,
      description: `${s.site} ${s.role} subnet`, gateway: s.gw, vlan_id: s.vlan,
      site: s.site, site_id: s.site_id, supernet_id: supId[s.sup], is_managed: true,
      is_sensitive: s.sensitive, location: s.site,
      total_hosts: s.total, used_hosts: s.used, free_hosts: free,
      unknown_hosts: s.unknown, scan_status: 'done', last_scanned: hoursAgo(6),
    }, ['network', 'prefix_length']);
  }

  // VLANs.
  for (const s of SUBNETS) {
    await insert('ipam_vlans', {
      vlan_id: s.vlan, name: `${s.site}-${s.role}`,
      description: `${s.name} VLAN`, site: s.site,
    }, ['vlan_id']);
  }

  // Representative IP addresses — gateways, key hosts (reserved/static),
  // and the staff workstations (dhcp). Subnet aggregate counts above carry the
  // dashboard utilization; these rows populate the per-subnet address lists.
  const addrSubnetOf = (ip) => {
    const base = ip.split('.').slice(0, 3).join('.') + '.0';
    return base;
  };
  // Gateways (skip any gateway IP that is already a named key host, e.g. the
  // firewall IS the mgmt gateway — avoids a redundant upsert on the same row).
  const keyHostIps = new Set(KEY_HOSTS.map((h) => h.ip));
  for (const s of SUBNETS) {
    if (keyHostIps.has(s.gw)) continue;
    await insert('ipam_addresses', {
      subnet_id: subId[s.network], ip_address: s.gw, status: 'reserved',
      hostname: `gw-${s.role}-${s.site.toLowerCase()}`, description: 'Default gateway',
      owner: 'Network Team', is_reserved: true, reserved_by: 'netops',
      reserved_at: daysAgo(300), last_seen: hoursAgo(1),
      device_type: 'gateway', risk_level: 'low', is_sensitive: s.sensitive,
      updated_at: NOW,
    }, ['subnet_id', 'ip_address']);
  }
  // Key infra hosts (static / reserved).
  for (const h of KEY_HOSTS) {
    const sn = addrSubnetOf(h.ip);
    if (!subId[sn]) continue;
    await insert('ipam_addresses', {
      subnet_id: subId[sn], ip_address: h.ip, status: 'reserved',
      hostname: h.host.toLowerCase(), mac_address: mac(h.oui, h.i),
      description: `${h.type} (static)`, owner: 'IT Infrastructure',
      is_reserved: true, reserved_by: 'netops', reserved_at: daysAgo(300),
      last_seen: hoursAgo(1), device_type: h.type, device_vendor: h.vendor,
      risk_level: 'low', is_sensitive: addrSubnetOf(h.ip) === '10.10.1.0',
      updated_at: NOW,
    }, ['subnet_id', 'ip_address']);
  }
  // Staff workstations (discovered via DHCP) — count already scaled by VOLUME.
  for (const w of wsRecords) {
    const sn = addrSubnetOf(w.ip);
    await insert('ipam_addresses', {
      subnet_id: subId[sn], ip_address: w.ip, status: 'dhcp',
      hostname: w.host.toLowerCase(), description: 'DHCP-assigned workstation',
      last_seen: hoursAgo(2), device_type: 'workstation', device_vendor: 'Dell',
      risk_level: 'low', is_sensitive: false, updated_at: NOW,
    }, ['subnet_id', 'ip_address']);
  }
  // A couple of "unknown" (rogue/unmanaged) responders for the security view.
  await insert('ipam_addresses', {
    subnet_id: subId['10.10.5.0'], ip_address: '10.10.5.200', status: 'unknown',
    description: 'Responds to ping, no DHCP lease', last_seen: hoursAgo(4),
    device_type: 'unknown', risk_level: 'medium', is_sensitive: false, updated_at: NOW,
  }, ['subnet_id', 'ip_address']);
  await insert('ipam_addresses', {
    subnet_id: subId['10.10.1.0'], ip_address: '10.10.1.205', status: 'unknown',
    mac_address: '02:AA:BB:CC:DD:EE',
    description: 'Unrecognised device on servers subnet', last_seen: hoursAgo(3),
    device_type: 'unknown', risk_level: 'high', is_sensitive: true, updated_at: NOW,
  }, ['subnet_id', 'ip_address']);

  // 9) IPAM utilization history (org-wide trend over DAYS days) --------------
  const totalIPs = SUBNETS.reduce((a, s) => a + s.total, 0);
  const usedFinal = SUBNETS.reduce((a, s) => a + s.used, 0);
  for (let d = DAYS; d >= 0; d--) {
    const frac = 1 - d / DAYS;
    const used = clamp(Math.round(usedFinal * (0.78 + 0.22 * frac)), 0, totalIPs);
    await insert('ipam_utilization_history', {
      recorded_at: daysAgo(d), total_ips: totalIPs, used_ips: used,
      free_ips: totalIPs - used, utilization_pct: round2((used / totalIPs) * 100),
    });
  }

  // 10) Site health scores --------------------------------------------------
  const siteScores = [
    { id: SITE.KLHQ, name: 'KL-HQ', overall: 91, dhcp: 88, ipam: 90, dns: 98, sec: 86 },
    { id: SITE.PEN,  name: 'PEN',   overall: 94, dhcp: 95, ipam: 92, dns: 97, sec: 90 },
    { id: SITE.JB,   name: 'JB',    overall: 96, dhcp: 96, ipam: 95, dns: 98, sec: 94 },
  ];
  for (const s of siteScores) {
    await insert('site_health_scores', {
      site_id: s.id, site_name: s.name, calculated_at: NOW,
      overall_score: s.overall, dhcp_score: s.dhcp, ipam_score: s.ipam,
      dns_score: s.dns, security_score: s.sec,
      details: JSON.stringify({ demo: true, site: s.name }),
    });
  }

  // 11) A few anomalies for the Security Overview / Intelligence tab ---------
  const anomalies = [
    { t: 'new_device_vip_subnet', sev: 'critical', et: 'device', eid: '10.10.1.205', desc: 'New unknown device on SENSITIVE servers subnet 10.10.1.0/24', det: { demo: true, subnet: '10.10.1.0/24' }, ago: 3 },
    { t: 'mac_spoofing',          sev: 'warning',  et: 'device', eid: '10.10.5.200', desc: 'IP 10.10.5.200 seen with multiple MAC addresses', det: { demo: true }, ago: 8 },
    { t: 'lease_spike',           sev: 'info',     et: 'scope',  eid: '10.10.5.0',   desc: 'Wireless lease count above baseline during business hours', det: { demo: true, current: 118, avg: 100 }, ago: 20 },
  ];
  for (const a of anomalies) {
    await insert('anomaly_events', {
      detected_at: hoursAgo(a.ago), anomaly_type: a.t, severity: a.sev,
      entity_type: a.et, entity_id: a.eid, description: a.desc,
      details: JSON.stringify(a.det), acknowledged: false,
    });
  }
}

// ── runner ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    await client.connect();
    console.log(`DDIVault demo seed — db=${client.database} reset=${RESET} days=${DAYS} volume=${VOLUME} (x${VOL_FACTOR})`);
    await client.query('BEGIN');
    await cleanup();
    await seed();
    await client.query('COMMIT');
    console.log('\nSeed complete. Rows inserted/upserted per table:');
    const tables = Object.keys(counts).sort();
    let total = 0;
    for (const t of tables) {
      total += counts[t];
      console.log('  ' + t.padEnd(24) + counts[t]);
    }
    console.log('  ' + '-'.repeat(30));
    console.log('  ' + 'TOTAL'.padEnd(24) + total);
    await client.end();
    process.exit(0);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* not connected */ }
    console.error('\nSeed FAILED — transaction rolled back:\n', err);
    try { await client.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
})();
