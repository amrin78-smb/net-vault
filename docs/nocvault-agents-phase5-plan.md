# Phase 5 — LogVault agent module: CONSIDERED and DEFERRED

> **Status: DEFERRED (decided 2026-07-28).** The NocVault Agents initiative is considered **complete at
> SpanVault + DDIVault**. A LogVault agent module was scoped in full (both codebases mapped) and then
> deliberately not built. This doc records the reasoning + the design, so it can be picked up if a concrete
> need appears. There is **no `log`/`logvault` agent module, no LogVault ingest, and no `log` entry in
> PORT_MAP** — those placeholders were removed.

---

## Why deferred (the honest assessment)

The SpanVault and DDIVault agents solve reachability problems with **no clean alternative**: you cannot poll
SNMP (SpanVault) or WinRM/SMB (DDIVault) across a segment the central server can't reach — you need code
running locally. They clearly earn their keep.

**LogVault is different: syslog is already push-based.** Devices send *to* LogVault; it never reaches out. So
the "remote site can't reach central LogVault" problem has a mature, 20-year-old, off-the-shelf answer — a
**syslog relay/forwarder** (rsyslog / nxlog / syslog-ng) at the site, pointed at LogVault. Building a bespoke
high-volume syslog-receiver + streaming subsystem into the NocVault agent is **partly reinventing rsyslog**,
and it is the **biggest and riskiest** module to build (see "What it would take" below).

What a LogVault agent *would* add over "just point nxlog at LogVault":
- **Windows Event Log collection** — the one genuinely new capability LogVault lacks today. (But even this is
  achievable off-the-shelf: NXLog/Winlogbeat forwarding to LogVault, whose `parsers/windows.js` already
  normalizes Snare/NXLog/Winlogbeat formats.)
- **Store-and-forward** reliability over a flaky WAN (better than plain UDP relay).
- **One unified hub-managed agent per site** — the initiative's thesis. This is the strongest argument: if a
  site already runs a span or ddi agent, adding `log` means one enrolled agent collects everything.

**Verdict:** as a standalone feature it's marginal (the reachability case is solved by standard relays); as a
third module on an agent a site already runs, it's reasonable incremental value. Not worth the largest, riskiest
build in the initiative without a concrete customer need. **Revisit** if a customer specifically wants managed
remote-syslog store-and-forward + Windows Event Log delivered as one hub-managed agent.

---

## What it would take (preserved design, if revisited)

Grounded in a 2026-07-28 read of both codebases. Two pieces are **net-new** (they don't exist today):

1. **Real streaming in the agent core.** `sendStream` was only ever a comment — `ctx` exposes `send` only (one
   `JSON.stringify` WS write per message, no batching/gzip/backpressure), and `core/buffer.js` is a 500-item
   array rewritten whole on every push (fine for periodic results, catastrophic for a syslog firehose). A
   streaming path (`core/stream.js`: batch + gzip + `ws.bufferedAmount` backpressure) + a rotating fsync'd
   high-volume disk spool (`core/spool.js`, replay-on-reconnect, ack-cursored) would both be net-new.
2. **An edge receiver (listen, not dial-out).** The module would bind UDP/TCP 514+1514 (`dgram`/`net`,
   portable from `logvault/collector/collector.js:1308-1357`) to catch the site's device syslog, plus a
   Windows Event Log collector (`Get-WinEvent` via the ddi module's `execFile` template, forwarded as
   Winlogbeat-JSON so `parsers/windows.js` parses it with zero new parser work — low volume, uses `send`).

**The decisive constraint:** LogVault's tamper hash-chain is a **single-writer, in-process, stateful** HMAC
chain built per-message on receipt in the **collector** (`collector.js` `lastHash` global). The agent ships
*raw*, so the central chain must be built by that one writer — therefore the LogVault agent-ingest WS must live
**inside the LogVault-Collector process** (calling its existing `processMessage(raw, sourceIp)` → `enqueue`),
**never** the Express API (a second writer forks the chain and breaks `verify-integrity.js`).

Other decisions that were settled: agent-ingest **port 3014** (3004 is LogVault's public frontend); per-device
attribution by forwarding each log's **original source IP** (→ `known_hosts.site_id`); a **third `log`
transport** replicating the Phase-4b ddi multi-transport block (JWT-mode-only); LogVault verifies the hub JWT
(add `jsonwebtoken` + `NEXTAUTH_SECRET` to the collector env + a `netvault.agents` cross-DB grant); a thin
read-only **roster** page (no server-assignment — LogVault is a passive receiver); installer parity for the new
port/env/grant. Full detail is in this file's git history (the pre-deferral revision).

---

## Out of scope now
The agents initiative ships **span + ddi**. LogVault continues to receive syslog directly / via standard
relays; Windows Event Log continues to be available via NXLog/Winlogbeat forwarding. No agent code references
LogVault.
