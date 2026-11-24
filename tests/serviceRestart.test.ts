//
// tests/serviceRestart.test.ts — applying a setting that needs a restart.
//
// ⛔ THE CENTRAL CASE IS THE RESTART THAT NEVER HAPPENED. `NocVault-Tls`
// declares `DependOnService NetVault`, so Windows REFUSES `sc stop NetVault`
// with 1051 while the terminator runs. The stop fails, the following start
// returns 1056 (already running), and the service is Running the entire time —
// so a verdict built on "is it running" reads a restart that did not happen as
// a success, and the operator is told their new console address is live while
// the old process serves on. Everything here defends the two halves of the
// fix: stop the dependents first, and require the PID to have CHANGED.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HUB_SERVICE,
  RESTART_SENTINEL,
  RESTART_TASK_NAME,
  TERMINATOR_SERVICE,
  buildRestartWrapper,
  isRestartPurpose,
  parseRestartLog,
  resolveRestartTarget,
  restartPaths,
  restartWaitLimitMs,
} from '../lib/serviceRestart.ts'
import { CONSOLES } from '../lib/consoles.ts'

// ─── which service applies which change ─────────────────────────────────────

test('a certificate is applied by the terminator, NOT by the hub', () => {
  const t = resolveRestartTarget('certificate', true)
  assert.deepEqual(t.services, [TERMINATOR_SERVICE])
  assert.ok(!t.services.includes(HUB_SERVICE))
  assert.match(t.why, /terminates TLS/i)
})

test('with no terminator a certificate needs no restart at all', () => {
  // ⛔ NOT "restart NetVault". There is nothing serving the certificate yet, so
  // bouncing a service achieves nothing and invites the conclusion that the
  // certificate is broken.
  const t = resolveRestartTarget('certificate', false)
  // ⛔ AN EMPTY LIST, NOT A LIST WITH A NULL IN IT: "nothing to restart" has one
  // spelling, so a caller cannot read it as "one service called null".
  assert.deepEqual(t.services, [])
  assert.match(t.why, /HTTPS is not turned on/i)
  assert.match(t.why, /Settings → HTTPS/)
})

test('the console address and SSO are applied by the hub by DEFAULT', () => {
  // ⛔ THE DEFAULT IS THE ANSWER THIS FUNCTION ALWAYS GAVE, because the GET
  // handler cannot know which consoles a pending change covers.
  for (const purpose of ['console-address', 'sso'] as const) {
    const t = resolveRestartTarget(purpose, true)
    assert.deepEqual(t.services, [HUB_SERVICE], purpose)
  }
  assert.match(resolveRestartTarget('console-address', true).why, /NextAuth builds its options once/i)
  assert.match(resolveRestartTarget('sso', true).why, /read once at startup/i)
})

test('a console-address change restarts exactly the consoles named, and SpanVault brings its API', () => {
  // ⛔ `SpanVault-API` IS NOT OPTIONAL. `spanvault/api/rbacScope.js`'s
  // `trustedFetchHostnames` puts NEXTAUTH_URL into the SSRF allow-list that
  // decides which hostnames a server-side fetch may use, and that process
  // dotenv-loads the same root `.env.local` this feature writes. Restart only
  // `SpanVault-App` and the API goes on trusting the old hostname — on routes
  // reachable with no session, i.e. sign-in itself.
  const t = resolveRestartTarget('console-address', true, ['spanvault'])
  assert.deepEqual(t.services, ['SpanVault-App', 'SpanVault-API'])

  // ⛔ AND LOGVAULT'S COLLECTOR IS THE SAME CLASS, FOUND BY LOOKING. Every alert
  // email's links come from `logvault/collector/emailer.js`'s `appUrl()` =
  // `process.env.NEXTAUTH_URL`, and that service dotenv-loads the same root
  // `.env.local` the hub just wrote. Restart only the console and every alert
  // email keeps pointing at the old address — the one symptom nobody sees in
  // the product.
  assert.deepEqual(resolveRestartTarget('console-address', true, ['logvault']).services,
    ['LogVault-App', 'LogVault-Collector'])
  // ⛔ AND NOTHING THAT DOES NOT READ THE VALUE: DDIVault has no second reader,
  // so restarting its API or collector would be an outage for nothing.
  assert.deepEqual(resolveRestartTarget('console-address', true, ['ddivault']).services, ['DDIVault-App'])

  const all = resolveRestartTarget('console-address', true, ['netvault', 'logvault', 'ddivault', 'spanvault'])
  assert.deepEqual(all.services, [
    'NetVault', 'LogVault-App', 'LogVault-Collector', 'DDIVault-App', 'SpanVault-App', 'SpanVault-API',
  ])
  // The hub is NOT dragged in by a satellite-only change: bouncing the console
  // the operator is holding, for a change that is not its own, is an outage for
  // nothing.
  assert.ok(!resolveRestartTarget('console-address', true, ['logvault']).services.includes(HUB_SERVICE))
})

test('an SSO change is never fanned out to the satellites', () => {
  // ⛔ THE DIRECTORY SETTINGS ARE THE HUB'S ALONE — the satellites verify a
  // token the hub signed and have no Entra configuration of their own.
  const t = resolveRestartTarget('sso', true, ['netvault', 'logvault', 'ddivault', 'spanvault'])
  assert.deepEqual(t.services, [HUB_SERVICE])
})

test('the slug→service mapping is the one place that knows the names', () => {
  // ⛔ NOT A PATTERN: the hub is bare `NetVault` while the satellites carry an
  // `-App` suffix, so deriving a service name from a slug would be wrong for
  // the hub and right by accident for the rest.
  assert.equal(CONSOLES.netvault.service, 'NetVault')
  assert.equal(CONSOLES.logvault.service, 'LogVault-App')
  assert.equal(CONSOLES.ddivault.service, 'DDIVault-App')
  assert.equal(CONSOLES.spanvault.service, 'SpanVault-App')
  // And the ports come from lib/publicUrl.ts's SIBLING_PORTS, not from a second copy.
  assert.deepEqual(
    [CONSOLES.netvault.publicPort, CONSOLES.logvault.publicPort, CONSOLES.ddivault.publicPort, CONSOLES.spanvault.publicPort],
    [3000, 3004, 3006, 3008],
  )
})

test('isRestartPurpose refuses anything that is not one of the three', () => {
  assert.equal(isRestartPurpose('certificate'), true)
  for (const v of ['NetVault', 'NocVault-Tls', 'restart', '', null, undefined, 1, {}]) {
    assert.equal(isRestartPurpose(v), false, String(v))
  }
})

// ─── the verdict ────────────────────────────────────────────────────────────

/** What a refused stop actually looks like: Running throughout, same PID. */
const REFUSED_STOP_LOG = [
  '[NV-RESTART] service=NetVault started 2026-11-06T09:00:00',
  '[NV-RESTART] pid before: 6224',
  '[NV-RESTART] stop issued: FAILED 1051: The service cannot be stopped because other services depend on it',
  '[NV-RESTART] state after 60004 ms: Running',
  '[NV-RESTART] start issued: FAILED 1056: An instance of the service is already running',
  '[NV-RESTART] pid after: 6224 changed=False',
  '[NV-RESTART] running=True after 12 ms',
  `${RESTART_SENTINEL} exit=1`,
].join('\r\n')

const GOOD_LOG = [
  '[NV-RESTART] service=NetVault started 2026-11-06T09:09:58',
  '[NV-RESTART] pid before: 6224',
  '[NV-RESTART] dependent NocVault-Tls stop: SERVICE_NAME: NocVault-Tls STATE : 4 RUNNING',
  '[NV-RESTART] state after 257 ms: Stopped',
  '[NV-RESTART] dependent NocVault-Tls back: True',
  '[NV-RESTART] pid after: 7120 changed=True',
  '[NV-RESTART] running=True after 4320 ms',
  `${RESTART_SENTINEL} exit=0`,
].join('\r\n')

test('a REFUSED stop reports failure even though the service is Running', () => {
  const r = parseRestartLog(REFUSED_STOP_LOG)
  assert.equal(r.finished, true)
  assert.equal(r.outcome, 'failed')
  assert.notEqual(r.outcome, 'succeeded')
})

test('"running=True" alone is NOT success — the PID must have changed', () => {
  const log = [
    '[NV-RESTART] pid after: 999 changed=False',
    '[NV-RESTART] running=True after 10 ms',
    `${RESTART_SENTINEL} exit=0`,
  ].join('\n')
  assert.equal(parseRestartLog(log).outcome, 'failed')
})

test('a real restart is succeeded', () => {
  const r = parseRestartLog(GOOD_LOG)
  assert.equal(r.outcome, 'succeeded')
  assert.equal(r.finished, true)
})

test('a run where ONE of several services did not come back is a failure, and it is NAMED', () => {
  // ⛔ "THREE OF THE FOUR CONSOLES TOOK THE NEW ADDRESS" IS NOT A SUCCESS: the
  // fourth is the one nobody can sign in to. And an unnamed failure sends an
  // operator to check all four by hand.
  const log = [
    '[NV-RESTART] runId=r1 services=NetVault,LogVault-App',
    '[NV-RESTART] service=NetVault pid after: 7120 changed=True',
    '[NV-RESTART] service=NetVault running=True after 4320 ms',
    '[NV-RESTART] service=LogVault-App pid after: 6224 changed=False',
    '[NV-RESTART] service=LogVault-App running=True after 120 ms',
    `${RESTART_SENTINEL} exit=1`,
  ].join('\r\n')
  const r = parseRestartLog(log)
  assert.equal(r.outcome, 'failed')
  assert.deepEqual(r.failedServices, ['LogVault-App'])
  assert.equal(r.services.length, 2)
})

test('every service coming back with a new PID is a success', () => {
  const log = [
    '[NV-RESTART] runId=r1 services=SpanVault-App,SpanVault-API',
    '[NV-RESTART] service=SpanVault-App pid after: 11 changed=True',
    '[NV-RESTART] service=SpanVault-App running=True after 9 ms',
    '[NV-RESTART] service=SpanVault-API pid after: 12 changed=True',
    '[NV-RESTART] service=SpanVault-API running=True after 9 ms',
    `${RESTART_SENTINEL} exit=0`,
  ].join('\r\n')
  const r = parseRestartLog(log)
  assert.equal(r.outcome, 'succeeded')
  assert.deepEqual(r.failedServices, [])
})

test('a log with NO per-service lines at all is failed, never succeeded', () => {
  // ⛔ THE WRAPPER DIED BEFORE IT SAID ANYTHING. With "any running=True" as the
  // test this was already failed; with "every service" it must not become
  // vacuously true — an empty set satisfies "all of them".
  const r = parseRestartLog(`[NV-RESTART] runId=r1 services=NetVault\r\n${RESTART_SENTINEL} exit=1`)
  assert.equal(r.outcome, 'failed')
})

test('a log from the PREVIOUS build, with no service= prefix, is still read', () => {
  // ⛔ THE FILE ON DISK RIGHT AFTER A DEPLOY IS THE OLD WRAPPER'S. Ignoring an
  // unprefixed line would find no services, and "all of none succeeded" would
  // turn an old FAILED run into a green verdict.
  const r = parseRestartLog([
    '[NV-RESTART] pid after: 6224 changed=False',
    '[NV-RESTART] running=True after 12 ms',
    `${RESTART_SENTINEL} exit=1`,
  ].join('\r\n'))
  assert.equal(r.outcome, 'failed')
  assert.deepEqual(r.failedServices, [''])
})

test('no sentinel means still running; no log at all means none', () => {
  assert.equal(parseRestartLog('[NV-RESTART] pid before: 1').outcome, 'running')
  assert.equal(parseRestartLog(null).outcome, 'none')
  assert.equal(parseRestartLog(undefined).outcome, 'none')
})

// ─── the wrapper ────────────────────────────────────────────────────────────

const wrapperArgs = {
  services: [HUB_SERVICE],
  log: 'C:\\Apps\\NetVault\\app\\logs\\service-restart.log',
  lock: 'C:\\Apps\\NetVault\\app\\logs\\service-restart.lock',
  taskName: RESTART_TASK_NAME,
  // ⛔ The arm token. Without it the wrapper refuses to touch a service, which
  // is what stops an orphaned task re-running it unattended. See lib/runLock.ts.
  runId: 'run-under-test',
}

test('the hub wrapper stops its dependents BEFORE the service and starts them after', () => {
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [TERMINATOR_SERVICE] })
  const depsDecl = s.indexOf(`$deps = @('${TERMINATOR_SERVICE}')`)
  const depStop = s.indexOf('sc.exe stop $d')
  const svcStop = s.indexOf('sc.exe stop $svc')
  const svcStart = s.indexOf('sc.exe start $svc')
  const depStart = s.indexOf('sc.exe start $d')
  assert.ok(depsDecl > 0, 'the dependent list must be declared')
  assert.ok(depStop > 0 && depStop < svcStop, 'dependents must stop BEFORE the service')
  assert.ok(svcStart > svcStop, 'the service starts after it stops')
  assert.ok(depStart > svcStart, 'dependents come back AFTER the service')
})

test('the wrapper captures the PID on both sides and makes the change part of the verdict', () => {
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [TERMINATOR_SERVICE] })
  assert.ok(s.includes('$before = (Get-CimInstance Win32_Service'), 'PID before')
  assert.ok(s.includes('$after = (Get-CimInstance Win32_Service'), 'PID after')
  assert.ok(s.includes('$changed = ($before -ne $after)'))
  // ⛔ EVERY service, not any: `$allOk` is false the moment one of them did not
  // come back with a new PID, and the dependents still have to be up.
  assert.ok(s.includes('if (-not ($running -and $changed)) { $allOk = $false }'))
  assert.ok(s.includes('$rc = if ($allOk -and $depsBack) { 0 } else { 1 }'))
})

test('the sentinel is written before the cleanup, inside finally', () => {
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [] })
  const sentinel = s.indexOf(RESTART_SENTINEL)
  assert.ok(sentinel > 0)
  assert.ok(s.indexOf('Remove-Item -LiteralPath $lock') > sentinel, 'lock removal after the sentinel')
  // ⛔ `lastIndexOf`, BECAUSE THERE ARE NOW TWO `/delete` CALLS AND THE FIRST
  // IS SUPPOSED TO COME EARLY. The arm guard deletes the task and exits when a
  // wrapper was not armed for this run (an orphaned task firing at midnight);
  // the SELF-delete is the one that has to follow the sentinel.
  assert.ok(s.lastIndexOf('/delete') > sentinel, 'task self-delete after the sentinel')
  assert.ok(s.includes('} finally {'))
})

test('the start is retried until the service runs, and never fired into a pending transition', () => {
  // ⛔ THIS TEST USED TO BE CALLED "the service is started even when the stop
  // timed out", which is what the function's header claimed and what the loop
  // has never done. A start issued while the service is STOP_PENDING is
  // REJECTED by the SCM (1056/1061) — and the only way the stop poll times out
  // is the service still being STOP_PENDING, so one unconditional attempt at
  // that moment is guaranteed to be refused. The real guarantee is about the
  // END state: skip a pending transition, ask again a second later, for 150 s.
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [] })
  const stopLoopEnd = s.indexOf('state after $([int]$sw.ElapsedMilliseconds) ms')
  const start = s.indexOf('sc.exe start $svc')
  assert.ok(start > stopLoopEnd, 'the start comes after the stop poll')
  assert.ok(!/if \(\$state -eq .Stopped.\)[^\n]*sc\.exe start/.test(s), 'the start must not be conditional on the stop')
  assert.match(s, /while \(\$sw2\.Elapsed\.TotalSeconds -lt 150\)/, 'it must RETRY, not try once')
  assert.match(
    s,
    /if \(\$st -ne 'StartPending' -and \$st -ne 'StopPending'\)/,
    'it must skip a pending transition rather than fire into a guaranteed rejection',
  )
})

test('an ABSENT service is noticed once, not hammered for 150 seconds', () => {
  // ⛔ `$st` IS `$null` WHEN Get-Service FINDS NOTHING, and `$null` passes both
  // `-ne` tests — so the loop used to issue `sc.exe start` once a second for
  // 150 seconds against a name the SCM does not have, writing 150 log lines.
  // Reachable through the route's own tri-state (`present === null` still
  // offers the target, and `serviceExists() === null` does not block it).
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [] })
  const nullGuard = s.indexOf('if ($null -eq $st) {')
  const startCall = s.indexOf('sc.exe start $svc')
  assert.ok(nullGuard > 0, 'the absent-service branch must exist')
  assert.ok(nullGuard < startCall, 'and it must be checked BEFORE a start is attempted')
  assert.match(s, /is not installed on this host - nothing to start/)
})

test('the wrapper refuses to act unless the route armed it for THIS run', () => {
  // ⛔ THE ORPHANED TASK. Nothing deleted `NocVault-ServiceRestart` when the
  // wrapper started and then died (reboot, task terminated, PowerShell crash),
  // and a `/sc once /st 00:00` trigger whose start time has passed fires the
  // FOLLOWING day — so a restart nobody asked for ran at midnight. The guard
  // has to come before any `sc.exe`, and it has to take the task with it.
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [TERMINATOR_SERVICE] })
  const guard = s.indexOf("$runId = 'run-under-test'")
  const refuse = s.indexOf('[NV-LOCK] refusing')
  const firstSc = s.indexOf('sc.exe')
  assert.ok(guard > 0, 'the run id must be baked into the wrapper')
  assert.ok(refuse > 0, 'there must be a refusal branch')
  assert.ok(refuse < firstSc, 'the refusal must be decided before any sc.exe call')
  assert.ok(s.indexOf('exit 0') < firstSc, 'and it must exit, not fall through')
  assert.match(s, /pending\\s\+" \+ \[regex\]::Escape\(\$runId\)/, 'it must match THIS run, not any claim')
})

test('the wrapper heartbeats the lock while it works', () => {
  // ⛔ WITHOUT THIS, AGE IS NOT A DEATH SIGNAL. The old reaper was
  // `dead || old` against an mtime written once at wrapper start, so `old`
  // alone removed the lock of a run that was still working.
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [TERMINATOR_SERVICE] })
  const writes = s.split('$PID | Out-File -FilePath $lock').length - 1
  assert.ok(writes >= 4, `the lock must be rewritten as the run proceeds, found ${writes} writes`)
})

test('a terminator restart carries no dependents', () => {
  const s = buildRestartWrapper({ ...wrapperArgs, services: [TERMINATOR_SERVICE], dependents: [] })
  assert.ok(s.includes('$deps = @()'))
  assert.ok(s.includes("$services = @('NocVault-Tls')"))
})

test('no service in the run is ever listed as its own dependent', () => {
  // ⛔ WITH A LIST THE FILTER HAS TO CONSIDER EVERY SERVICE IN THE RUN, not just
  // one: stopping SpanVault-App "as a dependent" and then again as a target
  // doubles the outage and confuses the verdict.
  const s = buildRestartWrapper({
    ...wrapperArgs,
    services: ['SpanVault-App', 'SpanVault-API'],
    dependents: ['SpanVault-API', TERMINATOR_SERVICE],
  })
  assert.ok(s.includes(`$deps = @('${TERMINATOR_SERVICE}')`), 'a service in the run is filtered out')
  assert.ok(s.includes("$services = @('SpanVault-App', 'SpanVault-API')"))
})

test('ONE wrapper walks the whole list, because the run lock is ONE file', () => {
  // ⛔ `restartPaths` gives a single `logs/service-restart.lock`, so two
  // concurrent restarts cannot exist — one POST per console would have the
  // second, third and fourth refused with 409. The wrapper takes the list, and
  // the shared front door comes down ONCE and goes back up LAST.
  const s = buildRestartWrapper({
    ...wrapperArgs,
    services: ['NetVault', 'LogVault-App'],
    dependents: [TERMINATOR_SERVICE],
  })
  assert.equal((s.match(/foreach \(\$svc in \$services\)/g) || []).length, 1, 'one loop over the services')
  assert.equal((s.match(/sc\.exe stop \$d/g) || []).length, 1, 'the front door is stopped once')
  assert.ok(s.indexOf('sc.exe stop $d') < s.indexOf('foreach ($svc in $services)'), 'before any console')
  assert.ok(s.lastIndexOf('sc.exe start $d') > s.lastIndexOf('sc.exe start $svc'), 'and comes back last')
})

test('the wait limit covers the wrapper\'s own worst case for every size of run', () => {
  // ⛔ A FIXED LIMIT IS WRONG AS SOON AS THE LIST CAN HOLD MORE THAN ONE. Per
  // service: 60 s polling for Stopped + 150 s of start attempts. Per dependent:
  // 45 s to stop + 90 s to come back.
  assert.ok(restartWaitLimitMs(1, 1) >= 345_000, 'one service behind the front door')
  assert.ok(restartWaitLimitMs(6, 1) >= (45 + 6 * 210 + 90) * 1000, 'all four consoles and their companions')
  // Monotonic, and never zero for a nonsense count.
  assert.ok(restartWaitLimitMs(6, 1) > restartWaitLimitMs(1, 1))
  assert.ok(restartWaitLimitMs(0, 0) > 0)
})

test('paths sit beside the updater\'s, under the repo root', () => {
  const p = restartPaths('C:\\Apps\\NetVault\\app')
  assert.equal(p.log, 'C:\\Apps\\NetVault\\app\\logs\\service-restart.log')
  assert.equal(p.wrapper, 'C:\\Apps\\NetVault\\app\\logs\\service-restart-run.ps1')
})
