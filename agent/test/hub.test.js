'use strict';
/**
 * Hub control-channel test: drives core/hub.js directly against a fake hub
 * (a local Node http server) — no whole-agent boot, no external deps.
 *
 * Proves: (1) enrollment POSTs the right body and persists the issued identity to
 * the temp identity path; (2) the agent then heartbeats with a valid Bearer token
 * and the correct body shape. Uses a short heartbeat interval so it finishes fast.
 *
 * `node test/hub.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const createHubClient = require('../core/hub');

// Temp identity path so we never touch a real agent/hub-identity.json.
const IDENTITY_PATH = path.join(os.tmpdir(), `hub-identity-test-${process.pid}.json`);

let server = null;
let hub = null;
const cleanup = () => {
  try {
    if (hub) hub.stop();
  } catch (_e) {}
  try {
    if (server) server.close();
  } catch (_e) {}
  try {
    fs.unlinkSync(IDENTITY_PATH);
  } catch (_e) {}
};
const fail = (m) => {
  console.error('  FAIL', m);
  cleanup();
  process.exit(1);
};

// State the assertions read.
let enrollBody = null;
let heartbeatBody = null;
let heartbeatAuth = null;

function readJsonBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_e) {}
    cb(body);
  });
}

server = http.createServer((req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && req.url === '/api/agents/enroll') {
    return readJsonBody(req, (body) => {
      enrollBody = body;
      reply(200, {
        agent_id: 'agt_test',
        identity: { jwt: 'fake.jwt', expires_at: new Date(Date.now() + 3600e3).toISOString() },
        modules: [{ app: 'span', enabled: true, config: {}, ingest: 'ws://x:3010/' }],
      });
    });
  }

  if (req.method === 'POST' && req.url === '/api/agents/agt_test/heartbeat') {
    heartbeatAuth = req.headers.authorization;
    return readJsonBody(req, (body) => {
      heartbeatBody = body;
      reply(200, { ok: true });
    });
  }

  if (req.method === 'GET' && req.url === '/api/agents/agt_test/policy') {
    return reply(200, { modules: [{ app: 'span', enabled: true, config: {}, ingest: 'ws://x:3010/' }] });
  }

  reply(404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;

  hub = createHubClient({
    config: { hubUrl: `http://127.0.0.1:${port}`, enrollToken: 'enroll-tok-123' },
    health: { build: () => ({ cpu_pct: 1, mem_pct: 2, disk_pct: 3 }) },
    version: '2.0.0',
    hostname: 'test-host',
    getModuleStatus: () => ({ span: 'ok' }),
    getBufferDepth: () => 7,
    logger: { info() {}, error(...a) { console.error('  [hub-err]', ...a); } },
    intervalMs: 300, // fast heartbeat for the test
    policyIntervalMs: 100000, // keep policy out of the way; not asserted here
    identityPath: IDENTITY_PATH,
  });

  hub.start();

  // Give it time to enroll + emit at least one heartbeat.
  setTimeout(() => {
    let passed = 0;
    const okc = (n) => {
      console.log('  PASS', n);
      passed++;
    };

    // (1) Enrollment body.
    if (!enrollBody) return fail('hub never called POST /api/agents/enroll');
    assert.strictEqual(enrollBody.token, 'enroll-tok-123', 'enroll body carries the token');
    assert.strictEqual(enrollBody.hostname, 'test-host', 'enroll body has hostname');
    assert.strictEqual(typeof enrollBody.os, 'string', 'enroll body has os string');
    assert.ok(enrollBody.os.length > 0, 'enroll os is non-empty');
    assert.strictEqual(enrollBody.agent_version, '2.0.0', 'enroll body has agent_version');
    assert.ok('local_ip' in enrollBody, 'enroll body includes local_ip (best-effort)');
    okc('enroll body shape (token/hostname/os/agent_version/local_ip)');

    // (2) Identity persisted to the temp path.
    assert.ok(fs.existsSync(IDENTITY_PATH), 'identity file was written');
    const saved = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    assert.strictEqual(saved.agent_id, 'agt_test', 'persisted agent_id');
    assert.strictEqual(saved.jwt, 'fake.jwt', 'persisted jwt');
    assert.ok(saved.expires_at, 'persisted expires_at');
    okc('identity persisted (agent_id/jwt/expires_at)');

    // (3) At least one valid heartbeat received.
    if (!heartbeatBody) return fail('no heartbeat received by the fake hub');
    assert.strictEqual(heartbeatAuth, 'Bearer fake.jwt', 'heartbeat carries Bearer fake.jwt');
    assert.deepStrictEqual(
      Object.keys(heartbeatBody).sort(),
      ['buffer_depth', 'health', 'module_status', 'version'].sort(),
      'heartbeat body has version/health/module_status/buffer_depth'
    );
    assert.strictEqual(heartbeatBody.version, '2.0.0', 'heartbeat.version');
    assert.deepStrictEqual(heartbeatBody.module_status, { span: 'ok' }, 'heartbeat.module_status');
    assert.strictEqual(heartbeatBody.buffer_depth, 7, 'heartbeat.buffer_depth');
    assert.strictEqual(typeof heartbeatBody.health, 'object', 'heartbeat.health is an object');
    okc('valid heartbeat (Bearer jwt + body shape)');

    console.log(`\n${passed} hub assertions passed.`);
    cleanup();
    process.exit(0);
  }, 1500);
});

process.on('uncaughtException', (e) => fail('uncaught: ' + e.message));
setTimeout(() => fail('overall timeout'), 8000).unref();
