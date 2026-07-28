'use strict';
/**
 * Hub control-channel test: drives core/hub.js directly against a fake hub
 * (a local Node http server) — no whole-agent boot, no external deps.
 *
 * Proves:
 *   (1) HAPPY PATH — enrollment POSTs the right body and persists the issued
 *       identity to a temp path; the agent then heartbeats with a valid Bearer
 *       token and the correct body shape.
 *   (2) 401-STOPS-HEARTBEAT — a 401 on heartbeat halts the heartbeat/policy loops
 *       WITHOUT re-enrolling and WITHOUT spinning (no repeated calls after the
 *       401), and moves the dead identity file aside so a restart can re-enroll.
 *   (3) ENROLL-BACKOFF — an enroll network error backs off on a timer instead of
 *       tight-looping, and never throws out of the hub (data path stays safe).
 *
 * `node test/hub.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const createHubClient = require('../core/hub');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const okc = (n) => console.log('  PASS', n);
const rmIfExists = (p) => {
  try {
    fs.unlinkSync(p);
  } catch (_e) {}
};

// A logger whose error() lines are captured (so tests can assert on backoff
// messages) — never prints tokens itself; the hub is what must avoid logging them.
function capturingLogger() {
  const errors = [];
  return {
    logger: {
      info() {},
      error(...a) {
        errors.push(a.join(' '));
      },
    },
    errors,
  };
}

// ── Test 1: happy path (enroll → persist → heartbeat) ──────────────────────────
async function testHappyPath() {
  const IDENTITY_PATH = path.join(os.tmpdir(), `hub-identity-happy-${process.pid}.json`);
  rmIfExists(IDENTITY_PATH);

  let enrollBody = null;
  let heartbeatBody = null;
  let heartbeatAuth = null;

  const readJsonBody = (req, cb) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_e) {}
      cb(body);
    });
  };

  const server = http.createServer((req, res) => {
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
    if (req.method === 'POST' && req.url === '/api/agents/agt_test/refresh') {
      // Phase 3 A5: identity refresh. The mock jwt ('fake.jwt') isn't decodable, so
      // shouldRefresh() assumes a 30-day TTL and fires on the immediate policy tick;
      // answer it (same jwt so the Bearer-fake.jwt assertions hold, far-out expiry so
      // it then quiesces) — this also covers the refresh round-trip end-to-end.
      return reply(200, { jwt: 'fake.jwt', expires_at: new Date(Date.now() + 30 * 24 * 3600e3).toISOString() });
    }
    reply(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const hub = createHubClient({
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
  await delay(1500); // enroll + at least one heartbeat

  try {
    // (1) Enrollment body.
    assert.ok(enrollBody, 'hub never called POST /api/agents/enroll');
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
    assert.ok(heartbeatBody, 'no heartbeat received by the fake hub');
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
  } finally {
    try { hub.stop(); } catch (_e) {}
    try { server.close(); } catch (_e) {}
    rmIfExists(IDENTITY_PATH);
  }
}

// ── Test 2: a 401 on heartbeat STOPS heartbeats — no re-enroll, no spin ─────────
async function test401StopsHeartbeat() {
  const IDENTITY_PATH = path.join(os.tmpdir(), `hub-identity-401-${process.pid}.json`);
  rmIfExists(IDENTITY_PATH);
  rmIfExists(IDENTITY_PATH + '.rejected');

  let enrollCount = 0;
  let heartbeatCount = 0;

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && req.url === '/api/agents/enroll') {
      enrollCount++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () =>
        reply(200, {
          agent_id: 'agt_401',
          identity: { jwt: 'fake.jwt', expires_at: new Date(Date.now() + 3600e3).toISOString() },
          modules: [],
        })
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/api/agents/agt_401/heartbeat') {
      heartbeatCount++;
      req.resume();
      return reply(401, { error: 'revoked' }); // identity rejected on every heartbeat
    }
    if (req.method === 'GET' && req.url === '/api/agents/agt_401/policy') {
      return reply(200, { modules: [] });
    }
    reply(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const hub = createHubClient({
    config: { hubUrl: `http://127.0.0.1:${port}`, enrollToken: 'tok-401' },
    health: { build: () => ({}) },
    version: '2.0.0',
    hostname: 'test-host',
    getModuleStatus: () => ({ span: 'ok' }),
    getBufferDepth: () => 0,
    logger: { info() {}, error() {} },
    intervalMs: 120, // if it spun, we'd see many heartbeats within the wait window
    policyIntervalMs: 100000,
    identityPath: IDENTITY_PATH,
  });

  hub.start();
  await delay(900); // >> 6 heartbeat intervals — a spin would rack up calls
  const heartbeatsAfterSettle = heartbeatCount;
  await delay(400); // second window: prove the count does NOT keep climbing

  try {
    assert.strictEqual(enrollCount, 1, 'enrolled exactly once — a 401 must NOT re-enroll in-run');
    assert.strictEqual(
      heartbeatCount,
      1,
      `401 must stop heartbeats after the first (no spin) — saw ${heartbeatCount}`
    );
    assert.strictEqual(heartbeatCount, heartbeatsAfterSettle, 'no further heartbeats after the 401 settled');
    okc('401 on heartbeat stops the loop (no re-enroll, no spin)');

    // FIX 6: the dead identity is moved aside so a RESTART with a fresh token can re-enroll.
    assert.ok(!fs.existsSync(IDENTITY_PATH), 'rejected identity file removed from the live path');
    assert.ok(fs.existsSync(IDENTITY_PATH + '.rejected'), 'rejected identity moved to .rejected');
    okc('rejected identity moved aside (restart can re-enroll)');
  } finally {
    try { hub.stop(); } catch (_e) {}
    try { server.close(); } catch (_e) {}
    rmIfExists(IDENTITY_PATH);
    rmIfExists(IDENTITY_PATH + '.rejected');
  }
}

// ── Test 3: an enroll network error backs off — no tight loop, no throw ─────────
async function testEnrollBackoff() {
  const IDENTITY_PATH = path.join(os.tmpdir(), `hub-identity-backoff-${process.pid}.json`);
  rmIfExists(IDENTITY_PATH);

  // Grab a definitely-closed port (bind then release) so enroll gets ECONNREFUSED.
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const { logger, errors } = capturingLogger();

  const hub = createHubClient({
    config: { hubUrl: `http://127.0.0.1:${deadPort}`, enrollToken: 'tok-backoff' },
    health: { build: () => ({}) },
    version: '2.0.0',
    hostname: 'test-host',
    getModuleStatus: () => ({}),
    getBufferDepth: () => 0,
    logger,
    intervalMs: 120,
    policyIntervalMs: 100000,
    identityPath: IDENTITY_PATH,
  });

  // start() must not throw synchronously even though the hub is unreachable.
  assert.doesNotThrow(() => hub.start(), 'hub.start() must not throw on an unreachable hub');

  await delay(900); // first backoff is ~8-12s, so at most ONE attempt lands in this window

  try {
    const backoffLogs = errors.filter((l) => /enroll network error/.test(l) && /retrying in/.test(l));
    assert.ok(backoffLogs.length >= 1, 'enroll network error is logged and a retry is scheduled');
    // Tight-loop guard: within ~0.9s only the first attempt should have fired (backoff >> window).
    assert.ok(
      backoffLogs.length <= 2,
      `enroll must back off, not tight-loop — saw ${backoffLogs.length} attempts in 0.9s`
    );
    assert.ok(/\(attempt 1\)/.test(backoffLogs[0]), 'first retry is scheduled as attempt 1 (backoff)');
    // No identity should have been written on a failed enroll.
    assert.ok(!fs.existsSync(IDENTITY_PATH), 'no identity persisted when enroll never succeeds');
    okc('enroll network error backs off (no tight loop, no throw)');
  } finally {
    try { hub.stop(); } catch (_e) {} // cancels the pending enroll-retry timer
    rmIfExists(IDENTITY_PATH);
  }
}

// ── Test 4: hub-carried commands (Phase 4a) — get_logs POST + restart exit ──────
// The hub returns queued commands in the heartbeat 200 body (no server→agent socket).
// A `get_logs` must POST the log tail back to /api/agents/<id>/logs (Bearer JWT) with
// { lines, command_id }; a `restart` must call the INJECTED exit with 0 (never the
// real process.exit, which would kill the test runner). Commands are served on the
// FIRST heartbeat only, then the hub returns [].
async function testHubCommands() {
  const IDENTITY_PATH = path.join(os.tmpdir(), `hub-identity-cmd-${process.pid}.json`);
  rmIfExists(IDENTITY_PATH);

  let heartbeats = 0;
  let logsAuth = null;
  let logsBody = null;
  let logsCount = 0;

  const readJsonBody = (req, cb) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_e) {}
      cb(body);
    });
  };

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && req.url === '/api/agents/enroll') {
      return readJsonBody(req, () =>
        reply(200, {
          agent_id: 'agt_cmd',
          identity: { jwt: 'fake.jwt', expires_at: new Date(Date.now() + 3600e3).toISOString() },
          modules: [],
        })
      );
    }
    if (req.method === 'POST' && req.url === '/api/agents/agt_cmd/heartbeat') {
      heartbeats++;
      return readJsonBody(req, () => {
        // Carry both commands on the FIRST heartbeat only; [] thereafter (mirrors the
        // hub marking them 'delivered' so they aren't handed back a second time).
        const commands =
          heartbeats === 1
            ? [
                { id: 1, type: 'get_logs' },
                { id: 2, type: 'restart' },
              ]
            : [];
        reply(200, { ok: true, commands });
      });
    }
    if (req.method === 'POST' && req.url === '/api/agents/agt_cmd/logs') {
      logsCount++;
      logsAuth = req.headers.authorization;
      return readJsonBody(req, (body) => {
        logsBody = body;
        reply(200, { ok: true });
      });
    }
    if (req.method === 'GET' && req.url === '/api/agents/agt_cmd/policy') {
      return reply(200, { modules: [] });
    }
    reply(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const exitCalls = [];

  const hub = createHubClient({
    config: { hubUrl: `http://127.0.0.1:${port}`, enrollToken: 'tok-cmd' },
    health: { build: () => ({}) },
    version: '2.0.0',
    hostname: 'test-host',
    getModuleStatus: () => ({ span: 'ok' }),
    getBufferDepth: () => 0,
    // logger.tail feeds get_logs — give it a couple of ring lines to ship.
    logger: {
      info() {},
      error() {},
      tail: (n) => ['line-a', 'line-b'].slice(-(n == null ? 200 : n)),
    },
    // Injected exit: record the code instead of killing the runner.
    exit: (code) => exitCalls.push(code),
    intervalMs: 200,
    policyIntervalMs: 100000,
    identityPath: IDENTITY_PATH,
  });

  hub.start();
  await delay(900); // enroll + a couple of heartbeats (commands land on the first)

  try {
    // get_logs → a single POST to /logs with the right auth + body shape.
    assert.strictEqual(logsCount, 1, `get_logs posts exactly once — saw ${logsCount}`);
    assert.strictEqual(logsAuth, 'Bearer fake.jwt', 'logs upload carries Bearer fake.jwt');
    assert.ok(logsBody, 'logs upload had a JSON body');
    assert.deepStrictEqual(logsBody.lines, ['line-a', 'line-b'], 'logs body carries logger.tail() lines');
    assert.strictEqual(logsBody.command_id, 1, 'logs body echoes command_id:1');
    okc('get_logs command posts the log tail to /logs (Bearer + {lines,command_id})');

    // restart → the INJECTED exit called once with 0 (test runner still alive).
    assert.deepStrictEqual(exitCalls, [0], `restart calls the injected exit with 0 — saw ${JSON.stringify(exitCalls)}`);
    okc('restart command calls the injected exit(0) — runner not killed');
  } finally {
    try { hub.stop(); } catch (_e) {}
    try { server.close(); } catch (_e) {}
    rmIfExists(IDENTITY_PATH);
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  await testHappyPath();
  await test401StopsHeartbeat();
  await testEnrollBackoff();
  await testHubCommands();
  console.log('\nAll hub tests passed.');
  process.exit(0);
})().catch((e) => {
  console.error('  FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});

process.on('uncaughtException', (e) => {
  console.error('  FAIL uncaught:', e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('  FAIL unhandledRejection:', e && e.stack ? e.stack : e);
  process.exit(1);
});
setTimeout(() => {
  console.error('  FAIL overall timeout');
  process.exit(1);
}, 15000).unref();
