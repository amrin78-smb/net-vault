'use strict';
/**
 * NocVault Agent — unified remote agent (Phase 1).
 *
 * A single outbound-dialing NSSM service that runs pluggable collection modules
 * (Phase 1: only `span` — SNMP + ICMP, byte-for-byte compatible with SpanVault's
 * ws-server). The core (transport / buffer / reconnect / heartbeat / health /
 * signed self-update / module router) is app-agnostic; each module ships raw
 * results over the shared transport and the server does all interpretation.
 *
 * Config: agent/config.json  { serverUrl, apiKey, wsPort?, updateUrl?, modules? }
 * Buffer: agent/buffer.json  — results queued while offline (capped)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep this literal exactly `const VERSION = '...'` (single quotes): SpanVault's
// server fingerprints agents with the regex  const VERSION = '([^']+)'.
const VERSION = '2.6.0';

// ── Self-update apply-on-next-start (Phase 3, Workstream B) — RUNS FIRST ────────
// This gate MUST execute BEFORE requiring any core module a pending update could
// replace: if a freshly-swapped build has a load-time error in a core module, the
// process crashes during that require. Were the gate AFTER the requires, the crash
// would beat the confirm-attempt bump and the crash-loop rollback would never fire
// (a brick). Running the gate first means a broken module crashes AFTER the counter
// is bumped, so it self-heals (rolls back once attempts >= 3). Only core/apply-update
// (Node built-ins only) loads before the gate; we log via a bare console because
// core/logger.js is itself replaceable and must not load before the gate either.
const { applyPendingIfAny, checkConfirmOnStart, commitUpdate } = require('./core/apply-update');
const bootLog = {
  info: (...a) => console.log('[Agent]', ...a),
  error: (...a) => console.error('[Agent]', ...a),
};
const applied = applyPendingIfAny(__dirname, bootLog);
if (applied.applied) {
  bootLog.info('Self-update applied -> restarting into new build');
  process.exit(0);
}
const confirm = checkConfirmOnStart(__dirname, bootLog);
if (confirm.rolledBack) {
  bootLog.error('New build failed to start; rolled back to the previous version - restarting');
  process.exit(0);
}

// Core modules — required AFTER the self-update gate, so a just-swapped broken build
// crashes here (after the confirm counter is bumped) and can still roll back.
const createLogger = require('./core/logger');
const createIdentityStore = require('./core/identity-store');
const createIdentity = require('./core/identity');
const createBuffer = require('./core/buffer');
const createTransport = require('./core/transport');
const createRuntime = require('./core/runtime');
const createHealth = require('./core/health');
const createUpdater = require('./core/updater');
const createHeartbeat = require('./core/heartbeat');

// ── Config ────────────────────────────────────────────────────
// Strip a leading UTF-8 BOM (U+FEFF) — PowerShell can write config.json with one
// and JSON.parse rejects it.
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));

// ── Core singletons ───────────────────────────────────────────
const logger = createLogger('Agent');

// The ONE shared identity store (Phase 3). Both the span identity (below) and the
// hub client consult it, so the span data path can present the hub-issued JWT.
// load() up front so a JWT-mode agent with a persisted identity can present it on the
// very FIRST dial (no defer); an apiKey-mode agent simply finds nothing and uses its
// apiKey exactly as Phase 1.
const store = createIdentityStore({ logger });
store.load();
const identity = createIdentity(config, store);
const buffer = createBuffer({ dir: __dirname, max: 500, logger });

const hostname = os.hostname();

// Wiring note: transport.send is referenced by both the heartbeat and the span
// module's ctx, but the transport is created AFTER them (its onOpen needs the
// heartbeat, and it needs the module wired into the runtime). We break the cycle
// with two forward-declared `let`s + a `send` indirection: `send(m)` and the
// transport's `onMessage`/`onOpen` are closures that read `transport`/`runtime`
// at CALL time, by which point (span.start / heartbeat.start / transport.start,
// all at the very end) both have been assigned.
let transport;
let runtime;
const send = (m) => transport.send(m);

// ── Modules ───────────────────────────────────────────────────
// Phase 1 always loads the span module. (Later phases load a module only when
// present/enabled in config.modules.)
const createSpanModule = require('./modules/span');
const spanCtx = {
  config: (config.modules && config.modules.span) || {},
  send,
  // The module shares the core logger instance so its output lands in the same
  // in-memory ring the server pulls via get_logs (single-ring get_logs parity
  // with the legacy agent, whose SNMP/ICMP logs were part of the same tail).
  logger,
  hostname,
  version: VERSION,
};
const span = createSpanModule(spanCtx);

// ── ddi module (Phase 4b) — loaded IN ADDITION to span when enabled ────────────
// A module is enabled when present in config.modules (an object key, or an array entry).
// span is always on; ddi is opt-in via config so a span-only agent is unaffected.
function moduleEnabled(name) {
  const m = config.modules;
  if (!m) return false;
  if (Array.isArray(m)) return m.includes(name);
  const v = m[name];
  return v === true || (v && typeof v === 'object' && v.enabled !== false);
}
const ddiEnabled = moduleEnabled('ddi') || moduleEnabled('ddivault');

// MULTI-INGEST: span ships to the SpanVault ingest (spanvault:3010) and ddi to the
// DDIVault ingest (ddivault:3011) — DIFFERENT app-WS endpoints. The core transport dials
// exactly ONE ingest URL, so each module gets its OWN transport (built below). `ddiSend`
// is a forward indirection into that transport, wired like the span `send` above.
let ddiTransport = null;
const ddiSend = (m) => { if (ddiTransport) ddiTransport.send(m); };
let ddi = null;
if (ddiEnabled) {
  const createDdiModule = require('./modules/ddi');
  ddi = createDdiModule({
    config: (config.modules && config.modules.ddi) || {},
    send: ddiSend,
    logger,
    hostname,
    version: VERSION,
  });
}

// Combined module-status map for the heartbeats (core span-WS + hub fleet). Includes ddi
// only when enabled, so the SpanVault heartbeat and the launcher Agents page both reflect it.
const moduleStatus = () => {
  const s = { [span.name]: span.status() };
  // Report ddi.status() only when its data plane actually came up. When ddi is enabled but
  // its transport was NOT started (apiKey-mode / not hub-enrolled → ddiTransport stays null),
  // the plane is inert; reporting ddi.status() ('ok') would make a dead plane look healthy on
  // the span-WS + hub heartbeats. Surface a distinct status instead. (ddiTransport is a `let`
  // assigned later in startup; this closure reads it at heartbeat time, by when it is set.)
  if (ddi) s[ddi.name] = ddiTransport ? ddi.status() : 'disabled:not-enrolled';
  return s;
};

// FIX 3 helper: a VALID, unexpired hub-issued JWT from the shared store (mirrors
// core/identity.js's validHubIdentity). ddi's data plane authenticates DDIVault with THIS
// hub JWT — never an apiKey (DDIVault would reject SpanVault's apiKey → endless reconnect).
function validHubJwt() {
  const id = typeof store.get === 'function' ? store.get() : null;
  if (!id || !id.jwt) return null;
  if (id.expires_at) {
    const t = Date.parse(id.expires_at);
    if (!isNaN(t) && Date.now() >= t) return null; // expired hub identity
  }
  return id;
}

// Is this agent hub-enrolled (JWT-mode)? Either it is configured to enroll (hubUrl +
// enrollToken → the hub channel provides/refreshes the JWT) or it already holds a persisted
// hub identity. An apiKey-mode / unenrolled agent is NOT hub-enrolled, so ddi stays off there
// (FIX 3): ddi requires a hub JWT, and presenting an apiKey to DDIVault would loop forever.
function hubEnrolled() {
  if (config.hubUrl && config.enrollToken) return true;
  return !!validHubJwt();
}

// FIX 4: fire the "assumed co-located ddi ingest" warning at most once (resolveDdiIngest is
// called on every isReady()/dial, so it must not log on every tick).
let ddiIngestAssumedWarned = false;

// Resolve WHERE the ddi transport dials. Resolution order:
//   1. explicit config.modules.ddi.ingest (or config.ddi.ingest) — full override;
//   2. JWT-mode: the SAME host the hub advertised for the span ingest, but the ddi port
//      (co-located suite is the common case; the hub does not yet advertise a per-module
//      ingest map — see the report's multi-ingest note);
//   3. apiKey-mode / fallback: config.serverUrl's host + the ddi port.
// Returns null when nothing resolves (the transport then defers its dial).
function resolveDdiIngest(cfg, ident) {
  const modCfg = (cfg.modules && cfg.modules.ddi) || cfg.ddi || {};
  if (modCfg.ingest) return modCfg.ingest;
  const port = modCfg.wsPort || 3011;
  try {
    const spanIngest = typeof ident.getIngest === 'function' ? ident.getIngest() : null;
    if (spanIngest) {
      const u = new URL(spanIngest);
      u.port = String(port);
      // FIX 4: the ddi ingest host was ASSUMED co-located with SpanVault (we swapped only the
      // port onto the hub-advertised span ingest host — there was no explicit
      // config.modules.ddi.ingest and no per-module hub ingest map). In a SPLIT deployment
      // (DDIVault on a different host) this points at the wrong box → a silent ddi reconnect
      // loop; log it once so that failure is diagnosable. Resolution logic itself is unchanged.
      if (!ddiIngestAssumedWarned) {
        ddiIngestAssumedWarned = true;
        logger.info(
          `[ddi] WARNING: DDIVault ingest host assumed co-located with SpanVault (${u.hostname}:${port}) — ` +
          'derived by port-swap on the span ingest. If DDIVault runs on a DIFFERENT host, set ' +
          'config.modules.ddi.ingest to avoid a silent reconnect loop.'
        );
      }
      return u.toString();
    }
  } catch (_e) { /* fall through */ }
  try {
    const host = new URL(cfg.serverUrl).hostname;
    const scheme = /^https/i.test(cfg.serverUrl) ? 'wss' : 'ws';
    return `${scheme}://${host}:${port}/`;
  } catch (_e) { /* no usable serverUrl */ }
  return null;
}

// A thin identity adapter for the ddi transport: reuse the shared hub identity (its JWT
// `aud` already covers every assigned module) and only OVERRIDE where to dial.
// FIX 3: isReady() requires a VALID HUB JWT specifically — NOT the base identity's isReady(),
// which is also true in apiKey-mode. Were it to fall back to the apiKey, the ddi transport
// would present SpanVault's apiKey to the DDIVault ingest, DDIVault would reject it, and the
// socket would reconnect forever. So the ddi plane dials only once a hub JWT exists (and a
// ddi ingest resolves, so it never falls back to the span port). getAuthHeader presents that
// hub JWT (ident.getAuthHeader is already JWT-first, so it returns the JWT once isReady gates).
function makeDdiIdentity(cfg, ident) {
  return {
    getAuthHeader: () => ident.getAuthHeader(),
    isReady: () => !!validHubJwt() && !!resolveDdiIngest(cfg, ident),
    getIngest: () => resolveDdiIngest(cfg, ident),
    onChange: (cb) => (typeof ident.onChange === 'function' ? ident.onChange(cb) : () => {}),
  };
}

// ── Health / updater / heartbeat (built by sibling agents; wired here) ─────────
// FIX 1: PER-DATA-PLANE health. Each data-plane heartbeat must report ONLY its own module's
// device count (and its own offline-buffer depth), so SpanVault's heartbeat isn't inflated by
// ddi's devices and DDIVault's isn't polluted by span's. The span heartbeat uses spanHealth
// (span devices + span buffer); the ddi heartbeat uses its own ddiHealth (built alongside the
// ddi buffer in the ddi block below). Separate instances each keep their own cpu/mem/disk
// sampler. ONLY the hub fleet heartbeat gets the COMBINED view (`health` below).
const spanHealth = createHealth({
  getDeviceCount: () => span.deviceCount(),
  getBufferDepth: () => buffer.depth(),
});

// Combined (span + ddi) health — used ONLY by the hub fleet heartbeat (core/hub.js), whose
// module_status/health intentionally reflects EVERY module this agent runs. Left as-is.
const health = createHealth({
  getDeviceCount: () => span.deviceCount() + (ddi ? ddi.deviceCount() : 0),
  getBufferDepth: () => buffer.depth(),
});

// The updater VERIFIES + STAGES a signed bundle (core/updater.js); the actual swap
// happens on the next start via applyPendingIfAny above. It is driven from the HUB
// control channel (see hub.start below), not the retired span-WS path.
const updater = createUpdater({ currentDir: __dirname, logger, currentVersion: VERSION });

const heartbeat = createHeartbeat({
  send,
  health: spanHealth, // FIX 1: span plane reports span devices only
  version: VERSION,
  hostname,
  getModuleStatus: moduleStatus,
  logger, // FIX 2: so a throwing accessor is logged + skipped, never crashes the agent
});

// ── Transport + runtime (mutually referenced; see wiring note above) ───────────
transport = createTransport({
  config,
  identity,
  buffer,
  // onMessage runs the server push through the runtime router.
  onMessage: (msg) => runtime.dispatch(msg),
  // onOpen fires synchronously inside the WS 'open' handler, BEFORE the buffer
  // flush — so the connect heartbeat is the first frame on a fresh connection.
  onOpen: () => heartbeat.sendNow(),
  logger,
});

// The updater is NOT wired into the runtime anymore — self-update is driven from the
// hub channel (passed into createHubClient below), not the span-WS message router.
runtime = createRuntime({ config, transport, logger, modules: [span] });

// ── ddi transport (Phase 4b) — a SECOND app-ingest tunnel ──────────────────────
// When ddi is enabled, stand up a dedicated transport dialing the DDIVault ingest
// (port 3011), reusing the shared hub identity/JWT via the ddi identity adapter (which
// only overrides WHERE to dial). It has its OWN offline buffer (agent/ddi-data/buffer.json
// — the core buffer uses a fixed file name per dir), its OWN runtime router (so restart/
// get_logs and the ddi_config/ddi_scan pushes on the DDIVault socket are handled), and its
// OWN heartbeat on the DDIVault data plane. The span path is completely untouched.
let ddiHeartbeat = null;
// FIX 3: ddi is JWT-mode ONLY. Stand up the ddi data plane ONLY when the agent is
// hub-enrolled — otherwise (apiKey-mode / not enrolled) there is no hub JWT to present to
// DDIVault and dialing would present SpanVault's apiKey → DDIVault rejects it → endless
// reconnect. When ddi is enabled but the agent isn't hub-enrolled, we do NOT start the ddi
// transport and warn clearly that ddi requires hub enrollment (hubUrl + enrollToken).
if (ddi && hubEnrolled()) {
  const ddiIdentity = makeDdiIdentity(config, identity);
  const ddiDir = path.join(__dirname, 'ddi-data');
  try { fs.mkdirSync(ddiDir, { recursive: true }); } catch (_e) { /* best-effort */ }
  const ddiBuffer = createBuffer({ dir: ddiDir, max: 500, logger });
  // FIX 1: the ddi plane's OWN health — ddi devices + ddi buffer only, so DDIVault's
  // heartbeat is never polluted with span's device count (and vice versa).
  const ddiHealth = createHealth({
    getDeviceCount: () => ddi.deviceCount(),
    getBufferDepth: () => ddiBuffer.depth(),
  });
  let ddiRuntime = null;
  ddiTransport = createTransport({
    config,
    identity: ddiIdentity,
    buffer: ddiBuffer,
    onMessage: (msg) => ddiRuntime.dispatch(msg),
    onOpen: () => { if (ddiHeartbeat) ddiHeartbeat.sendNow(); },
    logger,
  });
  // FIX 5: a RESTRICTED router for the ddi socket — NOT the full createRuntime. A push on the
  // DDIVault ingest must never carry cross-app control: `restart` (its process.exit would kill
  // the whole agent incl. span) and `get_logs` (ships the SHARED logger ring, which contains
  // span's logs, to DDIVault) stay on the span-WS runtime + the hub command channel only. This
  // thin dispatch forwards ddi_config/ddi_scan (and any other push) to the ddi module and does
  // NOT handle restart/get_logs.
  ddiRuntime = {
    dispatch: (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'restart' || msg.type === 'get_logs') {
        logger.info(`[ddi] ignoring '${msg.type}' from the DDIVault ingest — lifecycle/log control is span-WS + hub only`);
        return;
      }
      try {
        if (ddi.onMessage) ddi.onMessage(msg);
      } catch (e) {
        logger.error('[ddi] onMessage error:', e && e.message ? e.message : e);
      }
    },
  };
  ddiHeartbeat = createHeartbeat({
    send: ddiSend,
    health: ddiHealth, // FIX 1: ddi plane reports ddi devices only
    version: VERSION,
    hostname,
    getModuleStatus: () => ({ [ddi.name]: ddi.status() }),
    logger, // FIX 2
  });
} else if (ddi) {
  // ddi enabled but NOT hub-enrolled — do not start its transport (FIX 3).
  logger.error(
    '[ddi] module enabled but the agent is NOT hub-enrolled — ddi data plane NOT started. ' +
    'ddi requires hub enrollment (set config.hubUrl + config.enrollToken); an apiKey cannot ' +
    'authenticate to the DDIVault ingest.'
  );
}

// ── Crash safety — exit so NSSM restarts on the new process (suite convention) ─
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

// ── Applying hub policy: module set reconciliation ─────────────────────────────
// Which modules this agent runs is decided ONCE, at startup, from config.json —
// modules, their transports and their buffers are all built during module load.
// So "apply the hub's policy" means: rewrite config.json to match, then restart
// and let the normal startup path build the new set. That is the same
// restart-to-apply approach the self-updater already uses, and NSSM brings the
// service straight back.
//
// Before this, toggling a module on the hub's fleet page changed nothing on the
// agent — the toggle looked functional but only ever moved a row in the hub's own
// table (found on the first real deployment, 2026-08-03).
let policyApplyArmed = true;

function applyPolicyModules(desired) {
  if (!policyApplyArmed) return; // one reconfigure per process — never a restart loop

  // The runtime ALWAYS loads span (it is not conditional in this file), so span can
  // never be the thing that differs — force it into the desired set or a hub that
  // has span disabled would diff forever and restart on every policy tick.
  const want = new Set(desired);
  want.add('span');

  const have = new Set(['span']);
  if (ddi) have.add('ddi');

  const same = want.size === have.size && [...want].every((m) => have.has(m));
  if (same) return;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    // Preserve any per-module settings already in config.json; only add/remove the
    // module keys themselves. An array-form `modules` is normalized to an object.
    const prev = raw.modules;
    const prevObj = {};
    if (Array.isArray(prev)) { for (const k of prev) prevObj[String(k)] = { enabled: true }; }
    else if (prev && typeof prev === 'object') { Object.assign(prevObj, prev); }

    const next = {};
    for (const slug of want) {
      const existing = prevObj[slug];
      next[slug] = (existing && typeof existing === 'object') ? { ...existing, enabled: true } : { enabled: true };
    }
    raw.modules = next;

    // Atomic write — a torn config.json would leave the agent unable to start at all.
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    logger.error('[policy] could not rewrite config.json — module set unchanged:', e && e.message ? e.message : e);
    return;
  }

  policyApplyArmed = false;
  logger.info(
    `[policy] module set changed by the hub: [${[...have].sort().join(', ')}] -> ` +
    `[${[...want].sort().join(', ')}] — config updated, restarting to apply`
  );
  // Small delay so the log line is flushed before the process goes away.
  setTimeout(() => process.exit(0), 1000);
}

// ── Hub control channel (Phase 2) — OPT-IN, purely additive ────────────────────
// When BOTH config.hubUrl and config.enrollToken are set, the agent enrolls once
// with the NetVault hub for a signed identity, then fleet-heartbeats to it so the
// launcher Agents page is populated. This is a SIDE-CHANNEL: it never touches the
// app-WS data path above — the span module still gets its config and ships results
// over the transport to SpanVault. Absent either field, this block is skipped and
// the agent behaves exactly as Phase 1 (no hub channel).
if (config.hubUrl && config.enrollToken) {
  const createHubClient = require('./core/hub');
  const hub = createHubClient({
    config,
    health,
    version: VERSION,
    hostname: os.hostname(),
    getModuleStatus: moduleStatus,
    getBufferDepth: () => buffer.depth(),
    logger,
    // Phase 3: the hub client shares the SAME store the span identity reads, so its
    // enrolled/refreshed JWT (and the span ingest URL) drive the data-path auth.
    store,
    // Phase 3 Workstream B: self-update is driven from the hub control channel — the
    // policy tick fetches the signed manifest and calls updater.consider().
    updater,
    // Phase 5: apply the hub's module policy (see applyPolicyModules above).
    onPolicyModules: applyPolicyModules,
  });
  // Sequencing: in JWT-mode (no apiKey) the span transport DEFERS its dial until the
  // identity is ready (isReady()==false) — so starting the hub here (before
  // transport.start() below) kicks off enroll/load; store.set()/store.load() then
  // wakes the transport. In apiKey-mode the transport is ready immediately and this
  // hub channel stays a purely additive side-channel exactly as Phase 2.
  hub.start();
}

// ── Start ─────────────────────────────────────────────────────
span.start();
heartbeat.start();
transport.start();
// ddi (Phase 4b): start its module + dedicated DDIVault-ingest transport/heartbeat too.
// Its transport gates its own dial on identity readiness (same JWT-mode defer as span).
// Guarded on ddiTransport (built only when ddi is enabled AND the agent is hub-enrolled —
// FIX 3), so an enabled-but-unenrolled ddi never dials with an apiKey.
if (ddiTransport) {
  ddi.start();
  ddiHeartbeat.start();
  ddiTransport.start();
  logger.info(`[ddi] module enabled — data plane → ${resolveDdiIngest(config, identity) || '(ingest URL pending)'}`);
}
logger.info(`NocVault Agent v${VERSION} started`);

// The new build has started healthy — commit the self-update: clear the confirm
// marker + backup/ so future boots don't count/roll back a good build. No-op when
// this boot did not just apply an update.
if (confirm.confirming) commitUpdate(__dirname);
