# Phase 4 — DDIVault module + slim SpanVault page (+ hub lifecycle ops)

> Companion to `nocvault-agents-architecture.md` (federated end-state §6). Grounded in a read of the actual
> DDIVault + SpanVault code (2026-07-28).
> **Status:** Draft plan · **Depends on:** Phase 3 (shipped: netvault 1.27.0 / agent 2.3.0 / spanvault 1.84.0).

---

## The scope split (read first)

The roadmap bundled "DDIVault module + slim SpanVault page" as one phase. Reading both codebases shows they are
**very** different sizes, so this plan splits them:

- **Phase 4a — Slim SpanVault + move agent lifecycle ops (restart / logs) to the hub.** Moderate, well
  understood, low-risk, uses only SpanVault + hub (both known well from Phase 3). Completes the reconciliation
  UX. **Buildable now.**
- **Phase 4b — DDIVault edge module + DDIVault ingest.** A **major greenfield subsystem**: DDIVault has no
  agent, no WS, no JWT verification today, and its collection is **WinRM PowerShell remoting + SMB/UNC file
  reads + ICMP ping** — all of which must run *inside the Node agent at the edge*. This is essentially "port
  DDIVault's entire collector to the edge + build a new ingest data plane," and it **cannot be meaningfully
  tested without a real Windows DHCP/DNS + AD domain.** Needs an explicit scope decision (see §4b).

---

## Phase 4a — slim SpanVault + hub restart/logs

### 4a.1 — SpanVault page: drop the dead legacy-provisioning UI (keep everything else)

Now that the hub owns identity/enrollment, three SpanVault actions are **legacy-`api_key`-only and dead for
hub-JWT agents** (which have no `api_key`) — retire them from `spanvault/frontend/src/app/(app)/agents/`:
- **New Agent** modal (`POST /api/agents` — mints `api_key` + install command). Hub enrollment replaces it.
- **Rotate key** (`POST /api/agents/:id/rotate-key`). Meaningless without an `api_key`; the hub owns JWT
  refresh.
- **Install / Reconnect panel** + `AgentInstall`/`AgentConnectWaiter` + the `api_key`/`install_command`
  exposure in `GET /api/agents/:id` (`server.js:3293`). The real installer is the hub's
  `/api/agents/install.ps1`.

**KEEP on SpanVault** (domain config it owns, needed by BOTH agent kinds): the agent roster (read-only),
**Assigned Sites** editor (`POST /api/agents/:id/sites`), **Discover / Adopt** (`/discover`, `/discovered`,
`/discovered/adopt`). Preserve the site-binding logic that `POST /api/agents` did inline — it already exists
standalone as `POST /api/agents/:id/sites`, so a slimmed page binds sites to an already-hub-provisioned agent.

**Deliberately KEEP (do NOT move/remove yet): Restart, Logs, Disable, Delete, Rename over the span WS.**
Critical reason: **legacy `api_key` agents are NOT hub-enrolled, so the hub command channel (below) cannot
reach them** — SpanVault's span-WS path is the *only* way to restart/log them. These retire from SpanVault
only once the whole fleet is hub-JWT (a later cleanup, not Phase 4).

### 4a.2 — Hub gains Restart + Logs (for hub-JWT agents) via a poll-carried command channel

The hub↔agent link is an **HTTP poll** (`core/hub.js`: 30s heartbeat, 5min policy, refresh) — there is **no
server→agent socket**, so a command must be **queued server-side and carried back in a poll response**, then
executed by the agent on the next beat. The agent already fully handles `restart` / `get_logs` in
`core/runtime.js` (`process.exit(0)` / `logger.tail(200)`) — only the delivery + return plumbing is missing.

**Hub side (NetVault):**
1. New table `agent_commands(id, agent_id, type, args jsonb, status, created_at, delivered_at, result)` in
   `netvault` schema. `type` ∈ {`restart`,`get_logs`}.
2. `POST /api/agents/[id]/commands` (super_admin) — enqueue a pending command (the hub analog of SpanVault's
   `sendToAgentId`).
3. **Extend `POST /api/agents/[id]/heartbeat`** — currently returns `{ok:true}`; also return
   `{ ok:true, commands:[{id,type,args}] }` (the agent's pending rows, marked delivered). Heartbeat (30s) is
   the carrier (more responsive than the 5min policy).
4. New `POST /api/agents/[id]/logs` (**agent-authed**, `sub===id`) — the agent POSTs its log tail here (the
   hub has no socket to receive the agent's `{type:'logs'}` push); store it (a `last_logs` column/table or an
   in-memory map). New `GET /api/agents/[id]/logs` (super_admin) for the fleet page to read.
5. Fleet page (`app/(app)/agents/page.tsx`) — add **Restart** + **Fetch logs** actions (net-new; today it has
   only Add / Rename / Revoke). Restart enqueues + toasts; Logs enqueues `get_logs`, then polls the GET (mirrors
   SpanVault's `AgentLogs` ~8s poll). Offline handling: a command to an agent whose `last_seen_at` is stale
   surfaces "agent offline" (analog of SpanVault's 409).

**Agent side (`core/hub.js` + entrypoint):**
6. `sendHeartbeat` currently ignores the 200 body — read `res.body.commands` and dispatch each. Wire the
   `runtime` (a dispatch callback) into `createHubClient` (today it's only wired into `transport.onMessage`,
   not the hub client).
7. `get_logs` return path: over the span WS, `dispatch` replies with `transport.send({type:'logs'})`. The hub
   has no socket, so a hub-delivered `get_logs` must instead `POST <hub>/api/agents/<id>/logs {lines}`. Give the
   hub command handler its own reply sink (call `logger.tail(200)` + POST) rather than `transport.send`.
   `restart` needs no return (exit + NSSM). Ack: a command is `delivered` when carried in a heartbeat response
   and `done` when the agent acks (restart: implicit next-heartbeat; logs: the log POST is the ack).

**Reuse note:** this command channel is also what a future hub-driven **disable/delete/rename** would use, and
it's forward-useful for the DDIVault/LogVault modules (any hub→agent instruction).

### 4a.3 — Versions / parity
NetVault app MINOR (new routes + fleet actions + schema), agent MINOR (command handling), SpanVault MINOR
(slimmed page + retired routes). Installer parity: the `agent_commands` table in `schema.sql` + suite installer;
smoke-test the new routes. Release notes on each.

---

## Phase 4b — DDIVault edge module (major, needs a scope decision)

### What DDIVault collection actually is (why this is big)
DDIVault's central collector (`ddivault/collector/collector.js`, NSSM `DDIVault-Collector`) polls
`ddi_servers` via **three LAN/domain-bound mechanisms**, ALL of which the edge agent must run locally:
- **WinRM PowerShell remoting** (`powershellRunner.js` — `Invoke-Command -ComputerName`) for DHCP scopes/leases/
  reservations/options and DNS zones/records/health/failover. The Node agent would shell out to `powershell.exe`.
- **SMB/UNC file reads** of the Windows DHCP audit logs (`\\SERVER\DHCPLogs\...`, `dhcpReader.js`) — a *second*
  reachability dependency, easy to miss.
- **ICMP ping sweep** for IPAM (`ipamScanner.js`, forked `scanWorker.js`) — **API-triggered on demand**, not on
  the timer loop, so the agent must handle on-demand scan requests too.

Auth: `ddi_servers.auth_mode` ∈ {`kerberos` (default, assumes domain-join), `credential` (stored
`ps_username`/`ps_password`, **AES-256-GCM encrypted**, key = sha256(`NEXTAUTH_SECRET`)), `local`}. The whole
reason for the edge agent is that a central host cannot be domain-joined to every remote forest — so the agent
runs as a domain-joined service AT the site and uses local Kerberos, or carries decrypted `credential`-mode
creds over the authenticated channel.

### What Phase 4b must build (greenfield on the DDIVault side)
1. **DDIVault ingest data plane** — a new WS ingest server in `ddivault/api/` (Express, port 3007 is the API;
   the agent-WS port is **unassigned** — pick one, e.g. 3011 — and wire firewall + `PORT_MAP`).
2. **Hub-JWT verification** — DDIVault has **no `jsonwebtoken`** and does zero signature verification today
   (it trusts `x-ddi-actor*` headers from Next middleware). Add JWT verify (port SpanVault's
   `agent-identity.js` — HS256 + `NEXTAUTH_SECRET`), + a revocation cross-check against the NetVault DB
   (DDIVault already reads it for RBAC). Accept-both isn't needed (no legacy DDI agents) — JWT only.
3. **Agent↔server assignment** — DDIVault has only `site_id` scoping, **no per-collector ownership**. Add the
   concept (agent registered for a site → owns that site's `ddi_servers`/`ipam_subnets`, or an explicit
   assignment table). The ingest maps an agent's payload → the right `ddi_servers.id`.
4. **The `ddi` agent module** (`netvault/agent/modules/ddi/`) — ports the collector's WinRM/SMB/ICMP logic to
   run at the edge and ship raw results, built to the module contract (`ctx.send`, `ctx.onMessage` for the
   server-pushed plan + on-demand scan). This is the bulk: `powershellRunner`, `dhcpReader`, `dnsMonitor`,
   `haMonitor`, `ipamScanner` equivalents, running under Node on the edge host.
5. **DDIVault-side write path** — the ingest runs essentially the collector's existing UPSERT bodies
   (`collectScopeStats`, `syncLeases`, `syncDns`, …) keyed on `server_id`, so the central write logic is
   reusable; the collector's poll of an agent-owned server is skipped (the agent owns it).
6. **DDIVault domain-config panel** — a thin page (federated model): assign which `ddi_servers`/subnets an
   agent collects (keyed by hub agent id), deep-linked from the hub fleet page. No standalone agent console.
7. **Installer/port/firewall wiring** — `Update-DDIVault.ps1` + suite installer + smoke test + the agent's
   ddi-module deps.

### The testability problem (the reason for a staged approach)
WinRM/SMB/ICMP collection **cannot be unit-tested** without a real Windows DHCP/DNS server + AD domain. Building
the full collection port in one blind pass and shipping it untested is high-risk. **Recommended staging:**
- **4b-1 (plumbing, testable):** the DDIVault ingest WS + JWT accept + revocation + agent↔server assignment
  schema/UI + the `ddi` module *skeleton* (connects, receives its assigned-server plan, ships a trivial
  heartbeat/probe). Provable end-to-end (enroll → connect to DDIVault → get assigned servers) **without** a
  Windows domain. Establishes the whole data plane.
- **4b-2 (collection, validated incrementally):** port the WinRM/SMB/ICMP mechanisms one at a time (start with
  the simplest WinRM read, e.g. DNS zones or scope stats), each validated against a real DDIVault server as it
  lands. This is where the domain test environment is needed.

---

## Sequencing & recommendation
1. **Build 4a now** — it's the natural completion of Phase 3, low-risk, and the command channel it adds is
   reused by everything after.
2. **Then 4b, staged** — 4b-1 (plumbing) is a self-contained, testable milestone; 4b-2 (WinRM collection) is
   the large, domain-dependent part best done incrementally against a real DDIVault server.
3. Full adversarial **bug sweep after each build** (per standing request).

## Out of scope (Phase 5)
LogVault module (edge syslog + Event Log + streaming `sendStream`) — after DDIVault proves the federated module
pattern with a second app.
