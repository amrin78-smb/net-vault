# NocVault Suite Agents — Architecture & Hub Design

> **Status:** Phases 1–2 **shipped** (netvault 1.25.0 / agent 2.1.1) · end-state = **federated control plane** (§6) · Phase 3+ per §7
> **Scope:** LogVault · DDIVault · SpanVault · **Hub:** NetVault (:3000) · **Reuses:** the existing SpanVault remote-agent framework.
> Rendered design doc (light/dark, diagram, UI mock): `https://claude.ai/code/artifact/ab6234a7-857c-40b4-9912-b73d082b8ceb`

Extend the SpanVault remote-agent model to LogVault and DDIVault — as a **single unified NocVault Agent**
whose **control plane** lives in the NetVault hub and whose **data plane** flows directly to each app.

> **Read §6 first for the current direction.** The original draft (§1–5) framed the hub as *the* agent
> manager. Building Phases 1–2 surfaced that SpanVault *already* has a rich operational agent console, so the
> canonical end-state is now a **federated split** (§6): the hub owns everything *about the agent*; each app
> owns everything *about what that agent collects for it*. §7 phasing is organized around reaching it.

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

## 6. Federated control plane — the end-state (who owns what)

> Added after Phases 1–2 shipped, once the overlap with SpanVault's **existing** agent console became
> concrete. This is now the canonical end-state; §7 phasing is organized around reaching it.

Phases 1–2 revealed the design question the original draft glossed over: SpanVault **already** has a mature,
operational agent console — create-agent (mints an `apiKey`), site assignment, network discovery,
adopt-device, rotate-key, disable, delete, restart, log-fetch, config-push. The hub's new fleet page overlaps
it **without replacing it**, so today there are **two agent registries that don't know about each other**: an
agent installed the SpanVault way collects data but is invisible in the hub; an agent installed the hub way
appears in the fleet page but won't collect until SpanVault also knows about it.

The end-state is **neither** "the hub swallows SpanVault's console" (that makes the hub a god-object forced to
model every app's domain) **nor** "both live forever" (permanent double-management). It is a **federated
split**:

> **The hub owns everything _about the agent_. Each app owns everything _about what that agent collects for
> it_.**

The line falls exactly on **who has the knowledge**. Identity, lifecycle, health, and the binary are
cross-cutting and app-agnostic → **hub**. Site/server/source assignment, discovery, and device-adoption are
**domain knowledge only the app has** → **app**.

| Concern | Owner | Rationale |
|---|---|---|
| Enroll · identity · revoke | **Hub** | one trust root (`NEXTAUTH_SECRET`) — shipped |
| Fleet inventory · health · offline/degraded alerting | **Hub** | the only cross-app view there is |
| Module on/off (`log`/`ddi`/`span`) | **Hub** | coarse, app-agnostic |
| Agent binary + **signed** self-update | **Hub** | one bundle, one signing key |
| Restart agent · fetch agent logs | **Hub** | about the *process*, not the domain |
| **Which sites / servers / sources to collect** | **App** | only the app models its own domain |
| Discovery · adopt device | **App** (SpanVault) | deeply span-specific — keep it where it is |
| Collection-data ingest | **App**, direct | the data-plane rule (§3) |

### The keystone: one identity
The whole split unlocks from a single change — **each app trusts the hub-signed JWT on its data-plane WS**
instead of minting its own per-app `apiKey`. The moment there is one identity, the two registries collapse
into one: a hub-enrolled agent connects to SpanVault with **no separate SpanVault key** and appears in exactly
one place. Every app already holds the shared `NEXTAUTH_SECRET` (SSO), so each can verify the hub JWT with **no
new secret**. The transition is **accept-both** (hub JWT *or* legacy `apiKey`) so existing keyed agents never
break — the app links the hub `agent_id` to its own agent record on first JWT connect.

### What happens to SpanVault's agent page
It doesn't die — it **slims**. The lifecycle half (mint apiKey, rotate-key, delete, version, restart) **moves
to the hub**. The domain half (site assignment, discovery, adopt) **stays**, reframed as *"span collection
config for hub agent X"* and keyed by the hub `agent_id`. Net: agents are enrolled / seen / revoked / updated
in **one** place (the hub); each app keeps a **focused** panel for "what should this agent collect for me."

### Single pane of glass — by navigation, not by cramming
The hub fleet page **deep-links** into each app's module-config panel (click agent → "span config" → jump to
SpanVault's panel). It *feels* like one console while each app's domain logic stays where it belongs. This is
the deliberate alternative to centralizing every app's work-plan schema in the hub.

### Build the new modules straight onto this
DDIVault / LogVault modules are built to the federated contract **from day one** — a thin domain-config panel,
**no** standalone lifecycle console. That is the payoff: we implement the agent console **once** (in the hub)
instead of three times.

---

## 7. Trust model & the data-profile caveat

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

## 8. Phasing (revised around the federated end-state)

> **Renumbered:** the original draft's Phase 3 (DDIVault) / Phase 4 (LogVault) become **Phase 4 / 5**. A new
> **Phase 3 — identity reconciliation** is inserted first, because building two more modules on top of two
> unreconciled registries (§6) would triple the duplication instead of removing it.

| Phase | Deliverable | Status |
|---|---|---|
| **1** | Extract `nocvault-agent-core` from SpanVault (transport, buffer, reconnect, heartbeat, install, self-update) + module contract; SpanVault migrates onto it, no wire change. Signed self-update = **verify-and-stage**. | ✅ **Shipped** — agent 2.0.0 |
| **2** | Hub control plane: `agent_registry` schema, enrollment/fleet API, launcher Agents page, hub-signed identity — **plus** hub bundle distribution (served installer + multi-file agent bundle) and the 4-way adversarial bug-sweep hardening. | ✅ **Shipped** — netvault 1.25.0 / agent 2.1.1 |
| **3 — Identity reconciliation (the keystone, §6)** | SpanVault **accepts the hub JWT** on its data-plane WS (**accept-both** with the legacy `apiKey`); link hub `agent_id` ↔ SpanVault's agent record so one physical agent = one entry; hub applies module on/off. **Finish signed self-update** — sign the now-served bundle + verify-before-apply on the agent (Phase 1 left it verify-and-stage). | ⬜ **Next** |
| **4 — DDIVault module + slim SpanVault page** | Build the DDIVault edge module (WinRM/scan, edge Kerberos) **to the federated contract from day one** — thin domain-config panel, no standalone console. In parallel: slim SpanVault's page to the span-config panel keyed by hub id, retire its apiKey minting + duplicate lifecycle, and give the hub restart / log-fetch. Proves the federated pattern with a 2nd module. | ⬜ |
| **5 — LogVault module** | Edge syslog receiver + Windows Event Log + disk spool + gzipped raw streaming (`sendStream`), to the same federated shape. Highest value, most work; exercises the streaming contract reserved in Phase 1. | ⬜ |
| **Cross-cutting** (ongoing, not a phase) | mTLS / pinned `wss` over WAN; offline/degraded fleet alerting; `agent_health` retention (✅ 7-day prune shipped in the bug-sweep). | — |

*(Phase 1 detail: `nocvault-agents-phase1-plan.md`, now historical. A detailed Phase 3 plan will be written
when that phase is greenlit.)*

---

## 9. Decisions

**Resolved** (post Phases 1–2):

| Decision | Resolution | Why |
|---|---|---|
| Console ownership: hub vs app | **Federated split** — hub owns lifecycle/identity/fleet/distribution; each app owns its domain work-config, deep-linked from the fleet page (§6). | Pure-hub = a god-object modelling every app's domain; pure-app = permanent double-management. |
| Agent identity per app | **One hub-signed identity; apps accept-both during transition** (Phase 3). | Per-app apiKeys = two registries + double provisioning; unifying touches each app's data-plane auth, hence the accept-both window. |
| Unified agent vs per-app | **Unified** (shipped). | One service / tunnel / upgrade per site vs three; the bigger core refactor is done. |
| Data tunnel: per-app vs hub-relayed | **Per-app direct** (shipped). | Relaying is simpler to firewall but makes NetVault carry LogVault's volume — a bottleneck & SPOF. |
| Which app first (module) | **DDIVault** (Phase 4), after reconciliation (Phase 3). | Closest to SpanVault's model; LogVault is higher-value but more build. |
| LogVault: forward-raw vs parse-at-edge | **Forward-raw.** | Consistent central parsing + thin agents; parse-at-edge offloads the central box but couples agents to parser versions. |

**Still open** (revisit at the relevant phase):

| Decision | Leaning | Trade-off |
|---|---|---|
| Signed **bundle** verification | Sign in Phase 3 (the hub already *serves* the bundle unsigned). | Unsigned-over-trusted-LAN is acceptable today; over WAN it's a fleet-wide RCE vector — must be signed before wide rollout. |
| WAN transport hardening | mTLS / pinned `wss` mandatory over any WAN (cross-cutting). | SpanVault's TLS is optional today; making it required is a per-app data-plane change. |
| Does the hub ever own domain work-config? | **No** — deep-link instead (§6). | Centralizing all three apps' work-plan schemas is the god-object trap; revisit only if navigation UX proves insufficient. |
