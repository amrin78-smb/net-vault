'use strict';
/**
 * modules/span/index.js — the `span` module factory (shared module contract).
 *
 * Implements: createSpanModule(ctx) => { name, start, stop, status, onMessage,
 * deviceCount }, where ctx = { config, send, logger, hostname, version }.
 *
 * This is the entire SpanVault edge-collection workload lifted out of the legacy
 * standalone agent (spanvault/agent/agent.js) with byte-for-byte on-wire message
 * shapes preserved. The core owns the WebSocket transport, offline buffer,
 * heartbeats, self-update, and control messages (restart/get_logs); this module
 * owns ONLY the SpanVault collection behaviour:
 *   - config application + per-device poll loop + service-check loop (agent.js:
 *     204-236,445-453),
 *   - ping (ping.js), SNMP plan + legacy paths (snmp.js), service checks
 *     (checks.js), and zero-touch discovery (discovery.js).
 *
 * Deliberately NOT here (the core owns these now):
 *   - heartbeats (core),
 *   - the legacy single-file self-update triggered by config.agent_sha — we
 *     ignore agent_sha entirely (see agent.js:212-213; the core does signed
 *     bundle updates instead),
 *   - restart / get_logs (core control messages).
 */
const { doPing } = require('./ping');
const { runSnmpPlan, doSnmp } = require('./snmp');
const { runAndReport } = require('./checks');
const createDiscovery = require('./discovery');

function createSpanModule(ctx) {
  ctx = ctx || {};
  const send = ctx.send;
  // Fall back to console if no logger is injected (contract allows either).
  const logger = ctx.logger || {
    info: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
  };

  // ── Module state ────────────────────────────────────────────
  let devices = [];
  let settings = {};
  let serviceChecks = [];
  const pollTimers = new Map();
  const serviceTimers = new Map();
  // Last per-device poll error message, surfaced through status(); cleared on the
  // next successful poll cycle. null ⇒ status() returns 'ok'.
  let lastPollError = null;

  const discovery = createDiscovery({ send, logger });

  // ── Config application (agent.js:204-214) ───────────────────
  // Re-applies device config: clears the OLD per-device poll timers before
  // rescheduling so a re-pushed config never leaves a stale interval running for
  // a removed/renamed device. Drops the legacy agent_sha self-update line — the
  // core owns updates now.
  function applyConfig(msg) {
    devices = msg.devices || [];
    settings = msg.settings || {};
    logger.info(`Config received: ${devices.length} device(s)`);
    for (const t of pollTimers.values()) clearInterval(t);
    pollTimers.clear();
    for (const device of devices) schedulePoll(device);
    applyServiceChecks(msg.service_checks || []);
    // NOTE: msg.agent_sha is intentionally ignored — the core does signed-bundle
    // self-updates (agent.js:212-213 dropped).
  }

  // Service checks: clears the OLD service-check timers before rescheduling, same
  // re-application discipline as the device poll loop (agent.js:220-226).
  function applyServiceChecks(list) {
    serviceChecks = Array.isArray(list) ? list : [];
    for (const t of serviceTimers.values()) clearInterval(t);
    serviceTimers.clear();
    logger.info(`Service checks received: ${serviceChecks.length}`);
    for (const check of serviceChecks) scheduleServiceCheck(check);
  }

  // (agent.js:228-236) service-check default interval 60s.
  function scheduleServiceCheck(check) {
    if (!check || check.id == null) return;
    const interval = (parseInt(check.interval_seconds, 10) || 60) * 1000;
    const run = () => runAndReport(check, send).catch(
      (e) => logger.error(`Service check error for ${check.id}:`, e.message));
    run();
    const t = setInterval(run, interval);
    serviceTimers.set(check.id, t);
  }

  // (agent.js:445-453) poll default interval 300s
  // (poll_interval_seconds/settings.icmp_poll_interval_seconds/300).
  function schedulePoll(device) {
    const interval = (device.poll_interval_seconds ||
      parseInt(settings.icmp_poll_interval_seconds, 10) || 300) * 1000;
    const run = () => pollDevice(device)
      .then(() => { lastPollError = null; })
      .catch((e) => {
        lastPollError = e && e.message ? e.message : String(e);
        logger.error(`Poll error for ${device.name || device.id}:`, e.message);
      });
    run();
    const t = setInterval(run, interval);
    pollTimers.set(device.id, t);
  }

  // (agent.js:455-467) ping first; then plan path if a snmp_plan is present,
  // else the legacy per-metric path (old-server compatibility).
  async function pollDevice(device) {
    await doPing(device, send);
    if (!device.snmp_enabled) return;
    if (device.snmp_plan && (device.snmp_plan.walks || device.snmp_plan.gets)) {
      await runSnmpPlan(device, send, logger);
    } else {
      await doSnmp(device, send, logger);
    }
  }

  // ── Module contract ─────────────────────────────────────────
  return {
    name: 'span',

    // Nothing to poll until a config arrives — timers are created lazily in
    // applyConfig. Safe no-op.
    start() {},

    // Clear every timer this module created.
    stop() {
      for (const t of pollTimers.values()) clearInterval(t);
      pollTimers.clear();
      for (const t of serviceTimers.values()) clearInterval(t);
      serviceTimers.clear();
    },

    // 'ok' normally; 'error:<short>' if the last poll cycle failed.
    status() {
      return lastPollError ? `error:${lastPollError}` : 'ok';
    },

    // The core forwards EVERY inbound server message here. We handle exactly the
    // SpanVault ones (agent.js:116-117): config and discover. Everything else
    // (restart/get_logs/logs/…) is core-owned and ignored.
    onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'config') {
        applyConfig(msg);
      } else if (msg.type === 'discover') {
        discovery.run(msg).catch((e) => logger.error('Discovery error:', e.message));
      }
    },

    // The core's health widget reads this (legacy buildHealth used devices.length).
    deviceCount() {
      return devices.length;
    },
  };
}

module.exports = createSpanModule;
