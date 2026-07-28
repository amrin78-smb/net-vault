'use strict';
/**
 * scripts/sign-agent.js — offline release signer for the unified agent self-update.
 *
 * Walks the agent directory, builds a per-file sha256 manifest of every RUNTIME
 * file (applying the SAME exclude set as the hub's bundle route), signs a canonical
 * string over that file list with the Ed25519 PRIVATE signing key, and writes the
 * signed update manifest that the hub serves at /api/agents/update-manifest and that
 * core/updater.js verifies:
 *
 *     {
 *       "version": "1.2.0",
 *       "files": [ { "path": "core/hub.js", "sha256": "<hex>" }, ... ],
 *       "sig": "<base64>"
 *     }
 *
 *   - `files` is sorted ascending by `path`; `path` is a forward-slash relative
 *     path under the agent dir (e.g. "core/hub.js", "nocvault-agent.js",
 *     "package.json"). This list MUST equal the file list the hub's bundle route
 *     serves (/api/agents/bundle), because the agent downloads each file from
 *     /api/agents/bundle/<path> and verifies its sha256 against this manifest.
 *   - **Canonical signed string** (the signer signs the UTF-8 bytes of this,
 *     verbatim): `version + '\n' + files.map(f => f.path + ':' + f.sha256).join('\n')`
 *   - `sig` is a base64 Ed25519 signature made with `crypto.sign(null, data, key)`
 *     (null digest); core/updater.js checks it against the embedded public key.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   node scripts/sign-agent.js \
 *     --version 1.2.0 \
 *     --key keys/agent-signing-key.pem            (or env AGENT_SIGNING_KEY)
 *     [--dir <agentdir>]                          (defaults to this script's ..)
 *     [--out <path>]                              (defaults to <agentdir>/update-manifest.json)
 *
 * The private key is read from --key or the AGENT_SIGNING_KEY env var (a PKCS#8
 * PEM path). It is NEVER hardcoded and NEVER committed.
 *
 * ── Generating the keypair (run ONCE, offline; keep the private key off every repo)
 *   node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');\
 *   require('fs').writeFileSync('agent-signing-key.pem',privateKey.export({type:'pkcs8',format:'pem'}));\
 *   console.log(publicKey.export({type:'spki',format:'der'}).toString('base64'));"
 *
 *   - The printed base64 is the spki-DER PUBLIC key — paste it into
 *     core/updater.js's AGENT_UPDATE_PUBLIC_KEY constant (replacing the placeholder).
 *   - agent-signing-key.pem is the PKCS#8 PRIVATE key — store it OFFLINE on the
 *     release box only (e.g. under agent/keys/, which is git-ignored and excluded).
 *
 * ── .gitignore note ───────────────────────────────────────────────────────────
 *   The private signing key must NEVER be committed. Add patterns like
 *   `agent-signing-key.pem` / `*-signing-key.pem` / `keys/` to .gitignore. If a
 *   private key is ever committed by accident, treat it as compromised: rotate it
 *   (new keypair, new embedded public key, re-sign releases) — not just delete it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// EXCLUDE SET — MUST STAY BYTE-FOR-BYTE IN LOCKSTEP WITH
// netvault/lib/agentBundle.ts's isExcludedBundlePath(). The manifest's file list
// MUST equal the bundle route's served file list (the agent downloads each file
// from /api/agents/bundle/<path>); if these two exclude sets ever drift, a signed
// file won't be servable (or a served file won't be signed) and self-update breaks.
// Any edit here requires the same edit there, and vice versa.
// `relPath` is forward-slash relative to the agent dir.
function isExcludedBundlePath(relPath) {
  const rel = relPath.replace(/\\/g, '/');
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length) return true;
  const base = segments[segments.length - 1].toLowerCase();

  // Whole-directory excludes (any depth for node_modules + the signing key dir;
  // top-level test/ and the self-update staging/rollback dirs).
  if (segments.includes('node_modules')) return true;
  if (segments.includes('keys')) return true;
  if (segments[0] === 'test') return true;
  if (segments[0] === 'pending' || segments[0] === 'backup') return true;

  // Local runtime state / secrets — never part of a fresh bundle.
  if (base === 'config.json' || base === 'hub-identity.json' || base === 'buffer.json') return true;
  if (base === 'pending-update.bundle') return true;
  // The runtime signed manifest is served by its own route + is what we PRODUCE
  // here — it must never list itself. Same for the updater's apply-marker.
  if (base === 'update-manifest.json') return true;
  if (base === '.update-confirm.json') return true;
  if (base === '.gitignore') return true;
  // The installer script is served separately (baked) — not a runtime file.
  if (base === 'install.ps1') return true;
  if (base.endsWith('.log')) return true;
  // Private keys of any kind (covers scripts/*.key too).
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;

  return false;
}

// Recursively list the servable agent files as forward-slash relative paths, with
// the blocklist applied. Mirrors listBundleFiles() in lib/agentBundle.ts.
function listBundleFiles(agentDir) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (isExcludedBundlePath(rel)) continue;
      if (e.isDirectory()) {
        walk(path.join(absDir, e.name), rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(agentDir, '');
  out.sort();
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.slice(0, 2) === '--') {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const keyPath = args.key || process.env.AGENT_SIGNING_KEY;
  // Default agent dir = this script's parent (scripts/ -> agent root).
  const agentDir = path.resolve(args.dir || path.join(__dirname, '..'));
  const outPath = args.out || path.join(agentDir, 'update-manifest.json');

  if (!version || !keyPath) {
    console.error(
      'Usage: node scripts/sign-agent.js --version <x.y.z> ' +
        '--key <privkey.pem> (or env AGENT_SIGNING_KEY) [--dir <agentdir>] [--out <path>]'
    );
    process.exit(1);
    return;
  }

  // Build files:[{path, sha256}] for every runtime file, sorted ascending by path.
  const relPaths = listBundleFiles(agentDir);
  const files = relPaths.map((rel) => {
    const buf = fs.readFileSync(path.join(agentDir, rel));
    return { path: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  });

  // Canonical signed string — pinned by the manifest contract; the agent-side
  // verifier reconstructs and verifies exactly this:
  //   version + '\n' + files.map(f => f.path + ':' + f.sha256).join('\n')
  const canonical = version + '\n' + files.map((f) => f.path + ':' + f.sha256).join('\n');

  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'); // Ed25519 -> null digest

  const manifest = { version, files, sig };
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.error('Wrote signed update manifest (' + files.length + ' files) to ' + outPath);
}

main();
