#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * SpanVault — DEMO DATA seed script  (NocVault suite)
 * ============================================================================
 * Generates a realistic small network-monitoring dataset for the shared
 * NocVault demo scenario (org "Cahaya Teknologi Sdn Bhd", sites KL-HQ / PEN /
 * JB) so the SpanVault dashboard, Devices page, device-detail graphs, Alerts,
 * Network Map and Wireless views all render with believable data.
 *
 * WHAT IT SEEDS (all real tables/columns from spanvault/scripts/schema.sql):
 *   monitored_devices        routers/switches/firewalls/APs/servers, 3 sites
 *   ping_results             ICMP up/down + latency + packet-loss history
 *   snmp_results             cpu_pct / mem_pct / if_in_bps / if_out_bps history
 *   availability_summary     per-device-per-day uptime%/avg/min/max response
 *   alerts                   device_down / response_time / cpu_pct / mem_pct …
 *   wireless_controllers     one Aruba controller per site
 *   wireless_aps             the AP devices, linked to their controller
 *   wireless_ssids           corp + guest SSID per controller
 *   wireless_clients         current client snapshot (some flagged is_problem)
 *   wireless_history         per-AP clients/util time-series
 *   sv_maps / map_devices / map_connections / map_labels   one KL-HQ core map
 *
 * SAFETY — connect as a SUPERUSER / table owner (postgres):
 *   - Touches ONLY the demo-owned rows above. NEVER touches app_settings,
 *     alert_rules, users/auth/audit/session tables.
 *   - Demo rows are scoped by their natural keys: monitored_devices by
 *     ip_address, wireless_controllers + sv_maps by name. Deleting a demo
 *     device CASCADEs to ping_results/snmp_results/alerts/availability_summary;
 *     deleting a demo controller CASCADEs to its APs/clients/ssids/history;
 *     deleting a demo map CASCADEs to its devices/connections/labels.
 *   - Idempotent: parents upsert on their natural key; the demo children are
 *     cleared and regenerated on every run, so re-running is stable (no dup).
 *   - RESET=1 (default) additionally drops the demo parent rows first (full
 *     clean) so renamed/removed demo devices never linger.
 *
 * ENV (names + defaults):
 *   PGHOST      localhost
 *   PGPORT      5432
 *   PGUSER      postgres
 *   PGPASSWORD  (REQUIRED — no default; fail fast if missing)
 *   PGDATABASE  spanvault
 *   DAYS        14        history window (days back from now)
 *   VOLUME      normal    light x0.4 | normal x1 | heavy x2.5  (device count + sampling density)
 *   RESET       1         1/true = wipe demo parents first, then reseed
 *
 * USAGE (run on the demo/test box where Postgres is local):
 *   PGPASSWORD=... node spanvault-seed.js
 *   RESET=1 DAYS=14 VOLUME=heavy PGPASSWORD=... node spanvault-seed.js
 *
 * `pg` resolves at runtime via NODE_PATH set by the suite launcher.
 * ============================================================================
 */

const { Client } = require('pg');

// ── env / tunables ──────────────────────────────────────────────────────────
if (!process.env.PGPASSWORD) {
  console.error('SEED FAILED: PGPASSWORD is required (no default). Set it and re-run.');
  process.exit(1);
}
const DAYS = Math.max(1, parseInt(process.env.DAYS || '14', 10) || 14);
const RESET = process.env.RESET === undefined ? true
  : (process.env.RESET === '1' || process.env.RESET.toLowerCase() === 'true');
const VOLUME = (process.env.VOLUME || 'normal').toLowerCase();
const FACTOR = VOLUME === 'light' ? 0.4 : VOLUME === 'heavy' ? 2.5 : 1;

const conn = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'spanvault',
  ssl: false,
};
const client = new Client(conn);

// ── tiny helpers ────────────────────────────────────────────────────────────
const ri = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rf = (a, b) => Math.random() * (b - a) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Busier during work hours — drives latency/util/cpu diurnal shape.
const HOUR_LOAD = [
  0.15, 0.12, 0.10, 0.10, 0.12, 0.18, // 00-05
  0.30, 0.50, 0.80, 0.95, 1.00, 0.95, // 06-11
  0.85, 0.92, 1.00, 0.98, 0.90, 0.75, // 12-17
  0.55, 0.45, 0.38, 0.30, 0.22, 0.18, // 18-23
];
function loadAt(d) {
  const wk = (d.getDay() === 0 || d.getDay() === 6) ? 0.45 : 1; // quieter weekends
  return HOUR_LOAD[d.getHours()] * wk;
}

function randMac(oui) {
  const b = () => ri(0, 255).toString(16).padStart(2, '0');
  return `${oui}:${b()}:${b()}:${b()}`;
}

// ── shared scenario: sites (match netvault/logvault site codes + ids) ────────
const SITES = [
  { code: 'KL-HQ', id: 1, name: 'Kuala Lumpur HQ', sub: 10 },
  { code: 'PEN',   id: 2, name: 'Penang Branch',   sub: 20 },
  { code: 'JB',    id: 3, name: 'Johor Bahru Branch', sub: 30 },
];
const siteBy = Object.fromEntries(SITES.map((s) => [s.code, s]));

// Base monitored devices (~22). baseMs = normal latency floor as seen from the
// central collector (remote sites are higher). cpu/mem = idle baseline.
const T = { FW: 'Firewall', CORE: 'Core Switch', ACC: 'Access Switch', RTR: 'Router', SRV: 'Server', AP: 'Wireless AP' };
const BASE_DEVICES = [
  // ── KL-HQ (10.10.x) ──
  { host: 'FG-KLHQ-01',      ip: '10.10.0.1',   type: T.FW,   vendor: 'Fortinet', model: 'FortiGate-100F', site: 'KL-HQ', gw: true,  snmp: true,  baseMs: 2,  cpu: 22, mem: 55 },
  { host: 'SW-KLHQ-CORE-01', ip: '10.10.0.2',   type: T.CORE, vendor: 'Cisco',    model: 'C9300-48P',      site: 'KL-HQ', snmp: true,  baseMs: 1,  cpu: 30, mem: 48 },
  { host: 'SW-KLHQ-CORE-02', ip: '10.10.0.3',   type: T.CORE, vendor: 'Cisco',    model: 'C9300-48P',      site: 'KL-HQ', snmp: true,  baseMs: 1,  cpu: 28, mem: 47 },
  { host: 'SW-KLHQ-ACC-01',  ip: '10.10.0.10',  type: T.ACC,  vendor: 'Cisco',    model: 'C9200-24P',      site: 'KL-HQ', snmp: true,  baseMs: 2,  cpu: 18, mem: 40 },
  { host: 'SW-KLHQ-ACC-02',  ip: '10.10.0.11',  type: T.ACC,  vendor: 'Cisco',    model: 'C9200-24P',      site: 'KL-HQ', snmp: true,  baseMs: 2,  cpu: 19, mem: 41 },
  { host: 'RTR-WAN-01',      ip: '10.10.0.254', type: T.RTR,  vendor: 'Cisco',    model: 'ISR4331',        site: 'KL-HQ', snmp: true,  baseMs: 5,  cpu: 40, mem: 58 },
  { host: 'AP-KLHQ-01',      ip: '10.10.5.11',  type: T.AP,   vendor: 'Aruba',    model: 'AP-515',         site: 'KL-HQ', snmp: false, baseMs: 3,  cpu: 0,  mem: 0 },
  { host: 'AP-KLHQ-02',      ip: '10.10.5.12',  type: T.AP,   vendor: 'Aruba',    model: 'AP-515',         site: 'KL-HQ', snmp: false, baseMs: 3,  cpu: 0,  mem: 0 },
  { host: 'AP-KLHQ-03',      ip: '10.10.5.13',  type: T.AP,   vendor: 'Aruba',    model: 'AP-515',         site: 'KL-HQ', snmp: false, baseMs: 4,  cpu: 0,  mem: 0 },
  { host: 'SRV-DC01',        ip: '10.10.1.10',  type: T.SRV,  vendor: 'Dell',     model: 'PowerEdge-R650', site: 'KL-HQ', snmp: true,  baseMs: 1,  cpu: 35, mem: 62 },
  { host: 'SRV-FILE01',      ip: '10.10.1.11',  type: T.SRV,  vendor: 'Dell',     model: 'PowerEdge-R640', site: 'KL-HQ', snmp: true,  baseMs: 1,  cpu: 50, mem: 78 },
  { host: 'SRV-DB01',        ip: '10.10.1.30',  type: T.SRV,  vendor: 'Dell',     model: 'PowerEdge-R750', site: 'KL-HQ', snmp: true,  baseMs: 1,  cpu: 45, mem: 70 },
  // ── PEN (10.20.x) ──
  { host: 'FG-PEN-01',       ip: '10.20.0.1',   type: T.FW,   vendor: 'Fortinet', model: 'FortiGate-60F',  site: 'PEN',   gw: true,  snmp: true,  baseMs: 14, cpu: 20, mem: 52 },
  { host: 'SW-PEN-CORE-01',  ip: '10.20.0.2',   type: T.CORE, vendor: 'Aruba',    model: '6300M',          site: 'PEN',   snmp: true,  baseMs: 15, cpu: 24, mem: 45 },
  { host: 'SW-PEN-ACC-01',   ip: '10.20.0.10',  type: T.ACC,  vendor: 'Aruba',    model: '6100',           site: 'PEN',   snmp: true,  baseMs: 16, cpu: 17, mem: 38 },
  { host: 'AP-PEN-01',       ip: '10.20.5.11',  type: T.AP,   vendor: 'Aruba',    model: 'AP-505',         site: 'PEN',   snmp: false, baseMs: 17, cpu: 0,  mem: 0 },
  { host: 'SRV-PEN-APP01',   ip: '10.20.1.10',  type: T.SRV,  vendor: 'Dell',     model: 'PowerEdge-R640', site: 'PEN',   snmp: true,  baseMs: 15, cpu: 33, mem: 60 },
  // ── JB (10.30.x) ──
  { host: 'FG-JB-01',        ip: '10.30.0.1',   type: T.FW,   vendor: 'Fortinet', model: 'FortiGate-40F',  site: 'JB',    gw: true,  snmp: true,  baseMs: 22, cpu: 26, mem: 54 },
  { host: 'SW-JB-CORE-01',   ip: '10.30.0.2',   type: T.CORE, vendor: 'Aruba',    model: '6300M',          site: 'JB',    snmp: true,  baseMs: 23, cpu: 25, mem: 46 },
  { host: 'SW-JB-ACC-01',    ip: '10.30.0.10',  type: T.ACC,  vendor: 'Aruba',    model: '6100',           site: 'JB',    snmp: true,  baseMs: 24, cpu: 16, mem: 37 },
  { host: 'AP-JB-01',        ip: '10.30.5.11',  type: T.AP,   vendor: 'Aruba',    model: 'AP-505',         site: 'JB',    snmp: false, baseMs: 25, cpu: 0,  mem: 0 },
  { host: 'SRV-JB-APP01',    ip: '10.30.1.10',  type: T.SRV,  vendor: 'Dell',     model: 'PowerEdge-R640', site: 'JB',    snmp: true,  baseMs: 23, cpu: 30, mem: 58 },
];

// Believable incident windows (hours back from now). kind:
//   down    — device unreachable (status down, 100% loss)
//   latency — sustained latency spike (warning)
//   loss    — intermittent packet loss + latency
//   cpu     — sustained high CPU (fires cpu_pct alert)
//   mem     — sustained high memory (fires mem_pct alert)
const INCIDENTS = {
  'SW-KLHQ-ACC-02': [{ kind: 'down',    startH: 76, durH: 2.5 }],           // switch outage 3d ago
  'RTR-WAN-01':     [{ kind: 'loss',    startH: 30, durH: 3 },              // WAN flap yesterday
                     { kind: 'latency', startH: 6,  durH: 2 }],
  'FG-JB-01':       [{ kind: 'latency', startH: 10, durH: 4 }],             // JB WAN congestion
  'SRV-FILE01':     [{ kind: 'mem',     startH: 0,  durH: 5 }],             // ongoing high memory
  'SRV-DB01':       [{ kind: 'cpu',     startH: 2,  durH: 3 }],             // DB CPU burst
  'AP-PEN-01':      [{ kind: 'down',    startH: 48, durH: 1.5 }],           // AP reboot 2d ago
  'SW-PEN-ACC-01':  [{ kind: 'latency', startH: 120, durH: 2 }],
};

// Scale device count by VOLUME. Always keep gateways + core switches; add
// synthetic access-switch/AP rows for heavy, trim the tail for light.
function buildDevices() {
  const must = BASE_DEVICES.filter((d) => d.gw || d.type === T.CORE);
  const rest = BASE_DEVICES.filter((d) => !(d.gw || d.type === T.CORE));
  const target = Math.max(must.length, Math.round(BASE_DEVICES.length * FACTOR));

  let list = BASE_DEVICES.slice();
  if (target < list.length) {
    // light: keep the must-have set, then fill from the rest up to target.
    list = must.concat(rest).slice(0, target);
    // ensure must-haves are present (they lead the concat, so they are).
  } else if (target > list.length) {
    // heavy: append synthetic APs / access switches round-robin per site.
    let n = 0;
    while (list.length < target) {
      const s = SITES[n % SITES.length];
      const idx = Math.floor(n / SITES.length) + 1;
      const even = n % 2 === 0;
      if (even) {
        list.push({ host: `AP-${s.code}-EX${idx}`, ip: `10.${s.sub}.6.${20 + idx}`, type: T.AP,
          vendor: 'Aruba', model: 'AP-515', site: s.code, snmp: false, baseMs: 3 + (s.sub === 10 ? 0 : 12), cpu: 0, mem: 0, synthetic: true });
      } else {
        list.push({ host: `SW-${s.code}-ACC-EX${idx}`, ip: `10.${s.sub}.0.${40 + idx}`, type: T.ACC,
          vendor: 'Aruba', model: '6100', site: s.code, snmp: true, baseMs: 2 + (s.sub === 10 ? 0 : 14), cpu: ri(14, 22), mem: ri(35, 45), synthetic: true });
      }
      n++;
    }
  }
  // Attach resolved site fields + incidents.
  return list.map((d) => {
    const s = siteBy[d.site];
    return { ...d, site_id: s.id, site_name: s.name, sub: s.sub, incidents: INCIDENTS[d.host] || [] };
  });
}

// Which incident (if any) covers timestamp t, given hours-ago.
function incidentAt(dev, hoursAgo) {
  for (const inc of dev.incidents) {
    if (hoursAgo <= inc.startH && hoursAgo >= inc.startH - inc.durH) return inc;
  }
  return null;
}

// ── batch insert (respects the 65535-param limit) ───────────────────────────
async function insertBatch(table, cols, rows) {
  if (!rows.length) return 0;
  const chunkSize = Math.max(1, Math.floor(60000 / cols.length));
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    for (const r of chunk) {
      values.push('(' + cols.map(() => `$${p++}`).join(',') + ')');
      for (const c of cols) params.push(r[c]);
    }
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
    total += chunk.length;
  }
  return total;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  await client.connect();
  console.log(`[spanvault-seed] connected to ${conn.user}@${conn.host}:${conn.port}/${conn.database}`);
  console.log(`[spanvault-seed] DAYS=${DAYS}  VOLUME=${VOLUME} (x${FACTOR})  RESET=${RESET}`);

  const devices = buildDevices();
  const demoIps = devices.map((d) => d.ip);
  const ctrlNames = SITES.map((s) => `Aruba-Central-${s.code}`);
  const mapNames = ['Cahaya Teknologi — KL-HQ Core'];
  const summary = {};

  // sampling interval: base 30 min, denser with VOLUME.
  const intervalMin = Math.max(5, Math.round(30 / FACTOR));
  const intervalMs = intervalMin * 60 * 1000;
  const now = Date.now();
  const windowMs = DAYS * 24 * 3600 * 1000;
  console.log(`[spanvault-seed] ${devices.length} devices, sampling every ${intervalMin} min over ${DAYS} days`);

  // ── 1) RESET: drop demo parent rows (children CASCADE) ─────────────────────
  if (RESET) {
    // controllers first (cascade APs/clients/ssids/history/events), then maps
    // (cascade map_devices/connections/labels/shapes), then devices (cascade
    // ping_results/snmp_results/alerts/availability_summary/sensors/baselines).
    const c = await client.query('DELETE FROM wireless_controllers WHERE name = ANY($1::text[])', [ctrlNames]);
    const m = await client.query('DELETE FROM sv_maps WHERE name = ANY($1::text[])', [mapNames]);
    const d = await client.query('DELETE FROM monitored_devices WHERE ip_address = ANY($1::text[])', [demoIps]);
    console.log(`[spanvault-seed] RESET removed: controllers=${c.rowCount} maps=${m.rowCount} devices=${d.rowCount} (+cascaded children)`);
  }

  // ── 2) monitored_devices (upsert on ip_address) ────────────────────────────
  const idByIp = {};
  for (const d of devices) {
    const { rows } = await client.query(
      `INSERT INTO monitored_devices
         (name, ip_address, device_type, site_id, site_name, netvault_device_id,
          snmp_enabled, snmp_version, snmp_community, snmp_port, poll_interval_seconds,
          ping_threshold_ms, ping_failures_before_down, current_status, consecutive_failures,
          active, is_gateway, device_vendor, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'2c','public',161,300,500,3,'unknown',0,TRUE,$7,$8,NOW(),NOW())
       ON CONFLICT (ip_address) DO UPDATE SET
         name=EXCLUDED.name, device_type=EXCLUDED.device_type, site_id=EXCLUDED.site_id,
         site_name=EXCLUDED.site_name, snmp_enabled=EXCLUDED.snmp_enabled,
         is_gateway=EXCLUDED.is_gateway, device_vendor=EXCLUDED.device_vendor,
         active=TRUE, updated_at=NOW()
       RETURNING id`,
      [d.host, d.ip, d.type, d.site_id, d.site_name, d.snmp, !!d.gw, d.vendor]
    );
    idByIp[d.ip] = rows[0].id;
    d.id = rows[0].id;
  }
  summary.monitored_devices = devices.length;
  const devIds = devices.map((d) => d.id);

  // ── 3) clear demo children (idempotency for non-RESET re-runs) ─────────────
  await client.query('DELETE FROM ping_results        WHERE device_id = ANY($1::int[])', [devIds]);
  await client.query('DELETE FROM snmp_results         WHERE device_id = ANY($1::int[])', [devIds]);
  await client.query('DELETE FROM availability_summary WHERE device_id = ANY($1::int[])', [devIds]);
  await client.query('DELETE FROM alerts               WHERE device_id = ANY($1::int[])', [devIds]);

  // ── 4) generate ping + snmp history, aggregate availability ────────────────
  const pingRows = [];
  const snmpRows = [];
  // availability accumulator: key `${devId}|${date}`
  const avail = {};
  // remember each device's final sample to set its live current_status.
  const lastSample = {};

  for (const d of devices) {
    // per-device latency jitter multiplier so devices differ a little.
    const jitter = rf(0.85, 1.25);
    for (let t = now - windowMs; t <= now; t += intervalMs) {
      const when = new Date(t);
      const hoursAgo = (now - t) / 3600000;
      const inc = incidentAt(d, hoursAgo);
      const load = loadAt(when);

      let status = 'up';
      let responseMs = null;
      let lossPct = 0;

      if (inc && inc.kind === 'down') {
        status = 'down'; responseMs = null; lossPct = 100;
      } else {
        let ms = d.baseMs * jitter * (1 + load * 0.6) + rf(0, d.baseMs * 0.4 + 1.5);
        if (inc && inc.kind === 'latency') ms = ms * rf(6, 12) + rf(80, 220);
        if (inc && inc.kind === 'loss') { ms = ms * rf(2, 5) + rf(20, 90); lossPct = rf(4, 22); }
        // rare healthy-state blips
        if (!inc && Math.random() < 0.01) lossPct = rf(1, 6);
        responseMs = round1(ms);
        status = (responseMs > 500 || lossPct >= 15) ? 'warning' : 'up';
      }

      pingRows.push({ device_id: d.id, ts: when, response_ms: responseMs, packet_loss_pct: round1(lossPct), status });

      // daily availability aggregate
      const key = `${d.id}|${dateStr(when)}`;
      const a = avail[key] || (avail[key] = { device_id: d.id, date: dateStr(when), total: 0, failed: 0, sum: 0, cnt: 0, min: null, max: null });
      a.total += 1;
      if (status === 'down') a.failed += 1;
      if (responseMs != null) {
        a.sum += responseMs; a.cnt += 1;
        a.min = a.min == null ? responseMs : Math.min(a.min, responseMs);
        a.max = a.max == null ? responseMs : Math.max(a.max, responseMs);
      }

      // SNMP: cpu_pct / mem_pct for snmp devices; if_*_bps for gateways + cores.
      if (d.snmp && status !== 'down') {
        let cpu = clamp(d.cpu + load * 22 + rf(-6, 6), 1, 99);
        let mem = clamp(d.mem + load * 10 + rf(-4, 4), 1, 99);
        if (inc && inc.kind === 'cpu') cpu = clamp(rf(83, 97), 1, 99);
        if (inc && inc.kind === 'mem') mem = clamp(rf(88, 97), 1, 99);
        snmpRows.push({ device_id: d.id, ts: when, oid: '1.3.6.1.4.1.9.9.109.1.1.1.1.7', metric_name: 'cpu_pct', value: round1(cpu), if_index: null, if_name: null });
        snmpRows.push({ device_id: d.id, ts: when, oid: '1.3.6.1.4.1.9.9.48.1.1.1.5',    metric_name: 'mem_pct', value: round1(mem), if_index: null, if_name: null });

        if (d.gw || d.type === T.CORE) {
          const capBps = d.type === T.CORE ? 1e9 : 5e8;
          const inBps = Math.round(capBps * clamp(load * rf(0.25, 0.55) + rf(0, 0.05), 0, 0.95));
          const outBps = Math.round(capBps * clamp(load * rf(0.18, 0.42) + rf(0, 0.05), 0, 0.95));
          snmpRows.push({ device_id: d.id, ts: when, oid: '1.3.6.1.2.1.31.1.1.1.6.1',  metric_name: 'if_in_bps',  value: inBps,  if_index: 1, if_name: 'Uplink-1' });
          snmpRows.push({ device_id: d.id, ts: when, oid: '1.3.6.1.2.1.31.1.1.1.10.1', metric_name: 'if_out_bps', value: outBps, if_index: 1, if_name: 'Uplink-1' });
        }
      }

      lastSample[d.id] = { status, responseMs, when };
    }
  }

  summary.ping_results = await insertBatch('ping_results',
    ['device_id', 'ts', 'response_ms', 'packet_loss_pct', 'status'], pingRows);
  summary.snmp_results = await insertBatch('snmp_results',
    ['device_id', 'ts', 'oid', 'metric_name', 'value', 'if_index', 'if_name'], snmpRows);

  // availability_summary upsert
  const availRows = Object.values(avail).map((a) => ({
    device_id: a.device_id,
    date: a.date,
    uptime_pct: round1(a.total ? ((a.total - a.failed) / a.total) * 100 : 100),
    avg_response_ms: a.cnt ? round1(a.sum / a.cnt) : null,
    min_response_ms: a.min,
    max_response_ms: a.max,
    total_checks: a.total,
    failed_checks: a.failed,
  }));
  let availCount = 0;
  for (const a of availRows) {
    await client.query(
      `INSERT INTO availability_summary
         (device_id, date, uptime_pct, avg_response_ms, min_response_ms, max_response_ms, total_checks, failed_checks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id, date) DO UPDATE SET
         uptime_pct=EXCLUDED.uptime_pct, avg_response_ms=EXCLUDED.avg_response_ms,
         min_response_ms=EXCLUDED.min_response_ms, max_response_ms=EXCLUDED.max_response_ms,
         total_checks=EXCLUDED.total_checks, failed_checks=EXCLUDED.failed_checks`,
      [a.device_id, a.date, a.uptime_pct, a.avg_response_ms, a.min_response_ms, a.max_response_ms, a.total_checks, a.failed_checks]
    );
    availCount++;
  }
  summary.availability_summary = availCount;

  // ── 5) update monitored_devices live status from the final sample ──────────
  for (const d of devices) {
    const s = lastSample[d.id];
    if (!s) continue;
    const cur = s.status;
    const consec = cur === 'down' ? ri(3, 8) : 0;
    await client.query(
      `UPDATE monitored_devices
         SET current_status=$2, last_response_ms=$3, consecutive_failures=$4,
             last_checked_at=$5, last_seen_at=$6, updated_at=NOW()
       WHERE id=$1`,
      [d.id, cur, s.responseMs, consec, s.when, cur === 'down' ? new Date(s.when.getTime() - consec * intervalMs) : s.when]
    );
  }

  // ── 6) alerts (curated, tied to the incidents above) ───────────────────────
  const alertRows = [];
  const at = (h) => new Date(now - h * 3600000);
  const pushAlert = (host, type, sev, msg, val, trigH, opts = {}) => {
    const id = idByIp[BASE_DEVICES.find((b) => b.host === host)?.ip];
    if (!id) return; // device trimmed out at this VOLUME
    const triggered = at(trigH);
    alertRows.push({
      device_id: id, alert_type: type, severity: sev, message: msg, metric_value: val,
      triggered_at: triggered,
      acknowledged_at: opts.ackH != null ? at(opts.ackH) : null,
      acknowledged_by: opts.ackH != null ? 'demo-noc' : null,
      resolved_at: opts.resolvedH != null ? at(opts.resolvedH) : null,
      status: opts.resolvedH != null ? 'resolved' : 'active',
    });
  };
  // resolved historical
  pushAlert('SW-KLHQ-ACC-02', 'device_down',   'critical', 'SW-KLHQ-ACC-02 is unreachable (3 consecutive ICMP failures)', null, 76, { ackH: 75.5, resolvedH: 73.5 });
  pushAlert('AP-PEN-01',       'device_down',   'critical', 'AP-PEN-01 is unreachable — access point offline', null, 48, { ackH: 47.8, resolvedH: 46.5 });
  pushAlert('RTR-WAN-01',      'packet_loss',   'warning',  'RTR-WAN-01 packet loss 18% over WAN uplink', 18, 30, { resolvedH: 27 });
  pushAlert('SW-PEN-ACC-01',   'response_time', 'warning',  'SW-PEN-ACC-01 response time above threshold (612 ms)', 612, 120, { ackH: 119, resolvedH: 118 });
  // active / ongoing
  pushAlert('SRV-FILE01',      'mem_pct',       'warning',  'SRV-FILE01 memory utilization high (92%)', 92, 4.5);
  pushAlert('SRV-DB01',        'cpu_pct',       'critical', 'SRV-DB01 CPU utilization critical (95%)', 95, 2.5);
  pushAlert('FG-JB-01',        'response_time', 'warning',  'FG-JB-01 latency elevated (WAN congestion, ~180 ms)', 180, 3.5);
  pushAlert('RTR-WAN-01',      'response_time', 'warning',  'RTR-WAN-01 latency spike detected', 140, 1.5);
  summary.alerts = await insertBatch('alerts',
    ['device_id', 'alert_type', 'severity', 'message', 'metric_value', 'triggered_at',
     'acknowledged_at', 'acknowledged_by', 'resolved_at', 'status'], alertRows);

  // ── 7) wireless (controller + APs + SSIDs + clients + history per site) ─────
  let ctrlCount = 0, apCount = 0, ssidCount = 0, clientCount = 0, whistCount = 0;
  const CLIENT_HOSTS = ['ali-laptop', 'siti-iphone', 'kumar-android', 'wong-macbook', 'meeting-tv', 'nurul-ipad', 'guest-win11', 'faizal-pixel'];
  for (const s of SITES) {
    const ctrlName = `Aruba-Central-${s.code}`;
    // get-or-create controller by name (no unique index → manual)
    let ctrlId;
    const existing = await client.query('SELECT id FROM wireless_controllers WHERE name=$1', [ctrlName]);
    if (existing.rows.length) {
      ctrlId = existing.rows[0].id;
      // clear its demo children before regenerating (idempotency)
      const apsRows = await client.query('SELECT id FROM wireless_aps WHERE controller_id=$1', [ctrlId]);
      const apIds = apsRows.rows.map((r) => r.id);
      if (apIds.length) await client.query('DELETE FROM wireless_history WHERE ap_id = ANY($1::int[])', [apIds]);
      await client.query('DELETE FROM wireless_clients WHERE controller_id=$1', [ctrlId]);
      await client.query('DELETE FROM wireless_ssids   WHERE controller_id=$1', [ctrlId]);
      await client.query('DELETE FROM wireless_aps     WHERE controller_id=$1', [ctrlId]);
      await client.query('UPDATE wireless_controllers SET status=$2, last_polled_at=NOW() WHERE id=$1', [ctrlId, 'ok']);
    } else {
      const ins = await client.query(
        `INSERT INTO wireless_controllers (name, vendor, site_id, site_name, poll_interval_seconds, active, status, model, firmware_version, last_polled_at)
         VALUES ($1,'aruba',$2,$3,300,TRUE,'ok',$4,$5,NOW()) RETURNING id`,
        [ctrlName, s.id, s.name, 'Aruba 7205 Mobility Controller', '8.10.0.7']
      );
      ctrlId = ins.rows[0].id;
    }
    ctrlCount++;

    // APs = the AP-type demo devices at this site
    const siteAps = devices.filter((d) => d.type === T.AP && d.site === s.code);
    const apIdByHost = {};
    for (const ap of siteAps) {
      const online = lastSample[ap.id] && lastSample[ap.id].status !== 'down';
      const c2 = online ? ri(3, 18) : 0;
      const c5 = online ? ri(8, 32) : 0;
      const ins = await client.query(
        `INSERT INTO wireless_aps
           (controller_id, monitored_device_id, name, mac_address, model, ip_address, site_id, site_name,
            status, radio_2g_channel, radio_5g_channel, radio_2g_util_pct, radio_5g_util_pct,
            clients_2g, clients_5g, clients_total, tx_power_2g, tx_power_5g, uptime_seconds,
            firmware_version, last_seen_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),NOW())
         RETURNING id`,
        [ctrlId, ap.id, ap.host, randMac('20:4c:03'), ap.model, ap.ip, s.id, s.name,
         online ? 'online' : 'offline', pick([1, 6, 11]), pick([36, 44, 149, 157]),
         round1(rf(5, 35)), round1(rf(15, 60)), c2, c5, c2 + c5, 12, 18,
         online ? ri(200000, 3000000) : 0, '8.10.0.7']
      );
      apIdByHost[ap.host] = ins.rows[0].id;
      apCount++;

      // per-AP history (hourly over the window — coarser than ping to bound rows)
      const wh = [];
      for (let t = now - windowMs; t <= now; t += 3600000) {
        const when = new Date(t);
        const load = loadAt(when);
        const online2 = !(incidentAt(ap, (now - t) / 3600000) || {}).kind;
        const tot = online2 ? Math.round((c2 + c5 + 4) * load + rf(0, 3)) : 0;
        wh.push({ ap_id: ins.rows[0].id, ts: when, clients_total: tot,
          clients_2g: Math.round(tot * 0.35), clients_5g: Math.round(tot * 0.65),
          radio_2g_util: round1(clamp(load * 40 + rf(0, 10), 0, 100)),
          radio_5g_util: round1(clamp(load * 55 + rf(0, 12), 0, 100)) });
      }
      whistCount += await insertBatch('wireless_history',
        ['ap_id', 'ts', 'clients_total', 'clients_2g', 'clients_5g', 'radio_2g_util', 'radio_5g_util'], wh);
    }

    // SSIDs
    for (const ssid of ['Cahaya-Corp', 'Cahaya-Guest']) {
      const total = siteAps.reduce((n, ap) => n + (lastSample[ap.id] && lastSample[ap.id].status !== 'down' ? ri(4, 20) : 0), 0);
      await client.query(
        `INSERT INTO wireless_ssids (controller_id, ssid_name, site_id, site_name, status, clients_total, bytes_in, bytes_out, auth_successes, auth_failures)
         VALUES ($1,$2,$3,$4,'up',$5,$6,$7,$8,$9)`,
        [ctrlId, ssid, s.id, s.name, ssid.endsWith('Guest') ? Math.round(total * 0.4) : total,
         ri(1e8, 9e9), ri(1e8, 9e9), ri(200, 3000), ri(0, 40)]
      );
      ssidCount++;
    }

    // Current client snapshot (a handful; some flagged is_problem on poor RSSI)
    const onlineAps = siteAps.filter((ap) => lastSample[ap.id] && lastSample[ap.id].status !== 'down');
    const nClients = Math.max(2, Math.round(6 * FACTOR));
    for (let i = 0; i < nClients && onlineAps.length; i++) {
      const ap = pick(onlineAps);
      const rssi = ri(-88, -42);
      const band = pick(['2.4GHz', '5GHz', '5GHz']);
      const roam = ri(0, 8);
      await client.query(
        `INSERT INTO wireless_clients
           (mac_address, ip_address, hostname, controller_id, ap_id, ap_name, ssid_name, band, channel,
            rssi_dbm, tx_rate_mbps, rx_rate_mbps, connected_since, last_seen_at, auth_type, is_problem, is_sticky, roaming_count, vendor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14,$15,$16,$17,'aruba')
         ON CONFLICT (controller_id, mac_address) DO NOTHING`,
        [randMac('a4:83:e7'), `10.${s.sub}.${ri(20, 40)}.${ri(2, 250)}`, `${pick(CLIENT_HOSTS)}-${i}`,
         ctrlId, apIdByHost[ap.host], ap.host, pick(['Cahaya-Corp', 'Cahaya-Guest']), band,
         band === '2.4GHz' ? pick([1, 6, 11]) : pick([36, 44, 149]), rssi,
         round1(rf(6, 866)), round1(rf(6, 866)), pick(['wpa2-psk', 'wpa2-enterprise', 'wpa3-sae']),
         rssi < -75, rssi < -75 && roam <= 2, roam]
      );
      clientCount++;
    }
  }
  summary.wireless_controllers = ctrlCount;
  summary.wireless_aps = apCount;
  summary.wireless_ssids = ssidCount;
  summary.wireless_clients = clientCount;
  summary.wireless_history = whistCount;

  // ── 8) network map (KL-HQ core) ────────────────────────────────────────────
  const klCore = devices.filter((d) => d.site === 'KL-HQ' &&
    ['FG-KLHQ-01', 'SW-KLHQ-CORE-01', 'SW-KLHQ-CORE-02', 'SW-KLHQ-ACC-01', 'SW-KLHQ-ACC-02', 'SRV-DC01', 'SRV-DB01', 'AP-KLHQ-01']
      .includes(d.host));
  if (klCore.length) {
    // get-or-create map by name
    let mapId;
    const em = await client.query('SELECT id FROM sv_maps WHERE name=$1', [mapNames[0]]);
    if (em.rows.length) {
      mapId = em.rows[0].id;
      await client.query('DELETE FROM map_connections WHERE map_id=$1', [mapId]);
      await client.query('DELETE FROM map_labels      WHERE map_id=$1', [mapId]);
      await client.query('DELETE FROM map_devices     WHERE map_id=$1', [mapId]);
    } else {
      const im = await client.query(
        `INSERT INTO sv_maps (name, description, is_public) VALUES ($1,$2,FALSE) RETURNING id`,
        [mapNames[0], 'Kuala Lumpur HQ core network — demo topology']
      );
      mapId = im.rows[0].id;
    }
    // layout: firewall top, cores below, access + servers + ap on the third row
    const layout = {
      'FG-KLHQ-01':      { x: 720, y: 80 },
      'SW-KLHQ-CORE-01': { x: 520, y: 260 },
      'SW-KLHQ-CORE-02': { x: 920, y: 260 },
      'SW-KLHQ-ACC-01':  { x: 300, y: 460 },
      'SW-KLHQ-ACC-02':  { x: 540, y: 460 },
      'SRV-DC01':        { x: 800, y: 460 },
      'SRV-DB01':        { x: 1000, y: 460 },
      'AP-KLHQ-01':      { x: 1180, y: 460 },
    };
    const nodeIdByHost = {};
    for (const d of klCore) {
      const pos = layout[d.host] || { x: ri(200, 1200), y: ri(120, 500) };
      const r = await client.query(
        `INSERT INTO map_devices (map_id, device_id, x, y, label, icon_type, width, height, node_style)
         VALUES ($1,$2,$3,$4,$5,'box',130,64,'box') RETURNING id`,
        [mapId, d.id, pos.x, pos.y, d.host]
      );
      nodeIdByHost[d.host] = r.rows[0].id;
    }
    const links = [
      ['FG-KLHQ-01', 'SW-KLHQ-CORE-01'], ['FG-KLHQ-01', 'SW-KLHQ-CORE-02'],
      ['SW-KLHQ-CORE-01', 'SW-KLHQ-CORE-02'],
      ['SW-KLHQ-CORE-01', 'SW-KLHQ-ACC-01'], ['SW-KLHQ-CORE-01', 'SW-KLHQ-ACC-02'],
      ['SW-KLHQ-CORE-02', 'SRV-DC01'], ['SW-KLHQ-CORE-02', 'SRV-DB01'],
      ['SW-KLHQ-ACC-01', 'AP-KLHQ-01'],
    ];
    let linkCount = 0;
    for (const [a, b] of links) {
      if (nodeIdByHost[a] && nodeIdByHost[b]) {
        await client.query(
          `INSERT INTO map_connections (map_id, from_item_id, to_item_id, color, line_style, from_kind, to_kind, width)
           VALUES ($1,$2,$3,'#94a3b8','solid','device','device',2)`,
          [mapId, nodeIdByHost[a], nodeIdByHost[b]]
        );
        linkCount++;
      }
    }
    await client.query(
      `INSERT INTO map_labels (map_id, x, y, text, font_size, color, bold) VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
      [mapId, 640, 24, 'KL-HQ Core Network', 20, '#1a2744']
    );
    summary.sv_maps = 1;
    summary.map_devices = klCore.length;
    summary.map_connections = linkCount;
    summary.map_labels = 1;
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log('\n========== SPANVAULT DEMO SEED SUMMARY ==========');
  for (const [t, n] of Object.entries(summary)) console.log(`  ${t.padEnd(22)} ${n}`);
  console.log('=================================================');
  await client.end();
  console.log('[spanvault-seed] done.');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nSEED FAILED:', err.message);
  console.error(err.stack);
  try { await client.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
