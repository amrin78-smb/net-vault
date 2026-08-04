'use strict';
/**
 * Unit tests for the `ddi` module (Phase 4b) — plan handling + wire-frame shapes with a
 * fully stubbed ctx (no real WinRM/SMB/ICMP). Asserts the module:
 *   - emits the right ddi_result frames (one per applicable kind per server) for a ddi_config,
 *   - scopes kinds by server role (dhcp vs dns vs both),
 *   - re-applies a ddi_config (clears stale timers, no leaks),
 *   - handles ddi_scan → ddi_scan_result,
 *   - SURVIVES a collector throw (logs + continues; status() → degraded, no crash),
 *   - reports name/deviceCount/status per the module contract.
 *
 * `node test/ddi.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
// Fire the staggered initial poll immediately (no random start delay) so the tests can
// observe results within their short sleeps. Production defaults to a ~3s stagger cap.
process.env.DDI_STAGGER_MS = '0';
const createDdiModule = require('../modules/ddi');

let passed = 0;
const ok = (n) => { console.log('  PASS', n); passed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLogger = { info: () => {}, error: () => {} };

// A winrm stub: every reader resolves to a tagged array/object so we can assert the
// collection ran. `throwOn` lets a test force a specific reader to reject.
function makeWinrm(throwOn) {
  const g = (tag) => async () => {
    if (throwOn && throwOn.has(tag)) throw new Error(`boom:${tag}`);
    return [{ _tag: tag }];
  };
  return {
    asArray: (r) => (r == null ? [] : Array.isArray(r) ? r : [r]),
    getDhcpScopeStats: g('scope_stats'),
    getDhcpScopes: async () => [{ ScopeId: '10.0.0.0' }],
    getDhcpLeases: g('leases'),
    getDhcpReservations: g('reservations'),
    getDhcpScopeOptions: async () => [{ OptionId: 3, Name: 'Router', Value: '10.0.0.1' }],
    getDnsZones: async () => [{ ZoneName: 'corp.local', ZoneType: 'Primary', IsReverseLookupZone: false, IsAutoCreated: false }],
    getDnsRecords: async () => [{ HostName: 'www', RecordType: 'A', RecordData: '10.0.0.5' }],
    getDnsServerRole: async () => ({ isPDC: true }),
    getDnsForwarders: async () => ['8.8.8.8'],
    getDnsQueryStats: async () => ({ qps: 1 }),
    getDnsZoneSoaDetail: async () => ({ Serial: 5 }),
    getDnsZoneRecordCounts: async () => ({ Total: 3 }),
    getDnsZoneScavenging: async () => ({ AgingEnabled: true }),
    getDnsStaleRecords: async () => [],
    testDnsForwarder: async () => ({ Reachable: true }),
    getDhcpFailover: g('failover'),
  };
}

// Records the args of each readEvents call so a test can assert the module no longer passes
// a strict advancing since-cursor (FIX 4: re-read today+yesterday, rely on writer dedup).
const dhcplogStub = {
  calls: [],
  readEvents(...args) {
    this.calls.push(args);
    return [{ event_id: 10, event_type: 'Assign', event_time: '2026-07-28T10:00:00.000Z' }];
  },
};
const ipamStub = { scanCidr: async (cidr) => [{ ip: '10.0.0.1', alive: true, ping_ms: 2 }, { ip: '10.0.0.2', alive: false, ping_ms: null }] };

// Build a module with captured sends + stubbed collectors.
function build(opts = {}) {
  const sent = [];
  const mod = createDdiModule({
    send: (m) => sent.push(m),
    logger: silentLogger,
    hostname: 'edge-1',
    version: '9.9.9',
    winrm: opts.winrm || makeWinrm(opts.throwOn),
    dhcplog: opts.dhcplog || dhcplogStub,
    ipam: opts.ipam || ipamStub,
  });
  return { mod, sent };
}

// Fast intervals so we don't wait on real poll cadences.
const FAST = {
  scope_stats_interval_s: 3600, scopes_interval_s: 3600, leases_interval_s: 3600,
  reservations_interval_s: 3600, scope_options_interval_s: 3600, dhcp_events_interval_s: 3600,
  failover_interval_s: 3600, dns_interval_s: 3600, dns_records_interval_s: 3600, dns_health_interval_s: 3600,
};

// ── contract surface ─────────────────────────────────────────────────────────
(() => {
  const { mod } = build();
  assert.strictEqual(mod.name, 'ddi', 'name is ddi');
  for (const fn of ['start', 'stop', 'status', 'onMessage', 'deviceCount']) {
    assert.strictEqual(typeof mod[fn], 'function', `${fn}() present`);
  }
  assert.strictEqual(mod.status(), 'ok', 'status ok before any poll');
  assert.strictEqual(mod.deviceCount(), 0, 'deviceCount 0 before config');
  mod.stop();
  ok('module contract surface');
})();

// ── dhcp-role server: emits exactly the DHCP kinds, none of the DNS kinds ──────
(async () => {
  const evCalls = [];
  const evStub = { readEvents: (...args) => { evCalls.push(args); return [{ event_id: 10, event_type: 'Assign', event_time: '2026-07-28T10:00:00.000Z' }]; } };
  const { mod, sent } = build({ dhcplog: evStub });
  mod.onMessage({
    type: 'ddi_config',
    servers: [{ server_id: 1, hostname: 'dhcp1', ip_address: '10.0.0.10/24', role: 'dhcp', auth_mode: 'kerberos', dhcp_log_path: '\\\\srv\\logs' }],
    subnets: [],
    settings: FAST,
  });
  await sleep(120); // let the immediate poll fire per kind
  mod.stop();

  // FIX 4: dhcp_events must NOT pass a strict advancing since-cursor — it re-reads the
  // today+yesterday window each poll and relies on the server's ON CONFLICT dedup.
  assert.ok(evCalls.length >= 1, 'readEvents was called');
  assert.strictEqual(evCalls[0][0], '\\\\srv\\logs', 'readEvents gets the per-server dhcp_log_path');
  assert.strictEqual(evCalls[0][1], undefined, 'readEvents gets NO since-cursor (re-read window, writer dedups)');

  const results = sent.filter((m) => m.type === 'ddi_result');
  const kinds = results.map((m) => m.kind).sort();
  assert.deepStrictEqual(
    kinds,
    ['dhcp_events', 'leases', 'reservations', 'scope_stats'],
    'dhcp server emits only the 4 PERSISTED DHCP kinds (scopes folded into scope_stats; scope_options/failover dropped)'
  );
  for (const r of results) {
    assert.deepStrictEqual(Object.keys(r).sort(), ['data', 'kind', 'server_id', 'type'].sort(), 'ddi_result frame shape');
    assert.strictEqual(r.server_id, 1, 'server_id echoed');
    assert.ok(Array.isArray(r.data) || typeof r.data === 'object', 'data present');
  }
  // scope_stats folds scope config in: data = { stats:[...], scopes:[...] } (writeScopeStats input).
  const scopeStats = results.find((m) => m.kind === 'scope_stats');
  assert.ok(scopeStats.data && !Array.isArray(scopeStats.data), 'scope_stats data is an object, not a bare array');
  assert.ok(Array.isArray(scopeStats.data.stats), 'scope_stats.data.stats present');
  assert.strictEqual(scopeStats.data.scopes[0].ScopeId, '10.0.0.0', 'scope_stats.data.scopes carries scope config');
  assert.strictEqual(mod.status(), 'ok', 'status ok after clean polls');
  ok('dhcp-role server → persisted DHCP-kind ddi_result frames only (scope config folded into scope_stats)');
})();

// ── dns-role server: emits the DNS kinds only; dns_health is aggregated ────────
(async () => {
  const { mod, sent } = build();
  mod.onMessage({
    type: 'ddi_config',
    servers: [{ server_id: 2, hostname: 'dns1', ip_address: '10.0.0.20', role: 'dns', auth_mode: 'credential', ps_username: 'u', ps_password: 'p' }],
    subnets: [],
    settings: FAST,
  });
  await sleep(120);
  mod.stop();

  const kinds = sent.filter((m) => m.type === 'ddi_result').map((m) => m.kind).sort();
  assert.deepStrictEqual(kinds, ['dns_zones'], 'dns server emits only the persisted dns_zones kind (records folded in; dns_health dropped)');

  // dns_zones folds records in: data = { zones:[...], recordsByZone:{ "<zone>":[...] } } (writeDnsZones input).
  const dnsZones = sent.find((m) => m.kind === 'dns_zones');
  assert.ok(dnsZones.data && !Array.isArray(dnsZones.data), 'dns_zones data is an object, not a bare array');
  assert.strictEqual(dnsZones.data.zones[0].ZoneName, 'corp.local', 'dns_zones.data.zones carries zone metadata');
  assert.strictEqual(dnsZones.data.recordsByZone['corp.local'][0].HostName, 'www', 'dns_zones.data.recordsByZone folds per-zone records keyed by zone name');
  ok('dns-role server → single dns_zones frame with records folded into recordsByZone');
})();

// ── both-role server runs BOTH families ────────────────────────────────────────
(async () => {
  const { mod, sent } = build();
  mod.onMessage({
    type: 'ddi_config',
    servers: [{ server_id: 3, hostname: 'combo', ip_address: '10.0.0.30', role: 'both', auth_mode: 'local' }],
    subnets: [], settings: FAST,
  });
  await sleep(150);
  mod.stop();
  const kinds = new Set(sent.filter((m) => m.type === 'ddi_result').map((m) => m.kind));
  assert.ok(kinds.has('scope_stats') && kinds.has('dns_zones'), 'both-role runs DHCP + DNS kinds');
  assert.strictEqual(mod.deviceCount(), 1, 'deviceCount reflects monitored servers');
  ok('both-role server runs DHCP + DNS families');
})();

// ── ddi_scan → ddi_scan_result ─────────────────────────────────────────────────
(async () => {
  const { mod, sent } = build();
  mod.onMessage({ type: 'ddi_scan', subnet_id: 77, cidr: '10.0.0.0/24' });
  await sleep(50);
  const scan = sent.find((m) => m.type === 'ddi_scan_result');
  assert.ok(scan, 'ddi_scan_result emitted');
  assert.strictEqual(scan.subnet_id, 77, 'subnet_id echoed');
  assert.strictEqual(scan.data.length, 2, 'sweep rows returned');
  assert.deepStrictEqual(Object.keys(scan.data[0]).sort(), ['alive', 'ip', 'ping_ms'], 'raw sweep row shape matches writeScanResult (ping_ms, not response_ms)');
  mod.stop();
  ok('ddi_scan → ddi_scan_result');
})();

// ── collector throw: logged + isolated, module survives, status degrades ───────
(async () => {
  // Force the scope_stats reader to throw; the other DHCP kinds must still ship.
  const { mod, sent } = build({ throwOn: new Set(['scope_stats']) });
  mod.onMessage({
    type: 'ddi_config',
    servers: [{ server_id: 5, hostname: 'flaky', ip_address: '10.0.0.50', role: 'dhcp', auth_mode: 'kerberos' }],
    subnets: [], settings: FAST,
  });
  await sleep(120);
  const kinds = sent.filter((m) => m.type === 'ddi_result').map((m) => m.kind);
  assert.ok(!kinds.includes('scope_stats'), 'the throwing kind shipped no ddi_result');
  assert.ok(kinds.includes('leases') && kinds.includes('reservations'), 'sibling kinds still shipped despite the throw');
  assert.ok(mod.status().startsWith('degraded:'), 'status reflects the failing kind');
  mod.stop();
  ok('collector throw is isolated — module survives, status degrades');
})();

// ── re-applied config clears stale timers (no duplicate/leaked polls) ──────────
(async () => {
  const { mod, sent } = build();
  mod.onMessage({ type: 'ddi_config', servers: [{ server_id: 9, ip_address: '10.0.0.9', role: 'dhcp', auth_mode: 'kerberos' }], subnets: [], settings: FAST });
  await sleep(80);
  const firstCount = sent.length;
  // Re-push with an EMPTY server list — old timers must be cleared, no new results.
  mod.onMessage({ type: 'ddi_config', servers: [], subnets: [], settings: FAST });
  await sleep(80);
  const afterReconfig = sent.length;
  mod.stop();
  await sleep(60);
  assert.strictEqual(sent.length, afterReconfig, 'no polls fire after servers removed (timers cleared)');
  assert.ok(firstCount > 0, 'first config did poll');
  assert.strictEqual(mod.deviceCount(), 0, 'deviceCount 0 after empty reconfig');
  ok('re-applied config clears stale timers');
})();

// ── ignores unrelated / malformed messages ────────────────────────────────────
(() => {
  const { mod, sent } = build();
  mod.onMessage(null);
  mod.onMessage({ type: 'restart' });
  mod.onMessage('nope');
  assert.strictEqual(sent.length, 0, 'no frames from unrelated/malformed messages');
  mod.stop();
  ok('ignores unrelated/malformed messages');
})();

// ── EVENT_MAP covers the ids real DHCP servers actually emit ──────────────────
// A live 300-line sample from a production DHCP server parsed 68% as 'Unknown',
// and several mapped ids were plain wrong (30 is a DNS update REQUEST, not a
// failure). These assertions pin the corrected meanings so the map cannot quietly
// revert. The SAME map must exist in ddivault/collector/dhcpReader.js — that copy
// is the contract partner, since both write to one dhcp_events table.
(() => {
  const { EVENT_MAP, parseLine } = require('../modules/ddi/dhcplog');

  // ids observed in the live sample, with the counts they appeared at
  for (const id of [10, 11, 16, 17, 18, 24, 25, 30, 31, 32]) {
    assert.ok(EVENT_MAP[id], `event id ${id} must be mapped (seen in a real log)`);
    assert.notStrictEqual(EVENT_MAP[id].type, 'Unknown', `id ${id} must not be Unknown`);
  }

  // The corrections, asserted explicitly — these were the wrong ones.
  assert.strictEqual(EVENT_MAP[30].type, 'DNSUpdate',    'id 30 is a DNS update REQUEST, not a failure');
  assert.strictEqual(EVENT_MAP[31].type, 'DNSFailed',    'id 31 is the real DNS update failure');
  assert.strictEqual(EVENT_MAP[32].type, 'DNSUpdateOk',  'id 32 is a successful DNS update');
  assert.strictEqual(EVENT_MAP[13].type, 'AddressInUse', 'id 13 is an address conflict, not a DNS update');
  assert.strictEqual(EVENT_MAP[14].type, 'PoolExhausted', 'id 14 is scope exhaustion, not a DNS update');
  assert.strictEqual(EVENT_MAP[16].type, 'LeaseDeleted', 'id 16 is a deleted lease, not a DNS delete');
  ok('EVENT_MAP covers real-world ids and keeps the corrected meanings');

  // End-to-end through parseLine, in the real CSV shape.
  const line = '32,08/04/26,10:15:22,DNS Update Successful,10.1.2.3,host1.example.local,001122334455,,0,6,,,,';
  const ev = parseLine(line);
  assert.ok(ev, 'a real-shaped line parses');
  assert.strictEqual(ev.event_id, 32, 'event_id parsed');
  assert.strictEqual(ev.event_type, 'DNSUpdateOk', 'event_type from the corrected map');
  assert.ok(ev.event_time && !isNaN(new Date(ev.event_time)), 'event_time is a valid date');
  ok('parseLine maps a real-shaped line through the corrected map');
})();

// Give the async IIFEs time to finish, then report.
setTimeout(() => {
  console.log(`\n${passed} ddi assertions passed.`);
  process.exit(0);
}, 900);
process.on('unhandledRejection', (e) => { console.error('  FAIL unhandledRejection', e); process.exit(1); });
