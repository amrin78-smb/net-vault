# NocVault Suite Agents — Architecture & Hub Design

> **Status:** Draft for review · **Scope:** LogVault · DDIVault · SpanVault · **Hub:** NetVault (:3000)
> **Reuses:** the existing SpanVault remote-agent framework.
> Rendered design doc (light/dark, diagram, UI mock): `https://claude.ai/code/artifact/ab6234a7-857c-40b4-9912-b73d082b8ceb`

Extend the SpanVault remote-agent model to LogVault and DDIVault — as a **single unified NocVault Agent**
whose **control plane** lives in the NetVault hub and whose **data plane** flows directly to each app.

---

## 1. The decision, up front

**A single "NocVault Agent" installed once per remote site**, with pluggable modules (`log` / `ddi` / `span`)
you toggle per agent. It is **hosted, enrolled, and managed by NetVault (the hub)** and installed from the
**launcher** — but its telemetry goes **directly to each app**, never through the hub.

- **Control plane → NetVault.** Distribution, enrollment, identity, policy, health, and signed self-update all
  live in the hub. The launcher is the front door.
- **Data plane → each app.** Logs/metrics stream agent → LogVault / DDIVault / SpanVault ingest directly. The
  hub carries only low-volume control traffic and is never a bottleneck or a single point of failure for data.
- **Thin agent, central intelligence.** Like SpanVault today: the server drives the work, the agent runs it
  locally and ships *raw*; all parsing stays central.
- **Build on what exists.** Extract SpanVault's proven transport / offline-buffer / installer / self-update into
  a shared core; add per-app modules on top.

---

## 2. Why each app wants an agent (a different job each time)

"Agents like SpanVault" means something different per app, because each solves a different **reachability**
problem. SpanVault reaches out to poll; LogVault is pushed to; DDIVault reaches out via WinRM. The agent puts
the collection *in the right place*.

| App | Central model today | What the agent unlocks | Agent workload at the edge |
|---|---|---|---|
| **SpanVault** *(exists)* | Server polls out (SNMP / ICMP) | Segments the central server can't route to | Local SNMP walks + ICMP, ship raw varbinds |
| **DDIVault** *(closest fit)* | Server reaches out via **WinRM** + IPAM ping-sweeps | Remote **domains & subnets** WinRM/scans can't cross — incl. **native Kerberos** in the remote forest (no cross-WAN stored creds) | Run DHCP/DNS WinRM polls + subnet scans **locally**, ship results |
| **LogVault** *(highest value)* | Devices **push** syslog to it (UDP/TCP 514) | WAN reliability, one encrypted tunnel vs cleartext 514, NAT — **and new sources**: Windows Event Log, flat files | Local syslog concentrator (store-and-forward) + host-log collection, forward **raw** |

DDIVault is nearly a straight copy of SpanVault's "server pushes a poll-plan → agent runs it → ships results."
LogVault is the architecturally distinct one — and the most valuable, because it also grows LogVault past
network-device syslog toward real endpoint/server log coverage.

---

## 3. Control plane vs data plane

The single most important structural choice. Management is centralized in the hub; telemetry is not.

```
                        ┌─────────────────────────────────────────────┐
   CONTROL PLANE  ▸      │  NetVault Hub  :3000 · wss                   │
   (low volume)          │  distribution · enrollment tokens ·         │
                         │  signed identity · module/site policy ·     │
                         │  fleet health · signed self-update          │
                         └─────────────────────────────────────────────┘
                                          ▲  enroll · identity · policy ·
                                          │  heartbeat · update   (control)
                                          ▼
                         ┌─────────────────────────────────────────────┐
   EDGE (one per site) ▸ │  NocVault Agent   NSSM service · dials out   │
                         │  thin: disk buffer · backoff · ships raw     │
                         │  runs only assigned modules:                 │
                         │   [ log: syslog+winlog ] [ ddi: winrm+scan ] │
                         │   [ span: snmp+icmp ]                        │
                         └─────────────────────────────────────────────┘
                              │              │                │
       telemetry — direct,    ▼              ▼                ▼   (data)
       hub-signed token   ┌────────┐    ┌────────┐      ┌──────────┐
                          │LogVault│    │DDIVault│      │ SpanVault│
                          │:3004 ws│    │:3006 ws│      │:3010 ws  │
                          │ (new)  │    │ (new)  │      │ (exists) │
                          └────────┘    └────────┘      └──────────┘
   raw syslog / Win events   DHCP/DNS/IPAM scan results     SNMP/ICMP batches
   → central parse+hashchain → same tables as its collector → today's pipeline
```

**If the hub is down, existing agents keep streaming data fine — only *new* enrollments pause.**

---

## 4. Hosting & the install flow

NetVault is already the hub of record — SSO, users, per-user app-access, the launcher, the suite installer, the
bundled `nssm`. A suite-wide agent belongs to the hub, not to a satellite (a LogVault agent must not depend on
SpanVault being up to enroll). The unified agent is **one versioned artifact** the hub distributes and
self-updates — not three.

1. **Launcher → Agents → "Add agent"** (super_admin). The hub mints a one-time enrollment token and shows a
   one-line install command.
2. **Run it on the remote host.** The installer pulls the agent bundle from NetVault and registers the NSSM
   service — no inbound firewall rule needed (the agent dials out).
3. **Agent enrolls to the hub** with the token, submits host facts, and receives a **per-agent signed identity**
   plus its module/site assignment.
4. **Agent opens direct `wss` tunnels** to just the apps it was assigned, presenting the hub-signed token — and
   starts collecting.

---

## 5. Hub-side pieces, concretely

### 5a. Enrollment & fleet API — lives in NetVault (`app/api/agents/*`)

Control traffic only. Data never touches these routes.

| Method · Path | Caller / Auth | Purpose |
|---|---|---|
| `POST /api/agents/enroll-tokens` | super_admin | Mint a one-time enrollment token (+ site/module preset). Returns the install one-liner. |
| `POST /api/agents/enroll` | token-authed (public) | Agent redeems token + host facts → issues `agent_id`, signed identity, initial policy. |
| `POST /api/agents/:id/heartbeat` | agent identity | Health, version, per-module status, buffer depth. Drives the fleet view. |
| `GET /api/agents/:id/policy` | agent identity | Module assignment + per-module work-plan (which servers/subnets/ports). |
| `GET /api/agents/update?v=` | agent identity | Advertise newest **signed** agent bundle; agent verifies signature before applying. |
| `GET /api/agents` | super_admin | Fleet list for the launcher page. |
| `POST /api/agents/:id/revoke` | super_admin | Revoke identity; agent's tunnels are refused suite-wide on next connect. |

```jsonc
// POST /api/agents/enroll  (Authorization: Bearer <one-time-token>)
{ "hostname": "tus-branch-01", "os": "Windows Server 2022",
  "agent_version": "1.0.0", "local_ip": "10.40.2.11" }

// 200 → hub issues a durable identity + the modules an admin pre-assigned
{ "agent_id": "agt_7f3c…",
  "identity": { "jwt": "<hub-signed, aud=[logvault,ddivault]>", "expires": "…" },
  "modules": [
    { "app": "logvault", "ingest": "wss://hq:3004/agent",
      "config": { "listen": ["udp/514","tcp/1514"], "winlog": true } },
    { "app": "ddivault", "ingest": "wss://hq:3006/agent",
      "config": { "auth": "kerberos", "servers": ["dc01","dhcp02"] } }
  ] }
```

### 5b. `agent_registry` schema — in the **netvault** DB

The hub owns the canonical registry. Each app keeps its own ingest tables; it only needs to *verify* a
hub-signed identity, not store fleet state.

```sql
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,            -- agt_… (opaque)
  name          TEXT NOT NULL,
  hostname      TEXT,  os TEXT,  local_ip TEXT,
  site_id       INT,                          -- netvault.sites — scopes RBAC + data
  status        TEXT DEFAULT 'pending',       -- pending|online|degraded|offline|revoked
  agent_version TEXT,
  cert_fpr      TEXT,                          -- pinned identity fingerprint
  enrolled_at   TIMESTAMPTZ,  last_seen_at TIMESTAMPTZ,
  created_by    INT,  revoked_at TIMESTAMPTZ
);

CREATE TABLE agent_enrollment_tokens (
  token_hash    TEXT PRIMARY KEY,             -- store the hash, never the token
  created_by    INT,  created_at TIMESTAMPTZ,  expires_at TIMESTAMPTZ,
  preset        JSONB,                         -- {site_id, modules:[…]} applied on redeem
  used_at       TIMESTAMPTZ,  used_by TEXT REFERENCES agents(id)
);

CREATE TABLE agent_modules (
  agent_id      TEXT REFERENCES agents(id) ON DELETE CASCADE,
  app           TEXT NOT NULL,                -- 'logvault' | 'ddivault' | 'spanvault'
  enabled       BOOLEAN DEFAULT true,
  config        JSONB DEFAULT '{}',           -- module work-plan (servers, subnets, ports…)
  PRIMARY KEY (agent_id, app)
);

CREATE TABLE agent_health (                    -- small rolling history for the fleet view
  agent_id      TEXT REFERENCES agents(id) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL,
  cpu_pct       REAL,  mem_pct REAL,  buffer_depth INT,
  module_status JSONB                          -- {logvault:'ok', ddivault:'auth_error', …}
);
```

### 5c. Launcher "Agents" page — the fleet view + enrollment

A new super_admin section in the NetVault launcher. State is encoded in form, not just number — a status dot,
coloured module chips, an offline row that reads at a glance.

- **Fleet table:** Agent (name / IP / OS) · Site · Status (online/degraded/offline pill) · Modules (log/ddi/span
  chips) · Version · Last seen · Buffer depth.
- **Add agent:** generate one-time token → show install one-liner → pick Site + Modules (checkboxes) → run on host.
- A **degraded** row = connected but a module is erroring (e.g. `ddi · auth_error`); an **offline** row shows a
  growing buffer depth (edge is spooling; nothing lost yet).

---

## 6. Trust model & the data-profile caveat

### Trust — a new boundary to get right
An agent holds a persistent tunnel *into* your servers and local infra creds. Non-negotiables:

- **Enroll → per-agent identity** (keypair/cert), revocable — not a forever-static bearer.
- **mTLS / pinned `wss`** mandatory over any WAN (SpanVault's optional TLS becomes required).
- **Hub signs, apps verify** via the suite's shared `NEXTAUTH_SECRET` — the same trust SSO already uses. No app
  runs its own enrollment.
- **Signed self-update.** Today's update downloads & runs `agent.js`; unsigned, that's fleet-wide RCE. Add
  signature verification (harden SpanVault too).
- **Least privilege + no central creds at the edge** (DDIVault edge uses local Kerberos).

### Data profile — two shapes, one core
SpanVault/DDIVault ship **small periodic results**; today's JSON-over-WS is fine. LogVault is a **high-volume
stream** (bursty thousands/sec) and needs more:

- Disk-backed **spool at the edge** (mirror LogVault's server-side spool) — WAN outage ≠ log loss.
- **Batched + gzipped** frames with backpressure, not naive per-event sends.
- **Forward raw, parse central** — agents never carry parser versions; the tamper hash-chain is built once, on
  receipt.

So the shared core needs a **streaming module contract**, not only the periodic-batch one SpanVault uses today.

---

## 7. Suggested phasing

| Phase | Deliverable | Why this order |
|---|---|---|
| **1** | Extract `nocvault-agent-core` from SpanVault (transport, buffer, reconnect, heartbeat, install, self-update) + **signed update**; define the module contract; SpanVault migrates onto it — no behaviour change. | Everything else stands on this; also fixes SpanVault's update-signing gap. |
| **2** | **Hub control plane**: `agent_registry` schema, enrollment/fleet API, launcher Agents page, per-agent signed identity + mTLS enrollment. | Turns the core into a managed fleet. |
| **3** | **DDIVault module** — server pushes poll-plan → agent runs WinRM/scan locally (edge Kerberos) → DDIVault ingest. | Highest reuse, closest to SpanVault's model; proves the multi-app path end-to-end. |
| **4** | **LogVault module** — edge syslog receiver + Windows Event Log + disk spool + gzipped raw forward → central parse. | Highest value, most work; needs the streaming contract from Phase 1. |

*(See `nocvault-agents-phase1-plan.md` for the detailed Phase 1 scope.)*

---

## 8. Open decisions

| Decision | Recommendation | Trade-off |
|---|---|---|
| Unified agent vs per-app | **Unified.** | One service/tunnel/upgrade per site vs three; bigger core refactor up front. |
| LogVault: forward-raw vs parse-at-edge | **Forward-raw.** | Consistent parsing, thin agents; parse-at-edge offloads the central box but couples agents to parser versions. |
| Which app first | **DDIVault.** | Cleaner win, closest to SpanVault; LogVault is higher-value but more build. |
| Data tunnel: per-app vs hub-relayed | **Per-app direct.** | Simpler to firewall if relayed, but that makes NetVault carry LogVault's volume — a bottleneck & SPOF. |
