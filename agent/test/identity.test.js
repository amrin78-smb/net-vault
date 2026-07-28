'use strict';
/**
 * Phase 3 identity tests — the shared identity store, the JWT-or-apiKey seam, and the
 * hub JWT refresh. No test framework; plain assertions. `node test/identity.test.js`
 * exits non-zero on failure.
 *
 * Proves:
 *   (1) STORE round-trip — set() persists ATOMICALLY (tmp+rename, no .tmp left),
 *       load() into a fresh instance round-trips {agent_id,jwt,expires_at,ingest},
 *       set() without an ingest preserves the previously-known one, onChange fires,
 *       and reject() moves the file aside + clears memory.
 *   (2) IDENTITY seam — getAuthHeader() presents the hub JWT when the store has a
 *       valid one, and falls back to Bearer <apiKey> otherwise (no store / expired /
 *       empty). isReady() + getIngest() track the same rule.
 *   (3) REFRESH — on the policy tick, a near-expiry identity is refreshed against the
 *       hub /refresh endpoint and the NEW token lands in the store (firing onChange).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const createIdentityStore = require('../core/identity-store');
const createIdentity = require('../core/identity');
const createHubClient = require('../core/hub');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => {
  console.log('  PASS', n);
  passed++;
};
const rmIfExists = (p) => {
  try {
    fs.unlinkSync(p);
  } catch (_e) {}
};

// ── Test 1: identity-store atomic persist + load round-trip ─────────────────────
(function testStoreRoundTrip() {
  const p = path.join(os.tmpdir(), `id-store-${process.pid}.json`);
  rmIfExists(p);
  rmIfExists(p + '.rejected');

  const s = createIdentityStore({ identityPath: p });
  assert.strictEqual(s.get(), null, 'store starts empty');
  assert.strictEqual(s.load(), null, 'load() on a missing file returns null');

  let changes = 0;
  let lastEmitted = 'unset';
  s.onChange((id) => {
    changes++;
    lastEmitted = id;
  });

  const future = new Date(Date.now() + 3600e3).toISOString();
  const wrote = s.set({ agent_id: 'agt_x', jwt: 'j1', expires_at: future, ingest: 'ws://h:3010/' });
  assert.strictEqual(wrote, true, 'set() returns true on success');
  assert.strictEqual(changes, 1, 'set() emits exactly one change');
  assert.strictEqual(lastEmitted && lastEmitted.jwt, 'j1', 'onChange gets the new identity');
  assert.ok(fs.existsSync(p), 'identity file written');
  assert.ok(!fs.existsSync(p + '.tmp'), 'no .tmp left behind (atomic rename)');

  // Fresh instance reload round-trips all four fields (incl. ingest).
  const s2 = createIdentityStore({ identityPath: p });
  const loaded = s2.load();
  assert.deepStrictEqual(
    loaded,
    { agent_id: 'agt_x', jwt: 'j1', expires_at: future, ingest: 'ws://h:3010/' },
    'load() round-trips {agent_id,jwt,expires_at,ingest}'
  );

  // set() without an ingest preserves the previously-known one (refresh case).
  s2.set({ agent_id: 'agt_x', jwt: 'j2', expires_at: future });
  assert.strictEqual(s2.get().jwt, 'j2', 'set() updates the jwt');
  assert.strictEqual(s2.get().ingest, 'ws://h:3010/', 'set() preserves ingest when omitted');

  // reject() moves the file aside and clears memory + emits.
  let rejectEmitted = 'unset';
  s2.onChange((id) => {
    rejectEmitted = id;
  });
  s2.reject();
  assert.ok(!fs.existsSync(p), 'reject() removes the live identity file');
  assert.ok(fs.existsSync(p + '.rejected'), 'reject() moves it to .rejected');
  assert.strictEqual(s2.get(), null, 'reject() clears in-memory identity');
  assert.strictEqual(rejectEmitted, null, 'reject() emits a null-identity change');

  rmIfExists(p);
  rmIfExists(p + '.rejected');
  ok('identity-store atomic persist + load round-trip (+ ingest preserve, reject)');
})();

// ── Test 2: identity.js picks JWT when the store has one, else falls back to apiKey ─
(function testIdentitySeam() {
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const fakeStore = (id) => ({ get: () => id, onChange: () => () => {} });

  // No store → pure apiKey mode (Phase 1 behaviour, byte-for-byte).
  const i1 = createIdentity({ apiKey: 'K' });
  assert.deepStrictEqual(i1.getAuthHeader(), { Authorization: 'Bearer K' }, 'no store → Bearer apiKey');
  assert.strictEqual(i1.isReady(), true, 'apiKey present → ready immediately');
  assert.strictEqual(i1.getIngest(), null, 'no store → no ingest');

  // Store WITH a valid hub JWT → JWT wins over the apiKey (JWT-first).
  const i2 = createIdentity(
    { apiKey: 'K' },
    fakeStore({ agent_id: 'a', jwt: 'JJ', expires_at: future, ingest: 'ws://x:3010/' })
  );
  assert.deepStrictEqual(i2.getAuthHeader(), { Authorization: 'Bearer JJ' }, 'valid store jwt → Bearer jwt');
  assert.strictEqual(i2.getIngest(), 'ws://x:3010/', 'valid store → ingest URL exposed');
  assert.strictEqual(i2.isReady(), true, 'valid store → ready');

  // Store with an EXPIRED jwt → fall back to the apiKey.
  const i3 = createIdentity({ apiKey: 'K' }, fakeStore({ agent_id: 'a', jwt: 'JJ', expires_at: past }));
  assert.deepStrictEqual(i3.getAuthHeader(), { Authorization: 'Bearer K' }, 'expired store jwt → Bearer apiKey');
  assert.strictEqual(i3.getIngest(), null, 'expired store → no ingest');

  // JWT-mode (no apiKey) with a valid jwt → ready, presents jwt.
  const i4 = createIdentity({}, fakeStore({ agent_id: 'a', jwt: 'JJ', expires_at: future }));
  assert.deepStrictEqual(i4.getAuthHeader(), { Authorization: 'Bearer JJ' }, 'no apiKey, valid jwt → Bearer jwt');
  assert.strictEqual(i4.isReady(), true, 'no apiKey but valid jwt → ready');

  // JWT-mode with NO identity yet → NOT ready (transport must defer).
  const i5 = createIdentity({}, fakeStore(null));
  assert.strictEqual(i5.isReady(), false, 'no apiKey + no identity → not ready');

  ok('identity.js JWT-first / apiKey-fallback (getAuthHeader / isReady / getIngest)');
})();

// ── Test 3: refresh renews a near-expiry identity into the store on the policy tick ─
async function testRefresh() {
  const IDENTITY_PATH = path.join(os.tmpdir(), `id-refresh-${process.pid}.json`);
  rmIfExists(IDENTITY_PATH);
  rmIfExists(IDENTITY_PATH + '.rejected');

  let refreshAuth = null;
  let refreshCount = 0;

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && req.url === '/api/agents/enroll') {
      req.resume();
      return req.on('end', () =>
        reply(200, {
          agent_id: 'agt_ref',
          // Near-expiry token (10s left) so shouldRefresh() fires on the policy tick;
          // 'fake.jwt' doesn't decode to iat/exp, so TTL defaults to 30d >> 10s remaining.
          identity: { jwt: 'fake.jwt', expires_at: new Date(Date.now() + 10000).toISOString() },
          modules: [{ app: 'span', enabled: true, ingest: 'ws://ingest:3010/' }],
        })
      );
    }
    if (req.method === 'GET' && req.url === '/api/agents/agt_ref/policy') {
      return reply(200, { modules: [{ app: 'span', enabled: true, ingest: 'ws://ingest:3010/' }] });
    }
    if (req.method === 'POST' && req.url === '/api/agents/agt_ref/refresh') {
      refreshCount++;
      refreshAuth = req.headers.authorization;
      req.resume();
      return req.on('end', () =>
        reply(200, { jwt: 'fresh.jwt', expires_at: new Date(Date.now() + 30 * 24 * 3600e3).toISOString() })
      );
    }
    if (req.method === 'POST' && req.url === '/api/agents/agt_ref/heartbeat') {
      req.resume();
      return reply(200, { ok: true });
    }
    reply(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const store = createIdentityStore({ identityPath: IDENTITY_PATH });
  let changedToFresh = false;
  store.onChange((id) => {
    if (id && id.jwt === 'fresh.jwt') changedToFresh = true;
  });

  const hub = createHubClient({
    config: { hubUrl: `http://127.0.0.1:${port}`, enrollToken: 'tok-ref' },
    health: { build: () => ({}) },
    version: '2.0.0',
    hostname: 'test-host',
    getModuleStatus: () => ({}),
    getBufferDepth: () => 0,
    logger: { info() {}, error() {} },
    intervalMs: 100000, // keep heartbeats out of the way
    policyIntervalMs: 100000, // only the ONE immediate policy tick matters here
    identityPath: IDENTITY_PATH,
    store,
  });

  hub.start();
  await delay(800); // enroll → immediate policy tick → maybeRefresh

  try {
    assert.ok(refreshCount >= 1, 'refresh endpoint was called on the policy tick');
    assert.strictEqual(refreshAuth, 'Bearer fake.jwt', 'refresh presented the CURRENT Bearer token');
    const cur = store.get();
    assert.ok(cur, 'store still has an identity after refresh');
    assert.strictEqual(cur.jwt, 'fresh.jwt', 'store now holds the refreshed jwt');
    assert.strictEqual(cur.agent_id, 'agt_ref', 'refresh preserved agent_id');
    assert.strictEqual(cur.ingest, 'ws://ingest:3010/', 'refresh preserved the span ingest URL');
    assert.ok(changedToFresh, 'onChange fired with the refreshed identity (wakes transport reconnect)');

    // Persisted to disk too.
    const saved = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    assert.strictEqual(saved.jwt, 'fresh.jwt', 'refreshed jwt persisted to disk');
    ok('refresh renews the identity into the store on the policy tick');
  } finally {
    try {
      hub.stop();
    } catch (_e) {}
    try {
      server.close();
    } catch (_e) {}
    rmIfExists(IDENTITY_PATH);
    rmIfExists(IDENTITY_PATH + '.rejected');
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  await testRefresh();
  console.log(`\n${passed} identity assertions passed.`);
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
