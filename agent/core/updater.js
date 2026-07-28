'use strict';
/**
 * core/updater.js — SIGNED multi-file bundle self-update.
 *
 * This REPLACES the legacy single-file `agent_sha` overwrite (agent.js:401-443),
 * which could only safely replace a one-file agent and — worse — applied whatever
 * the server advertised with no signature check at all (a fleet-wide RCE vector:
 * anyone who could answer the update URL could push arbitrary code). The unified
 * agent is multi-file, so the update is a signed BUNDLE.
 *
 * SECURITY MODEL — fail closed. The security win Phase 1 must deliver is that a
 * bundle is cryptographically verified BEFORE anything touches the filesystem:
 *   1. Ed25519 signature (`sig`) over `version + '|' + sha256`, against the
 *      embedded public key — mirrors netvault/lib/eolFeed.ts (spki-DER key +
 *      crypto.verify(null, ...) for Ed25519's null-digest scheme).
 *   2. Download the bundle, recompute sha256, compare to the signed `sha256`.
 * Any failure at any step logs and returns WITHOUT touching files or exiting.
 *
 * APPLY — staged, not swapped (Phase 1 decision; see plan Task 5). Real bundle
 * distribution + atomic swap is owned by the Phase-2 hub. So the VERIFY is fully
 * real and unit-testable (verifyManifest + the sha256 recheck), while APPLY writes
 * the verified bundle to <currentDir>/pending-update.bundle and logs
 * "verified, apply staged for Phase 2 distribution" — it does NOT swap files or
 * process.exit(). The moment the hub owns distribution, applyBundle() grows the
 * extract-to-temp + atomic-swap + exit(0)-for-NSSM-restart step; the gate that
 * matters (verified-before-apply) is already real here.
 *
 * The manifest shape is:  { version, url, sha256, sig }
 *   version : the advertised release version (string)
 *   url     : bundle download URL (http/https)
 *   sha256  : hex sha256 of the bundle bytes
 *   sig     : base64 Ed25519 signature over the string `version + '|' + sha256`
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Embedded update-signing public key ────────────────────────────────────────
// PLACEHOLDER — replace with the REAL agent-release public key before shipping.
// Ed25519 public key, spki DER, base64 (same encoding netvault/lib/eolFeed.ts uses
// for the EOL feed key). The matching PRIVATE key stays OFFLINE on the release box
// and is NEVER committed to any repo (see scripts/sign-agent.js). Generate a real
// keypair with scripts/sign-agent.js's documented one-liner and paste the public
// half here.
// TODO(release): replace AGENT_UPDATE_PUBLIC_KEY with the real release public key.
const AGENT_UPDATE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// Coerce a public key given as a PEM string, a base64 spki-DER string, or an
// already-built KeyObject into a crypto KeyObject. Throws on anything unusable
// (the caller — verifyManifest — turns a throw into a `false`, i.e. fail closed).
function toPublicKey(pub) {
  if (pub && typeof pub === 'object' && pub.asymmetricKeyType) return pub; // KeyObject
  const s = String(pub || '');
  if (s.indexOf('-----BEGIN') !== -1) {
    return crypto.createPublicKey(s); // PEM
  }
  // Otherwise treat it as base64-encoded spki DER (the eolFeed.ts encoding).
  return crypto.createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' });
}

/**
 * verifyManifest(manifest, publicKeyPem) -> boolean
 *
 * Pure, side-effect-free signature check so the integrator can unit-test it in
 * isolation against a locally-signed manifest. Returns true ONLY when `sig`
 * (base64) is a valid Ed25519 signature over `version + '|' + sha256` under the
 * given public key. Any missing field, malformed input, or crypto error -> false.
 *
 * `publicKeyPem` accepts a PEM string, a base64 spki-DER string, or a KeyObject
 * (defaults to the embedded AGENT_UPDATE_PUBLIC_KEY when omitted).
 */
function verifyManifest(manifest, publicKeyPem) {
  try {
    if (!manifest || typeof manifest !== 'object') return false;
    const { version, sha256, sig } = manifest;
    if (typeof version !== 'string' || !version) return false;
    if (typeof sha256 !== 'string' || !sha256) return false;
    if (typeof sig !== 'string' || !sig) return false;
    const pub = toPublicKey(publicKeyPem || AGENT_UPDATE_PUBLIC_KEY);
    const data = Buffer.from(version + '|' + sha256, 'utf8');
    const sigBuf = Buffer.from(sig, 'base64');
    // Ed25519 uses a null digest algorithm (agent.js has no equivalent; this
    // mirrors eolFeed.ts's cryptoVerify(null, body, pub, sig)).
    return crypto.verify(null, data, pub, sigBuf) === true;
  } catch (_e) {
    return false;
  }
}

// Download url -> Buffer. Ported from agent.js:412-422 (httpGetBuffer): pick
// http/https by scheme, reject non-200, concat the body.
function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = /^https/i.test(url) ? https : http;
    lib
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function createUpdater({ config, currentDir, logger, publicKeyPem, currentVersion } = {}) {
  const log = logger && logger.info ? logger : { info: console.log, error: console.error };
  const dir = currentDir || __dirname;
  const pubKey = publicKeyPem || AGENT_UPDATE_PUBLIC_KEY;

  // The running version, used for the skip-if-same guard. Preference order:
  //   1. an explicit `currentVersion` factory arg (the integrator can pass it),
  //   2. `config.version` (config carries it in the unified entrypoint),
  //   3. ../package.json's version (the agent's own package — best-effort).
  // Documented so the integrator knows exactly where the skip check reads from.
  let VERSION = currentVersion || (config && config.version) || null;
  if (!VERSION) {
    try {
      VERSION = require('../package.json').version;
    } catch (_e) {
      VERSION = null;
    }
  }

  // Re-entrancy guard: a slow download must not let a second advert start a
  // parallel update (mirrors the legacy `updating` flag, agent.js:406).
  let updating = false;

  // Staged apply: the VERIFY above is real; the SWAP is owned by the Phase-2 hub.
  // Write the verified bytes next to the agent and stop. When the hub owns
  // distribution this grows an extract-to-temp + atomic-swap + process.exit(0).
  function applyBundle(buf) {
    const dest = path.join(dir, 'pending-update.bundle');
    fs.writeFileSync(dest, buf);
    log.info('Update verified, apply staged for Phase 2 distribution ->', dest);
  }

  async function consider(manifest) {
    // Falsy manifest is the COMMON case today: the SpanVault server does not yet
    // advertise a signed bundle (Phase 2 adds that). A safe no-op.
    if (!manifest) return;
    if (updating) return;
    if (VERSION && manifest.version === VERSION) return; // already on this version

    updating = true;
    try {
      // 1. Verify the signature BEFORE any download or file write (fail closed).
      if (!verifyManifest(manifest, pubKey)) {
        log.error('Update rejected: signature verification failed — staying on', VERSION || '(unknown)');
        return;
      }
      if (!manifest.url) {
        log.error('Update rejected: manifest has no bundle url');
        return;
      }

      // 2. Download the bundle.
      log.info('Update', manifest.version, 'signature OK — downloading bundle...');
      const buf = await httpGetBuffer(manifest.url);

      // 3. Verify the downloaded bytes hash to the signed sha256 (hex).
      const gotSha = crypto.createHash('sha256').update(buf).digest('hex');
      if (gotSha !== String(manifest.sha256).toLowerCase()) {
        log.error('Update rejected: bundle sha256 mismatch — expected', manifest.sha256, 'got', gotSha);
        return;
      }

      // 4. Apply (staged in Phase 1).
      applyBundle(buf);
    } catch (e) {
      log.error('Self-update failed:', e && e.message ? e.message : String(e));
    } finally {
      updating = false;
    }
  }

  return { consider };
}

module.exports = createUpdater;
module.exports.verifyManifest = verifyManifest;
module.exports.AGENT_UPDATE_PUBLIC_KEY = AGENT_UPDATE_PUBLIC_KEY;
