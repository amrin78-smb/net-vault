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
import os from 'node:os'
import path from 'node:path'
import { parseScQcDependencies, parseScQueryState, readingFromScQuery } from '../lib/terminatorState.ts'
import {
  parseRestartLog,
  RESTART_SENTINEL,
  buildRestartHeader,
  buildRestartWrapper,
} from '../lib/serviceRestart.ts'
import { parseRunLog, RUN_SENTINEL, buildWrapperScript } from '../lib/tlsTransport.ts'
import { transportPresentation } from '../components/settings/systemPanelHelpers.ts'
import {
  ARM_WINDOW_MS,
  LOCK_IDLE_MS,
  claimRunLock,
  parseLockBody,
  pendingLockBody,
  readRunLock,
  releaseRunLock,
  type LockEnv,
} from '../lib/runLock.ts'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, resolvePaging } from '../lib/pagination.ts'
import {
  PRIVILEGED_LICENSE_FIELDS,
  licensePayloadFor,
  publicLicensePayload,
} from '../lib/licensePayload.ts'
import { SSO_CLAIM_KEYS, handoffIdentity, ssoClaims } from '../lib/ssoHandoff.ts'

const repo = path.resolve(import.meta.dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8')

/**
 * The same file with its comments removed.
 *
 * ⛔ NEEDED BECAUSE THIS CODEBASE EXPLAINS ITS BUGS IN PROSE. A guard that
 * refuses `getToken(` or `reapStaleLock` would match the comment SAYING those
 * were removed and fail on a correct file — which, tuned away, is how a guard
 * test ends up asserting nothing.
 */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const code = (rel: string) => strip(read(rel))

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

// ─── seam 5: the hub's identity (Group A) ───────────────────────────────────

test('EVERY sso handoff route goes through getServerSession, not getToken', () => {
  // ⛔ ENUMERATED, NOT NAMED — the lesson from the `transportPresentation` test
  // above. `getToken({ req, secret })` only DECODES the cookie: it runs no
  // callbacks, so `[...nextauth]`'s `jwt` callback — which IS the mid-session
  // revocation layer, and whose own header says "a mapping an administrator
  // revokes must stop working at once" — never ran on two of the three
  // handoffs. A directory user whose group→role mapping had been revoked was
  // refused by logvault's handoff and handed a token carrying the OLD mapped
  // role by ddivault's and spanvault's.
  const dir = path.join(repo, 'app/api/sso')
  const slugs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  assert.ok(slugs.length >= 3, `expected at least 3 handoff routes, found ${slugs.length}`)
  for (const slug of slugs) {
    const src = code(path.join('app/api/sso', slug, 'route.ts'))
    assert.match(src, /getServerSession\(authOptions\)/, `${slug} must read the session, not decode the cookie`)
    assert.doesNotMatch(src, /\bgetToken\b/, `${slug} must not use getToken — it runs no callbacks`)
  }
})

test('every sso handoff mints the SAME claim set, and builds it in one place', () => {
  // ⛔ SPANVAULT REQUIRES `userId` AND `app === 'spanvault'` IN THE PAYLOAD
  // (spanvault/frontend/src/lib/auth.ts's token-TYPE gate, which exists because
  // the same NEXTAUTH_SECRET signs the remote agents' data-plane JWTs).
  // Dropping or renaming either claim breaks SpanVault sign-in entirely and
  // nothing in THIS repository fails — so the shape is built once and asserted
  // by name here.
  const user = { id: '42', email: 'a@example.test', role: 'admin', name: 'A' }
  for (const app of ['logvault', 'ddivault', 'spanvault'] as const) {
    const claims = ssoClaims(user, app, ['netvault', app])
    assert.deepEqual(Object.keys(claims).sort(), [...SSO_CLAIM_KEYS].sort())
    assert.equal(claims.userId, '42')
    assert.equal(claims.app, app)
    assert.deepEqual(claims.apps, ['netvault', app])
    assert.equal(claims.role, 'admin')
    assert.equal(claims.email, 'a@example.test')
    assert.equal(claims.name, 'A')
  }
  // And the routes must not spell the keys themselves again.
  for (const slug of ['logvault', 'ddivault', 'spanvault']) {
    const src = read(`app/api/sso/${slug}/route.ts`)
    assert.match(src, /ssoClaims\(/, `${slug} must build its claims through the shared helper`)
    assert.doesNotMatch(src, /^\s*userId:/m, `${slug} must not re-spell the claim names inline`)
  }
})

test('a session whose role was CLEARED cannot be handed to a satellite', () => {
  // ⛔ THE REVOCATION LAYER'S WHOLE POINT. The `jwt` callback nulls `token.role`
  // on a revoked directory mapping or a deleted local account — but a session
  // object with a null role is still a session, so without this the handoff
  // carried on and minted a token with `role: null`, which SpanVault's
  // `authorize()` reads as `payload.role || 'viewer'`. A revocation that
  // silently becomes "viewer on SpanVault" is not a revocation.
  assert.equal(handoffIdentity({ id: '42', role: null }), null)
  assert.equal(handoffIdentity({ id: '42', role: '' }), null)
  assert.equal(handoffIdentity({ id: '42' }), null)
  // And a missing id is refused too — SpanVault requires `userId`.
  assert.equal(handoffIdentity({ role: 'admin' }), null)
  assert.equal(handoffIdentity({ id: '', role: 'admin' }), null)
  // A real one survives, and a numeric id becomes a string.
  assert.deepEqual(handoffIdentity({ id: 42, role: 'admin', email: 'a@b.test', name: 'A' }),
    { id: '42', email: 'a@b.test', role: 'admin', name: 'A' })
  // Every route has to act on that refusal, not just compute it.
  for (const slug of ['logvault', 'ddivault', 'spanvault']) {
    assert.match(read(`app/api/sso/${slug}/route.ts`), /handoffIdentity\(session\.user\)/, slug)
  }
})

test('the unauthenticated licence payload withholds the server fingerprint', () => {
  // ⛔ `GET /api/license` HAD NO SESSION CHECK AT ALL (its POST does, which is
  // why a grep for auth in the file passed), and all three satellites
  // re-publish whatever it returns on their OWN unauthenticated
  // `/api/license-status` — so one unauthenticated hub response was reachable
  // on four ports. `serverId` is this machine's fingerprint (hostname +
  // MachineGuid, hashed), and it is the value a licence key is ISSUED against.
  const facts = {
    status: 'active', daysRemaining: 90, serverId: 'NCV-deadbeef', customer: 'Example Co',
    expiry: '2027-01-01', modules: ['netvault'], maxDevices: 500, trialDaysTotal: 30,
    installDate: '2026-01-01',
  }
  const pub = publicLicensePayload(facts) as Record<string, unknown>
  for (const field of PRIVILEGED_LICENSE_FIELDS) {
    assert.ok(!(field in pub), `${field} must not be in the public payload`)
  }
  // ⛔ AND THE FIELDS THE SATELLITES ACTUALLY CONSUME MUST STILL BE THERE. All
  // three fail OPEN on a non-2xx and read `status`/`daysRemaining`/`modules`
  // (api/licenseCheck.js) plus `customer`/`expiry`/`trialDaysTotal`
  // (LicenseGuard.tsx) — so trimming one of those disables licence enforcement
  // or blanks a banner in three products, silently.
  for (const field of ['status', 'daysRemaining', 'modules', 'customer', 'expiry', 'trialDaysTotal']) {
    assert.ok(field in pub, `${field} is consumed by the satellites and must stay public`)
  }
  // A super_admin gets everything; anything less gets the public shape.
  const priv = licensePayloadFor('super_admin', facts) as Record<string, unknown>
  assert.equal(priv.serverId, 'NCV-deadbeef')
  assert.equal(priv.maxDevices, 500)
  assert.equal(priv.installDate, '2026-01-01')
  for (const role of ['admin', 'site_admin', 'viewer', null, undefined]) {
    assert.ok(!('serverId' in (licensePayloadFor(role, facts) as Record<string, unknown>)),
      `role ${String(role)} must not see the server id`)
  }
  // ⛔ BUILT BY LISTING THE KEYS, NOT BY DELETING THEM FROM A SPREAD. A
  // delete-from-a-copy shape re-leaks every field added to LicenseFacts later.
  assert.doesNotMatch(code('lib/licensePayload.ts'), /\.\.\.f\b/)

  // ⛔ AND THE ROUTE MUST ACTUALLY SHAPE ITS ANSWER. The GET had no session
  // read at all — the POST's super_admin check is why a grep for auth in that
  // file passed.
  const route = code('app/api/license/route.ts')
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'))
  assert.match(get, /getServerSession\(authOptions\)/, 'GET must read the session')
  assert.match(get, /licensePayloadFor\(role,/, 'and shape its answer by role')
  // ⛔ THE SESSION READ MUST NOT BE ABLE TO FAIL THE REQUEST. An
  // unauthenticated satellite poll is the COMMON case; all three satellites
  // read `if (!res.ok) return null` as "hub unreachable" and then FAIL OPEN, so
  // a 500 out of getServerSession would disable licence enforcement in three
  // products with nothing logged anywhere.
  assert.match(get, /try \{[\s\S]{0,200}getServerSession[\s\S]{0,300}\} catch \{/,
    'the session read must be inside its own try/catch')
  // And it must not 401: the route stays reachable with no session.
  assert.doesNotMatch(get, /401/, 'GET must remain reachable without a session')
})

// ─── seam 6: pagination (Group B) ───────────────────────────────────────────

test('a caller-sized limit, a zero page and a non-number are all clamped', () => {
  // ⛔ ALL THREE WERE REACHABLE WITH A QUERY STRING BY ANY AUTHENTICATED USER:
  // `limit=99999999` was a DoS-sized SELECT over `v_devices_flat`, `page=0`
  // built a negative OFFSET which PostgreSQL rejects (500), and `limit=abc` was
  // NaN travelling into a query parameter (500 again).
  const p = (q: Record<string, string>) => resolvePaging({ get: (k) => q[k] ?? null })
  assert.equal(p({ limit: '99999999' }).limit, MAX_PAGE_SIZE)
  assert.equal(p({ page: '0' }).offset, 0)
  assert.equal(p({ page: '-5' }).offset, 0)
  assert.equal(p({ page: '-5' }).page, 1)
  assert.equal(p({ limit: 'abc' }).limit, DEFAULT_PAGE_SIZE)
  assert.equal(p({ limit: '0' }).limit, 1)
  assert.equal(p({ limit: '-10' }).limit, 1)
  assert.equal(p({}).limit, DEFAULT_PAGE_SIZE)
  // The ordinary case is untouched.
  assert.deepEqual(p({ page: '3', limit: '25' }), { page: 3, limit: 25, offset: 50 })
  // A fixed page size ignores the caller entirely (the audit log).
  const fixed = resolvePaging({ get: (k) => (k === 'limit' ? '5000' : '2') }, { fixedLimit: 50 })
  assert.deepEqual(fixed, { page: 2, limit: 50, offset: 50 })
  // ⛔ NO NaN MAY ESCAPE. A NaN offset reaches PostgreSQL as a parameter.
  const odd: Array<Record<string, string>> = [{ page: 'abc' }, { limit: 'abc' }, { page: '', limit: '' }, { page: '1e9999' }]
  for (const q of odd) {
    const r = p(q)
    assert.ok(Number.isInteger(r.limit) && Number.isInteger(r.offset) && Number.isInteger(r.page),
      `non-integer escaped for ${JSON.stringify(q)}: ${JSON.stringify(r)}`)
  }
})

test('EVERY route that reads a page or limit parameter goes through resolvePaging', () => {
  // ⛔ A CLASS, NOT TWO INSTANCES, AND ENUMERATED SO A THIRD CANNOT SLIP IN.
  // `app/api/admin/eol-seed` already clamped its own pair correctly and inline,
  // which is exactly how devices and audit came to differ from it: the right
  // version was never anywhere a third route could reuse.
  const offenders: string[] = []
  const unclamped: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (e.name !== 'route.ts') continue
      const src = strip(fs.readFileSync(full, 'utf8'))
      const rel = path.relative(repo, full)
      const reads = /get\(['"](?:page|limit|offset|pageSize|per_page)['"]\)/.test(src)
      const delegates = /resolvePaging\(/.test(src)
      // A route is paginated if it reads one of these parameters OR delegates
      // the reading to the shared helper.
      if (!reads && !delegates) continue
      offenders.push(rel)
      if (delegates) continue
      // ⛔ A BARE parseInt OF ONE OF THESE IS THE BUG, in any spelling. An
      // inline clamp is accepted only when BOTH a bound and the read are there.
      const clampedInline = /Math\.(?:min|max)\([\s\S]{0,200}?get\(['"](?:page|limit|offset|pageSize|per_page)['"]\)/
      if (!clampedInline.test(src)) unclamped.push(rel)
    }
  }
  walk(path.join(repo, 'app/api'))
  assert.ok(offenders.length >= 3, `expected at least 3 paginated routes, found ${offenders.join(', ')}`)
  assert.deepEqual(unclamped, [], `these read a pagination parameter without clamping it: ${unclamped.join(', ')}`)
})

// ─── seam 7: the run lock (Group C1/C3/C4/C6) ──────────────────────────────

const lockEnv = (alive: (pid: number) => boolean = () => true, now?: () => number) =>
  ({ fs, isPidAlive: alive, now }) as LockEnv

function tmpLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-runlock-'))
  return path.join(dir, 'run.lock')
}

test('a second click cannot claim the lock, so it cannot truncate the first run\'s log', () => {
  // ⛔ `service-restart` NEVER CLAIMED THE LOCK AT ALL: its 409 guard read a
  // lock only the WRAPPER writes, so between `schtasks /run` and the wrapper's
  // `$PID | Out-File` nothing was held. Two super_admin tabs ~2 s apart both
  // passed the guard, and POST 2 truncated the log — destroying run A's
  // `runId=` header, which is the whole mechanism that makes reading another
  // run's verdict impossible.
  const lock = tmpLock()
  assert.deepEqual(claimRunLock(lock, 'run-a', 1234, lockEnv()), { ok: true })
  const second = claimRunLock(lock, 'run-b', 1234, lockEnv())
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.reason : null, 'busy')
})

test('the claim is ATOMIC, so the request that loses a race is refused', () => {
  // ⛔ `flag: 'wx'` IS WHAT MAKES THE CHECK-THEN-WRITE SAFE, and a sequential
  // test cannot reach the window it closes — the stale-reaping read in front of
  // it answers "busy" long before the write. So the race is MODELLED: an `fs`
  // whose existence check says "free" (it lost the race) while the write finds
  // the file already there. Without the flag, the second request overwrites the
  // first run's claim and goes on to truncate its log.
  let wrote = false
  const racing = {
    existsSync: () => false,
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    statSync: () => ({ mtimeMs: Date.now() }),
    unlinkSync: () => {},
    writeFileSync: (_p: string, _d: string, opts: { flag?: string }) => {
      if (opts && opts.flag === 'wx') throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      wrote = true
    },
  }
  const res = claimRunLock('/nowhere/run.lock', 'run-b', 4242,
    { fs: racing as unknown as LockEnv['fs'], isPidAlive: () => true })
  assert.equal(res.ok, false, 'the loser of the race must be refused')
  assert.equal(res.ok === false ? res.reason : null, 'busy')
  assert.equal(wrote, false, 'and it must not have overwritten the winner\'s claim')
})

test('a claim the wrapper never took over expires on its own', () => {
  // ⛔ THE WEDGE. The claim is written with the HUB's pid — a process that is
  // permanently alive — so if the wrapper never started (task launch refused,
  // Scheduler stopped), a liveness-only check said "a run is in progress"
  // forever, GET reported it, and the panel hid the only button that could have
  // cleared it. Age is the only thing that can tell us here.
  const lock = tmpLock()
  // The clock has to be anchored on the file's REAL mtime, which is what the
  // reader compares against.
  let clock = Date.now()
  assert.ok(claimRunLock(lock, 'run-a', process.pid, lockEnv(() => true, () => clock)).ok)
  const t0 = fs.statSync(lock).mtimeMs
  clock = t0
  assert.equal(readRunLock(lock, lockEnv(() => true, () => clock)).held, true)
  clock = t0 + ARM_WINDOW_MS + 1
  const after = readRunLock(lock, lockEnv(() => true, () => clock))
  assert.equal(after.held, false)
  assert.equal(after.reaped, true, 'the file must be removed, not merely ignored')
  assert.equal(fs.existsSync(lock), false)
})

test('a LIVE wrapper-owned lock is not reaped for being old', () => {
  // ⛔ `reapStaleLock` WAS `dead || old` AGAINST AN MTIME WRITTEN ONCE AT
  // WRAPPER START, so `old` alone removed the lock of a run that was still
  // working — contradicting its own "age is the second condition" comment. The
  // wrappers now rewrite the lock as they work, so a fresh mtime means alive.
  const lock = tmpLock()
  fs.writeFileSync(lock, '4321', 'utf8')
  const now = fs.statSync(lock).mtimeMs
  assert.equal(readRunLock(lock, lockEnv(() => true, () => now)).held, true)
  // Still held well inside the idle window — a run that is working must not be
  // reaped for having started a while ago, which is what the old `dead || old`
  // against a write-once mtime did at 30 minutes.
  assert.equal(readRunLock(lock, lockEnv(() => true, () => now + LOCK_IDLE_MS - 1)).held, true)
  assert.equal(fs.existsSync(lock), true)
  // Gone quiet for longer than the idle timeout: now it is debris.
  assert.equal(readRunLock(lock, lockEnv(() => true, () => now + LOCK_IDLE_MS + 1)).held, false)
  // A dead pid is debris immediately, whatever the age.
  fs.writeFileSync(lock, '4321', 'utf8')
  assert.equal(readRunLock(lock, lockEnv(() => false, () => now)).held, false)
})

test('cleanup can withdraw a PENDING claim and can never drop a live run\'s', () => {
  // ⛔ THE DISASTER REACHED THROUGH ITS OWN CLEANUP. `schtasks /run` can SUCCEED
  // on the box and still exceed its 20 s timeout on a loaded host — the wrapper
  // is then mid-cutover, and the catch deleted the task and unlinked the lock
  // the wrapper owned. GET reported `runInProgress: false`, the panel re-enabled
  // every button, and a second POST started a SECOND engine instance stopping
  // and starting the same four services.
  const lock = tmpLock()
  assert.ok(claimRunLock(lock, 'run-a', process.pid, lockEnv()).ok)
  // Still ours: withdrawing is right, and says so.
  assert.equal(releaseRunLock(lock, lockEnv(), { onlyIfPending: true, runId: 'run-a' }), true)
  assert.equal(fs.existsSync(lock), false)

  // The wrapper has taken it over (a bare pid). Cleanup must refuse.
  fs.writeFileSync(lock, '9876', 'utf8')
  assert.equal(releaseRunLock(lock, lockEnv(), { onlyIfPending: true, runId: 'run-a' }), false)
  assert.equal(fs.existsSync(lock), true, 'a wrapper-owned lock must survive the route\'s cleanup')

  // Another request's pending claim is somebody else's run about to start.
  fs.writeFileSync(lock, pendingLockBody(process.pid, 'run-b'), 'utf8')
  assert.equal(releaseRunLock(lock, lockEnv(), { onlyIfPending: true, runId: 'run-a' }), false)
})

test('a bare pid still reads as a live run, so a lock written before this change is honoured', () => {
  assert.deepEqual(parseLockBody('4321'), { pid: 4321, pending: false, runId: null })
  assert.deepEqual(parseLockBody('4321\r\n'), { pid: 4321, pending: false, runId: null })
  assert.deepEqual(parseLockBody(pendingLockBody(7, 'abc')), { pid: 7, pending: true, runId: 'abc' })
  // Garbage is debris, not a run that holds the feature closed forever.
  assert.equal(parseLockBody(''), null)
  assert.equal(parseLockBody('not a pid'), null)
  assert.equal(parseLockBody(null), null)
})

test('both wrappers refuse to act unless the route armed them for THIS run', () => {
  // ⛔ THE ORPHANED TASK, WHICH NOTHING DELETED. Both routes delete the task
  // when `schtasks /run` FAILS; nothing did when the wrapper STARTED and then
  // DIED (host reboot mid-run, task terminated, PowerShell crash) — which both
  // files treat elsewhere as a first-class case, since it is the entire premise
  // of stale-lock reaping. The task survives with its `/sc once /st 00:00`
  // trigger, and by those files' own stated reasoning a `once` trigger whose
  // start time has passed fires THE FOLLOWING DAY. A reboot during a cutover at
  // 14:00 re-ran the wrapper at MIDNIGHT, still holding `action: 'disable'`,
  // dropping the whole suite to plain HTTP unattended.
  const transport = buildWrapperScript({
    script: 'C:\\x\\Enable-NocVaultTls.ps1', action: 'disable',
    log: 'C:\\x\\logs\\t.log', lock: 'C:\\x\\logs\\t.lock',
    taskName: 'NocVault-TlsTransport', runId: 'run-zz',
  })
  const restart = buildRestartWrapper({
    service: 'NetVault', log: 'C:\\x\\logs\\r.log', lock: 'C:\\x\\logs\\r.lock',
    taskName: 'NocVault-ServiceRestart', dependents: ['NocVault-Tls'], runId: 'run-zz',
  })
  for (const [name, s, dangerous] of [
    ['transport', transport, 'Enable-NocVaultTls.ps1'],
    ['restart', restart, 'sc.exe'],
  ] as const) {
    const refuse = s.indexOf('[NV-LOCK] refusing')
    assert.ok(refuse > 0, `${name}: there must be a refusal branch`)
    assert.ok(s.indexOf("$runId = 'run-zz'") >= 0, `${name}: the run id must be baked in`)
    // The refusal — and its exit — must come before anything that changes the box.
    const act = s.indexOf(dangerous, s.indexOf('[NV-LOCK]'))
    assert.ok(refuse < act, `${name}: the refusal must be decided before it acts`)
    assert.ok(s.indexOf('exit 0', refuse) < act, `${name}: it must exit rather than fall through`)
    // ⛔ AND IT TAKES THE TASK WITH IT. The wrapper's one unauthorised fire is
    // the only moment anything is running that can remove the orphan.
    assert.ok(s.indexOf('/delete', refuse) < act, `${name}: the orphan must delete itself`)
  }
})

test('BOTH routes reap the lock on the READ path and remove the orphaned task', () => {
  // ⛔ THE REAP WAS ON THE WRITE PATH AND THE GATE IT UNBLOCKS IS ON THE READ
  // PATH. GET spreads `...capability`, and `runInProgress` becomes a
  // `blockedReason` that hides the entire action card INCLUDING Preview — so
  // the only code that could clear a stuck lock was the POST the panel refused
  // to let anybody send. GET never reaped.
  for (const f of ['app/api/system/tls-transport/route.ts', 'app/api/system/service-restart/route.ts']) {
    const src = code(f)
    const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'))
    assert.match(get, /readRunLock\(/, `${f}: GET must read the lock through the reaping reader`)
    assert.match(get, /if \(lock\.reaped\)/, `${f}: GET must act on a reap`)
    assert.match(get, /delete(?:Transport|Restart)Task\(\)/, `${f}: a reap must remove the orphaned task`)
    // And the write path must claim atomically rather than check-then-write.
    assert.match(src, /claimRunLock\(/, `${f}: the ROUTE must claim the lock`)
    assert.doesNotMatch(src, /reapStaleLock/, `${f}: the private reaper must be gone`)
    assert.doesNotMatch(src, /flag: 'wx'/, `${f}: the raw wx write belongs in lib/runLock.ts`)
  }
})

// ─── seam 8: non-English Windows (C7) ──────────────────────────────────────

test('the terminator state is read from the NUMBER, so a localised sc.exe still works', () => {
  // ⛔ `parseScQcDependencies` WAS HARDENED AGAINST LOCALISED FIELD NAMES
  // TWENTY LINES BELOW, in the same commit that left `readTerminatorState`
  // keying on the English state WORDS. On a German or French Windows the state
  // was therefore always `unknown`, and `transportCapability` turns `unknown`
  // into "blocked in both directions" — which disables enable, disable AND
  // Preview. The whole HTTPS tab was dead on any non-English host, permanently,
  // and the panel reported it as an unchecked condition rather than a parser
  // failure.
  const german = [
    'SERVICENAME: NocVault-Tls',
    '        TYP                : 10  WIN32_OWN_PROCESS',
    '        STATUS             : 4  WIRD AUSGEFUEHRT',
    '                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)',
    '        WIN32_EXIT_CODE    : 0  (0x0)',
    '        DIENST_EXIT_CODE   : 0  (0x0)',
    '        PRUEFPUNKT         : 0x0',
    '        WARTEHINWEIS       : 0x0',
  ].join('\r\n')
  assert.equal(parseScQueryState(german), 4, 'RUNNING is state code 4 in every locale')

  const frenchStopped = german.replace('STATUS             : 4  WIRD AUSGEFUEHRT', 'ETAT               : 1  ARRETE')
  assert.equal(parseScQueryState(frenchStopped), 1)
  const pending = german.replace('STATUS             : 4  WIRD AUSGEFUEHRT', 'STATUS             : 3  WIRD BEENDET')
  assert.equal(parseScQueryState(pending), 3)

  // ⛔ IT IS THE SECOND NUMERIC FIELD, NOT THE FIRST. The first is TYPE, and
  // reading that would report service type 10 as a state.
  assert.notEqual(parseScQueryState(german), 10)

  // Nothing of the shape at all is a real "could not tell", not a guess.
  assert.equal(parseScQueryState(''), null)
  assert.equal(parseScQueryState('SERVICE_NAME: NocVault-Tls'), null)

  // ⛔ AND THE MAPPING, NOT JUST THE NUMBER. A perfect parser nothing consumes
  // leaves every non-English host exactly as broken — which is this codebase's
  // own worst regression of the family (a route COMPUTED `fronted`/`publicPort`
  // while no panel read either, with five PASSING tests over the dead branch,
  // because they called the helper directly). So exercise the function
  // `readTerminatorState` actually hands its stdout to.
  assert.deepEqual(readingFromScQuery(german),
    { state: 'running', detail: null, present: true, running: true })
  assert.deepEqual(readingFromScQuery(frenchStopped),
    { state: 'stopped', detail: null, present: true, running: false })
  assert.deepEqual(readingFromScQuery(pending),
    { state: 'stopped', detail: 'The service is changing state.', present: true, running: false })
  // ⛔ `present`/`running` ARE `null` ON AN UNKNOWN, NEVER `false` — the rule
  // this whole module exists for.
  const blind = readingFromScQuery('SERVICE_NAME: NocVault-Tls')
  assert.equal(blind.state, 'unknown')
  assert.equal(blind.present, null)
  assert.equal(blind.running, null)
  // The English path still answers exactly as it did.
  assert.equal(readingFromScQuery('        STATE              : 4  RUNNING').state, 'running')
  assert.equal(readingFromScQuery('        STATE              : 1  STOPPED').state, 'stopped')
  // And the spawn must hand its output to this function, not re-decide.
  assert.match(code('lib/terminatorState.ts'), /return readingFromScQuery\(stdout\)/)
})

// ─── seam 9: the restart panel's verdict (C2) ──────────────────────────────

test('hub uptime alone can no longer declare a restart finished', () => {
  // ⛔ THE FALSE ALL-CLEAR, AND IT MADE A GUARD UNREACHABLE. On an install where
  // NocVault-Tls really does declare `DependOnService NetVault`, the wrapper's
  // order is: stop the terminator → stop/start the hub → START THE TERMINATOR
  // AGAIN (up to 90 s) → write `dependent … back:` → write the sentinel. The hub
  // answers HTTP before `Get-Service` even reports it Running, so the first poll
  // gave a lower uptime with `finished: false` — and the panel went green with
  // "Restarted — the change is now in force" while the front door was stopped
  // and ALL FOUR consoles' public ports were dead. Polling stops at `done`, so a
  // terminator that never came back left the panel green forever. That is also
  // what made `parseRestartLog`'s `depsFailed` term — added specifically to
  // refuse this — unreachable on the only path where dependents exist.
  const src = read('components/settings/RestartControl.tsx')
  const done = /} else if \(([^)]*)\) \{\s*\n\s*setPhase\('done'\)/.exec(src)
  assert.ok(done, 'the done branch must be findable')
  assert.doesNotMatch(done[1], /uptimeProof/, 'the done branch must not accept a bare uptime proof')
  assert.match(done[1], /data\.lastRun\.finished/, 'it must require the run to have finished')
  assert.match(done[1], /outcome === 'succeeded'/, 'and to have succeeded')
  assert.match(done[1], /\bmine\b/, "and to be THIS run's verdict")
  // The uptime proof still has a job — it is how the panel says the console is
  // back while the wrapper is still bringing the front door up.
  assert.match(src, /if \(uptimeProof\) setBackOnline\(true\)/)
  // ⛔ AND `depsFailed` HAS TO BE REACHABLE: the failed branch must not demand
  // anything the dependents-back path cannot provide.
  assert.equal(parseRestartLog(restartLog(
    '[NV-RESTART] dependent NocVault-Tls back: False',
    '[NV-RESTART] pid after: 2 changed=True',
    '[NV-RESTART] running=True',
    `${RESTART_SENTINEL} exit=1`,
  )).outcome, 'failed')
})

test('the restart wait limit covers the wrapper\'s own worst case', () => {
  // ⛔ NOW THAT THE VERDICT DECIDES, A SHORT LIMIT REPORTS "could not confirm"
  // FOR RESTARTS THAT ARE WORKING. The wrapper's bounds add up: 45 s per
  // dependent stop + 60 s stop poll + 150 s of start attempts + 90 s per
  // dependent coming back = 345 s before the sentinel is written.
  const src = read('components/settings/RestartControl.tsx')
  const m = /const WAIT_LIMIT_MS = (\d+) \* 60 \* 1000/.exec(src)
  assert.ok(m, 'the limit must be stated in minutes')
  assert.ok(Number(m[1]) * 60 >= 345, `the limit must cover 345 s, got ${Number(m[1]) * 60} s`)
})

test('the restart button is not offered to a role the route will refuse', () => {
  // ⛔ A BUTTON THE SERVER WILL REFUSE IS WORSE THAN NO BUTTON. `POST
  // /api/system/service-restart` is super_admin; both panels rendered
  // `RestartControl` with no role prop at all, so an `admin` — who legitimately
  // reaches both tabs — met an enabled "Restart NetVault now" that answered a
  // bare 403. The same commit added `canInstall` gating to the install button 20
  // lines below one of them.
  for (const f of ['components/settings/CertificatePanel.tsx', 'components/settings/ConsoleAddressPanel.tsx']) {
    const src = read(f)
    const call = /<RestartControl[\s\S]{0,200}?\/>/.exec(src)
    assert.ok(call, `${f}: the RestartControl call must be findable`)
    assert.match(call[0], /canRestart=\{/, `${f} must pass canRestart`)
  }
  // And the settings page must hand the panels the real distinction.
  const page = read('app/(app)/settings/page.tsx')
  assert.match(page, /<ConsoleAddressPanel canRestart=\{isSuperAdmin\}/)
  assert.match(page, /<CertificatePanel canInstall=\{isSuperAdmin\}/)
  // The destructive confirmation in the certificate panel is gated too.
  assert.match(read('components/settings/CertificatePanel.tsx'),
    /disabled=\{busy \|\| !canInstall\}[\s\S]{0,120}Replace the installed certificate/)
})

test('the dependency probe\'s explanation reaches the operator', () => {
  // ⛔ `terminatorDependsOn` RETURNS `{ dependsOn, detail }` AND THE ROUTE READ
  // ONLY THE BOOLEAN. `null` is precisely the branch where the restart is
  // GUARANTEED to fail with 1051 — the front door is left running and Windows
  // refuses the stop — so the operator got a bare "The restart did not take
  // effect" with no hint that an unreadable dependency field was the cause.
  const route = read('app/api/system/service-restart/route.ts')
  assert.match(route, /dependencyDetail = dep\.dependsOn === null \? dep\.detail : null/)
  assert.match(route, /^\s*dependencyDetail,$/m, 'it must be in the response')
  const panel = read('components/settings/RestartControl.tsx')
  assert.match(panel, /setDependencyDetail\(/, 'the panel must read it')
  assert.match(panel, /1051/, 'and say what it means')
  // ⛔ BOTH VERDICTS THAT CAN BE CAUSED BY IT MUST SAY SO. `failed` is the
  // 1051 outcome itself; `unconfirmed` is what a panel sees when the wrapper
  // could not finish — and asserting only that the string appears SOMEWHERE
  // passes while one of the two quietly stops rendering it.
  assert.equal((panel.match(/\{dependencyDetail && /g) || []).length, 2,
    'the detail must render in BOTH the failed and unconfirmed callouts')
  for (const phase of ['unconfirmed', 'failed']) {
    const at = panel.indexOf(`if (phase === '${phase}'`)
    assert.ok(at > 0, `the ${phase} branch must exist`)
    const block = panel.slice(at, at + 1400)
    assert.match(block, /\{dependencyDetail && /, `the ${phase} branch must render the detail`)
  }
})

test('nothing returns a selfRestart nobody reads', () => {
  // ⛔ COMPUTED, RETURNED AND READ BY NOBODY. The panel already decides the same
  // thing from `service`, and a second derived spelling of one fact is how the
  // two drift apart.
  assert.doesNotMatch(read('app/api/system/service-restart/route.ts'), /^\s*selfRestart:/m)
  assert.doesNotMatch(read('components/settings/RestartControl.tsx'), /selfRestart/)
  // Same for the alias export that had no callers.
  assert.doesNotMatch(read('lib/serviceRestart.ts'), /^export const RESTART_SERVICE/m)
})

test('parseRestartLog\'s own doc sits above parseRestartLog', () => {
  // ⛔ `RESTART_RUN_PREFIX`/`buildRestartHeader` WERE INSERTED BETWEEN THE JSDOC
  // AND THE FUNCTION, so "What the last restart did." documented a string
  // constant and the function that reads the verdict had no doc at all.
  const src = read('lib/serviceRestart.ts')
  const doc = src.indexOf('What the last restart did.')
  const fn = src.indexOf('export function parseRestartLog')
  const prefix = src.indexOf('export const RESTART_RUN_PREFIX')
  assert.ok(doc > 0 && fn > 0 && prefix > 0)
  assert.ok(doc < fn, 'the doc must precede the function')
  assert.ok(prefix < doc, 'and the constant must not sit between them')
  // ⛔ PRECISE: the gap between the doc comment's `*/` and the function must be
  // whitespace only. A character budget is not an assertion — measured, a
  // `{0,400}` window did not even reach past this doc block, so the mutation it
  // was meant to refuse sailed through.
  const closeAt = src.indexOf('*/', doc)
  const between = src.slice(closeAt + 2, fn)
  assert.equal(between.trim(), '', `nothing may sit between the doc and parseRestartLog, found: ${between.trim().slice(0, 120)}`)
})

// ── The licence gate: what it may and may not take away ─────────────────────
//
// ⛔ THIS ASSERTS THE SPLIT IN BOTH DIRECTIONS, AND THAT IS THE POINT. A test
// that only checked "the product routes are gated" would have passed happily
// while `users` was gated too — which is the bug this encodes. A test that only
// checked "users is not gated" would not notice someone quietly ungating
// `devices`.
//
// The rule: the licence sells `modules` and `maxDevices` (see LicensePayload —
// there is no seat or user limit anywhere), so the gate belongs on routes that
// PRODUCE PRODUCT VALUE and nowhere else. Administering and recovering the
// installation must survive expiry, because NetVault is the suite hub: its
// `users` table is the identity every satellite authenticates against, and
// blocking DELETE there means a lapsed licence stops you revoking a
// compromised account. A commercial dispute must not become a security
// incident.
test('⛔ the licence gate is on product data, and NOWHERE in hub administration', () => {
  const GATED = [
    'app/api/devices/route.ts',
    'app/api/devices/[id]/route.ts',
    'app/api/devices/bulk/route.ts',
    'app/api/sites/[id]/route.ts',
    'app/api/sites/manage/route.ts',
    'app/api/sites/import/route.ts',
    'app/api/circuits/route.ts',
    'app/api/circuits/[id]/route.ts',
    'app/api/import/route.ts',
  ]
  const UNGATED = [
    'app/api/users/route.ts',          // identity — see the note in that file
    'app/api/users/[id]/route.ts',     // incl. DELETE: revocation must never be blocked
    'app/api/settings/route.ts',
    'app/api/system/entra/route.ts',
    'app/api/system/tls/route.ts',
    'app/api/system/tls-transport/route.ts',
    'app/api/system/console-url/route.ts',
    'app/api/suite/smtp/route.ts',
    'app/api/suite/smtp/test/route.ts',
    // ⛔ Token-gated infrastructure provisioning, not licensed data entry — the
    // route says so itself and has since it shipped. An agent enrolling is not
    // a user typing in a device, and a 403 here would strand a fleet rollout on
    // a licence question the agent cannot answer.
    'app/api/agents/enroll/route.ts',
  ]
  for (const f of GATED) {
    assert.match(code(f), /checkWriteAllowed/,
      `${f} produces product value and MUST stay behind the licence gate`)
  }
  for (const f of UNGATED) {
    assert.doesNotMatch(code(f), /checkWriteAllowed/,
      `${f} is administration/recovery and must survive licence expiry — see the note in app/api/users/route.ts`)
  }
})

// ⛔ The list above is hand-maintained, so this catches a route that adds the
// gate without anyone updating it. Any NEW caller of checkWriteAllowed has to
// be classified deliberately rather than inherited by accident.
test('⛔ no route gates on the licence without being classified above', () => {
  const known = new Set([
    'app/api/license/route.ts', // defines it
    'app/api/devices/route.ts', 'app/api/devices/[id]/route.ts', 'app/api/devices/bulk/route.ts',
    'app/api/sites/[id]/route.ts', 'app/api/sites/manage/route.ts',
    'app/api/sites/import/route.ts', 'app/api/circuits/route.ts', 'app/api/circuits/[id]/route.ts',
    'app/api/import/route.ts',
  ])
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (e.name === 'route.ts' && /checkWriteAllowed/.test(code(rel))) found.push(rel)
    }
  }
  walk('app/api')
  const surprises = found.filter((f) => !known.has(f))
  assert.deepEqual(surprises, [],
    `these routes gate on the licence but are not classified in the test above — decide whether each produces product value (gate it, add it to the list) or is administration/recovery (remove the gate): ${surprises.join(', ')}`)
})
