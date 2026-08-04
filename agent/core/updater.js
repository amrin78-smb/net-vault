'use strict';
/**
 * core/updater.js — SIGNED multi-file self-update (verify-before-apply → stage).
 *
 * NocVault Agents Phase 3, Workstream B. This is the VERIFY + STAGE half of the
 * self-update; the crash-safe apply-on-next-start swap lives in core/apply-update.js
 * and is driven from the entrypoint. The whole update is now driven from the HUB
 * control channel (core/hub.js's policy tick), NOT the dead span-WS `agent_bundle`
 * path that Phase 1 wired (that branch is retired in core/runtime.js).
 *
 * SECURITY MODEL — fail closed. A manifest is cryptographically verified BEFORE any
 * download or file write:
 *   1. Ed25519 signature (`sig`, base64) over the CANONICAL string
 *          version + '\n' + files.map(f => f.path + ':' + f.sha256).join('\n')
 *      against the embedded release public key (crypto.verify(null, ...) — Ed25519's
 *      null-digest scheme, same as netvault/lib/eolFeed.ts).
 *   2. Each file is downloaded from <hubUrl>/api/agents/bundle/<path>, its sha256
 *      recomputed and compared to the manifest. ANY mismatch/error aborts the WHOLE
 *      update (partial pending/ is discarded) — a tampered/partial bundle never runs.
 * Any failure at any step logs and returns WITHOUT applying or exiting.
 *
 * MANIFEST CONTRACT (produced by the hub-side signer):
 *   { version: string, files: [{ path, sha256 }], sig: base64 }
 *   - `files` sorted ascending by `path`; `path` is a forward-slash relative path
 *     under the agent dir (e.g. "core/hub.js", "nocvault-agent.js", "package.json").
 *
 * APPLY (staged): verified bytes are written under <currentDir>/pending/<path>, an
 * apply-marker <currentDir>/pending/APPLY.json is written, and onReady() is called
 * (default process.exit(0)) so NSSM restarts the process — the entrypoint's
 * applyPendingIfAny (core/apply-update.js) then performs the crash-safe swap.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Embedded update-signing public key ────────────────────────────────────────
// The REAL agent-release public key (Ed25519, spki DER, base64). The matching
// PRIVATE key stays OFFLINE on the release box and is NEVER committed (see
// scripts/sign-agent.js). Rotating the release keypair means replacing this
// constant and re-signing.
// ROTATED 2026-08-04. The previous private key lived only under agent/keys/
// (gitignored, never committed — correct) and was lost when that working tree was
// cleaned, leaving NO way to sign a release. Regenerated and now stored OUTSIDE
// every repo so a repo clean can't destroy it again.
//
// Rotating this constant is a BREAKING change for already-installed agents: an
// agent running the old build verifies against the OLD key, so it will correctly
// REFUSE any bundle signed with the new one. Those agents cannot self-update
// across the rotation and must be re-installed once from the hub installer
// (which downloads the bundle directly and does not verify a signature). With a
// single agent in the fleet that was an acceptable trade; at scale it is not.
const AGENT_UPDATE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEAB1bs89HVlxFvulxUocCEwVlfL2pimPeOEDO9vtYN/aU=';

// Default per-file download timeout (ms) — a black-hole hub must not hang the
// updater forever (it runs on the hub policy tick).
const DEFAULT_TIMEOUT_MS = 30000;

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

// The EXACT string the signer signs and this module verifies. Kept in one place so
// verifyManifest and any local re-derivation can never drift.
function canonicalString(manifest) {
  return (
    manifest.version +
    '\n' +
    manifest.files.map((f) => f.path + ':' + f.sha256).join('\n')
  );
}

/**
 * verifyManifest(manifest, publicKeyPem) -> boolean
 *
 * Pure, side-effect-free signature + shape check so it can be unit-tested in
 * isolation against a locally-signed manifest. Returns true ONLY when the shape is
 * valid AND `sig` (base64) is a valid Ed25519 signature over the canonical string
 * under the given public key. Any missing field, malformed input, or crypto error
 * -> false (fail closed).
 *
 * `publicKeyPem` accepts a PEM string, a base64 spki-DER string, or a KeyObject
 * (defaults to the embedded AGENT_UPDATE_PUBLIC_KEY when omitted).
 */
function verifyManifest(manifest, publicKeyPem) {
  try {
    if (!manifest || typeof manifest !== 'object') return false;
    const { version, files, sig } = manifest;
    if (typeof version !== 'string' || !version) return false;
    if (typeof sig !== 'string' || !sig) return false;
    if (!Array.isArray(files) || files.length === 0) return false;
    for (const f of files) {
      if (!f || typeof f !== 'object') return false;
      if (typeof f.path !== 'string' || !f.path) return false;
      if (typeof f.sha256 !== 'string' || !f.sha256) return false;
    }
    const pub = toPublicKey(publicKeyPem || AGENT_UPDATE_PUBLIC_KEY);
    const data = Buffer.from(canonicalString(manifest), 'utf8');
    const sigBuf = Buffer.from(sig, 'base64');
    // Ed25519 uses a null digest algorithm (mirrors eolFeed.ts's crypto.verify(null,...)).
    return crypto.verify(null, data, pub, sigBuf) === true;
  } catch (_e) {
    return false;
  }
}

// Download url -> Buffer with a timeout. Picks http/https by scheme, rejects
// non-200, concats the body. A stalled response is destroyed and rejected so the
// updater can abort cleanly rather than hang the policy tick forever.
function httpGetBuffer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = /^https/i.test(url) ? https : http;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const req = lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (e) => {
        req.destroy();
        finish(reject, e);
      });
      res.on('end', () => finish(resolve, Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () =>
      req.destroy(new Error('download timeout'))
    );
    req.on('error', (e) => finish(reject, e));
  });
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * createUpdater({ currentDir, logger, publicKeyPem?, currentVersion? }) -> { consider }
 */
function createUpdater({ currentDir, logger, publicKeyPem, currentVersion } = {}) {
  const log = logger && logger.info ? logger : { info: console.log, error: console.error };
  const dir = currentDir || __dirname;
  const pubKey = publicKeyPem || AGENT_UPDATE_PUBLIC_KEY;
  const VERSION = currentVersion || null;

  const pendingDir = path.join(dir, 'pending');

  // Re-entrancy guard: a slow multi-file download must not let a second policy tick
  // start an overlapping update.
  let updating = false;

  // Best-effort recursive delete of the pending/ staging dir (abort cleanup).
  function clearPending() {
    try {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    } catch (e) {
      log.error('Self-update: could not clear pending dir:', e && e.message ? e.message : String(e));
    }
  }

  // Atomic marker write (tmp + rename), mirroring core/identity-store.js.
  function writeJsonAtomic(filePath, obj) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filePath);
  }

  /**
   * consider(manifest, opts) — verify → stage all files → write APPLY.json → onReady.
   * opts = { bundleBaseUrl, onReady }
   *   bundleBaseUrl : `<hubUrl>/api/agents/bundle` — each file is GET
   *                   `${bundleBaseUrl}/${file.path}`.
   *   onReady       : called once ALL files are staged + APPLY.json written
   *                   (default () => process.exit(0)); injectable for tests.
   */
  async function consider(manifest, opts) {
    const options = opts || {};
    const bundleBaseUrl = options.bundleBaseUrl;
    const onReady = typeof options.onReady === 'function' ? options.onReady : () => process.exit(0);

    if (!manifest) return; // no manifest advertised — safe no-op
    if (updating) return; // re-entrancy guard — a slow run must not overlap

    updating = true;
    try {
      // 1. THE SECURITY GATE — verify the signature BEFORE any download or write.
      if (!verifyManifest(manifest, pubKey)) {
        log.error('Update rejected: signature verification failed — staying on', VERSION || '(unknown)');
        return;
      }

      // 2. Already on this version? Nothing to do.
      if (VERSION && manifest.version === VERSION) return;

      if (!bundleBaseUrl) {
        log.error('Update rejected: no bundleBaseUrl provided');
        return;
      }

      log.info('Update', manifest.version, 'signature OK — downloading', manifest.files.length, 'file(s)...');

      // Start from a clean staging dir (discard any stale/partial pending/).
      clearPending();

      const base = String(bundleBaseUrl).replace(/\/+$/, '');
      const stagedFiles = [];

      // 3. Download + verify + stage EACH file. ANY mismatch/error aborts the whole
      //    update (partial pending/ discarded) — a tampered/partial bundle never runs.
      for (const f of manifest.files) {
        const url = `${base}/${f.path}`;
        let buf;
        try {
          buf = await httpGetBuffer(url);
        } catch (e) {
          log.error('Update aborted: download failed for', f.path, '-', e && e.message ? e.message : String(e));
          clearPending();
          return;
        }
        const got = sha256Hex(buf);
        if (got !== String(f.sha256).toLowerCase()) {
          log.error('Update aborted: sha256 mismatch for', f.path, '— expected', f.sha256, 'got', got);
          clearPending();
          return;
        }
        const destPath = path.join(pendingDir, f.path);
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, buf);
        } catch (e) {
          log.error('Update aborted: could not stage', f.path, '-', e && e.message ? e.message : String(e));
          clearPending();
          return;
        }
        stagedFiles.push({ path: f.path, sha256: String(f.sha256).toLowerCase() });
      }

      // 4. All files verified + staged — write the apply marker atomically.
      try {
        writeJsonAtomic(path.join(pendingDir, 'APPLY.json'), {
          version: manifest.version,
          files: stagedFiles,
        });
      } catch (e) {
        log.error('Update aborted: could not write APPLY marker -', e && e.message ? e.message : String(e));
        clearPending();
        return;
      }

      log.info('Update', manifest.version, 'staged (', stagedFiles.length, 'file(s)) — restarting to apply');

      // 5. Hand off to the restart-into-apply path. Default kills the process so NSSM
      //    relaunches into applyPendingIfAny; injectable so tests don't kill the runner.
      onReady();
    } catch (e) {
      log.error('Self-update failed:', e && e.message ? e.message : String(e));
      clearPending();
    } finally {
      updating = false;
    }
  }

  return { consider };
}

module.exports = createUpdater;
module.exports.verifyManifest = verifyManifest;
module.exports.canonicalString = canonicalString;
module.exports.AGENT_UPDATE_PUBLIC_KEY = AGENT_UPDATE_PUBLIC_KEY;
