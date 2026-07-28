'use strict';
/**
 * Unit tests for the reusable agent core (no network).
 * Plain assertions, no test framework. `node test/units.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createBuffer = require('../core/buffer');
const createHealth = require('../core/health');
const createHeartbeat = require('../core/heartbeat');
const createTransport = require('../core/transport');
const createUpdater = require('../core/updater');

let passed = 0;
function ok(name) { console.log('  PASS', name); passed++; }

// ── buffer: cap, persist, reload, clear ──────────────────────────────────────
(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvagent-buf-'));
  const b = createBuffer({ dir, max: 500, logger: null });
  for (let i = 0; i < 600; i++) b.push({ type: 'ping_result', n: i });
  assert.strictEqual(b.depth(), 500, 'buffer capped at 500');
  assert.strictEqual(b.all()[0].n, 100, 'kept the LAST 500 (dropped first 100)');
  // reload from disk into a fresh instance
  const b2 = createBuffer({ dir, max: 500, logger: null });
  assert.strictEqual(b2.depth(), 500, 'buffer persisted + reloaded from disk');
  b.clear();
  assert.strictEqual(b.depth(), 0, 'clear empties');
  const b3 = createBuffer({ dir, max: 500, logger: null });
  assert.strictEqual(b3.depth(), 0, 'clear persisted');
  ok('buffer cap/persist/reload/clear');
})();

// ── transport.send: never buffer heartbeats when offline, buffer everything else ─
(() => {
  const pushed = [];
  const fakeBuffer = { push: (m) => pushed.push(m), all: () => pushed, clear: () => {}, depth: () => pushed.length };
  const t = createTransport({
    config: { serverUrl: 'http://127.0.0.1:3008', apiKey: 'k', wsPort: 3010 },
    identity: { getAuthHeader: () => ({ Authorization: 'Bearer k' }) },
    buffer: fakeBuffer, onMessage: () => {}, onOpen: () => {}, logger: null,
  });
  // never started → isOpen() false → send routes to buffer, except heartbeat
  t.send({ type: 'heartbeat', version: '2.0.0' });
  assert.strictEqual(pushed.length, 0, 'heartbeat dropped when offline (never buffered)');
  t.send({ type: 'ping_result', device_id: 1 });
  t.send({ type: 'snmp_batch', device_id: 1 });
  assert.strictEqual(pushed.length, 2, 'real results buffered when offline');
  ok('transport heartbeat-drop / result-buffer rule');
})();

// ── health.build(): exactly the 7 legacy fields, injected getters honoured ────
(() => {
  const h = createHealth({ getDeviceCount: () => 3, getBufferDepth: () => 7 });
  const out = h.build();
  assert.deepStrictEqual(
    Object.keys(out),
    ['cpu_pct', 'mem_pct', 'disk_pct', 'host_uptime_s', 'agent_uptime_s', 'device_count', 'buffer_depth'],
    'health has exactly the 7 legacy fields in order'
  );
  assert.strictEqual(out.device_count, 3, 'device_count from getter');
  assert.strictEqual(out.buffer_depth, 7, 'buffer_depth from getter');
  assert.strictEqual(typeof out.host_uptime_s, 'number', 'host_uptime_s numeric');
  ok('health.build() shape');
})();

// ── heartbeat payload: legacy 4 fields + additive module_status ───────────────
(() => {
  let sent = null;
  const hb = createHeartbeat({
    send: (m) => { sent = m; },
    health: { build: () => ({ cpu_pct: 1 }) },
    version: '2.0.0', hostname: 'testhost',
    getModuleStatus: () => ({ span: 'ok' }),
  });
  hb.sendNow();
  assert.deepStrictEqual(sent, {
    type: 'heartbeat', version: '2.0.0', hostname: 'testhost',
    health: { cpu_pct: 1 }, module_status: { span: 'ok' },
  }, 'heartbeat is the legacy 4 fields + additive module_status');
  ok('heartbeat payload shape');
})();

// ── updater.verifyManifest: Ed25519 sign/verify, tamper + wrong-key rejected ──
(() => {
  const { verifyManifest } = createUpdater;
  assert.strictEqual(typeof verifyManifest, 'function', 'verifyManifest exported');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const version = '2.1.0';
  const sha256 = crypto.createHash('sha256').update('fake-bundle-bytes').digest('hex');
  const sig = crypto.sign(null, Buffer.from(version + '|' + sha256), privateKey).toString('base64');

  assert.strictEqual(verifyManifest({ version, url: 'x', sha256, sig }, pubPem), true, 'valid manifest verifies');
  assert.strictEqual(verifyManifest({ version: '9.9.9', url: 'x', sha256, sig }, pubPem), false, 'tampered version rejected');
  assert.strictEqual(verifyManifest({ version, url: 'x', sha256: sha256.replace(/.$/, '0'), sig }, pubPem), false, 'tampered sha256 rejected');
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.strictEqual(verifyManifest({ version, url: 'x', sha256, sig }, other), false, 'wrong key rejected');
  assert.strictEqual(verifyManifest({}, pubPem), false, 'empty manifest rejected');
  ok('updater.verifyManifest Ed25519 gate (valid / tamper / wrong-key / empty)');
})();

console.log(`\n${passed} unit assertions passed.`);
