# NocVault Agent

The unified remote agent for the NocVault suite. A thin, dial-back collector: it opens one
outbound WebSocket to the server, runs only the collection **modules** it's assigned, buffers
results to disk while offline, and ships **raw** (all parsing stays central).

This is **Phase 1** of the design in [`../docs/nocvault-agents-architecture.md`] — the reusable
**core** extracted from SpanVault's agent, with the SpanVault workload as the first module. The hub
control plane (enrollment, fleet management, launcher page) and the DDIVault/LogVault modules are
later phases.

## Layout
```
core/
  transport.js   outbound WS dial-back: connect/reconnect (backoff+jitter), send (buffers offline)
  buffer.js      disk-backed offline buffer (buffer.json, cap 500, flush-on-reconnect)
  heartbeat.js   30s heartbeat: { type, version, hostname, health, module_status }
  health.js      CPU/mem/disk/uptime/device/buffer sampler
  updater.js     SIGNED (Ed25519) multi-file self-update — verify-before-apply, fail closed
  runtime.js     server-push router: restart / get_logs / signed-update, forwards rest to modules
  identity.js    auth (apiKey today; interface ready for Phase-2 issued identity)
  logger.js      console + in-memory ring (feeds get_logs)
modules/
  span/          the SpanVault edge workload (ping, SNMP plan+legacy, service checks, discovery)
nocvault-agent.js  entrypoint: reads config.json, wires the core + modules, starts
install.ps1        NSSM installer (NocVault-Agent service)
scripts/sign-agent.js  release signing CLI (Ed25519; private key stays offline)
```

## Module contract
```js
module.exports = createModule(ctx) => ({ name, start(), stop(), status(), onMessage(msg), deviceCount() })
// ctx = { config, send(msg), logger, hostname, version }
//   send(msg)       buffered-offline result path (periodic modules: span, ddi)
//   onMessage(msg)  every server push the core doesn't own is forwarded here
// (a streaming send path — sendStream — is reserved for LogVault's high-volume module, Phase 4)
```

## Config (`config.json`, gitignored)
```json
{ "serverUrl": "http://SERVER_IP:3008", "apiKey": "…", "wsPort": 3010 }
```

## Test
```
npm install
npm test          # unit (buffer/health/heartbeat/updater-verify) + e2e (fake ws-server, real ping)
```

## Self-update (signed)
`updater.js` verifies an Ed25519-signed manifest `{ version, url, sha256, sig }` (sig over
`version|sha256`) against an embedded public key, then re-hashes the downloaded bundle — **fail
closed** on any mismatch. `AGENT_UPDATE_PUBLIC_KEY` in `updater.js` is a **placeholder**; generate a
release keypair (`crypto.generateKeyPairSync('ed25519')`), embed the public spki-DER-base64, keep the
private key **offline** (never commit it). `scripts/sign-agent.js` produces release manifests. Phase 1
verifies-and-stages (`pending-update.bundle`); the atomic swap + restart + hub bundle distribution land
in Phase 2.
