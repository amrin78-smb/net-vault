//
// tests/systemSeams.test.ts — the joins, not the parts.
//
// ⛔ EVERY SERIOUS DEFECT FOUND IN THE 2026-11-06 SWEEP OF THE HTTPS AND
// RESTART FEATURES WAS AT A SEAM, and every pure function involved was already
// well covered. Route -> panel props, lib -> route null handling, engine banner
// -> parser, panel state -> verdict. The two files holding the worst bugs had
// no test at all, while the best-tested file was the one that was mostly right.
// So these tests are deliberately about the JOINS: what one layer promises and
// what the next layer actually reads.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseScQcDependencies } from '../lib/terminatorState.ts'
import { parseRestartLog, RESTART_SENTINEL, buildRestartHeader } from '../lib/serviceRestart.ts'
import { parseRunLog, RUN_SENTINEL } from '../lib/tlsTransport.ts'
import { transportPresentation } from '../components/settings/systemPanelHelpers.ts'

const repo = path.resolve(import.meta.dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8')

// ─── seam 1: sc qc output -> the dependency decision ────────────────────────

test('dependencies on UNLABELLED continuation lines are all collected', () => {
  // ⛔ The real shape. A parser keying on the line containing DEPENDENCIES sees
  // only NetVault and silently misses three.
  const out = [
    'SERVICE_NAME: NocVault-Tls',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        DEPENDENCIES       : NetVault',
    '                           : LogVault-App',
    '                           : DDIVault-App',
    '                           : SpanVault-App',
    '        SERVICE_START_NAME : LocalSystem',
  ].join('\r\n')
  assert.deepEqual(parseScQcDependencies(out), ['NetVault', 'LogVault-App', 'DDIVault-App', 'SpanVault-App'])
})

test('an EMPTY dependency field is an empty list, not "unknown"', () => {
  const out = ['        DEPENDENCIES       :', '        SERVICE_START_NAME : LocalSystem'].join('\r\n')
  assert.deepEqual(parseScQcDependencies(out), [])
})

test('a MISSING label is null — never an empty list', () => {
  // ⛔ sc.exe LOCALISES its field names. Reading "no DEPENDENCIES line" as "no
  // dependencies" on a German or French Windows is a guess dressed as a fact,
  // and it is the reading that decides whether a shared front door gets
  // stopped. Two callers depend on telling these apart.
  assert.equal(parseScQcDependencies('ABHAENGIGKEITEN    : NetVault'), null)
  assert.equal(parseScQcDependencies(''), null)
})

test('the next labelled field ends the dependency block', () => {
  const out = [
    '        DEPENDENCIES       : NetVault',
    '        SERVICE_START_NAME : LocalSystem',
    '                           : not-a-dependency',
  ].join('\r\n')
  assert.deepEqual(parseScQcDependencies(out), ['NetVault'])
})

// ─── seam 2: the wrapper's log -> the restart verdict ───────────────────────

const restartLog = (...lines: string[]) => [buildRestartHeader('run-1', 'NetVault').trim(), ...lines].join('\r\n')

test('a dependent left DOWN is not a success, however well the service itself restarted', () => {
  // ⛔ THE FALSE ALL-CLEAR THIS FUNCTION EXISTS TO REFUSE, from the other side.
  // The hub restarts perfectly and NocVault-Tls never comes back: all four
  // consoles' public ports are dead. The wrapper already made $depsBack part of
  // its exit code, and this parser ignores exit codes by design — so the one
  // term that knew was being written where nothing read it.
  const log = restartLog(
    '[NV-RESTART] pid before: 6224',
    '[NV-RESTART] dependent NocVault-Tls stop: SERVICE_NAME: NocVault-Tls',
    '[NV-RESTART] dependent NocVault-Tls back: False',
    '[NV-RESTART] pid after: 7120 changed=True',
    '[NV-RESTART] running=True after 4320 ms',
    `${RESTART_SENTINEL} exit=1`,
  )
  assert.equal(parseRestartLog(log).outcome, 'failed')
})

test('dependents back up IS a success', () => {
  const log = restartLog(
    '[NV-RESTART] dependent NocVault-Tls back: True',
    '[NV-RESTART] pid after: 7120 changed=True',
    '[NV-RESTART] running=True after 10 ms',
    `${RESTART_SENTINEL} exit=0`,
  )
  assert.equal(parseRestartLog(log).outcome, 'succeeded')
})

test('the runId travels from the header to the report', () => {
  // ⛔ The panel matches this against the id POST handed it. Without it, the
  // seconds between `schtasks /run` and the wrapper starting are a window in
  // which the PREVIOUS run's green verdict is what the panel reads.
  const log = restartLog('[NV-RESTART] running=True', `${RESTART_SENTINEL} exit=0`)
  assert.equal(parseRestartLog(log).runId, 'run-1')
  assert.equal(parseRestartLog('nothing here').runId, null)
})

// ─── seam 3: the engine's REAL banners -> the transport verdict ─────────────

const runLog = (action: string, ...lines: string[]) =>
  [`[NV-TRANSPORT] action=${action} started 2026-11-06T09:00:00`, ...lines].join('\r\n')

test('a DISABLE that left a console unreachable is not reported as success', () => {
  // ⛔ VERBATIM from Enable-NocVaultTls.ps1's failure branch. A loose
  // /HTTPS is OFF\b/i matches this too, which rendered a green "HTTPS was
  // turned off" over a console that never came back. The doctrine "the banner
  // is the verdict, never the exit code" was derived from the ENABLE path,
  // where the engine exits 0 either way; on this path the exit code is the
  // disambiguator.
  const log = runLog('disable',
    '    [!!] logvault is NOT answering on :3004',
    '  HTTPS is off but at least one console did not come back - see above.',
    `${RUN_SENTINEL} exit=1 action=disable`,
  )
  const r = parseRunLog(log)
  assert.notEqual(r.outcome, 'disabled')
  assert.equal(r.exitCode, 1)
})

test('a clean DISABLE still reports disabled', () => {
  const log = runLog('disable',
    '  HTTPS is OFF - all consoles are serving directly again.',
    `${RUN_SENTINEL} exit=0 action=disable`,
  )
  assert.equal(parseRunLog(log).outcome, 'disabled')
})

test('a PREVIEW whose gates fail is refused, NOT reverted', () => {
  // ⛔ Nothing was moved, so nothing was put back. `reverted`'s copy promises
  // the engine "put every console back the way it found it" — asserting a
  // four-console cutover and rollback that never happened, for the action we
  // actively recommend doing first.
  const log = runLog('preview',
    '    [!!] Gates did NOT pass, so a real run would change nothing either.',
    `${RUN_SENTINEL} exit=0 action=preview`,
  )
  assert.equal(parseRunLog(log).outcome, 'refused')
})

test('the LAST banner wins, not the earliest pattern in the table', () => {
  // ⛔ The docs always said the final banner is authoritative; the loop used to
  // iterate the PATTERN list and ask whether any line matched anywhere, so
  // pattern order silently outranked the engine's chronology.
  const log = runLog('enable',
    '  HTTPS is ON for every console.',
    '  REVERTING the TLS cutover',
    '  HTTPS was NOT enabled.',
    `${RUN_SENTINEL} exit=0 action=enable`,
  )
  assert.equal(parseRunLog(log).outcome, 'reverted')
})

// ─── seam 4: route payload -> panel props ──────────────────────────────────

test('an UNKNOWN terminator does not render as a confident port claim', () => {
  const unknown = transportPresentation('active', { httpsPort: 13000, fronted: null })
  assert.equal(unknown.tone, 'warn')
  assert.match(unknown.headline, /could not be read/i)
  // It may mention the port this PROCESS is bound to; what it must never do is
  // present that as the address people connect to.
  assert.match(unknown.headline, /the public port is a different one/i)
})

test('a fronted install reports the PUBLIC port, not the loopback port', () => {
  const p = transportPresentation('active', { httpsPort: 13000, fronted: true, publicPort: 3000 })
  assert.match(p.headline, /port 3000/)
  assert.match(p.headline, /127\.0\.0\.1:13000/)
})

test('EVERY transportPresentation call site passes the terminator frame', () => {
  // ⛔ ENUMERATED, NOT HARD-CODED. The first version of this test named the two
  // panels that had just been fixed — so when a THIRD call site
  // (TransportPanel, the HTTPS tab itself) turned out to be missing the frame,
  // the test that existed to catch exactly that could not see it, and went
  // green beside the bug. A guard test that lists the known-good cases proves
  // nothing; it has to go and find the cases.
  const dir = path.join(repo, 'components/settings')
  const callers = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => /transportPresentation\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
  assert.ok(callers.length >= 3, `expected at least 3 call sites, found ${callers.length}`)
  for (const f of callers) {
    const call = /transportPresentation\([\s\S]{0,400}?\n\s*\}\)/.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    assert.ok(call, `${f}: could not read the call`)
    assert.match(call[0], /fronted:/, `${f} must pass fronted`)
    assert.match(call[0], /publicPort:/, `${f} must pass publicPort`)
  }
})

test('the two panels wired in 1.62.0 still pass it', () => {
  // ⛔ THE REGRESSION THIS FILE EXISTS FOR. `app/api/system/tls/route.ts` and
  // `console-url/route.ts` computed `fronted`/`publicPort` in 1.60.1 and NO
  // panel read either one, so the helper's whole fronted branch was dead code
  // — with five passing tests over it, because they called the helper directly.
  // The route and the helper were both right; the JOIN was missing, and nothing
  // could see it. Assert the call sites, because that is where the bug lived.
  for (const f of ['components/settings/CertificatePanel.tsx', 'components/settings/ConsoleAddressPanel.tsx']) {
    const src = read(f)
    assert.match(src, /transportPresentation\(/, `${f} should present a transport`)
    assert.match(src, /fronted:/, `${f} must pass fronted`)
    assert.match(src, /publicPort:/, `${f} must pass publicPort`)
  }
})

test('the private key path is in NO tls payload, including the one the panel reads', () => {
  // ⛔ CHECK THE ROUTE THAT IS ACTUALLY RENDERED. The first version asserted
  // this only against tls-transport — the route whose payload nothing read the
  // key path from — while `app/api/system/tls/route.ts` went on returning it
  // and CertificatePanel went on displaying it. The release note said it was
  // removed; the test agreed; the page still showed it.
  for (const f of ['app/api/system/tls-transport/route.ts', 'app/api/system/tls/route.ts']) {
    assert.doesNotMatch(read(f), /^\s*keyPath: config\.keyPath,/m, f)
  }
  assert.doesNotMatch(read('components/settings/CertificatePanel.tsx'), /keyPath: data\.keyPath/)

  // ⛔ AND THE ROW MUST STILL TELL THE TRUTH. Removing the field was only half
  // the fix: the "Private key file" row branched on `state.keyPath`, so with
  // the field gone it reported "Not configured" for a key that was configured
  // and present. A redaction that silently changes what the page CLAIMS is a
  // new bug, not a fix — so pin the replacement seam in both directions.
  const panel = read('components/settings/CertificatePanel.tsx')
  const tlsRoute = read('app/api/system/tls/route.ts')
  assert.doesNotMatch(panel, /state\.keyPath/, 'the panel must not read a key path at all')
  assert.match(tlsRoute, /keyConfigured: Boolean\(config\.keyPath\)/, 'the route must send keyConfigured')
  assert.match(panel, /state\.keyConfigured/, 'the panel must branch on keyConfigured, not on a path')
})

test('the restart route derives its dependents from a real dependency probe', () => {
  // ⛔ It used to key on the terminator merely EXISTING, which re-created the
  // four-console outage the updaters had just been fixed to avoid — while the
  // confirm dialog promised the other three were unaffected.
  const src = read('app/api/system/service-restart/route.ts')
  assert.match(src, /terminatorDependsOn\(HUB_SERVICE\)/)
  assert.doesNotMatch(src, /dependents:.*present === true/)
})

test('the console-address example port cannot be the loopback port', () => {
  const src = read('app/api/system/console-url/route.ts')
  assert.doesNotMatch(src, /examplePort: tls\.httpsPort \|\| DEFAULT_CONSOLE_PORT/)
  assert.match(src, /HUB_PUBLIC_PORT/)
})
