//
// tests/tlsTransport.test.ts — the judgements behind Settings → HTTPS.
//
// ⛔ THE FIRST BLOCK IS THE ONE THAT MATTERS. `Enable-NocVaultTls.ps1` exits 0
// whether it enabled HTTPS or reverted everything and left the suite on plain
// HTTP — MEASURED on production on 2026-11-06, twice. Every test below that
// feeds a reverted run's log through `parseRunLog` exists to stop a future
// change deciding the outcome from the exit code, because the first thing that
// looks like a simplification here is exactly that.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN_SENTINEL,
  TRANSPORT_TASK_NAME,
  buildWrapperScript,
  destinationUrl,
  engineArgs,
  isTransportAction,
  parseRunLog,
  psLiteral,
  transportCapability,
  transportPaths,
  validatePublicHost,
} from '../lib/tlsTransport.ts'

// ─── the verdict comes from the banner, never the exit code ──────────────────

/** A real reverted run, trimmed: gate 3 failed, everything was put back, exit 0. */
const REVERTED_LOG = [
  '[NV-TRANSPORT] action=enable started 2026-11-06T07:40:00',
  '    [OK] netvault answering on 127.0.0.1:13000',
  '    [OK] logvault answering on 127.0.0.1:13004',
  '    [!!] No HTTPS 200 for netvault on :3000',
  '    [--]   probe said      : 60 attempt(s) over 60s: 60x The underlying connection was closed.',
  '    [!!] REVERTING the TLS cutover - the terminator did not prove itself',
  '    [OK] netvault is back on plain HTTP :3000',
  '  |   HTTPS was NOT enabled - the suite is unchanged      |',
  `${RUN_SENTINEL} exit=0 action=enable`,
].join('\r\n')

const ENABLED_LOG = [
  '[NV-TRANSPORT] action=enable started 2026-11-06T07:56:00',
  '    [OK] Certificate paths written where the terminator reads them (TLS_CERT_PATH, TLS_KEY_PATH)',
  '    [OK] HTTPS 200 for netvault through the terminator on :3000',
  '    [OK] GATE 3 PASS - NocVault-Tls is terminating TLS for every installed console',
  '  |   HTTPS is ON                                        |',
  `${RUN_SENTINEL} exit=0 action=enable`,
].join('\r\n')

test('a reverted run exits 0 and must NOT be read as enabled', () => {
  const report = parseRunLog(REVERTED_LOG)
  assert.equal(report.exitCode, 0, 'the engine really does exit 0 on a revert')
  assert.equal(report.outcome, 'reverted')
  assert.notEqual(report.outcome, 'enabled')
  assert.equal(report.finished, true)
  assert.equal(report.action, 'enable')
})

test('a successful run is enabled, with the same exit code as the failed one', () => {
  const ok = parseRunLog(ENABLED_LOG)
  const bad = parseRunLog(REVERTED_LOG)
  assert.equal(ok.outcome, 'enabled')
  assert.equal(bad.outcome, 'reverted')
  // The whole point: the exit codes are identical, so they cannot be the input.
  assert.equal(ok.exitCode, bad.exitCode)
})

test('"HTTPS was NOT enabled" is not matched as "HTTPS is ON" — and ALONE it is a refusal', () => {
  // The failure banner contains the word HTTPS; a looser matcher ordered the
  // other way round would report the failed run as a success.
  const r = parseRunLog(`x\n  HTTPS was NOT enabled\n${RUN_SENTINEL} exit=0 action=enable`)
  assert.notEqual(r.outcome, 'enabled')
  // ⛔ AND IT IS `refused`, NOT `reverted`, WHICH IS WHAT THIS ASSERTED BEFORE.
  // That banner is printed whenever `$script:TlsCutoverApplied` is false —
  // INCLUDING when the gates never passed and nothing was touched at all
  // (`NocVault-TlsCutover.ps1`'s `if (-not $TlsGateOk)` branch). `Gates did NOT
  // pass` is only ever printed on the `-DryRun` branch, so with this mapping a
  // REAL enable with failing gates could not reach `refused` at all: every one
  // of them rendered `reverted`'s copy, which promises the engine "put every
  // console back the way it found it". Nothing had been moved.
  assert.equal(r.outcome, 'refused')
})

test('a revert and a refusal are told apart by the line only a REVERT prints', () => {
  // ⛔ THE CLOSING BANNER IS THE SAME ON BOTH PATHS, so the only evidence that
  // four consoles were actually moved is `Undo-TlsCutover`'s own line — written
  // nowhere else in the engine. With it, the stronger copy is earned.
  const refused = parseRunLog([
    '[NV-TRANSPORT] action=enable started now',
    '  Not installed. A certificate pair was not found.',
    '  HTTPS was NOT enabled - the suite is unchanged',
    `${RUN_SENTINEL} exit=0 action=enable`,
  ].join('\r\n'))
  const reverted = parseRunLog([
    '[NV-TRANSPORT] action=enable started now',
    '  REVERTING the TLS cutover - netvault did NOT answer https on :3000',
    '  HTTPS was NOT enabled - the suite is unchanged',
    `${RUN_SENTINEL} exit=0 action=enable`,
  ].join('\r\n'))
  assert.equal(refused.outcome, 'refused')
  assert.equal(reverted.outcome, 'reverted')
})

test('a run with no sentinel is still running, and claims no outcome', () => {
  const report = parseRunLog('[NV-TRANSPORT] action=enable started now\n    [OK] netvault answering')
  assert.equal(report.outcome, 'running')
  assert.equal(report.finished, false)
  assert.equal(report.exitCode, null)
})

test('no log at all is "none", which is not a failure', () => {
  const report = parseRunLog(null)
  assert.equal(report.outcome, 'none')
  assert.equal(report.finished, false)
  assert.deepEqual(report.lines, [])
})

test('a finished run with no banner we know is "unknown", never "enabled"', () => {
  const report = parseRunLog(`something unexpected\n${RUN_SENTINEL} exit=0 action=enable`)
  assert.equal(report.outcome, 'unknown')
})

test('disable and preview report their own outcomes', () => {
  assert.equal(parseRunLog(`  HTTPS is OFF - all consoles serve directly\n${RUN_SENTINEL} exit=0 action=disable`).outcome, 'disabled')
  assert.equal(parseRunLog(`    [--] Re-run without -DryRun to do it.\n${RUN_SENTINEL} exit=0 action=preview`).outcome, 'previewed')
})

test('gate failures and probe verdicts are surfaced as highlights', () => {
  const report = parseRunLog(REVERTED_LOG)
  assert.ok(report.highlights.some((l) => l.includes('No HTTPS 200 for netvault')))
  assert.ok(report.highlights.some((l) => l.includes('probe said')))
  assert.ok(!report.highlights.some((l) => l.includes('answering on 127.0.0.1:13000')), 'an [OK] line is not a highlight')
})

// ─── the hostname is the only input, and it reaches a SYSTEM command line ────

test('a plain hostname is accepted', () => {
  assert.deepEqual(validatePublicHost('console.example.com'), { ok: true, host: 'console.example.com' })
  assert.deepEqual(validatePublicHost('  TH-CYBE-PRT-001.thaiunion.co.th  '), { ok: true, host: 'TH-CYBE-PRT-001.thaiunion.co.th' })
})

test('blank means "use the address the browser sends" and is allowed', () => {
  for (const v of ['', null, undefined, '   ']) {
    const verdict = validatePublicHost(v)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.ok && verdict.host, '')
  }
})

test('an IP address is refused, because Entra refuses it', () => {
  const verdict = validatePublicHost('192.168.6.111')
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : '', /Entra refuses an IP address/i)
})

test('every shell metacharacter is refused — this value runs as SYSTEM', () => {
  const attacks = [
    "host'; Remove-Item C:\\ -Recurse",
    'host`whoami`',
    'host$(whoami)',
    'host;shutdown /r',
    'host|calc',
    'host&calc',
    'host with space',
    'host"quote',
    "host'quote",
    'host\nnewline',
    'host\\backslash',
    '../../etc/passwd',
    '-Disable',
    '@{}',
  ]
  for (const a of attacks) {
    assert.equal(validatePublicHost(a).ok, false, `must refuse: ${JSON.stringify(a)}`)
  }
})

test('a hostname cannot start or end a label with a hyphen, or exceed the length limits', () => {
  assert.equal(validatePublicHost('-leading.example.com').ok, false)
  assert.equal(validatePublicHost('trailing-.example.com').ok, false)
  assert.equal(validatePublicHost('a..b').ok, false)
  assert.equal(validatePublicHost(`${'a'.repeat(64)}.example.com`).ok, false)
  assert.equal(validatePublicHost(`${'a'.repeat(250)}.com`).ok, false)
})

test('psLiteral doubles single quotes, so quoting does not rely on the validator', () => {
  assert.equal(psLiteral("it's"), "'it''s'")
  assert.equal(psLiteral('plain'), "'plain'")
})

// ─── the command line the wrapper builds ─────────────────────────────────────

test('each action maps to the engine switch that performs it', () => {
  assert.deepEqual(engineArgs('preview'), ['-DryRun'])
  assert.deepEqual(engineArgs('disable'), ['-Disable'])
  assert.deepEqual(engineArgs('enable'), [])
})

test('a public host is passed for enable and preview, never for disable', () => {
  assert.deepEqual(engineArgs('enable', 'a.example.com'), ['-TlsPublicHost', "'a.example.com'"])
  assert.deepEqual(engineArgs('preview', 'a.example.com'), ['-DryRun', '-TlsPublicHost', "'a.example.com'"])
  assert.deepEqual(engineArgs('disable', 'a.example.com'), ['-Disable'])
})

test('the wrapper writes its sentinel before it cleans up, and deletes its own task', () => {
  const script = buildWrapperScript({
    script: 'C:\\Apps\\NetVault\\app\\installer\\Enable-NocVaultTls.ps1',
    action: 'enable',
    log: 'C:\\Apps\\NetVault\\app\\logs\\tls-transport.log',
    lock: 'C:\\Apps\\NetVault\\app\\logs\\tls-transport.lock',
    taskName: TRANSPORT_TASK_NAME,
    runId: 'run-under-test',
  })
  const sentinelAt = script.indexOf(RUN_SENTINEL)
  // ⛔ `lastIndexOf`: the arm guard also deletes the task (early, on a refusal
  // — an orphan firing at midnight), so the SELF-delete is the last one.
  const deleteAt = script.lastIndexOf('/delete')
  const lockRemoveAt = script.indexOf('Remove-Item -LiteralPath $lock')
  assert.ok(sentinelAt > 0, 'the sentinel must be written')
  assert.ok(deleteAt > sentinelAt, 'the task delete must come after the sentinel')
  assert.ok(lockRemoveAt > sentinelAt, 'the lock removal must come after the sentinel')
  assert.ok(script.includes('finally'), 'the sentinel must be in a finally block')
  assert.ok(script.includes("'C:\\Apps\\NetVault\\app\\installer\\Enable-NocVaultTls.ps1'"))
})

test('the wrapper quotes a path containing spaces', () => {
  const script = buildWrapperScript({
    script: 'C:\\Program Files\\NocVault\\installer\\Enable-NocVaultTls.ps1',
    action: 'preview',
    log: 'C:\\Program Files\\NocVault\\logs\\tls-transport.log',
    lock: 'C:\\Program Files\\NocVault\\logs\\tls-transport.lock',
    taskName: TRANSPORT_TASK_NAME,
    runId: 'run-under-test',
  })
  assert.ok(script.includes("'C:\\Program Files\\NocVault\\installer\\Enable-NocVaultTls.ps1'"))
  assert.ok(script.includes('-DryRun'))
})

test('paths land under the repo root\'s logs folder, beside the updater\'s', () => {
  const p = transportPaths('C:\\Apps\\NetVault\\app')
  assert.equal(p.log, 'C:\\Apps\\NetVault\\app\\logs\\tls-transport.log')
  assert.equal(p.lock, 'C:\\Apps\\NetVault\\app\\logs\\tls-transport.lock')
  assert.equal(p.script, 'C:\\Apps\\NetVault\\app\\installer\\Enable-NocVaultTls.ps1')
})

// ─── which buttons the panel may offer ───────────────────────────────────────

const base = { platform: 'win32', scriptPresent: true, runInProgress: false }

test('the terminator running means the only move is off', () => {
  const cap = transportCapability({ ...base, terminator: 'running' })
  assert.equal(cap.canDisable, true)
  assert.equal(cap.canEnable, false)
  assert.equal(cap.canPreview, true)
  assert.equal(cap.blockedReason, null)
})

test('no terminator means the only move is on', () => {
  for (const terminator of ['absent', 'stopped'] as const) {
    const cap = transportCapability({ ...base, terminator })
    assert.equal(cap.canEnable, true, terminator)
    assert.equal(cap.canDisable, false, terminator)
  }
})

test('an unreadable service state blocks BOTH directions rather than guessing', () => {
  const cap = transportCapability({ ...base, terminator: 'unknown' })
  assert.equal(cap.canEnable, false)
  assert.equal(cap.canDisable, false)
  assert.equal(cap.canPreview, false)
  assert.match(cap.blockedReason || '', /unchecked condition, not a clean bill of health/i)
})

test('a run in progress blocks everything, and says so', () => {
  const cap = transportCapability({ ...base, terminator: 'absent', runInProgress: true })
  assert.equal(cap.canEnable, false)
  assert.match(cap.blockedReason || '', /already running/i)
})

test('a missing engine script is reported, not offered as a button', () => {
  const cap = transportCapability({ ...base, terminator: 'absent', scriptPresent: false })
  assert.equal(cap.canEnable, false)
  assert.match(cap.blockedReason || '', /Enable-NocVaultTls\.ps1 is missing/i)
})

test('a non-Windows host cannot act at all', () => {
  const cap = transportCapability({ ...base, platform: 'linux', terminator: 'absent' })
  assert.equal(cap.canEnable, false)
  assert.equal(cap.canPreview, false)
  assert.match(cap.blockedReason || '', /only available on the Windows host/i)
})

// ─── where the operator is sent afterwards ───────────────────────────────────

test('enable sends the operator to https on the host they are already using', () => {
  assert.equal(
    destinationUrl({ action: 'enable', browserHost: '192.168.6.111' }),
    'https://192.168.6.111:3000/settings?tab=https',
  )
})

test('a configured public host overrides the browser host', () => {
  assert.equal(
    destinationUrl({ action: 'enable', browserHost: '192.168.6.111', publicHost: 'console.example.com' }),
    'https://console.example.com:3000/settings?tab=https',
  )
})

test('disable sends them back to http', () => {
  assert.match(destinationUrl({ action: 'disable', browserHost: 'host' }) || '', /^http:\/\/host:3000/)
})

test('no host at all yields no link rather than a broken one', () => {
  assert.equal(destinationUrl({ action: 'enable', browserHost: '' }), null)
})

test('isTransportAction refuses anything else', () => {
  assert.equal(isTransportAction('enable'), true)
  for (const v of ['Enable', 'ENABLE', 'on', '', null, undefined, 1, {}]) {
    assert.equal(isTransportAction(v), false, String(v))
  }
})
