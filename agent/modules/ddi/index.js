'use strict';
/**
 * modules/ddi/index.js — the `ddi` module factory (shared module contract).
 *
 * createDdiModule(ctx) => { name:'ddi', start, stop, status, onMessage, deviceCount },
 * where ctx = { config, send, logger, hostname, version, [winrm], [dhcplog], [ipam] }.
 *
 * This runs DDIVault's edge collection LOCALLY at a remote site and ships RAW results to
 * DDIVault over the agent transport (the entrypoint gives this module a `send` bound to a
 * transport dialing the DDIVault ingest — see nocvault-agent.js). All DB writes stay on
 * the DDIVault server; this module only produces data.
 *
 * Wire contract (pinned — the DDIVault ingest is built to this). The module emits ONLY
 * the kinds DDIVault's agent ingest (api/ws-server.js → collector/writers.js) actually
 * PERSISTS, and each `data` payload is byte-shaped to the matching writer's input so an
 * agent-written row is indistinguishable from a centrally-polled one (Phase 4b):
 *   server → module (onMessage):
 *     { type:'ddi_config', servers:[…], subnets:[…], settings:{…} }  → (re)configure polls
 *     { type:'ddi_scan', subnet_id, cidr }                           → run one ICMP sweep
 *   module → server (send):
 *     { type:'ddi_result', server_id, kind, data }   kind ∈ scope_stats|leases|
 *       reservations|dhcp_events|dns_zones   with per-kind `data`:
 *         scope_stats  → { stats:[…ScopeStatistics], scopes:[…Scope] }  (writeScopeStats)
 *         leases       → [ …Get-DhcpServerv4Lease ]                      (writeLeases)
 *         reservations → [ …Get-DhcpServerv4Reservation ]               (writeReservations)
 *         dhcp_events  → [ …parsed DHCP log rows ]                       (writeDhcpEvents)
 *         dns_zones    → { zones:[…Zone], recordsByZone:{ "<zone>":[…rec] } } (writeDnsZones)
 *     { type:'ddi_scan_result', subnet_id, data:[ { ip, alive, ping_ms } ] } (writeScanResult)
 *   heartbeat/module status is carried by the core heartbeat (status() below).
 *
 * Deliberately NOT emitted — the ingest drops them, so shipping would waste bandwidth:
 *   scope_options, failover, dns_health (persisted centrally by writeScopeStats'
 *   getGateway callback / haMonitor / dnsMonitor, none of which are in writers.js).
 *   Scope config is folded into scope_stats and DNS records into dns_zones — there is no
 *   standalone `scopes`/`dns_records` frame. Agent-owned servers won't get the dropped
 *   data until a later pass; central collection still covers server-reachable installs.
 *
 * Defensive by construction: a WinRM/SMB/ICMP failure for ONE server/kind is caught,
 * logged, and recorded in per-server status — it never rejects out of a timer (which would
 * become an unhandledRejection) and never crashes the agent. An unreachable server surfaces
 * through status() (→ heartbeat module_status), not a throw.
 */

// Collectors are injectable via ctx for unit tests (stub winrm/dhcplog/ipam); default to
// the real ported implementations.
function createDdiModule(ctx) {
  ctx = ctx || {};
  const send = ctx.send || (() => {});
  const logger = ctx.logger || {
    info: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
  };
  const winrm = ctx.winrm || require('./winrm');
  const dhcplog = ctx.dhcplog || require('./dhcplog');
  const ipam = ctx.ipam || require('./ipam');

  // ── Module state ────────────────────────────────────────────
  let servers = [];
  let subnets = [];
  let settings = {};
  const pollTimers = new Map(); // key `${server_id}:${kind}` → setTimeout handle
  const inFlight = new Set(); // keys whose prior poll hasn't settled yet (re-entrancy guard)
  const serverErrors = new Map(); // `${server_id}:${kind}` → last error message
  const scansInFlight = new Set(); // subnet_id (string) → an ICMP sweep is running
  // Bumped on every applyConfig/stop so an in-flight self-rescheduling tick from an OLD
  // generation cannot resurrect a timer after its config was torn down.
  let schedulerEpoch = 0;

  const num = (v, d) => {
    const n = parseInt(v, 10);
    return isNaN(n) || n <= 0 ? d : n;
  };
  // Like num but allows an explicit 0 (used for the initial-stagger cap, which tests set to 0).
  const numOrZero = (v, d) => {
    const n = parseInt(v, 10);
    return isNaN(n) || n < 0 ? d : n;
  };

  // ── Concurrency cap ─────────────────────────────────────────
  // Bound the number of concurrent collections (each spawns 1-2 powershell.exe children)
  // across the WHOLE module, so a config with many servers can't fork unbounded PS processes.
  const MAX_CONCURRENT = num(process.env.DDI_MAX_CONCURRENT, 5);
  let activeSlots = 0;
  const slotWaiters = [];
  function acquireSlot() {
    return new Promise((resolve) => {
      if (activeSlots < MAX_CONCURRENT) { activeSlots++; resolve(); }
      else slotWaiters.push(resolve);
    });
  }
  function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) next(); // hand the held slot straight to the next waiter (count unchanged)
    else activeSlots--;
  }

  // Reschedule cadence with a small POSITIVE jitter so identical intervals across servers
  // don't re-align into a synchronized poll storm. Positive-only → never faster than configured.
  function rescheduleDelay(intervalMs) {
    return intervalMs + Math.round(intervalMs * 0.1 * Math.random());
  }
  // Initial per-timer stagger so every server/kind doesn't fire at t=0 (thundering herd).
  // Capped by DDI_STAGGER_MS (default 3s) and never larger than the interval itself.
  function initialDelay(intervalMs) {
    const cap = Math.min(intervalMs, numOrZero(process.env.DDI_STAGGER_MS, 3000));
    return Math.floor(Math.random() * cap);
  }

  // Which kinds run for a server, and how often (from settings, with sane defaults).
  // roles: which server.role values the kind applies to ('both' always matches).
  // ONLY the DDIVault-persisted kinds are here (Phase 4b reconciliation): scope config is
  // folded into scope_stats and DNS records into dns_zones; scope_options/failover/dns_health
  // are dropped (not persisted agent-side). See the wire-contract note at the top of file.
  const KIND_SPEC = [
    { kind: 'scope_stats', roles: ['dhcp'], interval: (s) => num(s.scope_stats_interval_s, 300) },
    { kind: 'leases', roles: ['dhcp'], interval: (s) => num(s.leases_interval_s, 600) },
    { kind: 'reservations', roles: ['dhcp'], interval: (s) => num(s.reservations_interval_s, 3600) },
    { kind: 'dhcp_events', roles: ['dhcp'], interval: (s) => num(s.dhcp_events_interval_s, 300) },
    { kind: 'dns_zones', roles: ['dns'], interval: (s) => num(s.dns_interval_s, 900) },
  ];

  function roleMatches(specRoles, role) {
    const r = (role || 'both').toLowerCase();
    if (r === 'both') return true;
    return specRoles.includes(r);
  }

  function authOf(s) {
    return {
      auth_mode: s.auth_mode,
      ps_username: s.ps_username,
      ps_password: s.ps_password,
      winrm_port: s.winrm_port,
      winrm_https: s.winrm_https,
    };
  }

  // ── Config application ───────────────────────────────────────
  function applyConfig(msg) {
    servers = Array.isArray(msg.servers) ? msg.servers : [];
    subnets = Array.isArray(msg.subnets) ? msg.subnets : [];
    settings = msg.settings || {};
    logger.info(`[ddi] config received: ${servers.length} server(s), ${subnets.length} subnet(s)`);
    // Clear OLD timers before rescheduling so a re-pushed config never leaves a stale
    // timer running for a removed/renamed server (same discipline as the span module).
    // Bumping the epoch also neutralizes any tick already mid-flight from the old config.
    schedulerEpoch++;
    for (const t of pollTimers.values()) clearTimeout(t);
    pollTimers.clear();
    inFlight.clear();
    serverErrors.clear();
    for (const server of servers) scheduleServer(server);
  }

  function scheduleServer(server) {
    if (!server || server.server_id == null) return;
    const epoch = schedulerEpoch; // captured; a tick only reschedules while its epoch is current
    for (const spec of KIND_SPEC) {
      if (!roleMatches(spec.roles, server.role)) continue;
      const intervalMs = spec.interval(settings) * 1000;
      const key = `${server.server_id}:${spec.kind}`;

      // Self-rescheduling tick: the NEXT run is armed only after the CURRENT one settles, so a
      // slow poll can never stack / spawn overlapping powershell.exe children (re-entrancy).
      const tick = async () => {
        if (!inFlight.has(key)) {
          inFlight.add(key);
          try {
            await pollKind(server, spec.kind);
          } finally {
            inFlight.delete(key);
          }
        }
        if (epoch === schedulerEpoch) {
          pollTimers.set(key, setTimeout(tick, rescheduleDelay(intervalMs)));
        }
      };

      // Staggered initial fire (not all at t=0), then self-reschedule on the interval.
      pollTimers.set(key, setTimeout(tick, initialDelay(intervalMs)));
    }
  }

  // Run one collection and ship a ddi_result. Never rejects — catches everything.
  async function pollKind(server, kind) {
    const key = `${server.server_id}:${kind}`;
    await acquireSlot(); // cap concurrent PS-spawning collections across the whole module
    try {
      const data = await collect(kind, server);
      send({ type: 'ddi_result', server_id: server.server_id, kind, data: data == null ? [] : data });
      serverErrors.delete(key);
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      serverErrors.set(key, m);
      logger.error(`[ddi] ${kind} failed for server ${server.server_id} (${server.hostname || server.ip_address}): ${m}`);
    } finally {
      releaseSlot();
    }
  }

  async function collect(kind, server) {
    const auth = authOf(server);
    const ip = server.ip_address;
    switch (kind) {
      case 'scope_stats': {
        // Fold scope config INTO the stats frame — writeScopeStats consumes
        // { stats, scopes } (identical to the central collector's syncScopeStats
        // call), so an agent scope write is indistinguishable from a central one.
        const [stats, scopes] = await Promise.all([
          winrm.getDhcpScopeStats(ip, auth),
          winrm.getDhcpScopes(ip, auth),
        ]);
        return { stats: stats || [], scopes: scopes || [] };
      }
      case 'leases':
        return winrm.getDhcpLeases(ip, auth);
      case 'reservations':
        return winrm.getDhcpReservations(ip, null, auth);
      case 'dhcp_events': {
        // NO advancing cursor. readEvents already spans today+yesterday; we re-read that
        // whole window every poll and let the DDIVault writer's `ON CONFLICT DO NOTHING`
        // dedup collapse the overlap. A strict advancing cursor would permanently LOSE any
        // events carried in a WS frame that got dropped in transit; bandwidth is cheap and
        // the writer already dedups, so re-sending is the safe choice.
        return dhcplog.readEvents(server.dhcp_log_path);
      }
      case 'dns_zones': {
        // Fold DNS records INTO the zones frame — writeDnsZones consumes
        // { zones, recordsByZone } (identical to the central collector's syncDns).
        // Records are fetched only for the eligible primary zones the writer will
        // actually persist (it re-applies the same filter).
        const zones = (await winrm.getDnsZones(ip, auth)) || [];
        const recordsByZone = {};
        for (const zone of zones) {
          if (!zone || !zone.ZoneName) continue;
          if (!zone.IsReverseLookupZone && !zone.IsAutoCreated && zone.ZoneType === 'Primary') {
            const records = await winrm.getDnsRecords(ip, zone.ZoneName, auth);
            if (records && records.length) recordsByZone[zone.ZoneName] = records;
          }
        }
        return { zones, recordsByZone };
      }
      default:
        return [];
    }
  }

  // ── On-demand ICMP sweep ─────────────────────────────────────
  async function runScan(msg) {
    const subnetId = msg.subnet_id;
    const cidr = msg.cidr;
    // Guard: don't let a duplicate ddi_scan for the SAME subnet run concurrently with one
    // already in progress (they'd race over PS children / temp scripts and waste the box).
    const scanKey = String(subnetId);
    if (scansInFlight.has(scanKey)) {
      logger.info(`[ddi] scan for subnet ${subnetId} already running — skipping duplicate request`);
      return;
    }
    scansInFlight.add(scanKey);
    try {
      const data = await ipam.scanCidr(cidr);
      send({ type: 'ddi_scan_result', subnet_id: subnetId, data: data || [] });
      logger.info(`[ddi] scan ${cidr} → ${(data || []).length} host result(s)`);
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      logger.error(`[ddi] scan failed for ${cidr}: ${m}`);
      send({ type: 'ddi_scan_result', subnet_id: subnetId, data: [], error: m.slice(0, 300) });
    } finally {
      scansInFlight.delete(scanKey);
    }
  }

  // ── Module contract ─────────────────────────────────────────
  return {
    name: 'ddi',

    // Nothing to poll until a ddi_config arrives — timers are created in applyConfig.
    start() {},

    stop() {
      schedulerEpoch++; // neutralize any in-flight tick so it won't reschedule after stop
      for (const t of pollTimers.values()) clearTimeout(t);
      pollTimers.clear();
      inFlight.clear();
    },

    // 'ok' when every recent poll succeeded; 'degraded:<n>' when N server/kind polls are
    // currently failing (surfaced through the heartbeat's module_status).
    status() {
      return serverErrors.size ? `degraded:${serverErrors.size}` : 'ok';
    },

    onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ddi_config') {
        applyConfig(msg);
      } else if (msg.type === 'ddi_scan') {
        runScan(msg).catch((e) => logger.error('[ddi] scan error:', e && e.message));
      }
    },

    // Number of monitored servers (the health widget's device_count analogue).
    deviceCount() {
      return servers.length;
    },
  };
}

module.exports = createDdiModule;
