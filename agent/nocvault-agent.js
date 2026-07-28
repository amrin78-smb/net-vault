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
const VERSION = '2.2.0';

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

// ── Health / updater / heartbeat (built by sibling agents; wired here) ─────────
const health = createHealth({
  getDeviceCount: () => span.deviceCount(),
  getBufferDepth: () => buffer.depth(),
});

const updater = createUpdater({ config, currentDir: __dirname, logger });

const heartbeat = createHeartbeat({
  send,
  health,
  version: VERSION,
  hostname,
  getModuleStatus: () => ({ [span.name]: span.status() }),
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

runtime = createRuntime({ config, transport, logger, updater, modules: [span] });

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
    getModuleStatus: () => ({ [span.name]: span.status() }),
    getBufferDepth: () => buffer.depth(),
    logger,
    // Phase 3: the hub client shares the SAME store the span identity reads, so its
    // enrolled/refreshed JWT (and the span ingest URL) drive the data-path auth.
    store,
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
logger.info(`NocVault Agent v${VERSION} started`);
