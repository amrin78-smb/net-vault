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
  identity.js    span-path auth seam: hub JWT when enrolled, else legacy apiKey
  identity-store.js  the ONE shared hub-identity store (hub.js + identity.js consult it)
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

## Config (`config.json`, gitignored) — TWO MODES

**apiKey-mode (legacy, unchanged):**
```json
{ "serverUrl": "http://SERVER_IP:3008", "apiKey": "…", "wsPort": 3010 }
```
The agent dials SpanVault directly and presents `Bearer <apiKey>`, exactly as Phase 1.

**JWT-mode (Phase 3):**
```json
{ "hubUrl": "http://SERVER_IP:3000", "enrollToken": "…" }
```
With `hubUrl` + `enrollToken` and **no** `apiKey`, the agent enrolls with the NetVault
hub, then presents its hub-issued **JWT** on the span data path and dials the
hub-provided span **ingest** URL. The shared identity store (`core/identity-store.js`)
holds `{ agent_id, jwt, expires_at, ingest }`; the span transport **defers** its dial
until the identity is ready, and **reconnects** when the JWT is refreshed/rotated
(the Bearer header is fixed at connect). `hubUrl` + `enrollToken` are BOTH required for
JWT-mode.

Setting `apiKey` **and** `hubUrl`+`enrollToken` together keeps `apiKey` on the data path
and runs the hub channel as an additive side-channel (the Phase 2 opt-in).

## Hub control channel (Phase 2)
An **opt-in** side-channel to the NetVault hub, enabled only when BOTH `hubUrl` and
`enrollToken` are set in `config.json`. It is purely additive — it does NOT touch the
app-WS data path: the span module still gets its device config and ships results over
the existing WebSocket to SpanVault. **Data flows to the apps, never to the hub.**

- **Enroll once.** On first start (no stored identity) the agent POSTs `enrollToken`
  to `<hubUrl>/api/agents/enroll` and receives a signed identity (`{ agent_id, jwt,
  expires_at }`) plus the span module's **ingest** URL; both are persisted (via the
  shared store) to `agent/hub-identity.json` (gitignored) as
  `{ agent_id, jwt, expires_at, ingest }`. On later starts the stored identity is
  loaded and enrollment is skipped. Enrollment failures (401/network) retry with
  backoff and never crash the data path.
- **Identity refresh (Phase 3).** On the policy tick, once < 1/3 of the JWT's TTL
  remains, the agent POSTs `<hubUrl>/api/agents/<agent_id>/refresh` (Bearer the current
  JWT) and stores the returned `{ jwt, expires_at }` — which reconnects the span
  transport with the new token. A refresh `401` (revoked) stops the loops, same
  no-spin rule as the heartbeat.
- **Fleet heartbeat.** Once enrolled, every 30s the agent POSTs a heartbeat
  (`{ version, health, module_status, buffer_depth }`, `Authorization: Bearer <jwt>`)
  so the launcher Agents page is populated. A `401` (revoked/expired identity) stops
  the heartbeats and logs clearly — it does not spin.
- **Policy poll (not applied).** Every ~5 min the agent GETs its policy and stores/logs
  it. In Phase 2 the policy is **not** applied to modules — the span module's real work
  config still comes from the app WS.

To reset a hub identity (e.g. after re-enrolling), delete `agent/hub-identity.json`.

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
