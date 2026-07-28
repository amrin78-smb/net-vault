'use strict';
/**
 * core/hub.js — OPT-IN hub control-plane client (NocVault Agents, Phase 2).
 *
 * This is an ADDITIVE side-channel. It does NOT touch the app-WS data path: the
 * span module still gets its device config and ships results over the existing
 * outbound WebSocket (core/transport.js) to SpanVault. The hub channel only:
 *   (a) enrolls ONCE with the NetVault hub to obtain a signed identity (JWT), and
 *   (b) periodically posts a fleet HEARTBEAT so the launcher Agents page is
 *       populated, plus a light POLICY poll (fetched + stored, NOT applied in
 *       Phase 2 — the module's real work config still comes from the app WS).
 *
 * Everything here is best-effort and MUST NEVER crash the agent: an unreachable
 * or hostile hub can only cost a log line, never the data path. It is wired into
 * the entrypoint only when BOTH `config.hubUrl` and `config.enrollToken` are set;
 * absent either, the agent behaves exactly as Phase 1 (no hub channel at all).
 *
 * HUB API CONTRACT (must match the NetVault backend agent):
 *   POST <hubUrl>/api/agents/enroll
 *        { token, hostname, os, agent_version, local_ip }
 *     -> 200 { agent_id, identity:{ jwt, expires_at }, modules:[...] }
 *     -> 401 on bad/expired/used token
 *   POST <hubUrl>/api/agents/<agent_id>/heartbeat   (Authorization: Bearer <jwt>)
 *        { version, health, module_status, buffer_depth }  -> 200 { ok:true }
 *   GET  <hubUrl>/api/agents/<agent_id>/policy       (Authorization: Bearer <jwt>)
 *        -> 200 { modules:[...] }
 *
 * Identity is persisted at agent/hub-identity.json ({ agent_id, jwt, expires_at });
 * present on start => enrollment is skipped.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

// Persist the issued identity next to the agent (agent/hub-identity.json). The
// entrypoint lives one level up from core/, matching config.json's location.
const DEFAULT_IDENTITY_PATH = path.join(__dirname, '..', 'hub-identity.json');

// ── JSON HTTP helpers (built-ins only — no dependency) ─────────────────────────
// Mirror updater.js:httpGetBuffer's http/https-by-scheme style, but JSON in/out.
// Resolve { statusCode, body } (body = parsed JSON or null); reject only on a
// transport error, so callers can branch on the status code (e.g. 401).
function requestJson(method, url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    };
    if (payload != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (_e) {
          body = null; // non-JSON body — leave null, caller only needs the code
        }
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const httpPostJson = (url, bodyObj, headers) => requestJson('POST', url, headers, bodyObj);
const httpGetJson = (url, headers) => requestJson('GET', url, headers, null);

// Best-effort primary IPv4 of the agent host (first non-internal IPv4).
function primaryIpv4() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        const family = ni.family;
        if ((family === 'IPv4' || family === 4) && !ni.internal && ni.address) {
          return ni.address;
        }
      }
    }
  } catch (_e) {
    /* ignore — local_ip is best-effort */
  }
  return null;
}

function createHubClient(opts) {
  const {
    config = {},
    health,
    version,
    hostname,
    getModuleStatus,
    getBufferDepth,
    logger,
    // Testability: override the heartbeat cadence (default 30s) and identity path.
    intervalMs = 30000,
    policyIntervalMs = 300000, // ~5 min
    identityPath = DEFAULT_IDENTITY_PATH,
  } = opts || {};

  const hubUrl = config.hubUrl && String(config.hubUrl).replace(/\/+$/, ''); // trim trailing /
  const enrollToken = config.enrollToken;

  function log(...a) {
    if (logger && logger.info) logger.info('[hub]', ...a);
  }
  function logErr(...a) {
    if (logger && logger.error) logger.error('[hub]', ...a);
  }

  let identity = null; // { agent_id, jwt, expires_at }
  let lastPolicy = null;
  let stopped = false;

  let heartbeatTimer = null;
  let policyTimer = null;
  let enrollTimer = null;
  let enrollAttempts = 0;

  // Same backoff spirit as core/transport.js: 10s * 1.5^n, capped at 120s, with
  // 0.8–1.2 jitter so a fleet doesn't retry enrollment in lockstep.
  function backoffDelay(attempt) {
    const base = Math.min(120000, 10000 * Math.pow(1.5, Math.max(0, attempt - 1)));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  function loadIdentity() {
    try {
      if (fs.existsSync(identityPath)) {
        const parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8').replace(/^\uFEFF/, ''));
        if (parsed && parsed.agent_id && parsed.jwt) return parsed;
      }
    } catch (e) {
      logErr('could not read stored identity:', e.message);
    }
    return null;
  }

  function persistIdentity(id) {
    try {
      fs.writeFileSync(
        identityPath,
        JSON.stringify({ agent_id: id.agent_id, jwt: id.jwt, expires_at: id.expires_at }, null, 2)
      );
    } catch (e) {
      logErr('could not persist identity:', e.message);
    }
  }

  // ── Enrollment ───────────────────────────────────────────────────────────────
  async function enroll() {
    if (stopped) return;
    const body = {
      token: enrollToken,
      hostname,
      os: `${os.type()} ${os.release()}`,
      agent_version: version,
      local_ip: primaryIpv4(),
    };
    let res;
    try {
      res = await httpPostJson(`${hubUrl}/api/agents/enroll`, body);
    } catch (e) {
      // Network error — retry with backoff. Must not crash the data path.
      return scheduleEnrollRetry(`enroll network error: ${e.message}`);
    }
    if (res.statusCode === 200 && res.body && res.body.agent_id && res.body.identity) {
      identity = {
        agent_id: res.body.agent_id,
        jwt: res.body.identity.jwt,
        expires_at: res.body.identity.expires_at,
      };
      persistIdentity(identity);
      enrollAttempts = 0;
      log(`enrolled as ${identity.agent_id} — identity persisted`);
      startLoops();
      return;
    }
    if (res.statusCode === 401) {
      // Bad/expired/used token — still retry (the operator may issue a fresh one),
      // but make it clear the token is the problem. Never spin tight (backoff).
      return scheduleEnrollRetry('enroll rejected (401) — token bad/expired/used');
    }
    return scheduleEnrollRetry(`enroll failed (HTTP ${res.statusCode})`);
  }

  function scheduleEnrollRetry(reason) {
    if (stopped) return;
    enrollAttempts++;
    const delay = backoffDelay(enrollAttempts);
    logErr(`${reason} — retrying in ${Math.round(delay / 1000)}s (attempt ${enrollAttempts})`);
    if (enrollTimer) clearTimeout(enrollTimer);
    enrollTimer = setTimeout(() => {
      enroll().catch((e) => logErr('enroll retry error:', e.message));
    }, delay);
  }

  // ── Heartbeat + policy loops (only once enrolled) ──────────────────────────────
  function startLoops() {
    if (stopped || !identity) return;
    sendHeartbeat(); // send one promptly so the fleet page populates fast
    if (!heartbeatTimer) heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
    pollPolicy(); // one immediate poll, then on the slow cadence
    if (!policyTimer) policyTimer = setInterval(pollPolicy, policyIntervalMs);
  }

  // A rejected identity (revoked/expired) must stop the loops WITHOUT spinning.
  function identityRejected() {
    logErr('hub identity rejected — agent may have been revoked; stopping hub heartbeats');
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (policyTimer) {
      clearInterval(policyTimer);
      policyTimer = null;
    }
  }

  async function sendHeartbeat() {
    if (stopped || !identity) return;
    const body = {
      version,
      health: health && typeof health.build === 'function' ? health.build() : {},
      module_status: typeof getModuleStatus === 'function' ? getModuleStatus() : {},
      buffer_depth: typeof getBufferDepth === 'function' ? getBufferDepth() : 0,
    };
    let res;
    try {
      res = await httpPostJson(
        `${hubUrl}/api/agents/${identity.agent_id}/heartbeat`,
        body,
        { Authorization: `Bearer ${identity.jwt}` }
      );
    } catch (e) {
      // Network error — best-effort, keep the interval and try again next tick.
      logErr('heartbeat network error:', e.message);
      return;
    }
    if (res.statusCode === 401) {
      identityRejected();
      return;
    }
    if (res.statusCode !== 200) {
      logErr(`heartbeat failed (HTTP ${res.statusCode})`);
    }
  }

  async function pollPolicy() {
    if (stopped || !identity) return;
    let res;
    try {
      res = await httpGetJson(`${hubUrl}/api/agents/${identity.agent_id}/policy`, {
        Authorization: `Bearer ${identity.jwt}`,
      });
    } catch (e) {
      logErr('policy poll network error:', e.message);
      return;
    }
    if (res.statusCode === 401) {
      identityRejected();
      return;
    }
    if (res.statusCode === 200 && res.body && Array.isArray(res.body.modules)) {
      // Phase 2: store + log only. Do NOT apply policy to modules yet — the span
      // module's real work config still arrives over the app WS.
      lastPolicy = res.body;
      log(`policy fetched (${res.body.modules.length} module(s)) — stored, not applied`);
    } else {
      logErr(`policy poll unexpected response (HTTP ${res.statusCode})`);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    start() {
      if (!hubUrl || !enrollToken) {
        // Defensive — the entrypoint guards this too. Absent config => no channel.
        return;
      }
      stopped = false;
      identity = loadIdentity();
      if (identity) {
        log(`using stored identity ${identity.agent_id} — skipping enrollment`);
        startLoops();
      } else {
        log('no stored identity — enrolling with hub');
        enroll().catch((e) => logErr('enroll error:', e.message));
      }
    },
    stop() {
      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (policyTimer) {
        clearInterval(policyTimer);
        policyTimer = null;
      }
      if (enrollTimer) {
        clearTimeout(enrollTimer);
        enrollTimer = null;
      }
    },
    // Exposed for tests/introspection (not used by the entrypoint).
    _getIdentity: () => identity,
    _getPolicy: () => lastPolicy,
  };
}

module.exports = createHubClient;
