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
} from '../lib/serviceRestart.ts'

// ─── which service applies which change ─────────────────────────────────────

test('a certificate is applied by the terminator, NOT by the hub', () => {
  const t = resolveRestartTarget('certificate', true)
  assert.equal(t.service, TERMINATOR_SERVICE)
  assert.notEqual(t.service, HUB_SERVICE)
  assert.match(t.why, /terminates TLS/i)
})

test('with no terminator a certificate needs no restart at all', () => {
  // ⛔ NOT "restart NetVault". There is nothing serving the certificate yet, so
  // bouncing a service achieves nothing and invites the conclusion that the
  // certificate is broken.
  const t = resolveRestartTarget('certificate', false)
  assert.equal(t.service, null)
  assert.match(t.why, /HTTPS is not turned on/i)
  assert.match(t.why, /Settings → HTTPS/)
})

test('the console address and SSO are applied by the hub', () => {
  for (const purpose of ['console-address', 'sso'] as const) {
    const t = resolveRestartTarget(purpose, true)
    assert.equal(t.service, HUB_SERVICE, purpose)
  }
  assert.match(resolveRestartTarget('console-address', true).why, /NextAuth builds its options once/i)
  assert.match(resolveRestartTarget('sso', true).why, /read once at startup/i)
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

test('no sentinel means still running; no log at all means none', () => {
  assert.equal(parseRestartLog('[NV-RESTART] pid before: 1').outcome, 'running')
  assert.equal(parseRestartLog(null).outcome, 'none')
  assert.equal(parseRestartLog(undefined).outcome, 'none')
})

// ─── the wrapper ────────────────────────────────────────────────────────────

const wrapperArgs = {
  service: HUB_SERVICE,
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
  assert.ok(s.includes('$rc = if ($running -and $changed -and $depsBack) { 0 } else { 1 }'))
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
  const s = buildRestartWrapper({ ...wrapperArgs, service: TERMINATOR_SERVICE, dependents: [] })
  assert.ok(s.includes('$deps = @()'))
  assert.ok(s.includes("$svc  = 'NocVault-Tls'"))
})

test('a service is never listed as its own dependent', () => {
  const s = buildRestartWrapper({ ...wrapperArgs, dependents: [HUB_SERVICE, TERMINATOR_SERVICE] })
  assert.ok(s.includes(`$deps = @('${TERMINATOR_SERVICE}')`), 'the service itself is filtered out')
})

test('paths sit beside the updater\'s, under the repo root', () => {
  const p = restartPaths('C:\\Apps\\NetVault\\app')
  assert.equal(p.log, 'C:\\Apps\\NetVault\\app\\logs\\service-restart.log')
  assert.equal(p.wrapper, 'C:\\Apps\\NetVault\\app\\logs\\service-restart-run.ps1')
})
