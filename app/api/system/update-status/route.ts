import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import pkg from '../../../../package.json'
import { findGitRoot } from '@/lib/gitRoot'

export const dynamic = 'force-dynamic'

const execFileP = promisify(execFile)
// Disable git's interactive credential prompt so an auth-required remote fails
// fast (returns null / falls back) instead of blocking on a hidden prompt.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

// Short git commit hash for the deployed checkout, or null if git is
// unavailable (e.g. a non-git on-prem deploy). Update detection degrades
// gracefully to "up to date" when this is null.
function localCommitHash(repoRoot: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 })
      .trim().slice(0, 7)
  } catch {
    return null
  }
}

// Short git commit hash for origin/main via the git transport (`git ls-remote`),
// which works from the server's egress even where GitHub's web APIs are
// per-IP rate-limited (raw.githubusercontent 429 / api.github.com timeouts).
// Returns the first 7 chars, or null on any failure — update detection degrades
// gracefully to "up to date" when this is null. Async (execFile) so the network
// git I/O does not block the Node event loop.
async function remoteCommitHash(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['ls-remote', 'origin', 'main'], {
      cwd: repoRoot,
      timeout: 10000,
      encoding: 'utf8',
      env: GIT_ENV,
    })
    const token = stdout.trim().split(/\s+/)[0]
    return token ? token.slice(0, 7) : null
  } catch {
    return null
  }
}

// Read the package.json version on origin/main via the git transport. Only call
// this when the remote hash differs from local (an update is available), so the
// fetch cost is paid only when there's something new. Falls back to the local
// pkg.version on any failure. Async (execFile) so the network fetch does not
// block the Node event loop. Reads FETCH_HEAD (the ref just fetched) rather than
// origin/main, which can be a stale local tracking ref.
async function remoteVersion(repoRoot: string): Promise<string> {
  try {
    await execFileP('git', ['fetch', '--quiet', 'origin', 'main'], {
      cwd: repoRoot,
      timeout: 20000,
      env: GIT_ENV,
    })
    const { stdout } = await execFileP('git', ['show', 'FETCH_HEAD:package.json'], {
      cwd: repoRoot,
      timeout: 10000,
      encoding: 'utf8',
      env: GIT_ENV,
    })
    return JSON.parse(stdout).version || pkg.version
  } catch {
    return pkg.version
  }
}

// Hardcoded structured release notes, keyed by version. When bumping the
// version, add a matching entry with 3-5 bullets. There is no CHANGELOG.md —
// release notes live here only.
const releaseNotes: Record<string, string[]> = {
  '1.29.7': [
    'You can now permanently delete an agent from the fleet. A revoked agent previously stayed in the list forever with no way to remove it. Expand a revoked agent and use "Delete agent" — it clears the agent from the hub AND from the apps it reported to (SpanVault), so no leftover entry is stranded behind.',
    'Delete is deliberately offered only AFTER an agent is revoked. Deleting a still-live agent would not really remove it: the agent keeps running and re-registers itself the next time it connects, so the entry would silently reappear. Revoking first invalidates its identity across the suite, which makes the delete stick. Deleting an agent does NOT uninstall the agent software on the remote host — if that host is still running it, uninstall it there too or it will keep trying to connect and being refused.',
    'Deleting an agent is now done from NetVault only, since NetVault owns agent identity. SpanVault\'s own Delete button is disabled for hub-managed agents (with a note pointing here), the same way Restart and Fetch logs already were. Legacy agents that were never enrolled through the hub are unaffected and are still deleted from SpanVault.',
  ],
  '1.29.6': [
    'Fixed: the modules you pick when enrolling an agent never actually reached the agent. The enrollment recorded them on the hub (so the Agents page showed, for example, both DDIVault and SpanVault enabled with working toggles), but the installer wrote a config file containing only the hub URL and the enrollment token — and the agent decides which modules to load from that file alone. So a DDIVault-enabled agent only ever ran SpanVault collection, reported only SpanVault in its health, and never connected to DDIVault, leaving DDIVault\'s Remote Agents page permanently empty with no error anywhere.',
    'The minted install command now carries the chosen modules through to the agent\'s config, so enrolling an agent with DDIVault selected genuinely starts its DDIVault collection. EXISTING agents are unaffected until re-installed with a freshly minted command — their config file is already written.',
    'Note this only closes the enrollment-time gap. Toggling a module on the fleet page after enrollment still does not reconfigure a running agent (hub policy is fetched by the agent but not yet applied) — that remains outstanding.',
  ],
  '1.29.5': [
    'EOL matching fix: the rule that strips Cisco product-ID prefixes (WS-C3750X → 3750X, AIR-AP1242 → 1242) was not anchored to Cisco, so ANY vendor\'s model spelled with the same leading letters was silently mangled into a different matching key — "air-fiber-5XHD" became "fiber-5xhd", "ws-comm-panel" became "omm-panel" — which could false-match an unrelated Cisco EOL entry and stamp the wrong end-of-support date onto a device. The rule now requires a digit after the prefix, which is what actually distinguishes a Cisco PID from an ordinary product name. Verified byte-for-byte identical on all 14,277 current feed model strings and all 82 matching devices in the live inventory, so no existing match changes and no resync is needed.',
    'Security hardening: the three internal scheduled-task endpoints (EOL feed sync, EOL enrichment, daily health snapshot) compared their shared CRON_SECRET with a plain string equality, which short-circuits on the first wrong byte and leaks — through response timing — how much of the secret a caller got right. All three now use a single constant-time check (lib/cronAuth.ts) that also fails closed when the secret is unset.',
    'Device form: "Technical debt" is a value NetVault calculates from lifecycle status, device status and device type — but it was rendered as an editable text box, so anything typed into it was silently thrown away on every save. It is now a read-only computed display that updates live as you change those three fields, with a note explaining how it is derived.',
  ],
  '1.29.4': [
    'Security fix: an adversarial audit of the Agents subsystem found the public, unauthenticated POST /api/agents/enroll (token-authed, no session) had NO rate limiting or lockout — an attacker could hammer it to brute-force the sha256-hashed one-time enrollment token or simply DoS it with junk requests. It now enforces a per-source-IP limit (10 attempts / 10 minutes, in-memory fixed window, 429 + Retry-After beyond that) before touching the DB or burning a token. Fails open by design — a bug in the limiter itself can never block a legitimate enrollment.',
    'Corrected two stale claims in docs/nocvault-agents-architecture.md left over from an earlier phase: the signed self-update work (Ed25519-signed release manifest, verify-before-download, crash-safe staged apply with automatic rollback) was marked "Next" in the phasing table and "leaning: sign in Phase 3" in the open-decisions table, but has actually been fully shipped since 1.27.0 / agent 2.3.0. No code change — the doc now matches the already-shipped behavior.',
  ],
  '1.29.3': [
    'Final bug-sweep hardening (agent 2.5.3) — a two-reviewer adversarial pass over the whole agent stack found no brick/crash/regression; these are the low-severity items it did surface, all fixed. The DDIVault agent\'s on-demand subnet scan now counts against the same collection-process cap as the pollers, so a "scan all subnets" action can no longer storm an edge host with PowerShell processes.',
    'Agent robustness: a reconfigure can no longer briefly double-poll one server; the result-buffer flush is now exception-guarded so a bad payload or mid-flush socket error can\'t crash the agent; and an enabled-but-not-yet-enrolled DDIVault plane now reports "disabled:not-enrolled" instead of falsely showing healthy.',
    'Fleet page: an agent carrying only an unknown/legacy module slug now shows "none" instead of a blank Modules cell, and stays visible in the detail panel. Enrolling an agent whose module preset contains no valid modules is now rejected loudly (400) instead of silently creating an online-but-inert agent.',
    'Housekeeping: corrected the codebase index (agent identity token TTL is 7 days) and dropped stale LogVault examples from schema comments; added a pre-release smoke-test note to the agent signer so a load-broken self-update build is caught before signing.',
  ],
  '1.29.2': [
    'Cleanup — the NocVault Agents initiative is now considered complete at SpanVault + DDIVault. A LogVault agent module was scoped in detail and deliberately DEFERRED: unlike SNMP/WinRM (which genuinely need a local collector to reach isolated segments), syslog is already push-based, so the "remote site can\'t reach central LogVault" case is solved by standard syslog relays (rsyslog/nxlog) pointed at LogVault. The agent\'s unique value (Windows Event Log, store-and-forward, one unified agent per site) didn\'t justify the largest/riskiest build without a concrete need.',
    'Removed the leftover LogVault agent-module placeholders accordingly: the Agents fleet page no longer offers a "LogVault" module when enrolling an agent (only SpanVault + DDIVault), and PORT_MAP / the module allow-list drop the log entry. No functional agent behaviour changes — the log module never existed. The reasoning + the full considered design are preserved in docs/nocvault-agents-phase5-plan.md. (Agent 2.5.2.)',
  ],
  '1.29.1': [
    'Phase 4 bug-sweep hardening (agent 2.5.1). The DDIVault agent module no longer places WinRM credentials on the process command line (they went via a temp script + env var now), caps how many collection processes run at once and never lets a slow poll stack, and re-reads DHCP events each cycle so a dropped frame can\'t silently lose events.',
    'Fixed a heartbeat regression: a span+ddi agent now reports each app ITS OWN device count (SpanVault\'s agent view was being inflated by DDIVault\'s servers, and vice-versa). The DDIVault module is also now gated to hub-enrolled agents only (a legacy key-based agent can\'t misfire the ddi data path).',
    'Robustness: the agent\'s heartbeat is now guarded so a module error can never crash the agent; hub commands are de-duplicated agent-side; and the agent_commands queue is pruned (was accumulating rows forever). The suite installer sets the DDIVault agent-WS env so the ingest starts on the trusted-LAN default.',
  ],
  '1.29.0': [
    'NocVault Agents — Phase 4b: the unified agent gains a DDIVault (ddi) collection module, so one agent can now collect for both SpanVault and DDIVault at a remote site. When an agent is assigned the ddi module it runs DDIVault\'s DHCP/DNS/IPAM edge collection (WinRM + DHCP-log + ICMP) locally and ships raw results to DDIVault\'s new agent ingest — the hub just wires the identity + the ingest port (ddi now maps to 3011, no longer a placeholder). (Agent 2.5.0.)',
    'A span+ddi agent uses one hub-issued identity but a separate data-plane connection per app (SpanVault and DDIVault are different ingest endpoints); the ddi module and its collection are additive — a span-only agent is unchanged. The DDIVault-side ingest, assignment UI, and installer wiring ship as DDIVault 1.24.0.',
    'This completes Phase 4 (4a hub Restart/Logs + slim SpanVault; 4b the DDIVault module). Note: DDIVault\'s WinRM edge collection can only be fully validated against a real Windows DHCP/DNS + AD domain, so it is shipped for on-box validation.',
  ],
  '1.28.0': [
    'NocVault Agents — Phase 4a: the hub Agents (fleet) page can now Restart a hub-enrolled agent and Fetch its recent logs, remotely. Because the hub reaches agents over a periodic check-in (not a live connection), a Restart or Fetch-logs is queued and the agent carries it out on its next check-in (~30s); the fleet page shows the returned log tail once it arrives, and warns if the agent is offline (the action stays queued until it reconnects).',
    'Under the hood: a new agent_commands queue + POST /api/agents/[id]/commands (super_admin) enqueues a restart/get_logs; the agent heartbeat response now carries any pending commands (claimed exactly-once); the agent runs them and, for logs, POSTs its tail back to a new agent-authed POST /api/agents/[id]/logs (the hub has no socket to receive a push), which the fleet page reads via GET /api/agents/[id]/logs. (Agent 2.4.0.)',
    'This command channel is the general hub->agent instruction path the DDIVault/LogVault agent modules will reuse. SpanVault\'s own agent page was slimmed in the same release (see SpanVault 1.85.0): its legacy per-app "add agent"/rotate-key/install-command UI is retired now that agents are enrolled centrally from this hub.',
  ],
  '1.27.0': [
    'NocVault Agents — Phase 3 Workstream B: agents can now self-update from the hub with full cryptographic verification. The hub serves a signed release manifest (Ed25519) listing every agent file and its hash; an agent checks the signature AND re-hashes every downloaded file BEFORE it touches anything on disk, so a tampered or partial build can never run. This closes the previous unsigned-update risk (where anything that could answer the update URL could push code to the fleet).',
    'The update is applied crash-safely: verified files are staged, then swapped in on the next restart with the previous build backed up first — and if the new build fails to start (crash-loops), the agent automatically rolls back to the previous version. The rollback gate runs before any replaceable module loads, so even a new build with a startup error self-heals rather than bricking.',
    'Self-update is driven from the hub control channel (the same policy heartbeat), reusing the agent bundle-distribution endpoints already built — no new download path — and only affects hub-enrolled agents. New public route GET /api/agents/update-manifest serves the signed manifest (the raw files come from the existing /api/agents/bundle route).',
    'Release signing: the agent signing keypair is generated (Ed25519); the private key is kept off the repo (git-ignored) and the public key is embedded in the agent. A committed, signed agent/update-manifest.json ships with each agent release — regenerated with scripts/sign-agent.js whenever agent code changes. (Agent 2.3.0.)',
  ],
  '1.26.0': [
    'NocVault Agents — Phase 3 (identity reconciliation): the suite now uses ONE identity per agent. An agent enrolled at the hub presents its hub-signed identity directly to SpanVault\'s collection channel, so the two separate agent registries (the hub fleet and SpanVault\'s own) collapse into a single agent that appears in one place. Existing SpanVault agents that use their old API key keep working unchanged (accept-both), so this rolls out with no disruption to the live fleet.',
    'Agent identities now auto-renew: a new hub endpoint re-issues an agent\'s identity before it expires (the default identity lifetime was also shortened from 30 to 7 days now that renewal is automatic), so a long-running agent\'s data channel never dies at the token expiry.',
    'Revoking an agent now takes effect immediately: in addition to refusing the agent on its next connect, the hub actively signals the relevant app to drop the agent\'s live session on revoke (SpanVault today; LogVault/DDIVault as those data planes ship).',
    'Under the hood: the shared agent (agent 2.2.0) gained a single identity store both the hub channel and the data path read from, the data path presents the hub JWT and dials the hub-advertised ingest URL, and a fully hub-managed agent now needs only a hub URL + enrollment token in its config. Verified end-to-end with the agent test suite and a clean build.',
  ],
  '1.25.1': [
    'Fixed an in-app updater failure seen on the demo server (and possible on any box in certain Windows configurations): after the update had already built, applied the schema, and come up healthy, the step that registers the recurring maintenance scheduled tasks (daily health snapshot, daily EOL enrichment, weekly EOL feed-sync) could fail with "No mapping between account names and security IDs was done" — a Windows account-name→SID resolution error. Because that step runs after the health check, the failure was mislabeled as a health-check failure and escalated an already-successful update into the CRITICAL "update failed / rollback also failed" banner, even though the app was actually running fine on the new version. (This is why manual updates and the production server were unaffected — the failure only occurs under the in-app updater\'s SYSTEM context on certain machines.)',
    'The scheduled tasks are now registered with an explicit Local SYSTEM principal via the fixed well-known SID (S-1-5-18) instead of relying on the ambient account name, so registration no longer depends on name→SID resolution and works across Windows editions/locales — and the tasks now correctly run unattended (whether or not a user is logged on).',
    'Task registration is now non-fatal: a hiccup registering a maintenance task can no longer fail an otherwise-healthy update (or abort a fresh install) or trigger a phantom rollback — it just logs a warning. Applied consistently across the NetVault updater, the standalone NetVault installer, and the shared NocVault suite installer.',
  ],
  '1.25.0': [
    'Agents bug-sweep (adversarial review of the 1.24.0 Agents feature — 10+ confirmed issues fixed). The most important: the enrollment install one-liner minted by the hub pointed at /api/agents/install.ps1, which nothing actually served — the flow was dead on arrival. The hub now serves the installer AND the multi-file agent bundle (a manifest + per-file endpoints), so the minted one-liner is genuinely self-bootstrapping (matching how SpanVault already serves its agent). The per-file server is path-traversal-hardened (resolve + confine + symlink recheck + exclude-list) so it can only ever serve the agent\'s own files.',
    'Fixed a token-enrollment race: the one-time enrollment token was checked then burned in two separate non-transactional steps, so two simultaneous redemptions of the same token could both mint valid agent identities. Enrollment is now a single transaction whose atomic "burn if still unused" gate lets exactly one caller win; the loser rolls back cleanly with no orphan agent.',
    'Fixed a fleet-page crash: expanding an agent that had not yet sent its first heartbeat threw on a null buffer value and took down the whole page. Also made the "Copy" button on the one-time enrollment token fall back gracefully when the browser blocks clipboard access over plain HTTP (previously it failed silently and you could lose the token), and corrected the token-expiry countdown that always read "just now".',
    'Agent hardening (agent 2.1.1): closed the one path where a misbehaving/hostile hub could crash the agent and take down its real data collection (an unhandled response-stream error), added a request timeout + non-stacking heartbeat loop so a black-hole hub can no longer leak connections, made the stored agent identity write atomic (crash-safe), and a revoked agent now clears its dead identity so a fresh token can re-enroll. Also synced the agent\'s reported version string, which had lagged its package version.',
    'Smaller fixes: module assignments are now validated against the known set (log/ddi/span) before storage; toggling a module\'s config no longer silently re-enables a module an admin had disabled; and the agent health-history table is now pruned to a rolling 7-day window instead of growing unbounded.',
  ],
  '1.24.0': [
    'NocVault Agents — Phase 2: the NetVault hub is now the control plane for a unified suite-wide remote agent (the same edge collector that today runs SpanVault, extended to carry LogVault/DDIVault modules in later phases). A new super-admin-only Agents page (sidebar) lists the fleet — each agent\'s host, site, assigned modules, version, buffer depth and live status (online / degraded / offline) — with per-agent enable/disable of modules and a revoke action.',
    'Enrollment is token-based: an admin mints a one-time install token (expires in 60 min, carries a site + module preset) and runs the returned one-line installer on the remote host. The agent redeems the token once, receives a durable hub-signed identity (a JWT signed with the suite-shared secret, pinned to HS256), and from then on posts a 30s fleet heartbeat. Only the token HASH is ever stored; a revoked agent\'s still-valid token is rejected on every call.',
    'New schema (agent_registry: agents, agent_enrollment_tokens, agent_modules, agent_health) provisioned on fresh install, plus 8 /api/agents/* routes (mint-token, public token-authed enroll, fleet list, per-agent detail/patch, agent-authed heartbeat + policy, revoke). The read-only diagnostics role is granted SELECT on the new tables (no secret columns exposed), and the fresh-install smoke tester now verifies them.',
    'The agent gains an opt-in hub control channel (agent subproject 2.1.0): set hubUrl + enrollToken in its config and it enrolls, heartbeats, and polls policy — purely additive, it never touches the existing app data path (collection results still flow directly to each app over the existing WebSocket, never through the hub). Omit those two keys and the agent behaves exactly as before.',
    'Data-plane isolation by design: the hub carries only control traffic (enroll / identity / fleet / policy). High-volume collection data goes agent→app directly, so a busy LogVault feed can never bottleneck the hub.',
  ],
  '1.23.32': [
    'Installer-parity fix: the shared suite installer (fresh-install path, used for every new customer deployment) applies DDIVault\'s 4 schema files with the same --single-transaction protection just added to DDIVault\'s own updater — without it, a failure partway through one of those files could leave that file\'s DDL partially applied on a brand-new install, same risk the updater fix closed for upgrades. Confirmed none of the 4 files use a statement that can\'t run inside a transaction. Everything else from yesterday\'s resilience-system fixes (concurrency locks, rollback logic, version-aware health checks, frontend success/rollback states) is specific to the update path and has no fresh-install equivalent, so no other installer changes were needed.',
  ],
  '1.23.31': [
    'A full adversarial review of the self-healing updater found and fixed 10 real issues in the update/rollback machinery itself: the initial service stop now always runs even if the service wasn\'t sampled as "Running" (a crash-looping service could otherwise keep auto-restarting into the update, corrupting the build mid-write); a rollback that can\'t find the pre-update commit now correctly reports failure instead of possibly claiming success without ever reverting the code.',
    'Fixed a false "rollback ALSO failed, NetVault may be DOWN" alarm that could fire even when the original build was never touched (a pre-flight snapshot failure before the live build was ever swapped out) — it now correctly recognizes "nothing needed to be rolled back" instead of triggering the scariest possible message for a run that never actually broke anything.',
    'If a database schema change succeeds but a later update step fails and triggers a rollback, the code is reverted but the schema is not — this mismatch is now flagged explicitly in the update status and shown as an extra warning line if it happens, instead of being silent.',
    'The post-update and post-rollback health checks now also verify the running version matches what was expected, not just that the server answers — closing a narrow window where a briefly-relaunched OLD build could be mistaken for a successfully completed update or rollback.',
    'Added a concurrency guard so two update runs can no longer overlap (e.g. a manual console run racing the in-app "Update Now" button) — a second attempt is refused with a clear message instead of corrupting the same files from two directions at once.',
    'The "Update Now" progress screen now checks whether the last update actually succeeded or was silently auto-rolled-back before showing the green success message and reloading — a failed-but-recovered update now shows a clearly different warning instead of looking identical to a real success, and a failed rollback shows the most urgent state without auto-reloading into a possibly-dead server.',
    'Hardening: the update status file is now written atomically (so a crash mid-write can never leave a corrupt file), the same careful stale-backup cleanup logic used before an update now also applies to the after-a-successful-update cleanup, and the two update-status API routes now require a signed-in session (previously reachable without one).',
  ],
  '1.23.30': [
    'Found via a full adversarial bug sweep of yesterday\'s resilience work (4 real issues, all fixed): the status file location still used the unfixed -InstallDir parameter while the app path already self-located independently of it, so on any install where the two diverge the failure banner would never appear even after a genuinely failed/rolled-back update -- -InstallDir now self-locates the same way the app path already does.',
    'The "kill any leftover node process" step during an update used to match by process name alone, which on the shared suite server also matches LogVault/DDIVault/SpanVault\'s own node.exe processes -- a routine NetVault-only update could force-kill sibling apps as collateral damage. Now scoped to only this install\'s own process.',
    'A stale rollback backup left behind by a rare failed cleanup (e.g. a locked file) could silently collide with the next update\'s own snapshot step and cause that run\'s rollback to restore the wrong, older version while still reporting success. The stale backup is now moved aside safely instead of causing a collision.',
    'The update-progress overlay\'s final verification could still fall through to declaring success without actually confirming anything, if the version-check request succeeded but came back with no commit data (a narrower trigger than the network-failure case already fixed) -- now retried the same way a network failure already was.',
  ],
  '1.23.29': [
    'Fixed the same rollback-ordering bug found live in LogVault/DDIVault/SpanVault\'s identical rollback code (production incident): the rollback restored .next\\standalone BEFORE stopping the NetVault service, so a failure after the service had already restarted (the service-start or health-check stage) would mutate a live build directory while the running process was still serving from it -- exactly the race that corrupted node_modules down to a handful of packages in the other apps. NetVault wasn\'t hit by it yet, but the exposure was identical. Reordered to stop the service first, matching the order the main update flow already uses.',
  ],
  '1.23.28': [
    'Fixed the "Update Now" progress overlay reloading into a dead page ("This site can\'t be reached") on a slow update. After 3 consecutive healthy checks it counts down and does one final check that the code actually changed before reloading -- but if THAT check itself failed to reach the server (the service can drop again right after briefly answering healthy, e.g. from a known NSSM auto-restart race that can relaunch the OLD build for a few seconds before the real update replaces it), the overlay assumed "it must be up anyway" and reloaded blind. It now retries the final check for about 10 seconds instead of guessing, and falls back to a "taking longer than expected, refresh manually" message rather than reloading into a server that might still be down.',
  ],
  '1.23.27': [
    'Fixed the new last-update-status.json (added in 1.23.24) being unreadable by the app: Windows PowerShell 5.1\'s Out-File -Encoding UTF8 writes a byte-order-mark, which Node\'s file reader does not strip, so JSON.parse threw on every single write -- the update-failure banner and status API always reported "no status" regardless of what actually happened. The updater now writes the file via .NET directly with a BOM-less encoding, and the API route also strips a BOM defensively in case an old BOM-prefixed file is still on disk.',
  ],
  '1.23.26': [
    'Fixed the in-app "Update Now" button running noticeably slower than a manual update, appearing "stuck" at the build step. The scheduled task it creates (schtasks /create, no priority specified) inherits Task Scheduler\'s default priority level (7 = BelowNormal process priority), unlike a manually-run script, which gets Normal priority -- starving the CPU-bound npm build step under contention from the rest of the suite (Postgres, the other 3 apps, their collectors). The updater now resets its own process priority to Normal at startup regardless of how it was invoked; a no-op for a manual run, which was already Normal.',
  ],
  '1.23.25': [
    'Cosmetic-only fix: corrected a misaligned hashtable entry in Update-NetVault.ps1 left over from 1.23.24 (no logic change). Also serves as a small, real commit to validate the new self-updating resilience flow end-to-end via the in-app "Update Now" button.',
  ],
  '1.23.24': [
    'Made the updater (Update-NetVault.ps1) resilient to a failed update instead of just reporting one: it now snapshots the current commit and build output before touching anything, and if any stage of an update fails (git pull, npm install/build, static copy, service start, or a NEW mandatory post-start health check), it automatically reverts to the last known-good version, restarts the service on it, and re-verifies /api/health -- instead of possibly leaving the hub on broken/partial code.',
    'Every update run (success or failure) now writes a structured result to logs\\last-update-status.json -- what stage it reached, an error code, the error message, whether it rolled back, and whether the health check passed after -- so a failure has a durable, specific record instead of just a scrollback log.',
    'New in-app failure banner (any admin, on every page including the launcher): if the last update failed, it surfaces immediately with what stage failed, whether it was automatically rolled back, and an error code -- previously the only way to notice a failed update was to happen to look at the server logs.',
    'The post-start health check that used to just warn and continue if NetVault never answered /api/health is now a hard gate -- an update is no longer reported as successful unless the running version is actually confirmed serving traffic.',
    'A schema-apply failure (already non-fatal, does not block an update) is now also surfaced as a lower-severity banner on an otherwise-successful update, since it still needs a human to check even though it did not cause downtime.',
  ],
  '1.23.23': [
    'Extended the same "don\'t silently swallow a real schema error" fix from 1.23.22 to SpanVault\'s fresh-install step in the suite installer, and to SpanVault\'s own per-app updater -- both now abort loudly instead of reporting success if scripts/schema.sql hits a genuine SQL error partway through.',
  ],
  '1.23.22': [
    'Security fix, corrected: the 1.23.18 fix for the cross-app diagnostic read role seeing user password hashes and the license key did NOT actually work -- the filtered view it added referenced a column that doesn\'t exist on NetVault\'s app_settings table, which made that view fail to create and silently aborted the whole access-narrowing step, leaving both password hashes and the license key just as exposed as before the "fix" shipped. Verified live against production and corrected: the view now only selects columns that actually exist, and the fix for each table is now independent and impossible to silently no-op.',
    'The database update scripts now stop and report clearly if a schema change fails to apply, instead of quietly carrying on as if it succeeded (which is how the above went unnoticed for a release).',
    'Merged two duplicate, slightly-inconsistent copies of internal update-checking logic into one, so a future fix to it can\'t drift between the "Update Now" button and the update-available check again.',
  ],
  '1.23.21': [
    'Fixed the updater (Update-NetVault.ps1) reporting "Update failed" on a benign npm notice (an npm registry deprecation message about their audit-check endpoint) even when npm actually succeeded -- a PowerShell quirk where any stderr output from a native command gets treated as a fatal error. Found and fixed 3 other places in the same script with the identical risk (both sc.exe calls), not just the one that was reported.',
  ],
  '1.23.20': [
    'Settings > General: the Session Security panel no longer stretches to the full page width around its single field. Same panel-width fix already shipped in LogVault and SpanVault.',
  ],
  '1.23.19': [
    'Deduplicated a device-status color map in global search that had drifted into its own hardcoded copy of the same colors already defined for status badges elsewhere in the app -- now reuses the shared badge component directly, so a future palette change can\'t accidentally leave global search out of sync. Purely cosmetic, no visible change.',
  ],
  '1.23.18': [
    'Added a pre-built codebase index (.ai-codex/) so future development sessions can find things faster, with a rule that keeps it in sync going forward.',
    'Security: closed a gap where the cross-app diagnostic/dashboard read role could see user password hashes and the app\'s license key. Those now live behind filtered views that only expose safe fields -- any new sensitive field added in the future is hidden from that role by default until someone deliberately decides it\'s safe to share.',
    'Fixed the same gap for LogVault, DDIVault, and SpanVault, and fixed an installer ordering bug that would have silently undone this fix on every brand-new install of the whole suite.',
  ],
  '1.23.17': [
    'Fixed a serious in-app "Update Now" bug: NSSM runs NetVault with its working directory inside .next/standalone (the build output), and this app\'s update trigger walks up from there looking for a .git folder to locate the real installer script. A stray/duplicate git checkout had ended up nested inside .next/standalone on the live server, so every in-app update click was silently running the update script from that STALE nested copy instead of the real one -- rebuilding the wrong tree while still restarting the actual service, which is why updates triggered from the UI could intermittently fail to actually update anything (or fail outright). The update trigger now refuses to treat a .git folder found inside a .next path as the real repo root.',
  ],
  '1.23.16': [
    'Follow-up to 1.23.14: capping the short-value inputs (Site code, Postal code, GPS coordinates, Phone, EOL/EOS date, Confidence) fixed the INPUT width, but the surrounding 2-column CSS grid column was still forced to ~half the panel width, leaving a large dead gap before the next field. The Add/Edit Site forms and the EOL Intelligence seed form now use a new flex-wrap based .form-grid-compact layout so fields size to their own content width and flow compactly, while full-width fields (Country, Address, Aliases) now use flexBasis: 100% instead of the grid-only gridColumn: 1 / -1.',
    'Styling only — no functional, validation, or data changes. The Add user/Edit user form grid was left untouched (still a real CSS grid) since it has no capped short-value fields.',
  ],
  '1.23.15': [
    'Fixed: the updater could report "Update failed" for an update that had actually succeeded. sc.exe start NetVault can return exit 1056 (service already running) because NSSM auto-restarts the service the instant this script kills a leftover process, racing the script\'s own explicit start call -- that exit code is now treated as success (the health-check poll right after is the real verification) instead of a hard failure.',
  ],
  '1.23.14': [
    'Fixed short-value form fields (Site code, Postal code, GPS coordinates, Phone in Settings → Sites; EOL date, EOS date, Confidence in EOL Intelligence) rendering stretched across the full width of their 2-column form grid — added shared .input-sm/.input-md width caps (matching the fix already shipped in SpanVault) instead of scattered one-off inline widths.',
    'Unified the Settings site-search and EOL Intelligence search boxes onto the same .input-md width, replacing two different one-off inline widths (240px and 440px) with one consistent size.',
    'Styling only — no functional, validation, or data changes.',
  ],
  '1.23.13': [
    'Added LogVault\'s 3 new Phase 4 dashboard rollup tables (syslog_fortinet_field_rollup, syslog_device_status_rollup, syslog_entity_activity_rollup) to the fresh-install smoke tester\'s LogVault privilege checks.',
  ],
  '1.23.12': [
    'Added the remaining 7 LogVault dashboard rollup tables (from today\'s Phase 2/3 performance work) to the fresh-install smoke tester\'s LogVault privilege checks — the previous check only covered the first 2.',
  ],
  '1.23.11': [
    'Added LogVault\'s new dashboard-performance rollup tables (syslog_stats_rollup, syslog_talker_rollup) and the new syslog_entries.srcip column to the fresh-install smoke tester\'s LogVault privilege checks, matching the existing pattern for its reporting-engine tables.',
  ],
  '1.23.10': [
    'Added the two new LogVault reporting-engine tables (saved_reports, report_run_history) to the fresh-install smoke tester\'s LogVault privilege checks, matching the pattern already used for DDIVault\'s equivalent tables.',
  ],
  '1.23.9': [
    'Hardened the in-app "Update" button: it now registers this repo as a git safe.directory for the SYSTEM account it runs under (Git refuses to operate in a repo it doesn\'t consider "owned" by the current account, which SYSTEM never is on an existing install) and writes a full transcript of the update run to installer\\logs\\ — previously a failed in-app-triggered update left no record of what happened, since that button runs fully in the background with no live output.',
  ],
  '1.23.8': [
    'Standardized the updater script (installer/Update-NetVault.ps1) to self-locate its app folder from the script\'s own location, instead of trusting the -InstallDir parameter to match. LogVault and DDIVault already worked this way; NetVault and SpanVault (fixed alongside this) instead derived the app folder from -InstallDir\'s default value, which only happened to work because it matched the current install layout. All four update scripts can now be run with no parameters at all, from any correctly-placed copy of the script, regardless of what folder name or casing was used to get there.',
  ],
  '1.23.7': [
    'Fixed 5 more spots (in the installer/updater scripts, not the app itself) still using "localhost" for the same server-to-server health-check/EOL calls fixed for the launcher in 1.23.6 — the daily health-snapshot, daily EOL-enrichment, and weekly EOL-sync scheduled tasks, plus the one-time baseline snapshot taken right after install/update. On Windows these could occasionally stall against the app\'s IPv4-only listener the same way the launcher tiles did. Now consistently 127.0.0.1. No effect on any already-running install; only affects new installs/updates going forward.',
  ],
  '1.23.6': [
    'Fixed the launcher\'s Suite Health Overview and per-app stat tiles intermittently showing "Unavailable" or blank dashes (especially LogVault) and only filling in after a manual refresh. The server-side probes to the other apps used "localhost", which on Windows tries IPv6 (::1) first and stalls ~1 second against the IPv4-only apps — often long enough to trip the timeout. They now use 127.0.0.1 (same fix already applied to the installer health checks) and have a more forgiving 3-second timeout, so all four apps report reliably on first load.',
  ],
  '1.23.5': [
    'Fixed: launcher tiles for LogVault and DDIVault always redirected to the server\'s original install-time IP address, no matter what hostname you actually used to reach NetVault (e.g. a local DNS name your IT team assigned). If that IP wasn\'t reachable from wherever you were browsing, the app would fail to load even though the launcher itself worked fine. Cross-app links now follow whatever hostname you\'re actually using.',
    'Added a proper single sign-on handoff for SpanVault (previously it used a different, less consistent mechanism) — same fix applies to it too.',
  ],
  '1.23.4': [
    'Fixed a fresh-install crash on a truly clean Windows machine (no Node.js or Git pre-installed): the installer\'s "already installed?" check for both tools threw a fatal "term not recognized" error instead of detecting they were missing and installing them. Affects only brand-new machines - any box that already had Node.js or Git was unaffected. Also hardened the equivalent check in the uninstaller.',
  ],
  '1.23.3': [
    'Security fix: a device\'s audit history (GET /api/audit/device/:id) had the same missing site-scoping the 1.23.2 fix closed on sites/circuits — any authenticated user, including a site_admin outside that device\'s site, could read its full change history (cost, contract, serial, IP). Now scoped the same way.',
    'Hardening: a database error while checking a user\'s per-app access previously granted that request access to every app rather than denying it. A transient DB error now fails closed instead of open.',
  ],
  '1.23.2': [
    'Security fix: site_admin users could read any other site\'s device inventory and any circuit\'s cost/subnet/contract details by guessing IDs (GET /api/sites/:id and /api/circuits/:id never applied the same site-scoping their list-view siblings already enforce). Fixed to match.',
    'The unauthenticated /api/server-stats endpoint (disk/CPU/memory/uptime, no secrets but more infra detail than a health check) now requires a signed-in session like the rest of the API.',
  ],
  '1.23.1': [
    'Fixed: the per-user "App access" control (added in 1.23.0) was not appearing on the Settings → Users form, because it was added to a different user-management screen. The app-access checkboxes and an "App access" column now show on Settings → Users where users are actually managed.',
  ],
  '1.23.0': [
    'New: per-user app access. When creating or editing a user you can now choose which of the four suite apps (NetVault, LogVault, DDIVault, SpanVault) they can access. NetVault is always available; super admins always have all apps; existing users keep access to everything until you change them.',
    'The launcher greys out apps a user is not allowed to open, and trying to open a disallowed app bounces back to the launcher with a clear "no access" message.',
    'Note: this is the NetVault (hub) side. Enforcement inside LogVault/DDIVault/SpanVault themselves is being rolled out in their own updates; until then those apps honour the launcher + login gate.',
  ],
  '1.22.1': [
    'Fixed: Sites Import failed with a server error whenever a row matched an existing site and had an empty field to fill in — the update referenced a column that does not exist, so nothing was imported. Filling empty fields on existing sites now works.',
    'Fixed: a failed import used to show a green "Import complete" message with blank numbers. Import and preview now show a clear error if the server rejects the file, and only report success when the import actually succeeded.',
  ],
  '1.22.0': [
    'New: Sites Import. On the Sites page, "Import Sites" lets you upload a spreadsheet of sites — download the built-in template, fill it in, and import. It creates new sites and fills in only the empty fields on existing ones (it never overwrites data you already have).',
    'Smart matching: existing sites are matched by code (or name + country); a preview shows exactly what will be created, filled, or skipped before you commit, and a "Dry run" reports the outcome without changing anything.',
    'Countries and regions are resolved automatically from the sheet (created if new), so you can add sites in new locations without setting them up first. Admin/super-admin only.',
  ],
  '1.21.8': [
    'Installer: fixed the long "Waiting for NetVault to respond" pause during updates. The health check used http://localhost:3000, which on Windows tries IPv6 (::1) first — but the app listens on IPv4 only, so the check timed out even though the app was already up. It now uses 127.0.0.1, so the update proceeds as soon as the app is ready.',
  ],
  '1.21.7': [
    'Installer: removed the redundant NSSM step that caused the "Error setting parameter AppEnvironmentExtra" message on every update. The Hub read-only DB credentials are already provided to the app via the standalone runtime env file (the mechanism NetVault actually reads, verified working), so the extra service-config write was both broken and unnecessary — it only produced confusing output.',
    'Installer: the "Starting NetVault service" step now shows progress dots while it waits for the freshly-built app to answer, so a normal 10-30s startup no longer looks like the updater has hung.',
  ],
  '1.21.6': [
    'Installer: fixed the harmless-but-noisy "Error setting parameter AppEnvironmentExtra" warning during updates. The updater read the existing service environment back (which comes with Windows line endings) and fed it straight to NSSM, which rejected it; it now normalizes the entries to clean KEY=VALUE lines before writing, so the Hub read-only DB credentials are reliably set in the service config and the update reports accurately.',
  ],
  '1.21.5': [
    'Updater hardening: the update script now pins the build directory to its true on-disk casing. A build could fail (duplicate React, "useContext" error) if the updater was invoked with a different path casing than a previous run (e.g. C:\\Apps\\NetVault vs ...\\netvault), because Next.js caches absolute paths. This makes the casing stable regardless of how the path is typed.',
  ],
  '1.21.4': [
    'Update check hardening: the git-based check now runs asynchronously so a slow or unreachable GitHub can no longer briefly freeze the app while checking, and it correctly reports "Could not check for updates" instead of silently showing "up to date" when the remote is unreachable.',
  ],
  '1.21.3': [
    'Fixed "Could not check for updates" in Settings → Updates. The update check was calling GitHub\'s public web APIs (api.github.com + raw.githubusercontent.com), which are rate-limited per source IP — from a shared network with several apps checking, raw.githubusercontent started returning 429 and the check failed. It now checks via git (the same transport the updater already uses), which is not rate-limited.',
  ],
  '1.21.2': [
    'Import preview now shows the cleaned model name (with the redundant brand stripped), so the preview matches exactly what the import will save',
  ],
  '1.21.1': [
    'Device model cleanup: some imported devices had the brand baked into the model field, so the list showed it twice — "Cisco Cisco SW 500", "Aruba Aruba 505". Imports now strip a redundant leading brand from the model (and the same on manual add/edit), so new/updated devices read correctly ("Cisco SW 500")',
    'Product lines are preserved (Catalyst, Aironet, Instant On, NGFW, MSM), and the full "Aruba Networking" vendor name is handled',
    'Ships a one-time, optional cleanup script (scripts/cleanup-brand-in-model.sql) to fix the ~1,549 existing rows — previewed + transactional + reversible; run manually when convenient. EOL matching is unaffected either way',
  ],
  '1.21.0': [
    'License banner is now the NocVault suite-standard full-width bar, consistent with DDIVault/LogVault/SpanVault: a solid per-state color strip directly below the header — trial (blue), expiring within 30 days (amber), grace period (orange), and expired/read-only (red) — each with a "Manage License →" link to Settings → License',
    'The trial banner now shows for the whole trial (days remaining) instead of only the last 5 days, so an unlicensed install is always clearly flagged; an active license also warns once it is within 30 days of expiry',
    'The same standardized banner now appears on both the main app (every route) and the launcher/hub landing page, and shows "Licensed to: <customer>" when an activated license carries a customer name',
    'Display-only change — license enforcement (read-only mode past grace, write-route guards, module gating) is unchanged',
  ],
  '1.20.4': [
    'Build no longer depends on Google Fonts: Inter was loaded via next/font/google, which fetched from fonts.googleapis.com at BUILD time and failed the whole build on any machine/network that can\'t reach Google Fonts (offline or restricted LAN) — this broke fresh installs. Inter now loads via the existing CSS @import in globals.css (with a system-ui fallback), so the build is network-independent',
  ],
  '1.20.3': [
    'EOL matching hardening: the synthetic Aruba AP bare-number aliases (e.g. "AP-615" → "615") added in 1.20.2 now only match devices whose brand is genuinely Aruba, so a plain HP/HPE device can never accidentally cross-match an Aruba access point by number',
    'Kept the HP/HPE/Aruba shared vendor bucket for real curated matches — verified against live inventory that all ~150 HP MSM wireless devices keep their existing seed matches and the +518 Aruba AP matches are fully preserved (zero-regression, defensive)',
  ],
  '1.20.2': [
    'EOL matching: Aruba access points recorded in inventory as "Aruba 505" now match the seed catalog\'s official "AP-505" entries and pick up their EOL/EOS dates. Previously the two names normalized differently and never matched, leaving ~500 Aruba APs dateless despite the data existing in the seed',
    'Adds the bare AP model number as an alias on Aruba "AP-###" seed entries, and scopes alias matches to the same vendor so an ambiguous number can only match within that brand (exact model matches are unchanged)',
    'Validated against live inventory: +518 devices gain dates, 0 existing matches lost. Run enrichment to apply — no seed sync needed',
  ],
  '1.20.1': [
    'EOL matching accuracy: removed the "Add all uncovered models to seed" action, which added device models as dateless placeholder entries. Those placeholders carried no dates, so they could not enrich anything — but a device would still "match" one and be counted as matched while no date was written, making enrichment look ~99% matched when real dated coverage was much lower',
    'Added a "Remove N dateless" button on Seed Management (super admin) to purge those dateless placeholder entries in one click (feed-sourced entries are never touched). After purging, re-run enrichment so the matched count reflects real coverage',
    'Coverage worklist now guides you to research and add real EOL/EOS dates for uncovered models, instead of bulk-adding empty placeholders',
  ],
  '1.20.0': [
    'EOL Intelligence: the Seed Management catalog (now 6,600+ entries) is grouped into collapsible vendor sections instead of one endless flat list — expand a vendor to see its models, each vendor row shows its entry count and how many are dated vs dateless, and a search box finds any model across all vendors',
    'New EOL Coverage panel: an at-a-glance donut of how many inventory devices have EOL dates vs none, a ranked "dateless devices by brand" list, and a seed-catalog-by-vendor breakdown',
    'Each "dateless by brand" row links straight to the device list filtered to that brand with no EOL date, so you can act on the gap; the device list gains a "No EOL date" filter and honours ?brand= and ?eol=none deep links',
    'Gap classification flags whether a brand is a "coverage gap" (seed is missing those models — research and add) or a "matching gap" (seed exists but device models are not matching it), so you know whether to add data or fix matching',
    'Fixed a paging bug in the seed list that showed only half of each page',
  ],
  '1.19.13': [
    'Device search now matches the brand/vendor name — searching a vendor like "Allied Telesis" now returns every device of that brand, not only the ones whose model string happens to contain the word. Previously the brand column was not searched, so devices with a clean model name were missed (e.g. an "Allied Telesis" search returned 16 of 33 devices)',
    'The same brand-aware search now applies consistently to the device list, the top-bar global search, and CSV export, so counts and exports agree',
  ],
  '1.19.12': [
    'Schema hardening: the public-object owner-reassignment loops in schema.sql now skip objects already owned by the netvault role, so a foreign (non-app) object landing in public can no longer abort the whole schema re-apply on upgrade',
    'Installer fix: the suite installer no longer swallows nocvault_readonly grant errors — a failed Hub read-only grant now surfaces a warning instead of silently shipping a degraded cross-DB install',
    'Smoke tester hardening: existence checks are now role-scoped privilege checks (the app role can actually SELECT the object), the nocvault_readonly grant is a hard FAIL across all four DBs, and collector-heartbeat queries no longer mislabel a query error as "idle by design"',
  ],
  '1.19.11': [
    'Provisioning fix: the nocvault_readonly Hub role is now granted SELECT in the schema self-heal (incl. ALTER DEFAULT PRIVILEGES for future netvault-created tables), so cross-app Hub reads cover runtime-created tables (e.g. the EOL Intelligence tables) on both fresh installs and upgrades',
  ],
  '1.19.10': [
    'Suite installer fix: a fresh install now reassigns ownership of all DDIVault and SpanVault tables, sequences, views and functions to their app roles (ddivault_user / spanvault_user) right after applying each schema as postgres — so each app\'s self-migration (and SpanVault\'s API at boot) no longer fails silently with "must be owner" and the schema stays in sync',
    'Suite installer fix: the installer now writes POSTGRES_PASSWORD into the DDIVault and SpanVault .env files, so their updaters can self-heal existing installs by reassigning object ownership on the next upgrade',
  ],
  '1.19.9': [
    'Fresh-install fix: the v_devices_flat view is now created after the columns it references, so it exists on a clean database — the Devices and EOL Intelligence pages no longer come up blank on a brand-new install',
    'Fresh-install fix: the core tables are now owned by the netvault application role, so runtime schema changes succeed — this clears the "must be owner of table devices" error that blocked EOL enrichment on fresh installs',
    'Fresh-install fix: eol_discrepancies.device_id and eol_recommendations.device_id are now INTEGER to match the devices.id type, fixing the "invalid input syntax for type uuid" error when running EOL enrichment; a guarded, idempotent migration corrects the column type on existing installs automatically',
  ],
  '1.19.8': [
    'Launcher performance: the suite health/stats tiles now fail fast and cache. The per-app cross-probe timeout was cut from 5s to 1.5s and results are cached in-memory for ~20s, so a single slow or offline sibling app no longer stalls the launcher for up to 5 seconds',
    'Launcher performance: the license server-ID is now memoized, so GET /api/license no longer spawns a synchronous Windows registry query (execSync) on every call — removing a small per-request event-loop stall',
  ],
  '1.19.7': [
    'Security: upgraded Next.js 16.2.1 → 16.2.9 (the patched release), closing high-severity advisories reachable over HTTP — SSRF via WebSocket upgrades, middleware/proxy bypass via dynamic route params, and App-Router XSS — plus the bundled postcss stringify XSS. No functional or UI changes',
  ],
  '1.19.6': [
    'Fresh-install fix: the devices table now defines support_vendor_id inline, so the v_devices_flat view (which joins the support vendor) builds successfully on a clean database. Previously the column was only added by a later ALTER, so on a fresh install the view — and its GRANT — failed, breaking device lists, dashboard, search, export, compliance and health scoring until patched',
  ],
  '1.19.5': [
    'Security: the two EOL enrichment status endpoints (latest job + job status) now require the EOL license module, closing an unlicensed-read gap that let an authenticated user on a lapsed install read stale enrichment-job data (device model names)',
  ],
  '1.19.4': [
    'Dark mode: swept the remaining hardcoded light colors on the Sites page — the per-site risk badges (High/Medium/Low) and the per-site Total/Active/EOL/Decommed stat numbers now use the adaptive theme tokens, so they stay readable in dark mode. The site-card hover border also uses the brand token now',
  ],
  '1.19.3': [
    'Dashboard: the KPI cards (Total Devices, Total Sites, WAN Circuits, Main Links, ISP Providers) are now more compact — the icon sits inline on the same row as the number instead of stacked above it, reducing card height',
    'Dark mode: fixed the top KPI cards on the Sites page (Total Sites / Total Devices / EOL Devices) and the Devices page (Total / Active / EOL-EOS / Decommed) that kept light backgrounds in dark mode — they now use the adaptive theme tokens and flip correctly',
  ],
  '1.19.2': [
    'Dashboard: removed the non-functional "Custom View" button — dashboard customization is not available yet, so the placeholder control has been taken out',
  ],
  '1.19.1': [
    'Settings → License: fixed the "Copy" button next to Your Server ID, which did nothing when the app is served over HTTP (the browser clipboard API is unavailable in that context). It now falls back to a reliable copy and shows a "Server ID copied" confirmation toast',
  ],
  '1.19.0': [
    'Launcher tiles are now license-aware: any suite app (LogVault, DDIVault, SpanVault) whose module is not included in your active license key is greyed out and blurred, with its "Open" button replaced by a non-clickable "Not licensed" state and a "contact sales@nocvault.com" prompt',
    'Gating is lenient and never locks you out by mistake — a tile is only marked unlicensed when there is an active license that explicitly lists modules and omits that app. Trial, grace, expired, empty-module, or unreachable-license states leave every tile open as before',
    'The NetVault host tile is always available and never greyed',
    'The Suite Health Overview pills mirror the same state, showing "Not licensed" for any app missing from an explicit active license',
    'Display-only change — no routing or SSO logic changed beyond disabling the open action for unlicensed tiles',
  ],
  '1.18.0': [
    'EOL Intelligence is now a licensed add-on module. On installs whose license does not include the "eol" module, the EOL Intelligence page is locked (shows an upsell with your Server ID), the feed sync and enrichment no longer run (the scheduled tasks no-op), and all EOL admin/system endpoints return 403',
    'Gating is access-control only — NO data is changed or deleted. Your seed catalog, the EOL dates already on devices, and recommendations are all left intact. Activating a license that includes the "eol" module immediately restores full access with all data in place',
    'This establishes reusable per-module license enforcement (the "eol" module is the first); the License page already lists your entitled modules',
  ],
  '1.17.1': [
    'EOL Intelligence: hardened the feed sync. The whole sync now runs in a single database transaction, so a crash mid-sync can no longer leave the seed catalog half-updated (it rolls back instead)',
    'EOL Intelligence: fixed a latent bug where collapsing duplicate seed entries during a sync could fail with a foreign-key error (and abort every subsequent sync) when a device recommendation referenced the merged-away entry — the sync now repoints those references correctly',
    'EOL Intelligence: the feed download now has a 15-second timeout, so an unreachable or slow feed host no longer hangs the weekly sync; it is treated the same as offline',
    'EOL Intelligence: after a manual "Sync from EOL feed", the confirmation now reminds you to run enrichment to apply the updated catalog to devices',
    'EOL Intelligence: added a guard so a model that normalizes to an empty key can never be written to the seed catalog',
  ],
  '1.17.0': [
    'EOL Intelligence: the EOL feed now syncs automatically every week (Sunday) — new vendor end-of-life dates published centrally now reach this install on their own, with no need to click "Sync from EOL feed." The weekly sync runs just ahead of the nightly enrichment, so refreshed dates are applied to devices that same night',
    'EOL Intelligence: the weekly sync verifies the feed signature before writing and only touches the seed catalog (never device records); offline/air-gapped installs simply skip it and keep using the bundled baseline',
    'The manual "Sync from EOL feed" and "Run enrichment now" buttons remain for on-demand use',
  ],
  '1.16.0': [
    'EOL Intelligence: the bundled offline EOL baseline now ships 949 vendor-confirmed models (910 with dates, 40 confirmed-retired) — up from ~32 — regenerated from the central NocVault EOL feed. A fresh or air-gapped install now starts with near-full EOL coverage even before the first "Sync from EOL feed"',
    'EOL Intelligence: the bundled seed now carries each model\'s vendor and lifecycle flag, so the offline baseline matches devices using the exact same keys as the online feed — including vendors the old derivation missed (Brocade, Asus, Linksys, TOTOLINK, and others)',
    'EOL Intelligence: added scripts/gen-eol-seed.cjs to regenerate the bundled seed from the central feed, keeping the offline floor and the live feed in step',
  ],
  '1.15.2': [
    'Updater: the update script now polls the health endpoint after restart instead of waiting a fixed delay, so it continues as soon as the app is actually serving (typically a few seconds sooner)',
    'Updater: removed the synchronous baseline health-snapshot and full EOL-enrichment run that fired during every update — both still run on their daily scheduled tasks, and EOL enrichment can be triggered on demand via the "Run enrichment now" button on the EOL Intelligence page. This shortens the update and avoids loading the freshly-restarted server with a ~2,500-device scan mid-deploy',
  ],
  '1.15.1': [
    'EOL Intelligence: fixed a page crash ("Cannot read properties of null") that occurred once a "should be EOL" recommendation came from a lifecycle=EOL seed entry with no published date — the days-remaining cell now shows "no date" instead of trying to format a null value',
  ],
  '1.15.0': [
    'EOL Intelligence: the EOL feed can now carry a "lifecycle: EOL" flag for models a vendor has confirmed retired/obsolete but for which no concrete End-of-Support date is published — so these are tracked as EOL without inventing a date',
    'EOL Intelligence: when a device matches such a flagged model, enrichment raises a normal (human-gated) "should be EOL" status recommendation reasoned "vendor-confirmed end-of-life (no published EOL date)" — review and accept it like any other',
    'EOL Intelligence: latest feed adds 34 newly-dated legacy models and 39 confirmed-retired-no-date models from the full EOL audit (sync from the feed, then run enrichment to apply)',
  ],
  '1.14.1': [
    'EOL Intelligence: fixed a matcher bug where a dateless "Add all to seed" placeholder could shadow a dated curated entry — a device whose model exactly matched the placeholder stayed undated even though the real EOL date existed on an entry carrying that model as an alias. The exact and alias tiers are now considered together and the dated entry always wins (re-run enrichment to pick up ~24+ previously-shadowed devices, e.g. WS-C2960X, A5120 EI, SG350-52, Catalyst 3850, Cisco 2504)',
  ],
  '1.14.0': [
    'EOL Intelligence: the model matcher is now flexible to product-line naming differences — an inventory "Cisco 3750x" now matches a seed "Catalyst 3750-X", and "Palo Alto NGFW PA-440" matches "PA-440". It strips curated product-line noise words (Catalyst, NGFW, FlexNetwork, ProCurve, Series, …) and common Cisco PID prefixes (WS-C, AIR-AP), while preserving model-defining lines (SonicWave, AirEngine)',
    'EOL Intelligence: "Sync from EOL feed" now self-heals — it recomputes the seed keys with the current normalizer and collapses any duplicate models before applying the feed, so matching stays consistent after a matcher upgrade',
    'EOL Intelligence: re-run enrichment after syncing to pick up the wider matches — more devices will now match the curated EOL dates despite messy inventory model spellings',
  ],
  '1.13.0': [
    'EOL Intelligence: new "Sync from EOL feed" button pulls the centralized NocVault EOL feed (800+ vendor-confirmed models) into the local seed catalog — no more waiting for an app update to get new EOL dates',
    'EOL Intelligence: the feed is cryptographically verified (Ed25519 signature + sha256) before anything is written, so a tampered or corrupt feed is rejected',
    'EOL Intelligence: the sync updates ONLY the EOL seed catalog (added_by="feed") — it never touches device records; device EOL dates are still filled by the separate enrichment step, and the bundled seed remains the offline fallback',
  ],
  '1.12.1': [
    'Site detail: the five summary KPI cards (Total devices, Active, EOL / EOS, Decommed, Circuits) now use theme tokens instead of hardcoded pastel colors, so they render correctly in dark mode instead of staying light-on-dark',
    'Site detail: replaced the tall "By device type" sidebar — which stretched to the full height of the device table and left a large empty box — with a compact full-width strip of clickable type cards (count, share %, EOL badge, mini bar) above a now full-width device table',
    'Site detail: cleaned up remaining hardcoded colors on the page (device-type bar fill, bulk-action bar, circuit group labels) so they adapt to the active theme',
  ],
  '1.12.0': [
    'EOL Intelligence: added vendor-confirmed end-of-support dates for SonicWall SonicPoint-Ne (2020-10-01), SonicWave 432e (2027-04-23) and NSA 3650 (2026-08-01), plus Cisco SG250-08HP / SG200-50 / SG95D-08 / SG350-52 / SG300-28PP / CBS350-24T-4G, Cisco Aironet 1242AG, and TP-Link EAP110-Outdoor — all from official vendor EoL bulletins',
    'EOL Intelligence: the SonicWall AP entries also match the legacy mislabeled model strings ("Ne INT" / "432e INT"), so the ESIP access points are dated even before their model text is cleaned up',
    'EOL Intelligence: enrichment now recognizes SonicWall as a vendor and matching is fully brand-independent — a device with a wrong or missing brand still matches the seed on its model, so inaccurate brand labels no longer block EOL dating',
    'EOL Intelligence: a fresh full research sweep confirmed the remaining dateless models (Aruba Wi-Fi 6 APs, Grandstream GWN, Ruckus R550/R650/T350, Huawei AirEngine/S-series, Palo Alto PA-440/460, Cisco C9200L/C9300) are current-gen with no published vendor EoL — correctly left undated rather than guessed',
  ],
  '1.11.0': [
    'Import: re-importing a device now updates it in place when its IP matches an existing device in the same site, even if the serial does not match — so you can correct or backfill devices that were first imported without serials (or with wrong/garbled ones) just by re-importing with the real names and serial numbers',
    'Import: the IP-based update only overwrites the fields actually present in your file, so a sparse re-import never wipes existing good data (a blank Lifecycle/Status column no longer resets known values), and Technical Debt is recomputed from the resulting values',
    'Import: serial number remains the primary match key (unchanged); IP-in-same-site is the new fallback. A row whose IP already belongs to a device in a different site is still skipped to avoid clobbering the wrong record',
  ],
  '1.10.4': [
    'EOL Intelligence: deleting a device now also clears its pending EOL recommendations and discrepancies, so a removed device no longer lingers in the review queues',
  ],
  '1.10.3': [
    'EOL Intelligence: enrichment can no longer wedge permanently — a job left in "running" after a server restart is now reaped as stale after 30 minutes, and a partial unique index plus a race-safe insert prevent two concurrent runs from colliding',
    'EOL Intelligence: D-Link and Ubiquiti (and every other curated seed vendor) are now recognized by the vendor parser, and the seed migration repairs already-stored entries whose normalized key kept the brand token — so models like the D-Link DGS-1100-24P and Ubiquiti UAP-Pro finally pick up their vendor EOL dates on the next run',
    'EOL Intelligence: status recommendations now respect direction — a new opposite-direction recommendation is no longer suppressed by an unrelated ignored one; and the seed date-fill no longer clobbers an unrelated placeholder row',
    'Reliability: EOL recommendation/discrepancy resolve actions (including bulk accept-all) now run in a transaction, so a mid-step failure can no longer leave a device updated without its audit record — bulk reports an accurate success count instead of a blanket error',
    'Compliance: an empty (or near-empty) fleet now shows an explicit "No data to assess" state instead of a misleading green 100%',
  ],
  '1.10.2': [
    'EOL Intelligence: third (final) research sweep over the legacy tail — added ~27 more vendor-confirmed models from official bulletins (Cisco Catalyst 2960/3750X/ISR-1941/Aironet 3602/1702/2702/1815, Meraki MS210/MS120-8FP/MS355, HP 5130/1950/A5120 SI/2920/2620, Netgear GS408EPP/S3300/GS108T, D-Link DGS-1100-24P, TP-Link EAP225, Ubiquiti UAP-Pro), covering ~115 more devices',
    'Remaining dateless models are now overwhelmingly current-gen gear with no published vendor EOL, junk/placeholder model names, or chassis modules — i.e. correctly not datable',
  ],
  '1.10.1': [
    'EOL Intelligence: added 9 more vendor-confirmed models from official bulletins — Cisco Catalyst 2960/2960-X, Aironet 3800, CBS350, Meraki MR20/MS120-24, Aruba 7205 controller, TP-Link TL-SG1016/TL-SG1024 (~60 devices)',
    'Fixed seed-key normalization for vendors without a recognized prefix (Allied Telesis, TP-Link, etc.): deriveVendor no longer collapses the model into an empty key, so previously-confirmed entries (AT-TQ5403e, AT-x510L, TL-GS108) now correctly match their devices (~40 devices recovered on the next enrichment run)',
  ],
  '1.10.0': [
    'EOL Intelligence: new "Add all to seed" button on the Coverage Worklist bulk-adds every uncovered device model to the seed in one click (server-side, using the same model normalization as the matcher) instead of adding them one at a time, then auto-runs enrichment to refresh',
    'Bulk-added models are dateless placeholders that track the model — their EOL dates still come from research/curation (many current-gen models have no published vendor date)',
  ],
  '1.9.2': [
    'EOL Intelligence: the seed migration now fills confirmed dates onto ALL dateless rows (including UI-added duplicates), not just the first match — so duplicate placeholders for already-confirmed models (AT-TQ5403e, AT-x510L, Aruba 214, HP MSM family) now pick up their vendor dates',
    'Added HP A5120 EI switches (End-of-Sale 2015-10-01 — same hardware as HP 5120 EI per HPE docs), covering ~72 more devices',
    'Re-checked the remaining dateless models (Aruba 2930F 24G/48G + CX 6100, Cisco C9200L/C9300/Aironet 1242AG, Huawei AirEngine/S5731, Palo Alto PA-460, Forcepoint NGFW, and current Wi-Fi 6 APs) — still no official published vendor EOL, so they remain correctly unseeded (no guessing)',
  ],
  '1.9.1': [
    'EOL Intelligence: the seed-entry Vendor field is now a dropdown of known brands (from the inventory) instead of free text, so vendor names stay standardized',
  ],
  '1.9.0': [
    'EOL Intelligence seed expanded with 21 vendor-confirmed model families from official EoS/EoL bulletins (Aruba 207/210/300/360-series + 6200F, HP MSM/5120/5130, Allied Telesis, Netgear, TP-Link, Cisco SF500/SG300/Aironet 2802i, Meraki MR33/MR46/MR52) — each with its vendor source URL — adding confirmed EOL dates to ~480 more devices',
    'The seed migration now upserts: it fills confirmed dates onto dateless placeholder entries (added via the worklist) without overwriting any manually-curated date',
    'Current-gen models (Aruba 5xx/6x00, Grandstream GWN766x, Ruckus, Huawei AirEngine, Cisco C9300/C9200, etc.) were researched but have no published vendor EOL, so they remain correctly unseeded — no dates are guessed',
  ],
  '1.8.1': [
    'Fixed EOL Intelligence seed dates showing (and saving on edit) one day early — the seed-management list read DATE columns in UTC; it now returns true calendar dates, matching the matching-engine fix',
  ],
  '1.8.0': [
    'New EOL Intelligence "Status Recommendations" (super-admin): when a vendor-confirmed (high-confidence) seed date contradicts a device\'s lifecycle status, it surfaces a recommendation — "Should be EOL" (Active devices past their vendor EOL date) and "Possibly Incorrect EOL" (EOL-marked devices still within vendor support)',
    'Recommendations are never auto-applied — an admin accepts (updates lifecycle_status, with the vendor source URL shown to verify and an audit-log entry written) or ignores (suppressed for 90 days); per-row and bulk actions are supported',
    'Only high-confidence exact/alias seed matches generate recommendations (never fuzzy/medium), and stale recommendations auto-clear when a device no longer qualifies',
  ],
  '1.7.1': [
    'Fixed EOL Intelligence date handling: DATE columns were read in UTC and rolled back a day (+07), producing phantom "1-day" discrepancies and off-by-one dates — dates are now compared and displayed as true calendar dates',
    'Discrepancy review no longer flags the enrichment’s own seed-written dates as conflicts (only genuinely manual dates are flagged); stale/false discrepancies are auto-cleared on the next run and resolved items no longer reappear',
    'Coverage Worklist and live run progress now display correctly (the API {ok,job} envelope was not being unwrapped), and the privileged CREATE EXTENSION was moved off the request path',
  ],
  '1.7.0': [
    'New EOL Intelligence admin (Settings → EOL Intelligence, super-admin): the curated EOL seed now lives in a managed database table — add/edit/delete model→EOL/EoS entries with a live coverage preview showing how many devices match before you save',
    'Enrichment now runs as a background job with live progress, flexible matching (exact, alias, and fuzzy similarity when pg_trgm is enabled), and a coverage worklist of the top unmatched models with one-click "add to seed"',
    'Discrepancy review: when the seed disagrees with a manually-entered EOL date, it is flagged for review (accept seed / keep manual / ignore) instead of silently overwriting your data',
  ],
  '1.6.1': [
    'Added EOL provenance columns (eol_source, eol_confidence, eol_enriched_at) to the canonical schema so fresh installs match the enrichment route’s runtime self-heal',
    'Researched the highest-volume unmatched models for end-of-life dates (Aruba 505/515/575, Grandstream GWN7660); no official vendor EoS dates are published for these current Wi-Fi 6 products, so none were added (no guessing) — they are tracked in the seed worklist to revisit',
  ],
  '1.6.0': [
    'New automated EOL/EOS enrichment: a curated, vendor-sourced model→end-of-life seed populates support-end and OS-EOL dates on matching devices, with provenance (source + confidence) and never overwriting manually-entered dates',
    'Runs as a daily scheduled task (and once on update) and returns a curation "worklist" of the highest-volume models still missing EOL dates — coverage grows from real vendor bulletins; no dates are ever guessed',
    'Feeds the new risk scoring: as EOL dates populate, the support-expiry compliance check auto-reactivates (≈175 devices gain dates from the initial seed)',
  ],
  '1.5.0': [
    'Compliance and health scores now measure real risk, not empty fields — checks on inventory fields populated on <5% of the fleet (e.g. support-end-date, OS EOL) move to a new "Data Completeness" metric and are excluded from the risk score until the data exists, then auto-reactivate',
    'Compliance 59% → 88% and health grade F → D now reflect genuine fleet risk (EOL-active devices, sites at risk) instead of undesigned columns',
    'Security hardening: the license key is no longer returned to unauthenticated callers, the in-app update trigger now requires an admin session, the license signing secret can be rotated via env, and token/cookie fragments were removed from SSO logs',
  ],
  '1.4.3': [
    'Correlated suite alerts no longer show a /32 CIDR suffix on the source IP — the Hub security-alert query now strips it with host() like the other Hub queries',
  ],
  '1.4.2': [
    'Fixed correlated suite alerts not appearing — the EOL-device correlation queried NetVault/SpanVault IP columns with a Postgres inet-only function, so those alerts silently failed',
    'Update-NetVault.ps1 now backs up and restores the standalone .env.local across the rebuild, so manually-added keys (e.g. the cross-app read role) are no longer wiped on every update',
  ],
  '1.4.1': [
    'New unified suite search on the launcher Hub — find any asset by IP, hostname or name across all four apps at once',
    'New Asset 360 drawer: one slide-in view of a device’s full story — NetVault asset of record, SpanVault monitoring (status, health, uptime, alerts), LogVault risk & recent security events, and DDIVault DNS/IPAM',
    'Search results tag which apps each asset appears in; the drawer shows suite presence at a glance',
    'All cross-app reads stay read-only and degrade gracefully when a signal is absent for an asset',
  ],
  '1.4.0': [
    'New "NocVault Hub — Suite Intelligence" section on the launcher: cross-app KPIs (fleet health, availability, log anomalies, IPAM utilization, open alerts) and correlated alerts spanning all four apps',
    'Correlated alerts surface what no single app can see — e.g. an end-of-life device that also has active monitoring alerts and security events',
    'Server Status moved to the bottom of the launcher; the existing app cards and Suite Health Overview are unchanged',
    'Reads cross-app data via a dedicated read-only role (populates once NOCVAULT_RO_* is configured; degrades gracefully otherwise)',
  ],
  '1.2.0': [
    'Enterprise dashboard with health score and charts',
    'Animated login page redesign',
    'Server status monitoring',
    'Automatic versioning across suite',
  ],
  '1.2.1': [
    'More reliable auto-reload after applying an update',
    'Extended the update recovery window so slower builds finish cleanly',
    'Cleaner update screen with structured release notes',
    'Removed the legacy CHANGELOG file',
  ],
  '1.2.2': [
    'Idle timeout now returns you to the page you were on after logging back in',
    'Fixed a redirect that could send users to a non-existent /sso page',
    'Login safely ignores invalid or looping callback URLs',
  ],
  '1.2.3': [
    'Removed the redundant refresh button from the dashboard header',
  ],
  '1.2.4': [
    'Standardized Settings page styling to match NocVault suite',
  ],
  '1.2.5': [
    'Standardized Settings menu (removed Branding, added About tab, Security→General)',
    'Theming continues to apply from stored or default values',
  ],
  '1.2.6': [
    'Settings copy cleanup (removed stale branding references)',
  ],
  '1.2.7': [
    'Standardized Updates and About tabs to NocVault suite spec',
  ],
  '1.2.8': [
    'Tightened card corners and elevation for a cleaner operations-console look',
    'Standardized border radius across the suite — 8px panels/cards/tables/modals, 6px buttons/inputs/dropdowns',
    'Replaced heavier card shadows with a subtle border-plus-faint-shadow elevation',
    'Kept pill toggles, status dots, and avatars fully rounded',
  ],
  '1.2.9': [
    'Standardized typography on a shared 7-step type scale (suite-wide standard)',
    'Unified the monospace font into a single token across all app screens',
    'Replaced duplicated hardcoded colors with design tokens for consistent theming',
    'Snapped ad-hoc font sizes onto the scale, collapsing ~12 sizes down to 7',
    'Login and launcher hero typography intentionally left unchanged',
  ],
  '1.2.10': [
    'Standardized sidebar nav icon chips (28×28, radius 8, per-route tint) to match the NocVault suite',
    'Bumped nav labels to 14px for suite-wide typographic parity',
    'Switched the header avatar to a 34px circular badge on solid primary',
  ],
  '1.2.11': [
    'Moved the header tagline beside the logo (after a divider) instead of stacked beneath it, matching the rest of the NocVault suite',
  ],
  '1.2.12': [
    'Opening the suite at the root URL now lands on the launcher (or the login screen if signed out) instead of dropping straight into the NetVault dashboard',
    'NetVault is now opened from the launcher like the other suite apps',
  ],
  '1.3.1': [
    'Extended dark mode across the whole hub — dashboard, settings, devices, sites, circuits, users, EOL, compliance, audit and shared components now adapt cleanly to the dark theme',
    'Replaced hardcoded light backgrounds/text with adaptive design tokens so theme switching is consistent on every page',
    'Kept brand accent colors, status signals, and the navy chrome unchanged in both themes',
  ],
  '1.3.0': [
    'Added suite-standard dark mode with a sun/moon theme switcher in the top bar (launcher + app), bringing NetVault to parity with the rest of the NocVault suite',
    'Your theme choice is remembered and applied before the page paints, so there is no flash of the wrong theme on load',
    'Tokenized the launcher surfaces (background, Suite Health Overview, Server Status, headings/body text) so they adapt cleanly to dark mode',
    'Kept the navy top bar, per-app brand accent colors, and status colors unchanged in both themes',
  ],
  'default': [
    'Bug fixes and performance improvements',
  ],
}

// Compares the local git commit hash against the latest commit on origin/main
// via the git transport (`git ls-remote`). ANY differing commit counts as an
// update available — the package.json version is for display only, so patches
// pushed without a version bump are no longer missed. Never 500s: a git failure
// degrades to "up to date" so we never show a false "update available".
// Item 10 (2026-07-24 resilience review): this route was reachable with no
// session check at all, even though every caller in the app (UpdateNotifier,
// shown to any logged-in user; the Settings > Updates tab, admin-only in the
// UI) only ever renders behind a login. The data itself is mild (version
// strings, short commit hashes, release-note text - comparable to the
// already-public /api/health) - not sensitive enough to warrant this route
// being intentionally public - so gated to any authenticated session, per
// this app's per-route auth convention (see CLAUDE.md's access-control
// section), rather than left open as an oversight.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const repoRoot = findGitRoot(process.cwd())
  const current_version = pkg.version
  const localHash = localCommitHash(repoRoot)

  try {
    const remoteHash = await remoteCommitHash(repoRoot)

    // If the remote is unreachable (git unavailable or transport error), we
    // genuinely could not check — say so explicitly rather than falling through
    // to the success shape, which would make a truly-outdated deploy that can't
    // reach the remote look up-to-date.
    if (!remoteHash) {
      return NextResponse.json({
        current_version,
        current_commit: localHash,
        up_to_date: true,
        update_available: false,
        error: 'Could not check for updates',
      })
    }

    // Any differing commit = update available. If the local hash is missing
    // (git unavailable locally), treat as up to date to avoid a false alarm.
    const update_available = !!localHash && remoteHash !== localHash

    // The remote version is display-only. Only read it (a git fetch) when an
    // update is actually available; otherwise the local version is authoritative.
    const latest_version: string = update_available ? await remoteVersion(repoRoot) : current_version

    // Release notes for the version being offered (the latest), falling back to
    // a generic message when there's no curated entry for that version.
    const release_notes = (latest_version && releaseNotes[latest_version]) || releaseNotes['default']

    return NextResponse.json({
      current_version,
      latest_version,
      current_commit: localHash,
      latest_commit: remoteHash,
      current_hash: localHash,
      latest_hash: remoteHash,
      up_to_date: !update_available,
      update_available,
      release_notes,
      release_date: new Date().toISOString().slice(0, 10),
    })
  } catch (e: any) {
    const detail = (e?.message || 'version check failed').toString().trim()
    console.error('[update-status] version check failed:', detail)
    // Degrade to "up to date" rather than surfacing a false update available.
    return NextResponse.json({
      current_version,
      current_commit: localHash,
      up_to_date: true,
      update_available: false,
      error: 'Could not check for updates',
    })
  }
}
