# Phase 3 — Identity reconciliation (one agent, one identity) + finish signed self-update

> Companion to `nocvault-agents-architecture.md` (the **federated control plane** end-state, §6). This is the
> detailed scope for **Phase 3 only**.
> **Status:** Draft plan · **Depends on:** Phases 1–2 (shipped: netvault 1.25.0 / agent 2.1.1) ·
> **Unblocks:** Phase 4 (DDIVault module + slim SpanVault page), Phase 5 (LogVault module).

---

## Objective

Make **one physical agent = one identity.** Today there are two agent registries that don't know about each
other: the **hub** (`netvault.agents`, opaque `agt_…` id, hub-signed JWT) and **SpanVault**
(`spanvault.agents`, `SERIAL` id, plaintext `api_key`). Phase 3 collapses them by making SpanVault **trust the
hub-signed JWT on its data-plane WebSocket** instead of minting and checking its own `api_key`, and by making
the agent **present its hub identity** to SpanVault. This is the keystone of the federated model (§6): once
there is one identity, everything downstream (slimming SpanVault's page, DDI/Log modules) becomes additive.

Phase 3 also **finishes signed self-update** — Phase 1 left it *verify-and-stage* (verifies an Ed25519 manifest
+ sha256, then only writes `pending-update.bundle`); this phase adds a real signing key, a hub-served signed
manifest that **reuses the bundle routes we already built**, and a crash-safe **verify-before-apply →
apply-on-next-start** swap so the fleet can actually be updated from the hub.

**No collection behaviour changes.** SpanVault still polls exactly the same devices via the same config push;
only *how the agent authenticates* and *how it self-updates* change. Success is "existing keyed agents keep
working untouched, a hub-enrolled agent connects with no SpanVault key and appears in exactly one place, and a
signed update can be rolled out from the hub."

---

## Two workstreams (independent; A is the priority)

- **Workstream A — Identity reconciliation (the keystone).** Agent presents the hub JWT to SpanVault; SpanVault
  verifies it (accept-both with the legacy `api_key`); link the two registries; honour revocation.
- **Workstream B — Signed self-update completion.** Real key + hub-served signed manifest (reusing the bundle
  routes) + verify-before-apply + crash-safe apply-on-next-start + rollback.

They share no files and can run in parallel. If time-boxed, ship A first — it removes the duplication the whole
initiative exists to fix; B can slip to a "3b" without blocking Phase 4.

---

## Current state (verified) — the seams this plan turns

**Agent (`netvault/agent/`)**
- `transport.js:62` opens the span WS with `headers: identity.getAuthHeader()` and **only ever** calls that one
  method — `identity.js:16-18` returns `{ Authorization: 'Bearer ' + config.apiKey }`. **This is the entire
  data-path auth seam.**
- `transport.js:30-43` (`buildUrl`) builds `ws://<host-of-serverUrl>:<wsPort>/` (port on `serverUrl` stripped).
- `hub.js` is fully walled off: the hub JWT (`hub-identity.json`, loaded/persisted at `hub.js:171-201`) is used
  **only** for hub HTTP heartbeat (`hub.js:340`) + policy (`hub.js:361`). It's a closure-local `let identity`
  (`hub.js:152`), exposed only via `_getIdentity()` for tests. **The span transport cannot reach it today.**
- Hub enroll/policy responses already return the span **ingest URL** (`deriveIngest` → `ws://<host>:3010/`,
  `lib/agentIdentity.ts:35-45`), i.e. the hub already tells the agent where SpanVault's data plane is.
- `updater.js` = verify-and-stage: verifies sig (`:154`) + sha256 (`:168`) **before** `applyBundle`, but
  `applyBundle` (`:138-142`) only writes `pending-update.bundle` — no extract, no swap, no `exit`. Public key is
  an all-zeros **placeholder** (`:48-49`); the trigger is wired to the **span WS** (`runtime.js:30-34`,
  `msg.agent_bundle`), which **no server sends today** (dead path). `scripts/sign-agent.js` signs a single
  pre-built archive file over `version|sha256`; **no dir→archive packer exists.**

**SpanVault (`spanvault/api/`)**
- `ws-server.js:92-102` (`getApiKey`) reads `Authorization: Bearer <key>` (or legacy `?key=`). Verify =
  **plaintext** `SELECT * FROM agents WHERE api_key=$1` (`ws-server.js:142-149`); connect-time only; the whole
  row becomes the agent identity. Live sockets are indexed **by api_key**: `connectedAgents.set(apiKey, ws)`
  (`ws-server.js:82,158`). Close codes: `4001` no key, `4003` invalid/disabled.
- `agents` (`scripts/schema.sql:305-325`): `id SERIAL PK`, `api_key TEXT NOT NULL UNIQUE DEFAULT
  gen_random_uuid()::text` (**plaintext**), `disabled`, `health JSONB`, status/version/hostname/last_seen. **No
  hub linkage column.** `agent_sites(agent_id,site_id,site_name)` drives `monitored_devices.agent_id` → the
  `type:'config'` push (`ws-server.js:227-284`). `agent_discovered_devices` for discover/adopt.
- The Express backend **already has** `jsonwebtoken` ^9.0.2 (declared, unused in `api/`) **and**
  `NEXTAUTH_SECRET` in its env (`api/server.js:10` loads `../.env.local`). SSO is currently proxied to the hub,
  not verified locally. SpanVault already reads the **NetVault DB** (site IDs in `agent_sites` come from it).

**Hub (`netvault/`)**
- `lib/agentIdentity.ts:92-106` (`verifyAgentIdentity`): `jwt.verify(token, NEXTAUTH_SECRET, {algorithms:
  ['HS256']})`, requires `typ==='agent'` + `sub`, returns `{agentId, modules}`. **~15 lines, no netvault-only
  imports → directly portable to SpanVault's Express.** (`requireAgentAuth` adds a netvault-DB revocation check
  — that part is not portable as-is; see A2.)
- Identity is issued once at enroll (30-day TTL, `:79-81`) and **never refreshed**. Bundle is served **unsigned**
  (`app/api/agents/bundle` manifest of paths + `bundle/[...path]` raw files). No `/api/agents/update` endpoint.

---

## Success criteria (definition of done)

**Workstream A**
1. SpanVault's `ws-server` accepts an agent presenting a **hub-signed JWT** (aud includes `span`/`spanvault`):
   verifies signature + `typ` + expiry with the shared `NEXTAUTH_SECRET`, and **honours hub revocation** at
   connect.
2. **Accept-both:** an existing agent presenting its legacy `api_key` still connects exactly as today. No
   deployed SpanVault agent breaks during or after rollout.
3. **One entry:** a hub-enrolled span agent auto-links to a single `spanvault.agents` row via a new
   `hub_agent_id`; it appears once in SpanVault's page (for site assignment) and once in the hub fleet page —
   never as two mystery agents.
4. The **agent** presents its hub JWT on the span data path (via the identity seam) and finds SpanVault's data
   plane from the **hub-provided ingest URL**; a fully hub-managed agent needs only `{hubUrl, enrollToken}` in
   `config.json` (no `apiKey`/`serverUrl`). Legacy `apiKey` config still works.
5. Hub identity is **refreshable** so an agent's data-path credential doesn't die at the 30-day TTL.
6. Revoking an agent in the hub **disconnects its live SpanVault session** (not only refuses the next connect).

**Workstream B**
7. A **real Ed25519 release keypair** replaces the placeholder; private key stays offline.
8. The hub serves a **signed update manifest**; the agent verifies it against the embedded public key, downloads
   the files from the existing bundle routes, verifies each `sha256`, and applies **only** on full success.
9. Apply is **crash-safe**: staged then applied on next start with **automatic rollback** on any failure; a
   tampered/partial/unsigned bundle never runs.
10. Update is driven from the **hub control channel** (not the dead span-WS path).

**Both:** green against the dev/demo suite; unit/integration coverage for JWT-accept-both, revocation, refresh,
and the update verify/rollback path; installer + smoke-test parity.

---

## Non-goals (explicitly deferred)

- **Slimming SpanVault's agent page** (retire `api_key` minting UI, reframe as "span config for hub agent X")
  → **Phase 4**. Phase 3 keeps the existing SpanVault page fully working; it only adds the JWT path underneath.
- **DDIVault / LogVault** trusting the hub JWT → those apps' modules are Phase 4/5; Phase 3 proves the pattern
  on SpanVault only (but the SpanVault-side verify helper is written to be copy-paste reusable).
- **Applying hub policy to modules** (module on/off actually gating collection) beyond what auth implies →
  Phase 4. Phase 3's authorization signal is "the JWT `aud` includes this app's module."
- **Hashing SpanVault's `api_key`** / removing the legacy `?key=` param → out of scope; the accept-both window
  keeps them, and they retire naturally when Phase 4 stops minting keys.
- **mTLS / pinned `wss`** over the data plane → cross-cutting hardening, tracked separately (§9 architecture).

---

## Key decisions (fixed for this phase)

1. **Link, don't migrate.** Add `hub_agent_id TEXT UNIQUE` to `spanvault.agents`; keep the `SERIAL` PK and every
   existing INTEGER FK (`agent_sites`, `monitored_devices.agent_id`, `ping_results`, `snmp_results`, `alerts`,
   `agent_discovered_devices`) unchanged. A hub JWT resolves `sub` → the local row via `hub_agent_id`.
2. **Accept-both, JWT-first.** On connect, try to verify the Bearer token as a hub JWT (local crypto, no DB); on
   success take the JWT path, else fall back to the existing `api_key` DB lookup. Legacy `?key=` stays for
   `api_key` only. This is symmetric on the agent side (send JWT if enrolled, else `apiKey`).
3. **Auto-provision on first JWT connect.** A valid hub JWT whose `aud` includes span, with no matching
   `hub_agent_id` row, creates one (`hub_agent_id=sub`, `api_key=NULL`, name = hostname-or-`sub`, no sites). The
   admin then assigns sites in SpanVault's page as today. (Authorization is already established: the hub
   super-admin minted the enrollment token and assigned the span module.)
4. **Copy the verifier, cross-check revocation.** Port `verifyAgentIdentity` (~15 lines) into `spanvault/api`
   (reuses the existing `jsonwebtoken` dep + `NEXTAUTH_SECRET`). For revocation (which `verifyAgentIdentity`
   alone can't see), **query the NetVault DB** `agents WHERE id=$1 AND revoked_at IS NULL` at connect —
   SpanVault already has NetVault DB read access. Ensure the read-only grant covers `agents.revoked_at`.
5. **`api_key` column becomes nullable** (drop `NOT NULL`; keep `UNIQUE` which already ignores NULLs). Existing
   rows keep their key; JWT-provisioned rows have none.
6. **Shared identity store on the agent.** Extract identity storage into one module both `hub.js` and the span
   `identity.js` consult, so `getAuthHeader()` can return the hub JWT and pick up a refreshed token on
   reconnect. JWT-mode transport **gates** on identity being ready and uses the **hub-provided ingest URL**.
7. **Self-update reuses the bundle routes; no tar dependency.** The signed update manifest is
   `{ version, files:[{path,sha256}], sig }` (sig over a canonical hash of the file list). The agent downloads
   each file from the existing `/api/agents/bundle/<path>` route, verifies per-file `sha256`, and applies. This
   unifies self-update with the distribution we already built and stays dependency-free (the suite's style).
8. **Apply-on-next-start, not swap-in-place.** Windows can't atomically replace files the running Node process
   has open. The updater stages verified files to `pending/`, writes an apply-marker, and exits; the entrypoint,
   **before loading modules**, detects the marker, backs up the current tree, moves `pending/` into place,
   verifies, and rolls back on any failure — mirroring the (heavily battle-tested) NetVault updater's
   stop→swap→verify→rollback discipline documented in `netvault/CLAUDE.md`.

---

## Workstream A — identity reconciliation

### A1. SpanVault data model (`spanvault/scripts/schema.sql` + migration)
- `ALTER TABLE agents ADD COLUMN hub_agent_id TEXT UNIQUE;` and `ALTER TABLE agents ALTER COLUMN api_key DROP
  NOT NULL;` — additive, safe on a populated DB. Add an index on `hub_agent_id` (UNIQUE already provides one).
- Follow the suite's fresh-install ordering rules (these ALTERs go **after** the `agents` CREATE; see the
  `[[fresh-install-schema-ordering-bugs]]` class — scan for any grant/view that would need the new column).

### A2. SpanVault WS auth — accept-both + verify + revocation (`spanvault/api/ws-server.js`)
- Add `verifyHubAgentJwt(token)` (ported from `lib/agentIdentity.ts:92-106`: HS256 pinned, `typ==='agent'`,
  `sub` present, `NEXTAUTH_SECRET`). Put it in a small `spanvault/api/agent-identity.js` so DDI/Log can reuse it.
- Rewrite the connect handler (`ws-server.js:138-166`): extract Bearer token → `verifyHubAgentJwt`; if valid and
  `aud` includes `span`/`spanvault` → **JWT path** (A3); else → existing `api_key` path (unchanged).
- **JWT path revocation:** query the NetVault DB `SELECT 1 FROM agents WHERE id=$1 AND revoked_at IS NULL`
  ([sub]) using SpanVault's existing NetVault connection; refuse with `4003 'Agent revoked'` if absent.
- Keep all close codes; add `4003 'Agent revoked'`. Legacy `?key=` remains `api_key`-only.

### A3. Auto-provision, re-key the socket map, active kick (`spanvault/api/ws-server.js` + `server.js`)
- **Auto-provision:** on JWT path with no `hub_agent_id` match, `INSERT INTO agents (hub_agent_id, name, status)
  VALUES ($1, $1, 'online') ... RETURNING *` (name later updated to hostname on heartbeat). Then proceed as if
  that row were the authed agent.
- **Re-key live sockets by local `agent.id`, not `api_key`** (`connectedAgents`, `ws-server.js:82,105-108,158`;
  audit `disconnectAgent`, `pushConfigToAgentId`, rotate/disable/delete, and the loopback
  `/api/internal/agents/push-config`). JWT agents have no `api_key`, so the map key must be the local id — which
  both paths already resolve to.
- **Active kick on hub revoke:** add `POST /api/internal/agents/disconnect` (loopback-gated, mirroring
  `push-config` at `server.js:1040`) taking `{hub_agent_id}` → look up local id → `disconnectAgent`. The hub's
  `POST /api/agents/[id]/revoke` fans out this signal to the apps the agent's modules cover (the hub already
  fans out to siblings for health/stats — same pattern, `127.0.0.1`).

### A4. Agent — present the hub JWT on the span data path (`netvault/agent/`)
- **Shared identity store** `core/identity-store.js`: `load()/persist()/get()/onChange(cb)` over
  `hub-identity.json` (move the atomic tmp+rename from `hub.js:183-201` here). `hub.js` uses it for
  enroll/persist; the span identity reads from it.
- **`core/identity.js`:** `getAuthHeader()` returns `Bearer <hub jwt>` when the store has a valid identity, else
  falls back to `Bearer <config.apiKey>` (legacy). Add `isReady()` (true if apiKey present, or a hub identity is
  loaded). Add an `onChange` that lets transport reconnect to pick up a refreshed token (headers are fixed at
  connect, so rotation = reconnect).
- **`core/transport.js`:** if `!identity.isReady()`, defer dialing and retry when it becomes ready; on identity
  change, drop+reconnect. For JWT-mode agents, take the WS URL from the hub-provided **ingest** URL
  (`modules[].ingest` for span in the enroll/policy response, surfaced via the store/hub) instead of
  `config.serverUrl`.
- **`nocvault-agent.js`:** sequence so a JWT-mode agent (config has `hubUrl`+`enrollToken`, no `apiKey`) enrolls
  / loads its identity **before** the span transport dials; an apiKey-mode agent is unchanged (ready
  immediately). Document the new minimal config: `{ "hubUrl": "...", "enrollToken": "..." }`.

### A5. Hub identity refresh (`netvault/` + agent `hub.js`)
- Add `POST /api/agents/[id]/refresh` (agent-authed via `requireAgentAuth`, `sub===id`) → issue a fresh identity
  (`issueAgentIdentity`) and return it; the agent persists it via the store.
- `hub.js`: before expiry (e.g. when < 1/3 TTL remains, checked on the existing policy-poll tick) call refresh;
  on success persist + `onChange`. A refresh `401` (revoked) → stop, same no-spin rule as today.
- Consider shortening the default TTL now that refresh exists (e.g. 7 days) so a revoked agent's window is
  smaller even between reconnects — decide with the revocation cross-check (A2) in mind.

*(Phase 4, not here: slim SpanVault's page — the create/api_key/rotate UI retires; the page becomes site
assignment + discovery keyed by `hub_agent_id`, deep-linked from the hub fleet page.)*

---

## Workstream B — finish signed self-update

### B1. Release keypair
- Generate an Ed25519 keypair (`crypto.generateKeyPairSync('ed25519')`); embed the **spki-DER-base64 public key**
  in `updater.js` (replace the placeholder `:48-49`) and pass it through `createUpdater` at
  `nocvault-agent.js:77`. Private key stays **offline** on the release box (never committed; `.gitignore` +
  checklist), exactly like the EOL-feed key pattern (`lib/eolFeed.ts`).

### B2. Signed manifest + hub endpoint (reuse the bundle routes)
- Manifest shape `{ version, files:[{path, sha256}], sig }`; `sig` = Ed25519 over a canonical string (e.g.
  `version + '\n' + sorted("path:sha256")`). Produced **offline** by an updated `scripts/sign-agent.js` (B5) and
  committed as `agent/update-manifest.json`.
- New route `GET /api/agents/update-manifest` (public, like `bundle`) that serves that file, plus
  `resolveAgentDir()`-based freshness (or just serves the committed file). Files themselves are already served by
  `bundle/[...path]` — **no new file-serving code.**

### B3. Updater — verify-before-apply → staged apply-on-next-start + rollback (`agent/core/updater.js` + entrypoint)
- `consider(manifest)`: verify `sig` (embedded key) → skip if `version===VERSION` → download each
  `files[].path` from `<hubUrl>/api/agents/bundle/<path>` → verify each `sha256` → write all into `pending/` →
  write `pending/APPLY` marker (with the target version + file list) → `process.exit(0)`. **Any failure = discard
  `pending/`, log, keep running.** (The verify-before-apply ordering already exists; this replaces the
  `applyBundle` stub at `:138-142`.)
- `nocvault-agent.js` **startup**, before loading modules: if `pending/APPLY` exists → back up the current tree
  to `backup/`, move `pending/` files into place, re-verify the applied file set against the marker, then delete
  `pending/`. On any error → restore from `backup/` and continue on the old version. Mirror NetVault's
  stop→swap→verify→rollback logic (`CLAUDE.md`).

### B4. Hub-channel trigger (`agent/core/hub.js`)
- The policy poll response advertises the current signed manifest (or the agent fetches `/api/agents/update-manifest`
  on the policy tick). `hub.js` calls `updater.consider(manifest)` — moving self-update onto the **hub control
  channel** where it belongs (the span-WS `agent_bundle` path `runtime.js:30-34` is left inert / removed).
  Wire `updater` into the hub client (today it's only reachable from the span runtime).

### B5. `scripts/sign-agent.js`
- Change from "hash one archive file" to "walk the agent dir (reuse the `bundle` exclude set), build
  `files:[{path,sha256}]`, sign the canonical string, emit `update-manifest.json`." Keep the PKCS#8 PEM key
  input (`--key`/`AGENT_SIGNING_KEY`).

---

## Work breakdown

| # | Task | Files | Acceptance |
|---|---|---|---|
| **A1** | `hub_agent_id` column + `api_key` nullable + migration; forward-ref scan | `spanvault/scripts/schema.sql`, migration | Fresh install + populated-DB migrate both clean; existing rows intact |
| **A2** | Port JWT verifier; accept-both connect; revocation cross-check | `spanvault/api/agent-identity.js` (new), `spanvault/api/ws-server.js` | Valid hub JWT (aud⊇span) connects; bad/expired/revoked → `4003`; legacy `api_key` unchanged |
| **A3** | Auto-provision; re-key `connectedAgents` by local id; loopback disconnect + hub fan-out on revoke | `spanvault/api/ws-server.js`, `spanvault/api/server.js`, `netvault/app/api/agents/[id]/revoke/route.ts` | First JWT connect creates one row; revoke in hub drops the live SpanVault socket |
| **A4** | Shared identity store; `identity.js` JWT-or-apiKey; transport gate + ingest URL; entrypoint sequencing | `netvault/agent/core/{identity-store.js(new),identity.js,transport.js,hub.js}`, `nocvault-agent.js`, `config.json.example` | JWT-mode agent (`{hubUrl,enrollToken}` only) polls SpanVault identically; apiKey-mode unchanged |
| **A5** | Identity refresh endpoint + agent refresh-before-expiry | `netvault/app/api/agents/[id]/refresh/route.ts` (new), `netvault/agent/core/hub.js`, `lib/agentIdentity.ts` (TTL) | Agent renews before TTL; revoked refresh → stop, no spin |
| **B1** | Real Ed25519 keypair; embed public; wire into `createUpdater` | `netvault/agent/core/updater.js`, `nocvault-agent.js`, `.gitignore` | Placeholder gone; private key never committed |
| **B2** | Signed manifest format + `update-manifest` endpoint | `netvault/app/api/agents/update-manifest/route.ts` (new), `agent/update-manifest.json` | Endpoint serves a valid signed manifest; files served by existing bundle route |
| **B3** | Updater verify→stage→exit; entrypoint apply-on-start + rollback | `netvault/agent/core/updater.js`, `nocvault-agent.js` | Tampered/partial bundle never applies; good bundle applies + restarts; failure rolls back |
| **B4** | Drive update from hub channel; retire span-WS trigger | `netvault/agent/core/hub.js`, `core/runtime.js` | `updater.consider` fires from the policy tick, not the span WS |
| **B5** | `sign-agent.js` → multi-file manifest signer | `netvault/agent/scripts/sign-agent.js` | Produces a manifest `updater.js` accepts |
| **T-test** | Unit + integration: accept-both, revocation, refresh, update verify/rollback | `netvault/agent/test/*`, `spanvault` test harness | All green; "no collection behaviour change" asserted via SpanVault config-push diff |

---

## SpanVault accept-both migration & backward compatibility

- **Rollout order:** (1) ship SpanVault A1–A3 (accept-both) first — it changes nothing for existing agents (JWT
  verify simply fails → api_key path). (2) Ship the agent A4/A5. (3) Migrate agents **one at a time**: enroll via
  the hub, swap the host's `config.json` to `{hubUrl, enrollToken}`, restart. Existing `api_key` agents keep
  running throughout — no big-bang.
- **The same physical agent, mid-migration:** before its config swap it connects by `api_key` (one local row);
  after, by JWT (auto-provisions/links a row via `hub_agent_id`). To avoid a duplicate row, the migration for an
  *existing* agent should **stamp its `hub_agent_id`** onto the current row (a small "link existing agent" step:
  match by hostname, or an admin action) rather than auto-provisioning a second one. New agents auto-provision
  cleanly.
- **Coexistence is the default,** not a special mode: SpanVault runs both auth paths indefinitely; Phase 4
  decides when to stop minting new `api_key`s.

---

## Security considerations

- **Revocation is the sharp edge.** A pure signature check can't see a hub revoke; A2's NetVault-DB cross-check
  closes it at connect and A3's active-kick closes the live-session gap. Confirm SpanVault's NetVault DB role can
  `SELECT agents.revoked_at` (the bundle-sweep granted the agent tables to the read-only roles — verify the role
  SpanVault actually uses is covered).
- **Shorter TTL + refresh** (A5) shrinks the window a revoked-but-unexpired token is usable between reconnects.
- **Unsigned bundle → signed (B).** Serving the bundle unsigned is acceptable on a trusted LAN but is a
  fleet-wide RCE vector over any WAN; B is what makes the served bundle safe to auto-apply.
- **Still open, not in this phase:** plaintext `api_key` (retires with Phase 4), plaintext `ws://` +
  plaintext SNMP creds in the config push (mTLS/`wss` is the cross-cutting hardening item), and per-message
  agent↔device ownership (a pre-existing SpanVault gap, noted for its own fix).

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Auth change breaks the ~live SpanVault fleet | Accept-both (JWT-first, api_key fallback); JWT failure is transparent; roll out SpanVault side first, migrate hosts one at a time. |
| Duplicate agent rows for a migrated host | "Link existing" stamps `hub_agent_id` on the current row; auto-provision only for genuinely new agents. |
| `connectedAgents` re-key misses a call site (rotate/disable/push-config/loopback) | Audit every `connectedAgents`/`api_key`-keyed use in one pass; both paths resolve to the local `agent.id` used as the new key. |
| Self-update bricks an agent (partial swap) | Verify-before-apply + apply-on-next-start + backup/rollback; NSSM restarts into old build on failure; test the rollback path explicitly. |
| Revoked agent keeps a live data session | Connect-time NetVault-DB revocation check + hub→app active-kick fan-out on revoke. |
| Signing key handling / accidental commit | Private key offline only; embed public key; `.gitignore` + checklist (same as EOL feed). |
| Cross-repo coupling (agent in netvault, server in spanvault) | Copy the ~15-line verifier into spanvault (no shared build dep); JWT is signed with the already-shared `NEXTAUTH_SECRET`. |
| Scope creep into Phase 4 (slim page) | Hard non-goal; Phase 3 only *adds* the JWT path under the existing SpanVault page. |

---

## Installer parity

- **NetVault:** new routes `/api/agents/[id]/refresh` and `/api/agents/update-manifest` → update `.ai-codex/routes.md`
  + add to `Test-NocVault-Suite.ps1` (200 checks). `agent/update-manifest.json` ships in the bundle-served tree
  (ensure it's not in the exclude set). New scheduled tasks: none.
- **SpanVault:** the `agents` ALTERs must be in **both** SpanVault's own updater schema path **and** the shared
  suite installer (`netvault/installer/Install-NocVault-Suite.ps1` provisions all four apps) — same-change rule.
  New env: none (`NEXTAUTH_SECRET` already present suite-wide). Add a smoke check that a JWT agent can connect and
  that a revoked agent is refused.
- **Versions:** netvault app MINOR (new routes) + agent MINOR (identity + real self-update) + SpanVault MINOR
  (JWT data-plane auth). Release notes on each; commit/push per standing workflow; **never deploy from here**.

---

## Rough sequencing & effort

1. **A1–A3 (SpanVault accept-both + link + revoke).** Self-contained, ships first, zero impact on live agents.
   *Largest single chunk — the SpanVault backend change.*
2. **A4–A5 (agent identity store + JWT presentation + refresh).** The agent-side seam; smaller, but touches the
   startup sequence — test apiKey-mode and JWT-mode side by side.
3. **B1–B5 (signed self-update).** Independent of A; can run in parallel or as a "3b". Highest security value,
   moderate size (reuses the bundle routes).
4. **Tests + on-wire "no behaviour change" verification** (SpanVault config-push diff, buffered replay, fleet
   view) — the acceptance gate.

Deliverable at the end of Phase 3: **one identity per agent** — a hub-enrolled agent authenticates to SpanVault
with its hub JWT, appears once everywhere, is revocable from the hub, and can be safely self-updated from the
hub — with every existing `api_key` agent still running untouched, ready for Phase 4 to slim SpanVault's page and
add the DDIVault module onto the same contract.

## Deploy / verification notes (suite conventions)

- Docs-only until code lands; the code phase follows build/test → commit → push → **manual** updater. Never
  deploy from here.
- Verify against the demo/prod suite with the "curl answers is-it-up, DB answers is-it-correct" rule: confirm a
  JWT agent's row in `spanvault.agents` (with `hub_agent_id`), its single hub fleet entry, buffered-replay after
  an outage, revoke-kicks-the-session, and a signed self-update round-trip. Read-only DB creds per
  `[[db-readonly-access]]`.
