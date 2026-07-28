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
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const createIdentityStore = require('./identity-store');

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
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      // A mid-response connection reset emits 'error' on the response stream; with
      // no listener that would bubble to process-level uncaughtException (which the
      // entrypoint answers with process.exit(1) — killing the span data path).
      res.on('error', (e) => {
        req.destroy();
        finish(reject, e);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (_e) {
          body = null; // non-JSON body — leave null, caller only needs the code
        }
        finish(resolve, { statusCode: res.statusCode, body });
      });
    });
    // A black-hole hub (accepts TCP, never responds) must not hang forever — that
    // would leak a socket/FD every interval and could eventually starve the span
    // transport. 15s is well under the 30s heartbeat cadence.
    req.setTimeout(15000, () => req.destroy(new Error('hub request timeout')));
    req.on('error', (e) => {
      req.destroy();
      finish(reject, e);
    });
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
    // Phase 3 Workstream B: the signed-self-update driver. The hub channel now owns
    // self-update — on the policy tick we fetch the signed manifest and hand it to
    // updater.consider(); absent an updater this is simply skipped.
    updater,
    // Phase 4a: injectable process exit for the hub-carried `restart` command. The hub
    // has no server→agent socket, so a restart arrives in a heartbeat response and is
    // executed here (process.exit(0) → NSSM restarts). Overridable so tests can assert
    // a restart was requested WITHOUT killing the test runner. Default = real exit.
    exit = () => process.exit(0),
    // Testability: override the heartbeat cadence (default 30s) and identity path.
    intervalMs = 30000,
    policyIntervalMs = 300000, // ~5 min
    identityPath = DEFAULT_IDENTITY_PATH,
    // The SHARED identity store both hub.js and the span identity consult (Phase 3).
    // The entrypoint passes the one it also wired into core/identity.js so the span
    // transport can present this JWT; tests that drive hub.js alone pass none and get
    // a private store over identityPath (same file, same atomic write as before).
    store = createIdentityStore({ identityPath, logger }),
  } = opts || {};

  const hubUrl = config.hubUrl && String(config.hubUrl).replace(/\/+$/, ''); // trim trailing /
  const enrollToken = config.enrollToken;

  function log(...a) {
    if (logger && logger.info) logger.info('[hub]', ...a);
  }
  function logErr(...a) {
    if (logger && logger.error) logger.error('[hub]', ...a);
  }

  let lastPolicy = null;
  let stopped = false;

  // Pull the span module's ingest WS URL out of an enroll/policy modules[] list so the
  // transport (via the store) knows WHERE to dial in JWT-mode. Accepts app==='span'
  // or 'spanvault'; returns null if the span module isn't present / carries no ingest.
  function extractSpanIngest(modules) {
    if (!Array.isArray(modules)) return null;
    for (const m of modules) {
      if (!m) continue;
      const app = String(m.app || m.name || '').toLowerCase();
      if ((app === 'span' || app === 'spanvault') && m.ingest) return m.ingest;
    }
    return null;
  }

  // Decode a JWT's payload (base64url middle segment) WITHOUT verifying — used only to
  // read iat/exp so we can size the refresh window as a fraction of the real TTL.
  function jwtClaims(jwt) {
    try {
      const seg = String(jwt).split('.')[1];
      if (!seg) return null;
      const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return JSON.parse(json);
    } catch (_e) {
      return null;
    }
  }

  // Refresh once less than 1/3 of the TTL remains (per the Phase 3 plan). TTL is taken
  // from the JWT's own exp-iat when decodable, else a 30-day assumption (the hub's
  // issue default). An already-expired identity returns true (a last-ditch refresh).
  function shouldRefresh(id) {
    if (!id || !id.expires_at) return false;
    const exp = Date.parse(id.expires_at);
    if (isNaN(exp)) return false;
    const remaining = exp - Date.now();
    if (remaining <= 0) return true;
    let ttlMs = 30 * 24 * 3600 * 1000;
    const claims = jwtClaims(id.jwt);
    if (claims && claims.exp && claims.iat && claims.exp > claims.iat) {
      ttlMs = (claims.exp - claims.iat) * 1000;
    }
    return remaining < ttlMs / 3;
  }

  let heartbeatTimer = null;
  let policyTimer = null;
  let enrollTimer = null;
  let enrollAttempts = 0;
  // Guards the self-scheduling loops: a tick re-arms only while this is true, so a
  // 401 (identityRejected) or stop() halts both loops without any further spin.
  let loopsActive = false;

  // Same backoff spirit as core/transport.js: 10s * 1.5^n, capped at 120s, with
  // 0.8–1.2 jitter so a fleet doesn't retry enrollment in lockstep.
  function backoffDelay(attempt) {
    const base = Math.min(120000, 10000 * Math.pow(1.5, Math.max(0, attempt - 1)));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  // Identity load/persist + the atomic tmp+rename now live in the shared store
  // (core/identity-store.js); hub.js reads via store.get() and writes via store.set(),
  // storing the span ingest URL alongside the identity so the transport can dial it.

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
      // Persist via the shared store, INCLUDING the span ingest URL the hub handed
      // back in modules[] — so the span transport (via the store) knows where to dial
      // in JWT-mode. store.set() emits a change, which wakes a deferred transport.
      store.set({
        agent_id: res.body.agent_id,
        jwt: res.body.identity.jwt,
        expires_at: res.body.identity.expires_at,
        ingest: extractSpanIngest(res.body.modules),
      });
      enrollAttempts = 0;
      log(`enrolled as ${res.body.agent_id} — identity persisted`);
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
  // Self-scheduling setTimeout instead of setInterval: each tick re-arms the next
  // ONLY after the previous call settles, so a slow or black-hole hub can never
  // stack overlapping in-flight requests (which would leak sockets/FDs and could
  // eventually starve the span transport). Cadences (intervalMs / policyIntervalMs)
  // are preserved. stop() / identityRejected() flip loopsActive off + clear timers.
  function armHeartbeat() {
    if (stopped || !loopsActive) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(runHeartbeat, intervalMs);
  }
  async function runHeartbeat() {
    heartbeatTimer = null;
    try {
      await sendHeartbeat();
    } catch (e) {
      logErr('heartbeat loop error:', e.message);
    }
    armHeartbeat(); // re-arm only after this call settled (no-op if loops stopped)
  }
  function armPolicy() {
    if (stopped || !loopsActive) return;
    if (policyTimer) clearTimeout(policyTimer);
    policyTimer = setTimeout(runPolicy, policyIntervalMs);
  }
  async function runPolicy() {
    policyTimer = null;
    try {
      await pollPolicy();
    } catch (e) {
      logErr('policy loop error:', e.message);
    }
    // A5: piggy-back the JWT refresh check on the policy tick. Refresh renews the
    // data-path credential before the TTL expires so the span session doesn't die at
    // 30 days; on success store.set() fires onChange → the transport reconnects with
    // the new token; on 401 identityRejected() stops the loops (no spin).
    try {
      await maybeRefresh();
    } catch (e) {
      logErr('refresh loop error:', e.message);
    }
    // B4: piggy-back the signed self-update check on the policy tick. Best-effort —
    // a fetch/verify failure only logs; it must NEVER crash the data path.
    try {
      await maybeSelfUpdate();
    } catch (e) {
      logErr('self-update loop error:', e.message);
    }
    armPolicy(); // re-arm only after this call settled (no-op if loops stopped)
  }

  function startLoops() {
    if (stopped || !store.get() || loopsActive) return;
    loopsActive = true;
    runHeartbeat(); // send one promptly so the fleet page populates fast, then re-arm
    runPolicy(); // one immediate poll, then on the slow cadence
  }

  // A rejected identity (revoked/expired) must stop the loops WITHOUT spinning.
  function identityRejected() {
    logErr('hub identity rejected — agent may have been revoked; stopping hub heartbeats');
    loopsActive = false; // any in-flight tick will NOT re-arm once it settles
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (policyTimer) {
      clearTimeout(policyTimer);
      policyTimer = null;
    }
    // Move the dead identity aside so a RESTART with a fresh enrollToken can
    // re-enroll instead of reloading the revoked JWT forever. We do NOT re-enroll
    // within THIS run (loops stay stopped above) — only a restart retries, so the
    // "no spin" property is preserved. store.reject() also emits a change so a
    // JWT-mode span transport drops the now-credential-less socket.
    store.reject();
  }

  // ── Phase 4a: execute a hub-carried command ────────────────────────────────────
  // The hub↔agent link is an HTTP poll with NO server→agent socket, so lifecycle ops
  // (restart / get_logs) are queued server-side and carried back in a heartbeat 200
  // body ({ commands:[{id,type,args}] }); the hub marks each 'delivered' when it hands
  // it back, so the agent won't receive the same command twice. This runs ON the
  // heartbeat path, so it is strictly best-effort and MUST NEVER crash: any error can
  // cost only a log line, never the span data path. Unlike the span-WS runtime (which
  // replies over the socket), the hub has no socket — so `get_logs` POSTs its tail
  // back to the hub's /logs endpoint (the return path); `restart` needs no return.
  async function handleCommand(cmd) {
    // Guard a null / typeless command (defensive — the hub shouldn't send one).
    if (!cmd || !cmd.type) return;
    try {
      if (cmd.type === 'restart') {
        log(`restart command received (id=${cmd.id}) — exiting; the service manager will restart`);
        exit(0);
        return;
      }
      if (cmd.type === 'get_logs') {
        const id = store.get();
        if (!id) return; // no identity → nowhere to authenticate the upload
        const lines = logger && typeof logger.tail === 'function' ? logger.tail(200) : [];
        try {
          const res = await httpPostJson(
            `${hubUrl}/api/agents/${id.agent_id}/logs`,
            { lines, command_id: cmd.id },
            { Authorization: `Bearer ${id.jwt}` }
          );
          if (res.statusCode === 200) {
            log(`get_logs command (id=${cmd.id}) — ${lines.length} line(s) posted to hub`);
          } else {
            logErr(`get_logs upload failed (HTTP ${res.statusCode})`);
          }
        } catch (e) {
          // Best-effort return path — a failed upload only logs, never crashes.
          logErr('get_logs upload network error:', e.message);
        }
        return;
      }
      logErr(`unknown hub command type '${cmd.type}' (id=${cmd.id}) — ignoring`);
    } catch (e) {
      // A command handler must NEVER crash the heartbeat/data path.
      logErr('command handler error:', e.message);
    }
  }

  async function sendHeartbeat() {
    const id = store.get();
    if (stopped || !id) return;
    let res;
    try {
      // Build the body INSIDE the try: an injected accessor (health.build /
      // getModuleStatus / getBufferDepth) that throws must be caught locally and
      // logged, never escape as an unhandled rejection out of the hub client.
      const body = {
        version,
        health: health && typeof health.build === 'function' ? health.build() : {},
        module_status: typeof getModuleStatus === 'function' ? getModuleStatus() : {},
        buffer_depth: typeof getBufferDepth === 'function' ? getBufferDepth() : 0,
      };
      res = await httpPostJson(
        `${hubUrl}/api/agents/${id.agent_id}/heartbeat`,
        body,
        { Authorization: `Bearer ${id.jwt}` }
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
      return;
    }
    // Phase 4a: the hub carries any queued commands back in the 200 body (there is no
    // server→agent socket). Execute each — handleCommand is fully self-guarding, so a
    // bad command can never crash this heartbeat tick or the span data path.
    const commands = res.body && Array.isArray(res.body.commands) ? res.body.commands : [];
    for (const cmd of commands) {
      await handleCommand(cmd);
    }
  }

  async function pollPolicy() {
    const id = store.get();
    if (stopped || !id) return;
    let res;
    try {
      res = await httpGetJson(`${hubUrl}/api/agents/${id.agent_id}/policy`, {
        Authorization: `Bearer ${id.jwt}`,
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
      // A4d: if the policy re-advertises the span ingest URL and it changed, update
      // the store (preserving the current JWT) so the transport re-dials the new
      // ingest on the resulting onChange. No change → no store write → no churn.
      const ingest = extractSpanIngest(res.body.modules);
      const cur = store.get();
      if (ingest && cur && ingest !== cur.ingest) {
        store.set({ agent_id: cur.agent_id, jwt: cur.jwt, expires_at: cur.expires_at, ingest });
        log(`span ingest URL updated from policy: ${ingest}`);
      }
      log(`policy fetched (${res.body.modules.length} module(s)) — stored, not applied`);
    } else {
      logErr(`policy poll unexpected response (HTTP ${res.statusCode})`);
    }
  }

  // ── A5: identity refresh (renew the JWT before it expires) ──────────────────────
  // CONTRACT: POST <hubUrl>/api/agents/<agent_id>/refresh (Authorization: Bearer <jwt>)
  //   -> 200 { jwt, expires_at }   (issues a fresh identity)
  //   -> 401                       (revoked/expired) — stop, same no-spin rule as HB.
  // On success we store.set() the new token (preserving agent_id + ingest), which fires
  // onChange so the span transport reconnects to present it.
  async function maybeRefresh() {
    const id = store.get();
    if (stopped || !loopsActive || !id) return;
    if (!shouldRefresh(id)) return;
    let res;
    try {
      res = await httpPostJson(
        `${hubUrl}/api/agents/${id.agent_id}/refresh`,
        {},
        { Authorization: `Bearer ${id.jwt}` }
      );
    } catch (e) {
      // Network error — best-effort; the token still has >0 TTL, retry next tick.
      logErr('refresh network error:', e.message);
      return;
    }
    if (res.statusCode === 401) {
      identityRejected();
      return;
    }
    if (res.statusCode === 200 && res.body && res.body.jwt) {
      store.set({
        agent_id: id.agent_id,
        jwt: res.body.jwt,
        expires_at: res.body.expires_at,
        ingest: id.ingest,
      });
      log(`identity refreshed — new expiry ${res.body.expires_at || '?'}`);
    } else {
      logErr(`refresh failed (HTTP ${res.statusCode})`);
    }
  }

  // ── B4: hub-driven signed self-update ───────────────────────────────────────────
  // On the policy tick, fetch the signed update manifest from the hub and hand it to
  // the updater, which verifies the Ed25519 signature + each file's sha256 BEFORE
  // staging anything and only applies (via a restart into apply-on-next-start) on full
  // success. CONTRACT:
  //   GET <hubUrl>/api/agents/update-manifest  (public, like the bundle routes)
  //     -> 200 { version, files:[{path,sha256}], sig }   (a signed manifest)
  //     -> 404                                            (no update advertised — no-op)
  // Best-effort: any fetch error only logs (never crashes the data path). Only runs
  // while the hub channel is active (loopsActive), so it's naturally gated to enrolled
  // agents. The updater downloads each file from <hubUrl>/api/agents/bundle/<path>.
  async function maybeSelfUpdate() {
    if (stopped || !loopsActive) return;
    if (!updater || typeof updater.consider !== 'function') return;
    let res;
    try {
      res = await httpGetJson(`${hubUrl}/api/agents/update-manifest`);
    } catch (e) {
      logErr('update-manifest fetch network error:', e.message);
      return;
    }
    if (res.statusCode === 404) return; // no update advertised — normal
    if (res.statusCode !== 200 || !res.body) {
      logErr(`update-manifest unexpected response (HTTP ${res.statusCode})`);
      return;
    }
    // consider() is fully self-guarding: it verifies the signature before any download
    // or write, skips if already on this version, and aborts (discarding pending/) on
    // any per-file mismatch. On full success it stages + restarts the process.
    await updater.consider(res.body, { bundleBaseUrl: `${hubUrl}/api/agents/bundle` });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    start() {
      if (!hubUrl || !enrollToken) {
        // Defensive — the entrypoint guards this too. Absent config => no channel.
        return;
      }
      stopped = false;
      const loaded = store.load();
      if (loaded) {
        log(`using stored identity ${loaded.agent_id} — skipping enrollment`);
        startLoops();
      } else {
        log('no stored identity — enrolling with hub');
        enroll().catch((e) => logErr('enroll error:', e.message));
      }
    },
    stop() {
      stopped = true;
      loopsActive = false;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (policyTimer) {
        clearTimeout(policyTimer);
        policyTimer = null;
      }
      if (enrollTimer) {
        clearTimeout(enrollTimer);
        enrollTimer = null;
      }
    },
    // Exposed for tests/introspection (not used by the entrypoint).
    _getIdentity: () => store.get(),
    _getPolicy: () => lastPolicy,
    _maybeRefresh: () => maybeRefresh(),
    _getStore: () => store,
  };
}

module.exports = createHubClient;
