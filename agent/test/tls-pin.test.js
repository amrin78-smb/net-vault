'use strict';
/**
 * TLS certificate-pin verification for the agent data-plane transport
 * (core/transport.js). `node test/tls-pin.test.js` — exits non-zero on failure.
 *
 * These stand up a REAL wss:// server with a self-signed certificate, because
 * what is under test is whether a SUBSTITUTED certificate is actually rejected.
 * A pin that silently fails open is worse than no pin — it buys false
 * confidence — so asserting on the comparison helper alone would prove little.
 *
 * The fixture cert (test/fixtures/test-ws.crt|.key) is a throwaway generated for
 * this suite: CN=nocvault-agent-test, SAN localhost + 127.0.0.1, expires 2046.
 * It is not used anywhere else and is not a secret.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const createTransport = require('../core/transport');

let passed = 0;
function ok(name) { console.log('  PASS', name); passed++; }

const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ws.crt'));
const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-ws.key'));

// Derive the pin the same way an operator would read it off the server, rather
// than hard-coding it — if the fixture is ever regenerated the test still holds.
const FP = new crypto.X509Certificate(CERT).fingerprint256.replace(/:/g, '').toLowerCase();

function startTlsWs() {
  return new Promise((resolve) => {
    const server = https.createServer({ cert: CERT, key: KEY });
    const wss = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1', () => resolve({ server, wss, port: server.address().port }));
  });
}

function identityFor(url) {
  return {
    isReady: () => true,
    getIngest: () => url,
    getAuthHeader: () => ({ Authorization: 'Bearer test' }),
  };
}

function bufferStub() {
  const items = [];
  return {
    push: (m) => items.push(m),
    depth: () => items.length,
    all: () => items,
    clear: () => { items.length = 0; },
  };
}

// Dial a throwaway wss server with the given config, then report what happened.
function run(name, extraConfig, expect) {
  return new Promise((resolve, reject) => {
    startTlsWs().then(({ server, wss, port }) => {
      const url = `wss://127.0.0.1:${port}/`;
      const logs = [];
      const t = createTransport({
        config: { serverUrl: 'http://127.0.0.1:3008', wsPort: port, ...extraConfig },
        app: 'span',
        identity: identityFor(url),
        buffer: bufferStub(),
        onMessage: () => {},
        onOpen: () => {},
        logger: {
          info: (...a) => logs.push(a.join(' ')),
          error: (...a) => logs.push('ERR ' + a.join(' ')),
        },
      });
      t.start();
      setTimeout(() => {
        const open = t.isOpen();
        t.stop();
        wss.close();
        server.close();
        try {
          expect({ open, logs });
          ok(name);
          resolve();
        } catch (e) {
          console.error('  FAIL', name);
          console.error('    logs:', logs);
          reject(e);
        }
      }, 1200);
    });
  });
}

(async () => {
  await run('wss with a MATCHING pin stays connected',
    { wsFingerprints: { span: FP } },
    ({ open, logs }) => {
      assert.strictEqual(open, true, 'socket should be open when the pin matches');
      assert.ok(logs.some((l) => /verified against configured pin/.test(l)),
        'should log a successful verification');
    });

  // The assertion that actually matters: a cert the agent was not told to expect
  // must not be accepted, or the pin is decorative.
  await run('wss with a MISMATCHED pin is CLOSED',
    { wsFingerprints: { span: 'de'.repeat(32) } },
    ({ open, logs }) => {
      assert.strictEqual(open, false, 'socket MUST NOT stay open when the fingerprint differs');
      assert.ok(logs.some((l) => /MISMATCH/.test(l)), 'should log the mismatch');
    });

  // openssl prints fingerprints as AB:CD:EF..; operators will paste that form.
  await run('pin comparison ignores colons and case',
    { wsFingerprints: { span: FP.toUpperCase().replace(/(..)(?=.)/g, '$1:') } },
    ({ open }) => {
      assert.strictEqual(open, true, 'a colon-separated upper-case pin should still match');
    });

  // Not configuring a pin must not strand an agent whose server was upgraded
  // first — encrypted-but-unpinned is still better than the plain ws:// it
  // replaces — but it must say so rather than implying full protection.
  await run('wss with NO pin connects but warns it is UNPINNED',
    {},
    ({ open, logs }) => {
      assert.strictEqual(open, true, 'must not refuse when no pin is configured');
      assert.ok(logs.some((l) => /UNPINNED/.test(l)), 'should state plainly that it is unverified');
    });

  // SpanVault and DDIVault present different certs; a pin filed under the wrong
  // app must never be borrowed, or one endpoint authenticates against the other.
  await run('per-app pins: a ddi pin does not authenticate the span endpoint',
    { wsFingerprints: { ddi: FP } },
    ({ open, logs }) => {
      assert.strictEqual(open, true, 'no span pin -> unpinned, not a false match');
      assert.ok(logs.some((l) => /UNPINNED/.test(l)), 'span must not silently borrow the ddi pin');
    });

  console.log(`\n${passed} TLS-pin assertions passed.`);
})().catch((e) => {
  console.error('FAILED:', e && e.message);
  process.exit(1);
});
