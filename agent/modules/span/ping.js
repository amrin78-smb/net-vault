'use strict';
/**
 * modules/span/ping.js — ICMP probe + a lightweight discovery ping.
 *
 * Extracted verbatim from the legacy SpanVault agent (agent.js:530-556,765-768),
 * preserving byte-for-byte on-wire behaviour:
 *  - doPing(): 3 probes (`-n`/`-c 3`), 5s timeout, threshold `ping_threshold_ms||500`;
 *    emits { type:'ping_result', device_id, ts:ISO, response_ms, packet_loss_pct, status }
 *    with the exact up/warning/down logic and the exception path
 *    (response_ms:null, packet_loss_pct:100, status:'down').
 *  - pingHost(): 1 probe (`-n`/`-c 1`), 1s timeout -> boolean alive (used by discovery).
 */
const ping = require('ping');

// Windows uses -n for the ping count, everything else -c (agent.js:531).
const IS_WIN = process.platform === 'win32';

// doPing: full device ICMP poll. Never throws — the exception path still ships a
// 'down' ping_result so a probe crash is reported, not swallowed (agent.js:533-556).
async function doPing(device, send) {
  const countFlag = IS_WIN ? '-n' : '-c';
  try {
    const res = await ping.promise.probe(device.ip_address, { timeout: 5, extra: [countFlag, '3'] });
    let ms = null;
    if (res.alive && res.avg !== undefined && res.avg !== 'unknown') {
      const t = parseFloat(res.avg);
      if (!isNaN(t)) ms = t;
    }
    const threshold = device.ping_threshold_ms || 500;
    const status = res.alive ? (ms !== null && ms > threshold ? 'warning' : 'up') : 'down';
    send({
      type: 'ping_result', device_id: device.id,
      ts: new Date().toISOString(), response_ms: ms,
      packet_loss_pct: res.alive ? 0 : 100, status,
    });
  } catch (e) {
    send({
      type: 'ping_result', device_id: device.id,
      ts: new Date().toISOString(), response_ms: null,
      packet_loss_pct: 100, status: 'down',
    });
  }
}

// pingHost: single-probe reachability check for the discovery sweep (agent.js:765-768).
function pingHost(ip) {
  return ping.promise.probe(ip, { timeout: 1, extra: [IS_WIN ? '-n' : '-c', '1'] })
    .then((r) => !!r.alive).catch(() => false);
}

module.exports = { doPing, pingHost, IS_WIN };
