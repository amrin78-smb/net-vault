'use strict';
/**
 * scripts/sign-agent.js — release signing tool for the unified agent self-update.
 *
 * Given a built bundle file + the Ed25519 PRIVATE signing key, it computes the
 * bundle's sha256, signs `version + '|' + sha256` (the exact string core/updater.js
 * verifies), and prints the update manifest JSON:
 *
 *     { "version": "...", "url": "...", "sha256": "<hex>", "sig": "<base64>" }
 *
 * The `sig` is a base64 Ed25519 signature; core/updater.js's verifyManifest()
 * checks it against the embedded AGENT_UPDATE_PUBLIC_KEY. The download `url` is
 * where the hub will serve the bundle bytes (Phase 2); pass it in or fill it later.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   node scripts/sign-agent.js \
 *     --bundle path/to/agent-bundle.tar.gz \
 *     --version 1.1.0 \
 *     --url https://<hub>/agent/bundle/1.1.0.tar.gz \
 *     [--key path/to/agent-signing-key.pem]   (or env AGENT_SIGNING_KEY)
 *     [--out manifest.json]                    (defaults to stdout)
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
 *     release box only.
 *
 * ── .gitignore note ───────────────────────────────────────────────────────────
 *   The private signing key must NEVER be committed. Add patterns like
 *   `agent-signing-key.pem` / `*-signing-key.pem` to .gitignore. If a private key
 *   is ever committed by accident, treat it as compromised: rotate it (new keypair,
 *   new embedded public key, re-sign releases) — do not just delete the file.
 */
const crypto = require('crypto');
const fs = require('fs');

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
  const bundlePath = args.bundle;
  const version = args.version;
  const url = args.url || '';
  const keyPath = args.key || process.env.AGENT_SIGNING_KEY;
  const outPath = args.out;

  if (!bundlePath || !version || !keyPath) {
    console.error(
      'Usage: node scripts/sign-agent.js --bundle <file> --version <x.y.z> ' +
        '[--url <bundle-url>] [--key <privkey.pem> | env AGENT_SIGNING_KEY] [--out manifest.json]'
    );
    process.exit(1);
    return;
  }

  const bundle = fs.readFileSync(bundlePath);
  const sha256 = crypto.createHash('sha256').update(bundle).digest('hex');

  // Sign the EXACT string core/updater.js verifies: `version + '|' + sha256`.
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const data = Buffer.from(version + '|' + sha256, 'utf8');
  const sig = crypto.sign(null, data, privateKey).toString('base64'); // Ed25519 -> null digest

  const manifest = { version, url, sha256, sig };
  const json = JSON.stringify(manifest, null, 2);

  if (outPath) {
    fs.writeFileSync(outPath, json + '\n');
    console.error('Wrote manifest to ' + outPath);
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
