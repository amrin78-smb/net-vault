'use strict';
/**
 * core/heartbeat.js — periodic heartbeat sender.
 *
 * Sends a heartbeat every intervalMs (default 30000, matching the legacy agent's
 * setInterval(sendHeartbeat, 30000) — agent.js:201).
 *
 * WIRE SHAPE — superset of the legacy heartbeat (agent.js:198-201), which was:
 *   { type:'heartbeat', version, hostname, health }
 * Phase 1 adds ONE additive top-level field, module_status, e.g. { span:'ok' }.
 * The SpanVault ws-server heartbeat handler reads only version/hostname/health and
 * ignores extra top-level fields, so this is wire-safe: an old and a new agent are
 * indistinguishable to the server except for the field it already ignores.
 *
 * start() does NOT send immediately — the entrypoint calls sendNow() itself on
 * socket-open (mirroring the legacy ws 'open' -> sendHeartbeat() at agent.js:103);
 * start() only arms the recurring interval. This keeps the "send on connect + then
 * every 30s" cadence without double-sending on the open event.
 *
 * Note heartbeats are intentionally NOT buffered — send() (in buffer/transport)
 * drops a heartbeat when offline rather than queueing it (agent.js:79), because a
 * stale heartbeat replayed on reconnect would bump last_seen_at to NOW() and mask
 * how long the agent was actually gone.
 */
function createHeartbeat({
  send,
  health,
  version,
  hostname,
  getModuleStatus,
  intervalMs = 30000,
} = {}) {
  let timer = null;

  function sendNow() {
    send({
      type: 'heartbeat',
      version,
      hostname,
      health: health.build(),
      module_status: typeof getModuleStatus === 'function' ? getModuleStatus() : {},
    });
  }

  return {
    sendNow,
    start() {
      if (timer) return; // idempotent — never stack intervals
      timer = setInterval(sendNow, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

module.exports = createHeartbeat;
