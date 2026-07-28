# Phase 1 — `nocvault-agent-core` (extract + SpanVault migration + signed update)

> Companion to `nocvault-agents-architecture.md`. This is the detailed scope for **Phase 1 only**.
> **Status: ✅ SHIPPED** (agent 2.0.0; Phase 2 shipped after it at netvault 1.25.0 / agent 2.1.1). This doc is
> now a **historical record** of the Phase 1 plan. The **current forward roadmap lives in
> `nocvault-agents-architecture.md` §7–§8**, revised around the **federated control plane** end-state (§6) —
> which reframes the later phases: a new **Phase 3 = identity reconciliation** (SpanVault trusts the hub JWT;
> collapse the two agent registries into one) is inserted before the DDIVault (now Phase 4) and LogVault (now
> Phase 5) modules. Read that first; the notes below describe Phase 1 as originally planned and delivered.

---

## Objective

Turn SpanVault's remote agent into a **reusable, app-agnostic runtime** (`nocvault-agent-core`) with a clean
**module contract**, prove it by **migrating SpanVault's own agent onto it with zero wire-level behaviour
change**, and close the one security gap worth fixing immediately: **signed self-update**.

Phase 1 ships *no new product feature* to end users — it's the foundation the DDIVault and LogVault agents
(Phase 3/4) and the hub fleet management (Phase 2) build on. Success is measured by "SpanVault agents behave
identically" + "the core is ready for a second module to plug in."

## Success criteria (definition of done)

1. `nocvault-agent-core` exists as a self-contained runtime: transport, offline buffer, reconnect, heartbeat,
   health, self-update, module loader — with **no SpanVault/SNMP-specific code in the core**.
2. A **module contract** is defined and documented; SNMP is the first module implementing it.
3. The **unified agent running only the `span` module** connects to SpanVault's existing `ws-server` (:3010) and
   is **byte-for-byte compatible on the wire** with today's agent (same auth, same `snmp_batch`/`heartbeat`
   message shapes, same buffer/flush semantics). An already-deployed legacy agent and a new unified agent are
   indistinguishable to the server.
4. **Self-update verifies a signature** before applying; an unsigned or tampered bundle is rejected and the
   agent keeps running the current version.
5. Green path validated end-to-end against a real SpanVault server (dev/demo), plus a unit/integration test
   harness for the core.

## Non-goals (explicitly deferred)

- **Hub enrollment API, `agent_registry` schema, launcher Agents page** → Phase 2.
- **Per-agent issued identity / mTLS enrollment flow** → Phase 2 (Phase 1 keeps the existing static-bearer
  `apiKey` install path; it defines the *identity interface* so Phase 2 can slot in, but does not build the hub
  side).
- **DDIVault / LogVault modules** → Phase 3 / 4 (Phase 1 defines the contract they'll implement, including the
  streaming variant, but implements only `span`).
- **Moving distribution to the hub** → Phase 2. Phase 1 installs the unified agent the same way SpanVault does
  today (config.json with server URL + apiKey).

---

## Key decisions (fixed for this phase)

1. **Where the code lives:** a new top-level `netvault/agent/` in the **netvault** repo — the future home, since
   the hub distributes it. Layout:
   ```
   netvault/agent/
     nocvault-agent.js        # entrypoint: load config, start core, load enabled modules
     core/
       transport.js           # WS dial-back client, auth header, connect/reconnect (backoff+jitter)
       buffer.js              # disk-backed offline buffer (cap, flush-on-reconnect, no-heartbeat rule)
       heartbeat.js           # periodic {version, hostname, health, buffer_depth, module_status}
       health.js              # CPU/mem/buffer sampler
       updater.js             # version advert handling + SIGNATURE VERIFY + exit-for-NSSM-restart
       runtime.js             # module loader + work-plan dispatch + send()/sendStream() API
       identity.js            # apiKey today; interface ready for Phase 2 issued identity
     modules/
       span/                  # SNMP + ICMP module (extracted from spanvault/agent/agent.js)
     install.ps1              # NSSM installer (generalized from spanvault/agent/install.ps1)
     config.json.example
     package.json             # deps: ws (+ net-snmp for the span module)
   ```
2. **SpanVault stays backward-compatible.** `spanvault/api/ws-server.js` is **unchanged** except for the
   signed-update serving (see Task 5). `spanvault/agent/` is marked **deprecated** (kept in place, no longer the
   source of truth) — existing deployed agents keep working; new installs use the unified agent.
3. **Two send paths in the contract from day one:** `send(msg)` (buffered, for periodic/pushed modules like span
   & ddi) and `sendStream(frame)` (backpressure-aware, for high-volume modules like log). Phase 1 implements
   both in the core; only `span` (which uses `send`) exercises it. This avoids a contract-breaking refactor when
   LogVault's streaming module arrives.
4. **Signing:** Ed25519. A private signing key stays offline (dev/release box); the **public key is embedded in
   the agent** (`core/updater.js`) — same pattern NetVault already uses for the EOL feed's Ed25519 verification
   (`lib/eolFeed.ts`), so there's a proven in-repo reference. The update manifest is `{ version, sha256, sig }`.

---

## The module contract (defined here, implemented by `span`)

```js
// A module is a factory: (ctx) => ({ start, stop, status })
// ctx (provided by core/runtime.js):
//   ctx.config            module-specific config block (from policy/config.json)
//   ctx.send(msg)         queue a discrete result; buffered offline, flushed on reconnect
//   ctx.sendStream(frame) high-volume path; batched+gzipped, backpressure-aware (Phase 3/4)
//   ctx.onWorkPlan(fn)    subscribe to server-pushed work-plans addressed to this module
//   ctx.logger            scoped logger
//
// module.start(ctx): begin work (open listeners, register work-plan handler, start timers)
// module.stop():      clean shutdown
// module.status():    'ok' | 'error:<short>'  → surfaced in heartbeat.module_status
```

`span` module (Phase 1): on a server-pushed SNMP fetch-plan it runs the walks/gets locally (moving the existing
`agent.js` SNMP logic behind the contract) and `ctx.send({ type:'snmp_batch', … })` — identical to today.

---

## Work breakdown

| # | Task | Files | Acceptance |
|---|---|---|---|
| **T1** | **Scaffold `netvault/agent/`** + `package.json` (`ws`, `net-snmp`), `config.json.example`, entrypoint that reads config and starts the core. | `netvault/agent/*` | `node nocvault-agent.js` boots, reads config, attempts connect. |
| **T2** | **Extract `core/transport.js`** — WS dial-back, `Authorization: Bearer`, connect + reconnect with exponential backoff **+ jitter** (lift the exact curve from `agent.js`), `send`/queue hooks. | `core/transport.js` | Reconnect timing matches current agent; jitter preserved. |
| **T3** | **Extract `core/buffer.js`** — disk buffer (`buffer.json`), `MAX_BUFFER` cap, flush-as-`{type:'batch',results}` on reconnect, **never buffer heartbeats** (the current stale-heartbeat rule). | `core/buffer.js` | Same file format + flush message shape as today; a stopped server → buffered results → replay on reconnect. |
| **T4** | **Extract `core/heartbeat.js` + `core/health.js`** — periodic `{version, hostname, health, buffer_depth}`, plus new `module_status` map. | `core/heartbeat.js`, `core/health.js` | Heartbeat payload is a **superset** (adds `module_status`); existing fields byte-identical. |
| **T5** | **`core/updater.js` — signed self-update.** Handle the server's version advertisement; fetch `{version,sha256,sig}` manifest + bundle; **verify Ed25519 sig against the embedded public key AND sha256**; only then replace `nocvault-agent.js`/module files and exit for NSSM restart. Reject + log + keep running on any failure. Add a `scripts/sign-agent.js` release tool + document the keypair. Emit the signed manifest from SpanVault's update-serving path. | `core/updater.js`, `netvault/agent/scripts/sign-agent.js`, small change in `spanvault/api/ws-server.js` (or its update endpoint) to serve the manifest | Tampered/unsigned bundle is **rejected** (unit test); a correctly signed bundle applies + restarts. Closes SpanVault's current unsigned-update RCE gap. |
| **T6** | **`core/runtime.js` — module loader + dispatch.** Load enabled modules, give each a `ctx`, route server-pushed work-plans to the addressed module, expose `send`/`sendStream`. | `core/runtime.js` | With only `span` enabled, a pushed SNMP plan reaches the module and its `send` reaches the server. |
| **T7** | **`core/identity.js` — auth interface.** Phase 1: static `apiKey` (as today). Define the interface (`getAuthHeader()`, `onIdentityRotate()`) so Phase 2's issued identity drops in without touching transport/modules. | `core/identity.js` | apiKey path works; interface documented; no Phase-2 hub calls. |
| **T8** | **`modules/span/` — extract SNMP/ICMP.** Move the SNMP session build + walk/get + `snmp_batch` shaping out of `agent.js` into a module implementing the contract. Match `collector/snmp-session.js` v3 handling (already noted in SpanVault CLAUDE.md). | `modules/span/*` | Emitted `snmp_batch` is byte-identical to today's for the same plan. |
| **T9** | **Generalize `install.ps1`** — NSSM install for the unified agent (service name, config path, args); keep it a drop-in for the SpanVault case (same service behaviour). | `netvault/agent/install.ps1` | Fresh install registers the NSSM service and the agent connects to :3010. |
| **T10** | **Deprecate `spanvault/agent/`** — leave files but add a `DEPRECATED.md` pointer to `netvault/agent/`; confirm `spanvault/api/ws-server.js` accepts the unified agent unchanged. | `spanvault/agent/DEPRECATED.md` | Server logs show the unified agent enrolling/polling identically. |
| **T11** | **Test harness** — unit tests for buffer (cap/flush/no-heartbeat), transport (backoff curve), updater (sig verify pass/fail); one integration test: fake ws-server ← unified agent (span) ← mock SNMP, assert wire messages. | `netvault/agent/test/*` | Tests green; the "no wire change" claim is asserted, not assumed. |

---

## SpanVault migration & backward compatibility

- The unified agent (`span` module) speaks the **same protocol** SpanVault's `ws-server` already expects:
  Bearer-`apiKey` auth, `heartbeat`, `snmp_batch`, `batch` (buffered flush). No server parsing changes.
- **Both old and new agents coexist.** During rollout, some remote hosts run the legacy `spanvault/agent`,
  others the unified agent — the server can't tell them apart (heartbeat adds an optional `module_status` field
  the server already ignores unknown fields for). No big-bang cutover.
- **Verification of "no behaviour change"** (the core acceptance gate):
  1. Diff the actual on-wire messages (capture from a legacy agent vs the unified agent against the same SNMP
     plan) — must match except the additive `module_status`.
  2. Run a unified agent against the dev/demo SpanVault; confirm the `/agents` fleet view, device polling,
     buffered-replay-after-outage, and self-update all behave identically.
  3. Confirm an existing deployed legacy agent still works unchanged (server untouched).

## Signed self-update — the security payoff (spec)

- **Manifest:** `GET <update-url>` → `{ "version":"1.1.0", "sha256":"…", "sig":"<ed25519(base64)>" }` where `sig`
  signs `version|sha256`. Bundle fetched separately, hashed, compared to `sha256`.
- **Verification order (fail closed):** parse manifest → verify `sig` against embedded public key → download
  bundle → verify `sha256` → atomically swap files → `process.exit()` (NSSM restarts on new code). Any step
  failing = log + stay on current version.
- **Keys:** Ed25519. Private key offline on the release box; `scripts/sign-agent.js` signs a release. Public key
  embedded in `core/updater.js`. **Reference implementation already in the suite:** `netvault/lib/eolFeed.ts`
  verifies an Ed25519 signature the same way — reuse that shape.
- This is the one item worth doing now regardless of the rest: it removes a real fleet-wide RCE vector from
  SpanVault's *current* self-update.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Subtle wire drift during extraction breaks live SpanVault agents | T11 message-diff test + coexistence design; server untouched; roll out to one host first. |
| Cross-repo coupling (agent in netvault, server in spanvault) | Phase 1 keeps distribution/install as-is; only the *code* moves. No build-time dependency between repos. |
| Signing key handling / accidental commit of the private key | Private key never in any repo (offline release box); only the public key is embedded; add to `.gitignore` + a checklist note. |
| Scope creep into Phase 2 (enrollment/hub UI) | Hard non-goals above; `identity.js` is an interface only, no hub calls. |
| Installer parity (per suite rules) | If any new NSSM service/port/env is introduced, update `netvault/installer/Install-NocVault-Suite.ps1` + `Test-NocVault-Suite.ps1` in the same change (Phase 1 aims to reuse SpanVault's existing service model, so ideally none). |

## Rough sequencing & effort

1. **T1–T4** (scaffold + transport/buffer/heartbeat extraction) — the mechanical core. *~largest chunk.*
2. **T6–T8** (runtime + identity interface + span module) — makes it actually poll.
3. **T5** (signed update) — self-contained, can run in parallel; highest security value.
4. **T9–T11** (install + deprecate + tests + on-wire verification) — the "prove no behaviour change" gate.

Deliverable at the end of Phase 1: a single `netvault/agent/` unified agent that runs SpanVault's polling
exactly as today, with a documented module contract ready for DDIVault/LogVault, and a self-update that can no
longer be used to push unsigned code to the fleet.

## Deploy / verification notes (suite conventions)

- Docs-only until code lands; the code phase follows the standard flow (build/test → commit → push → manual
  updater). Never deploy from here.
- Validate against the demo/prod SpanVault via the read-only DB (`agents` table, heartbeats) + the `/agents`
  page, per the suite's "curl answers is-it-up, DB answers is-it-correct" rule.
- Keep `spanvault/api/ws-server.js` changes minimal and backward-compatible (only the signed-update manifest).
