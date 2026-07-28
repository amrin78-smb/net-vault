'use strict';
/**
 * Updater test (Phase 3, Workstream B) — verifyManifest + consider().
 *
 * Proves the SECURITY GATE and the verify-before-apply staging:
 *   verifyManifest — valid passes; tampered version / tampered file sha256 / wrong
 *     key / malformed all FAIL (fail closed). Manifests are signed in-test with a
 *     throwaway Ed25519 keypair, whose public half is passed via publicKeyPem.
 *   consider() — against a fake local http server serving the bundle files + a signed
 *     manifest:
 *       (a) HAPPY: all files stage to pending/, APPLY.json is written, onReady fires.
 *       (b) TAMPERED FILE: a served file whose bytes don't match the manifest sha256
 *           ABORTS — no pending/ left behind, onReady NOT called.
 *
 * `node test/updater.test.js` — exits non-zero on failure.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const createUpdater = require('../core/updater');
const { verifyManifest, canonicalString } = createUpdater;

let passed = 0;
const ok = (n) => {
  console.log('  PASS', n);
  passed++;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Build a signed manifest from a { relpath: Buffer } file map + a private key.
// files[] is sorted ascending by path, exactly as the hub-side signer emits.
function buildManifest(version, fileMap, privateKey) {
  const files = Object.keys(fileMap)
    .sort()
    .map((p) => ({ path: p, sha256: sha256(fileMap[p]) }));
  const manifest = { version, files };
  const sig = crypto.sign(null, Buffer.from(canonicalString(manifest), 'utf8'), privateKey);
  manifest.sig = sig.toString('base64');
  return manifest;
}

// ── verifyManifest: valid / tamper / wrong-key / malformed ──────────────────────
(() => {
  assert.strictEqual(typeof verifyManifest, 'function', 'verifyManifest exported');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const files = {
    'core/hub.js': Buffer.from('hub bytes'),
    'nocvault-agent.js': Buffer.from('entry bytes'),
    'package.json': Buffer.from('{"version":"9.9.9"}'),
  };
  const manifest = buildManifest('9.9.9', files, privateKey);

  // valid
  assert.strictEqual(verifyManifest(manifest, pubPem), true, 'valid manifest verifies');

  // tampered version
  assert.strictEqual(
    verifyManifest(Object.assign({}, manifest, { version: '0.0.0' }), pubPem),
    false,
    'tampered version rejected'
  );

  // tampered file sha256 (mutate one entry, keep the original signature)
  const tamperedFiles = manifest.files.map((f, i) =>
    i === 0 ? { path: f.path, sha256: f.sha256.replace(/.$/, f.sha256.endsWith('0') ? '1' : '0') } : f
  );
  assert.strictEqual(
    verifyManifest(Object.assign({}, manifest, { files: tamperedFiles }), pubPem),
    false,
    'tampered file sha256 rejected'
  );

  // wrong key
  const otherPub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.strictEqual(verifyManifest(manifest, otherPub), false, 'wrong key rejected');

  // malformed inputs
  assert.strictEqual(verifyManifest(null, pubPem), false, 'null rejected');
  assert.strictEqual(verifyManifest({}, pubPem), false, 'empty object rejected');
  assert.strictEqual(verifyManifest({ version: 'x', files: [], sig: 'y' }, pubPem), false, 'empty files[] rejected');
  assert.strictEqual(
    verifyManifest({ version: 'x', files: [{ path: 'a' }], sig: 'y' }, pubPem),
    false,
    'file missing sha256 rejected'
  );
  assert.strictEqual(
    verifyManifest({ version: 'x', files: [{ path: 'a', sha256: 'b' }] }, pubPem),
    false,
    'missing sig rejected'
  );
  ok('verifyManifest gate (valid / tamper-version / tamper-sha / wrong-key / malformed)');
})();

// ── A fake bundle server: serves /api/agents/bundle/<path> + a manifest ─────────
// `corrupt` (optional) names a path whose served bytes are mangled (sha mismatch).
function startBundleServer(fileMap, corrupt) {
  const base = '/api/agents/bundle/';
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.indexOf(base) === 0) {
      const rel = decodeURIComponent(req.url.slice(base.length));
      if (Object.prototype.hasOwnProperty.call(fileMap, rel)) {
        let body = fileMap[rel];
        if (corrupt && rel === corrupt) body = Buffer.concat([body, Buffer.from('-TAMPERED')]);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(body);
      }
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(404);
    res.end('not found');
  });
  return server;
}

// ── consider(): HAPPY PATH — stage all files + APPLY.json + onReady ─────────────
async function testConsiderHappy() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const fileMap = {
    'core/hub.js': Buffer.from('new hub source ' + Math.random()),
    'nocvault-agent.js': Buffer.from('new entry source'),
    'package.json': Buffer.from('{"version":"3.0.0"}'),
  };
  const manifest = buildManifest('3.0.0', fileMap, privateKey);

  const server = startBundleServer(fileMap);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvagent-upd-happy-'));
  let onReadyCalled = 0;
  const updater = createUpdater({
    currentDir: dir,
    logger: { info() {}, error(...a) { console.error('  [upd-err]', ...a); } },
    publicKeyPem: pubPem,
    currentVersion: '2.9.9',
  });

  try {
    await updater.consider(manifest, {
      bundleBaseUrl: `http://127.0.0.1:${port}/api/agents/bundle`,
      onReady: () => {
        onReadyCalled++;
      },
    });

    assert.strictEqual(onReadyCalled, 1, 'onReady called exactly once on success');

    // Every file staged to pending/<path> with the right bytes.
    for (const rel of Object.keys(fileMap)) {
      const staged = path.join(dir, 'pending', rel);
      assert.ok(fs.existsSync(staged), `staged ${rel} exists`);
      assert.strictEqual(sha256(fs.readFileSync(staged)), sha256(fileMap[rel]), `staged ${rel} bytes match`);
    }

    // APPLY.json marker written with version + files.
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'pending', 'APPLY.json'), 'utf8'));
    assert.strictEqual(marker.version, '3.0.0', 'APPLY.json carries the version');
    assert.strictEqual(marker.files.length, 3, 'APPLY.json lists all files');
    assert.deepStrictEqual(
      marker.files.map((f) => f.path).sort(),
      Object.keys(fileMap).sort(),
      'APPLY.json paths match the manifest'
    );

    // The live tree was NOT touched (staged only).
    assert.ok(!fs.existsSync(path.join(dir, 'core', 'hub.js')), 'live files not swapped by consider()');
    ok('consider() HAPPY: stages all files to pending/ + APPLY.json + onReady');
  } finally {
    try { server.close(); } catch (_e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── consider(): TAMPERED FILE — abort, no pending/, onReady NOT called ──────────
async function testConsiderTamperedFile() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const fileMap = {
    'a.js': Buffer.from('alpha'),
    'b.js': Buffer.from('bravo'),
    'c.js': Buffer.from('charlie'),
  };
  const manifest = buildManifest('3.1.0', fileMap, privateKey);

  // Server serves 'b.js' with extra bytes → sha256 won't match the (validly signed) manifest.
  const server = startBundleServer(fileMap, 'b.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvagent-upd-tamper-'));
  let onReadyCalled = 0;
  const updater = createUpdater({
    currentDir: dir,
    logger: { info() {}, error() {} },
    publicKeyPem: pubPem,
    currentVersion: '2.9.9',
  });

  try {
    await updater.consider(manifest, {
      bundleBaseUrl: `http://127.0.0.1:${port}/api/agents/bundle`,
      onReady: () => {
        onReadyCalled++;
      },
    });

    assert.strictEqual(onReadyCalled, 0, 'onReady NOT called when a served file is tampered');
    assert.ok(!fs.existsSync(path.join(dir, 'pending')), 'NO pending/ left behind after abort');
    ok('consider() TAMPERED FILE: aborts — no pending/, onReady not called');
  } finally {
    try { server.close(); } catch (_e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── consider(): a BAD SIGNATURE never downloads or stages ───────────────────────
async function testConsiderBadSignature() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  // Verify against a DIFFERENT key than the one that signed → verifyManifest fails.
  const wrongPub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });

  const fileMap = { 'a.js': Buffer.from('alpha') };
  const manifest = buildManifest('3.2.0', fileMap, privateKey);

  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end(fileMap['a.js']);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvagent-upd-badsig-'));
  let onReadyCalled = 0;
  const updater = createUpdater({
    currentDir: dir,
    logger: { info() {}, error() {} },
    publicKeyPem: wrongPub,
    currentVersion: '2.9.9',
  });

  try {
    await updater.consider(manifest, {
      bundleBaseUrl: `http://127.0.0.1:${port}/api/agents/bundle`,
      onReady: () => {
        onReadyCalled++;
      },
    });
    assert.strictEqual(hits, 0, 'a bad signature must abort BEFORE any download');
    assert.strictEqual(onReadyCalled, 0, 'onReady NOT called for a bad signature');
    assert.ok(!fs.existsSync(path.join(dir, 'pending')), 'no pending/ for a bad signature');
    ok('consider() BAD SIGNATURE: rejected before any download or write');
  } finally {
    try { server.close(); } catch (_e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── consider(): already on this version → no-op ─────────────────────────────────
async function testConsiderSameVersion() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const fileMap = { 'a.js': Buffer.from('alpha') };
  const manifest = buildManifest('2.9.9', fileMap, privateKey);

  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end(fileMap['a.js']);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvagent-upd-same-'));
  let onReadyCalled = 0;
  const updater = createUpdater({
    currentDir: dir,
    logger: { info() {}, error() {} },
    publicKeyPem: pubPem,
    currentVersion: '2.9.9', // SAME as manifest.version
  });

  try {
    await updater.consider(manifest, {
      bundleBaseUrl: `http://127.0.0.1:${port}/api/agents/bundle`,
      onReady: () => {
        onReadyCalled++;
      },
    });
    assert.strictEqual(hits, 0, 'same version → no download');
    assert.strictEqual(onReadyCalled, 0, 'same version → onReady not called');
    ok('consider() SAME VERSION: no-op (already up to date)');
  } finally {
    try { server.close(); } catch (_e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testConsiderHappy();
  await testConsiderTamperedFile();
  await testConsiderBadSignature();
  await testConsiderSameVersion();
  console.log(`\n${passed} updater assertions passed.`);
  process.exit(0);
})().catch((e) => {
  console.error('  FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});

setTimeout(() => {
  console.error('  FAIL overall timeout');
  process.exit(1);
}, 15000).unref();
