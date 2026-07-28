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
const VERSION = '2.5.0';

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
  if (ddi) s[ddi.name] = ddi.status();
  return s;
};

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
// `aud` already covers every assigned module) and only OVERRIDE where to dial. isReady()
// also gates on a resolvable ddi ingest so the transport never falls back to the span port.
function makeDdiIdentity(cfg, ident) {
  return {
    getAuthHeader: () => ident.getAuthHeader(),
    isReady: () => {
      const base = typeof ident.isReady === 'function' ? ident.isReady() : true;
      return base && !!resolveDdiIngest(cfg, ident);
    },
    getIngest: () => resolveDdiIngest(cfg, ident),
    onChange: (cb) => (typeof ident.onChange === 'function' ? ident.onChange(cb) : () => {}),
  };
}

// ── Health / updater / heartbeat (built by sibling agents; wired here) ─────────
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
  health,
  version: VERSION,
  hostname,
  getModuleStatus: moduleStatus,
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
if (ddi) {
  const ddiIdentity = makeDdiIdentity(config, identity);
  const ddiDir = path.join(__dirname, 'ddi-data');
  try { fs.mkdirSync(ddiDir, { recursive: true }); } catch (_e) { /* best-effort */ }
  const ddiBuffer = createBuffer({ dir: ddiDir, max: 500, logger });
  let ddiRuntime = null;
  ddiTransport = createTransport({
    config,
    identity: ddiIdentity,
    buffer: ddiBuffer,
    onMessage: (msg) => ddiRuntime.dispatch(msg),
    onOpen: () => { if (ddiHeartbeat) ddiHeartbeat.sendNow(); },
    logger,
  });
  ddiRuntime = createRuntime({ config, transport: ddiTransport, logger, modules: [ddi] });
  ddiHeartbeat = createHeartbeat({
    send: ddiSend,
    health,
    version: VERSION,
    hostname,
    getModuleStatus: () => ({ [ddi.name]: ddi.status() }),
  });
}

// ── Crash safety — exit so NSSM restarts on the new process (suite convention) ─
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

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
if (ddi) {
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
