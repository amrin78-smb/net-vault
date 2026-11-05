'use strict';
/**
 * TLS trust handling for the HUB control channel (core/hub.js).
 * `node test/hub-tls.test.js` — exits non-zero on failure.
 *
 * The sibling suite test/tls-pin.test.js proves the same property for the
 * data-plane WebSocket; this is its counterpart for the hub channel, which
 * carries the enrolment token (in the enroll body) and the hub JWT (in the
 * Authorization header of every heartbeat/policy/refresh call).
 *
 * These stand up a REAL https hub with a self-signed certificate, because what is
 * under test is whether a SUBSTITUTED certificate is actually rejected, and
 * whether it is rejected EARLY ENOUGH. A pin checked after the response arrives
 * would be decorative: the credential rides in the request. So the assertions are
 * on what reached the far end (`seen`), not merely on whether a call failed.
 *
 * The fixture cert (test/fixtures/test-ws.crt|.key) is the same throwaway the
 * WS-pin suite uses: CN=nocvault-agent-test, SAN localhost + 127.0.0.1, expires
 * 2046. Nothing new is committed, and the pin is derived from the fixture at
 * runtime rather than hard-coded, so regenerating it keeps these tests honest.
 * (node:crypto can generate the Ed25519 keypair the self-update test needs, but it
 * cannot mint an X.509 certificate — hence reusing the existing fixture here.)
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const createHubClient = require('../core/hub');
const createUpdater = require('../core/updater');
const { canonicalString } = createUpdater;

let passed = 0;
let caseNo = 0;
// Collected rather than thrown: a mutation sweep needs to know WHICH assertions a
// broken guard takes down, and a fail-fast runner hides every test after the first.
const failures = [];
const ok = (n) => {
  console.log('  PASS', n);
  passed++;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rmIfExists = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
};

const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ws.crt'));
const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ws.key'));

// Derive the pin exactly as an operator would read it off the server.
const FP = new crypto.X509Certificate(CERT).fingerprint256.replace(/:/g, '').toLowerCase();

const AGENT_ID = 'agt_tls';
const FAR_FUTURE = () => new Date(Date.now() + 30 * 24 * 3600e3).toISOString();
const MODULES = [{ app: 'span', enabled: true, config: {}, ingest: 'ws://x:3010/' }];

// A fake hub, over https (self-signed) or plain http.
//
// TWO levels of recording, and the lower one is the one that matters:
//   `wire` — every plaintext byte the client ever wrote, captured on the socket
//            BEFORE the HTTP parser sees it. This is the real assertion target: a
//            request whose headers flushed but whose body never arrived would
//            never raise a 'request' event at all, so a test that only watched
//            requests would call that leak a pass.
//   `seen` — one entry per HTTP request, PUSHED WHEN THE REQUEST ARRIVES (not when
//            its body ends, for the same reason) and filled in with the body after.
function startFakeHub(opts) {
  const { secure = false, manifest = null, bundle = {}, redirectTo = null } = opts || {};
  const seen = [];
  const wire = [];
  const handler = (req, res) => {
    const entry = { method: req.method, url: req.url, auth: req.headers.authorization || null, body: null, raw: '' };
    seen.push(entry);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      entry.raw = Buffer.concat(chunks).toString('utf8');
      try {
        entry.body = entry.raw ? JSON.parse(entry.raw) : null;
      } catch (_e) {
        /* leave null */
      }

      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // A plaintext→HTTPS bounce in front of the hub: every request answered 301.
      if (redirectTo) {
        res.writeHead(301, { Location: redirectTo + req.url });
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/api/agents/enroll') {
        return reply(200, {
          agent_id: AGENT_ID,
          identity: { jwt: 'fake.jwt', expires_at: FAR_FUTURE() },
          modules: MODULES,
        });
      }
      if (req.method === 'POST' && req.url === `/api/agents/${AGENT_ID}/heartbeat`) {
        return reply(200, { ok: true });
      }
      if (req.method === 'GET' && req.url === `/api/agents/${AGENT_ID}/policy`) {
        return reply(200, { modules: MODULES });
      }
      if (req.method === 'POST' && req.url === `/api/agents/${AGENT_ID}/refresh`) {
        return reply(200, { jwt: 'fake.jwt', expires_at: FAR_FUTURE() });
      }
      if (req.method === 'GET' && req.url === '/api/agents/update-manifest') {
        return manifest ? reply(200, manifest) : reply(404, { error: 'no update' });
      }
      if (req.method === 'GET' && req.url.startsWith('/api/agents/bundle/')) {
        const rel = req.url.slice('/api/agents/bundle/'.length);
        if (!bundle[rel]) return reply(404, { error: 'no such file' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(bundle[rel]);
        return;
      }
      reply(404, { error: 'not found' });
    });
  };
  const server = secure ? https.createServer({ cert: CERT, key: KEY }, handler) : http.createServer(handler);
  // Tap the decrypted stream. A mismatched pin SHOULD still produce a TLS
  // connection (we complete the handshake, read the certificate, then destroy) —
  // what must never appear is a single plaintext byte from the client.
  server.on(secure ? 'secureConnection' : 'connection', (sock) => {
    sock.on('data', (c) => wire.push(Buffer.from(c)));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const scheme = secure ? 'https' : 'http';
      resolve({ server, port, seen, wire, hubUrl: `${scheme}://127.0.0.1:${port}` });
    });
  });
}

// Drive core/hub.js against a fake hub for `waitMs`, then report what happened.
async function run(name, { hub: hubOpts = {}, extraConfig = {}, waitMs = 600, extra = {} }, expect) {
  const identityPath = path.join(os.tmpdir(), `hub-tls-identity-${process.pid}-${caseNo++}.json`);
  rmIfExists(identityPath);
  const { server, port, seen, wire, hubUrl } = await startFakeHub(hubOpts);
  const logs = [];
  const client = createHubClient({
    config: { hubUrl, enrollToken: 'enroll-tok-tls', ...extraConfig },
    health: { build: () => ({ cpu_pct: 1 }) },
    version: '0.0.0-test',
    hostname: 'tls-test-host',
    getModuleStatus: () => ({ span: 'ok' }),
    getBufferDepth: () => 0,
    logger: {
      info: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push('ERR ' + a.join(' ')),
    },
    intervalMs: 100000, // keep the repeating loops out of the way
    policyIntervalMs: 100000,
    identityPath,
    ...extra,
  });
  client.start();
  await delay(waitMs);
  client.stop();
  await new Promise((r) => server.close(r));
  try {
    await expect({ identity: client._getIdentity(), logs, seen, wire, port, hubUrl });
    ok(name);
  } catch (e) {
    failures.push(name);
    console.error('  FAIL', name);
    console.error('    ', e && e.message);
    console.error('    logs:', logs);
    console.error('    seen:', JSON.stringify(seen.map((s) => `${s.method} ${s.url}`)));
  } finally {
    rmIfExists(identityPath);
  }
}

(async () => {
  // ── 1. Self-signed HTTPS reachable with NO pin, and it says so ────────────────
  // The default that matters: turning HTTPS on at the hub must not strand an
  // already-deployed agent. But it must not imply full protection either.
  await run(
    'self-signed https hub is reachable with NO pin and logs UNPINNED (once)',
    { hub: { secure: true } },
    ({ identity, logs, seen }) => {
      assert.ok(identity, 'must enrol over a self-signed https hub without a pin');
      assert.strictEqual(identity.agent_id, AGENT_ID, 'identity should be the hub-issued one');
      const unpinned = logs.filter((l) => /UNPINNED/.test(l));
      assert.strictEqual(
        unpinned.length,
        1,
        'must state plainly it is unverified — exactly once, not on every request: ' + JSON.stringify(unpinned)
      );
      assert.ok(
        seen.some((s) => s.url === '/api/agents/enroll' && s.body && s.body.token === 'enroll-tok-tls'),
        'the enrol token should have reached the hub'
      );
      assert.ok(seen.length > 1, 'the heartbeat/policy loops should also have run over TLS');
    }
  );

  // ── 2. A correct pin succeeds ────────────────────────────────────────────────
  await run(
    'self-signed https hub with a MATCHING pin enrols and reports it verified',
    { hub: { secure: true }, extraConfig: { hubFingerprint: FP } },
    ({ identity, logs, seen, wire }) => {
      assert.ok(identity, 'a correct pin must not block enrolment');
      // Keeps the WRONG-pin test below honest: it asserts ZERO plaintext bytes
      // reached the hub, which would also hold if the wire tap never worked. This
      // is the positive control proving the tap sees traffic on the same path.
      assert.ok(
        Buffer.concat(wire).toString('utf8').includes('POST /api/agents/enroll'),
        'the wire tap must actually observe plaintext on a GOOD connection'
      );
      assert.ok(
        logs.some((l) => /hub certificate verified against configured pin/.test(l)),
        'should log a successful verification'
      );
      assert.ok(!logs.some((l) => /UNPINNED/.test(l)), 'a pinned channel must not claim to be unpinned');
      assert.ok(
        seen.some((s) => s.url === `/api/agents/${AGENT_ID}/heartbeat` && /^Bearer /.test(s.auth || '')),
        'the JWT should reach a verified hub'
      );
    }
  );

  // ── 3. THE assertion: a wrong pin is rejected BEFORE the credential is sent ──
  // Not "the request failed" — the hub must never have received anything at all.
  // Verifying on the response would be too late: the enrol token is in the request
  // body and the JWT is in the request headers.
  await run(
    'a WRONG pin is REJECTED before any request body reaches the hub',
    { hub: { secure: true }, extraConfig: { hubFingerprint: 'aa'.repeat(32) } },
    ({ identity, logs, seen, wire }) => {
      assert.strictEqual(identity, null, 'must not enrol against an unverified certificate');
      // The byte-level assertion. This is what catches handing the socket to
      // http.ClientRequest before 'secureConnect' (returning it from
      // createConnection instead of only ever passing it to cb): the headers then
      // flush on handshake completion and the enrol POST is half on the wire,
      // which raises no 'request' event the HTTP layer could have noticed.
      const plaintext = Buffer.concat(wire).toString('utf8');
      assert.strictEqual(
        plaintext.length,
        0,
        'not one plaintext byte may reach an unverified hub — got: ' + JSON.stringify(plaintext.slice(0, 400))
      );
      assert.deepStrictEqual(
        seen.map((s) => `${s.method} ${s.url}`),
        [],
        'the hub must never receive a request — got: ' + JSON.stringify(seen.map((s) => s.raw))
      );
      assert.ok(
        logs.some((l) => /MISMATCH/i.test(l)),
        'should tell the operator the certificate did not match the pin'
      );
      assert.ok(
        logs.some((l) => /refusing to send credentials/i.test(l)),
        'should say plainly that no credential was sent'
      );
    }
  );

  // ── 4. openssl prints AB:CD:EF…; operators will paste that form ──────────────
  await run(
    'hub pin comparison ignores colons and case',
    {
      hub: { secure: true },
      extraConfig: { hubFingerprint: FP.toUpperCase().replace(/(..)(?=.)/g, '$1:') },
    },
    ({ identity, logs }) => {
      assert.ok(identity, 'a colon-separated upper-case pin should still match');
      assert.ok(
        logs.some((l) => /hub certificate verified against configured pin/.test(l)),
        'the pasted form should verify, not fall through to unpinned'
      );
    }
  );

  // ── 5. Plain http is completely unaffected ───────────────────────────────────
  // The Phase-1/2 deployment is plain http; this change must be a no-op there,
  // including not emitting a TLS posture line that would confuse an operator.
  await run(
    'a plain http hub is unaffected (no TLS options, no TLS log lines)',
    { hub: { secure: false }, extraConfig: { hubFingerprint: FP } },
    ({ identity, logs, seen }) => {
      assert.ok(identity, 'http enrolment must keep working exactly as before');
      assert.ok(
        !logs.some((l) => /TLS:/.test(l)),
        'a plain-http hub must not log a TLS posture: ' + JSON.stringify(logs.filter((l) => /TLS:/.test(l)))
      );
      assert.ok(
        seen.some((s) => s.url === '/api/agents/enroll'),
        'the enroll request should have been made'
      );
    }
  );

  // ── 6. Self-update works end-to-end over a self-signed, PINNED hub ───────────
  // The manifest is fetched by hub.js, but each bundle FILE is downloaded by
  // core/updater.js — a different http client. If the TLS options are not threaded
  // through, the manifest arrives and every download then fails, which looks like a
  // broken bundle rather than a trust problem.
  {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const fileBytes = Buffer.from('// staged over TLS\n');
    const files = [{ path: 'core/probe.js', sha256: sha256(fileBytes) }];
    const manifest = { version: '9.9.9', files };
    manifest.sig = crypto
      .sign(null, Buffer.from(canonicalString(manifest), 'utf8'), privateKey)
      .toString('base64');

    const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tls-update-'));
    const real = createUpdater({
      currentDir,
      logger: { info() {}, error(...a) { console.error('  [updater]', ...a); } },
      publicKeyPem: pubPem,
      currentVersion: '0.0.0-test',
    });
    let sawTlsOptions = null;
    let readyCalled = false;
    // Wrap the real updater ONLY to inject onReady: consider()'s default is
    // process.exit(0), which would kill the test runner and make a silent pass.
    // Everything else (including the tlsOptions hub.js passes) goes through verbatim.
    const updater = {
      consider: (m, o) => {
        sawTlsOptions = o && o.tlsOptions;
        return real.consider(m, { ...o, onReady: () => { readyCalled = true; } });
      },
    };

    await run(
      'self-update over a self-signed PINNED hub: manifest AND bundle both download',
      {
        hub: { secure: true, manifest, bundle: { 'core/probe.js': fileBytes } },
        extraConfig: { hubFingerprint: FP },
        extra: { updater },
        waitMs: 1200,
      },
      ({ seen }) => {
        assert.ok(sawTlsOptions, 'hub.js must hand the updater its TLS options');
        assert.strictEqual(
          sawTlsOptions.rejectUnauthorized,
          false,
          'a self-signed hub has no chain to validate'
        );
        assert.strictEqual(
          typeof sawTlsOptions.createConnection,
          'function',
          'a PINNED hub must gate the bundle download on the handshake too'
        );
        assert.ok(
          seen.some((s) => s.url === '/api/agents/bundle/core/probe.js'),
          'the bundle file should have been fetched over TLS'
        );
        assert.ok(readyCalled, 'the staged update should have reached the apply handoff');
        const marker = path.join(currentDir, 'pending', 'APPLY.json');
        assert.ok(fs.existsSync(marker), 'APPLY.json should be staged');
        assert.deepStrictEqual(
          JSON.parse(fs.readFileSync(marker, 'utf8')).version,
          '9.9.9',
          'the staged marker should name the manifest version'
        );
        assert.deepStrictEqual(
          fs.readFileSync(path.join(currentDir, 'pending', 'core', 'probe.js')),
          fileBytes,
          'the downloaded bytes should be staged verbatim'
        );
      }
    );
    rmIfExists(currentDir);
  }

  // ── 7. A 3xx is diagnosed, not chased ────────────────────────────────────────
  // Redirects stay unfollowed on purpose (this channel carries the enrol token and
  // the hub JWT), but "HTTP 301" alone reads like a hub bug rather than a hubUrl
  // that needs an `s`.
  {
    const target = await startFakeHub({ secure: false });
    await run(
      'a 301 is reported as a non-followed redirect and the target is never contacted',
      { hub: { secure: false, redirectTo: `${target.hubUrl}?token=should-not-be-logged` } },
      ({ identity, logs, seen }) => {
        assert.strictEqual(identity, null, 'a redirect must not be mistaken for an enrolment');
        const line = logs.find((l) => /redirect/.test(l));
        assert.ok(line, 'should report the redirect explicitly: ' + JSON.stringify(logs));
        assert.ok(/NOT followed/.test(line), 'should say the redirect was not followed: ' + line);
        assert.ok(/hubUrl/.test(line), 'should point the operator at hubUrl: ' + line);
        assert.ok(
          !/should-not-be-logged/.test(logs.join('\n')),
          'the Location query string must be stripped, never logged'
        );
        assert.deepStrictEqual(
          target.seen.map((s) => s.url),
          [],
          'the redirect target must never be contacted — got: ' + JSON.stringify(target.seen.map((s) => s.url))
        );
        assert.ok(seen.length >= 1, 'the original request should still have been made');
      }
    );
    await new Promise((r) => target.server.close(r));
  }

  if (failures.length) {
    console.error(`\n${failures.length} hub-TLS assertion(s) FAILED: ${JSON.stringify(failures)}`);
    process.exit(1);
  }
  console.log(`\n${passed} hub-TLS assertions passed.`);
})().catch((e) => {
  console.error('FAILED:', e && e.message);
  process.exit(1);
});
