import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// ── making three route files importable under `node --test` ─────────────────
//
// ⛔ THESE GUARDS WERE GOING TO BE UNTESTED, AND THAT IS WHY THIS HARNESS
// EXISTS. `app/api/system/*/route.ts` imports `next/server` and `next-auth`,
// neither of which resolves under plain node (`next/server` is not an
// exports-mapped specifier node can follow), so the usual answer is "put the
// logic in a pure module and test that". Most of it already is —
// `lib/consoleUrl.ts`, `lib/entraSettings.ts`, `lib/tlsConfig.ts` and
// `lib/certImport.ts` carry every judgement and have their own suites. But what
// is left in the routes is not nothing, and it is the dangerous half:
//
//   - `confirm` must become 409 + needsConfirmation, not a silent accept;
//   - `tlsActive` must be PASSED (it is tri-state, and omitting it disables the
//     strongest refusal in `lib/consoleUrl.ts` with no symptom);
//   - the Entra route must be super_admin, stricter than its sibling;
//   - `previous` — the OLD CLIENT SECRET — must not reach a response body;
//   - the certificate pair must be validated BEFORE anything is written;
//   - an existing certificate must not be replaced unasked.
//
// Every one of those is a property of the ROUTE, invisible to the libraries, and
// each fails silently in production. Node's in-thread `registerHooks` makes them
// reachable without a server: two tiny stubs for `next/server` and `next-auth`,
// and `@/…` resolved against the repo root the way the bundler resolves it.
// Nothing in the routes is changed or re-implemented to suit the test.

const ROOT = path.resolve(import.meta.dirname, '..')

const NEXT_SERVER_STUB = `
  export class NextResponse {
    constructor(body, init) { this.body = body; this.status = (init && init.status) || 200 }
    static json(body, init) { return new NextResponse(body, init) }
  }
  export class NextRequest {}
`
const NEXT_AUTH_STUB = `
  export async function getServerSession() { return globalThis.__nvSession ?? null }
`

// ⛔ THE STORE IS A SPY, NOT A DATABASE, AND THAT IS THE POINT FOR TWO OF THE
// TESTS BELOW. /api/system/directory-mappings validates the role BEFORE it
// inserts, and its comment calls the table's CHECK constraint a mere second line
// of defence. The only way to prove the first line exists is to assert the store
// WAS NOT CALLED on a refused request — which a real database cannot tell you.
// (The SQL itself is covered against a real PostgreSQL in directoryStore.test.ts,
// including the ON CONFLICT target and the CHECK constraint.)
const DIRECTORY_STORE_STUB = `
  globalThis.__nvStoreCalls = []
  export async function listDirectoryMappings() {
    globalThis.__nvStoreCalls.push(['list'])
    return globalThis.__nvMappings ?? []
  }
  export async function createDirectoryMapping(input) {
    globalThis.__nvStoreCalls.push(['create', input])
    if (globalThis.__nvCreateDuplicate) return null
    return { id: 7, provider: 'entra', group_key: input.groupKey,
             display_name: input.displayName ?? null, role: input.role,
             created_at: '2026-11-05T00:00:00Z' }
  }
  export async function deleteDirectoryMapping(id) {
    globalThis.__nvStoreCalls.push(['delete', id])
    if (globalThis.__nvDeleteMissing) return null
    return { id, provider: 'entra', group_key: 'gk-' + id, display_name: null,
             role: 'admin', created_at: '2026-11-05T00:00:00Z' }
  }
`
// systemAudit imports db.ts, which builds a pg Pool from DATABASE_URL at module
// load. Stubbing the pool keeps these route tests from needing a database at all.
const DB_STUB = `
  export async function query() { return { rows: [], rowCount: 0 } }
  export default { end: async () => {}, query: async () => ({ rows: [], rowCount: 0 }) }
`

// ⛔ `registerHooks` is real (Node >= 22.15) but absent from the @types/node this
// repo pins, and package.json is not ours to touch — so it is reached through a
// narrow local type rather than by widening anything.
type Next = (specifier: string, context?: unknown) => unknown
const registerHooks = (
  nodeModule as unknown as {
    registerHooks: (hooks: {
      resolve: (spec: string, ctx: unknown, next: Next) => unknown
      load: (url: string, ctx: unknown, next: Next) => unknown
    }) => void
  }
).registerHooks

registerHooks({
  resolve(spec: string, ctx: unknown, next: Next) {
    if (spec === 'next/server') return { url: 'nvstub:next/server', shortCircuit: true }
    if (spec === 'next-auth') return { url: 'nvstub:next-auth', shortCircuit: true }
    if (spec.includes('[...nextauth]')) return { url: 'nvstub:authOptions', shortCircuit: true }
    if (spec.endsWith('lib/directoryStore.ts')) return { url: 'nvstub:directoryStore', shortCircuit: true }
    // ⛔ MATCHES './db.ts' TOO. systemAudit imports it relatively, so a matcher
    // anchored on 'lib/db.ts' silently misses it and the real pg Pool loads.
    if (spec === './db.ts' || spec.endsWith('/db.ts')) return { url: 'nvstub:db', shortCircuit: true }
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx)
    return next(spec, ctx)
  },
  load(url: string, ctx: unknown, next: Next) {
    const stubs: Record<string, string> = {
      'nvstub:next/server': NEXT_SERVER_STUB,
      'nvstub:next-auth': NEXT_AUTH_STUB,
      'nvstub:authOptions': 'export const authOptions = {}',
      'nvstub:directoryStore': DIRECTORY_STORE_STUB,
      'nvstub:db': DB_STUB,
    }
    if (stubs[url]) return { format: 'module', source: stubs[url], shortCircuit: true }
    return next(url, ctx)
  },
})

type Answer = { body: Record<string, unknown>; status: number }

const consoleUrlRoute = await import('../app/api/system/console-url/route.ts')
const entraRoute = await import('../app/api/system/entra/route.ts')
const tlsRoute = await import('../app/api/system/tls/route.ts')
const mappingsRoute = await import('../app/api/system/directory-mappings/route.ts')

// ── harness ─────────────────────────────────────────────────────────────────

function session(role: string | null): void {
  ;(globalThis as Record<string, unknown>).__nvSession =
    role === null ? null : { user: { role, name: 'test-operator' } }
}

const req = (body: unknown) => ({ json: async () => body }) as never

/**
 * A throwaway repo root: a `.git` marker so `findGitRoot` stops here, a `.env`
 * (the deploy source `writeManagedKey` requires) and optionally the standalone
 * runtime file.
 *
 * ⛔ EVERY TEST RUNS INSIDE ONE OF THESE. The routes resolve their targets from
 * `process.cwd()`, so without the sandbox a test would rewrite the real
 * repository's `.env`.
 */
function sandbox(envText = '', withStandalone = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-routes-'))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.env'), envText)
  if (withStandalone) {
    fs.mkdirSync(path.join(dir, '.next', 'standalone'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.next', 'standalone', '.env.local'), envText)
  }
  process.chdir(dir)
  return dir
}

const SAVED_ENV = { ...process.env }
const SAVED_CWD = process.cwd()

function resetEnv(): void {
  for (const k of ['NEXTAUTH_URL', 'TLS_CERT_PATH', 'TLS_KEY_PATH', 'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'HTTPS_PORT', 'PORT', 'HTTP_REDIRECT_PORT']) {
    delete process.env[k]
    if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k]
    else delete process.env[k]
  }
  process.chdir(SAVED_CWD)
}

/** Fixture GUIDs — obviously fake, and never a real tenant or app id. */
const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
// ⛔ Not a credential: a literal typed here, in a test, for a tenant that does
// not exist. Its only job is to be searched for in a response body.
const OLD_SECRET = 'fixture-old-secret-value-not-real'
const NEW_SECRET = 'fixture-new-secret-value-not-real'

// ⛔ RFC 5737 TEST-NET-2, reserved for documentation and guaranteed never to be
// this server. It needs no resolver (`isIpv4` short-circuits the lookup), which
// is what makes the lockout path deterministic in a test.
const ELSEWHERE = 'http://198.51.100.7:3000'

// A real certificate chain, minted once, for the TLS route.
type Material = { leaf: string; chain: string; key: string; otherKey: string; pfx: Buffer }
let material: Material | undefined

/**
 * ⛔ IT THROWS RATHER THAN RETURNING null. An earlier version returned null on
 * any failure and every test began `if (!m) return` — which turned one
 * unsupported OpenSSL flag into a suite that reported PASS while asserting
 * nothing at all. A fixture that cannot be built is a failure, loudly.
 */
function mintMaterial(): Material {
  if (material !== undefined) return material
  const openssl = ['/usr/bin/openssl', '/usr/local/bin/openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].find((c) => fs.existsSync(c))
  if (!openssl) {
    throw new Error('OpenSSL was not found, so the TLS route cannot be exercised with real material.')
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-routemat-'))
  const p = (n: string) => path.join(dir, n)
  const run = (a: string[]) => execFileSync(openssl, a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-noenc']
    run(['req', '-x509', ...ec, '-keyout', p('ca.key'), '-out', p('ca.crt'), '-days', '2',
      '-subj', '/CN=NV Route Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE'])
    run(['req', '-new', ...ec, '-keyout', p('leaf.key'), '-out', p('leaf.csr'),
      '-subj', '/CN=console.invalid'])
    fs.writeFileSync(p('leaf.ext'), 'subjectAltName=DNS:console.invalid\nbasicConstraints=critical,CA:FALSE\n')
    run(['x509', '-req', '-in', p('leaf.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'),
      '-out', p('leaf.crt'), '-days', '2', '-extfile', p('leaf.ext')])
    run(['req', '-x509', ...ec, '-keyout', p('other.key'), '-out', p('other.crt'), '-days', '2',
      '-subj', '/CN=other.invalid', '-addext', 'subjectAltName=DNS:other.invalid'])
    run(['pkcs12', '-export', '-inkey', p('leaf.key'), '-in', p('leaf.crt'),
      '-certfile', p('ca.crt'), '-out', p('leaf.pfx'), '-passout', 'pass:fixturePass'])
    const pfx = fs.readFileSync(p('leaf.pfx'))
    material = {
      leaf: fs.readFileSync(p('leaf.crt'), 'utf8'),
      chain: fs.readFileSync(p('ca.crt'), 'utf8'),
      key: fs.readFileSync(p('leaf.key'), 'utf8'),
      otherKey: fs.readFileSync(p('other.key'), 'utf8'),
      pfx,
    }
    return material
}

function countCerts(pem: string): number {
  return (pem.match(/-----BEGIN CERTIFICATE-----/g) || []).length
}

// ════════════════════════════════════════════════════════════════════════════
// /api/system/console-url
// ════════════════════════════════════════════════════════════════════════════

test('console-url: no session is 401 and no role is 403', async () => {
  sandbox()
  try {
    session(null)
    assert.equal(((await consoleUrlRoute.GET()) as unknown as unknown as Answer).status, 401)
    session('viewer')
    assert.equal(((await consoleUrlRoute.GET()) as unknown as unknown as Answer).status, 403)
    session('site_admin')
    assert.equal(((await consoleUrlRoute.PUT(req({ url: 'http://x' }))) as unknown as unknown as Answer).status, 403)
    session('admin')
    assert.equal(((await consoleUrlRoute.GET()) as unknown as unknown as Answer).status, 200)
  } finally {
    resetEnv()
  }
})

test('console-url GET reports saved and running separately', async () => {
  sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    process.env.NEXTAUTH_URL = 'http://running.invalid:3000'
    session('admin')
    const { body } = (await consoleUrlRoute.GET()) as unknown as Answer
    assert.equal(body.saved, 'http://saved.invalid:3000')
    assert.equal(body.running, 'http://running.invalid:3000')
    assert.equal(body.restartPending, true)
  } finally {
    resetEnv()
  }
})

test('console-url GET reports an UNKNOWN shadow verdict as unknown, never as clear', async () => {
  sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    session('admin')
    const { body } = (await consoleUrlRoute.GET()) as unknown as Answer
    const shadow = body.shadow as { state: string; reason?: string }
    // Off Windows the NSSM service environment cannot be read at all. ⛔ That
    // is `unknown` with a reason, and it must NOT be reported as `clear` — "we
    // did not check" is not "nothing is pinned", and the difference decides
    // whether the operator's next restart changes anything.
    assert.equal(shadow.state, 'unknown')
    assert.ok(shadow.reason)
    assert.notEqual(shadow.state, 'clear')
    assert.equal(body.takesEffectOnRestart, null)
    assert.match(String(body.shadowNote), /not a clean bill of health/i)
  } finally {
    resetEnv()
  }
})

test('console-url PUT refuses a malformed address without writing', async () => {
  const dir = sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    session('admin')
    const { status, body } = (await consoleUrlRoute.PUT(req({ url: 'console.invalid:3000' }))) as unknown as Answer
    assert.equal(status, 400)
    assert.match(String(body.error), /Include the scheme/)
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /saved\.invalid/)
  } finally {
    resetEnv()
  }
})

test('console-url PUT refuses https while TLS is NOT active — the tri-state argument is passed', async () => {
  const dir = sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    session('admin')
    // ⛔ THIS IS THE `tlsActive` PIN. `ConsoleUrlContext.tlsActive` is
    // tri-state: `undefined` refuses NEITHER scheme. A route that forgot to
    // pass it would ACCEPT this https address, write it, and every sign-in
    // after the restart would fail with no error anywhere — the cookie is
    // issued for an origin the browser is not on. There is no certificate
    // configured in this sandbox, so `resolveTlsConfig` is `disabled` and the
    // refusal must fire.
    const { status, body } = (await consoleUrlRoute.PUT(req({ url: 'https://console.invalid:3000' }))) as unknown as Answer
    assert.equal(status, 400)
    assert.match(String(body.error), /TLS is NOT active/)
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /saved\.invalid/)
  } finally {
    resetEnv()
  }
})

test('console-url PUT turns a name pointing elsewhere into 409 + needsConfirmation, writing nothing', async () => {
  const dir = sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    session('admin')
    // ⛔ THE LOCKOUT GUARD AT ITS HTTP BOUNDARY. A silent accept here is the one
    // typo that makes the console unreachable by the person who made it: after
    // the restart nobody can sign in, so nobody can change it back from this
    // panel.
    const { status, body } = (await consoleUrlRoute.PUT(req({ url: ELSEWHERE }))) as unknown as Answer
    assert.equal(status, 409)
    assert.equal(body.needsConfirmation, true)
    assert.ok(String(body.reason).length > 0)
    assert.equal(body.nothingChanged, true)
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /saved\.invalid/)
  } finally {
    resetEnv()
  }
})

test('console-url PUT with confirmed:true saves to both files and says a restart is required', async () => {
  const dir = sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    session('admin')
    const { status, body } = (await consoleUrlRoute.PUT(req({ url: ELSEWHERE, confirmed: true }))) as unknown as Answer
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.url, ELSEWHERE)
    // ⛔ IN THE RESPONSE, not only in the UI: NextAuth reads its options once at
    // startup, so the address saved here is not the address in force.
    assert.equal(body.restartRequired, true)
    assert.match(String(body.message), /[Rr]estart/)
    // Both targets, deploy source first.
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /198\.51\.100\.7/)
    assert.match(
      fs.readFileSync(path.join(dir, '.next', 'standalone', '.env.local'), 'utf8'),
      /198\.51\.100\.7/,
    )
    // The warning survives the confirmation, because the next person to read
    // Settings did not click the prompt.
    assert.ok((body.warnings as string[]).some((w) => /does not resolve to this server/.test(w)))
  } finally {
    resetEnv()
  }
})

test('console-url PUT accepts an address that IS this server with no prompt', async () => {
  sandbox('NEXTAUTH_URL=http://saved.invalid:3000\n')
  try {
    session('super_admin')
    const { status, body } = (await consoleUrlRoute.PUT(req({ url: 'http://127.0.0.1:3000' }))) as unknown as Answer
    assert.equal(status, 200)
    assert.equal(body.pointsHere, true)
    assert.equal(body.needsConfirmation, undefined)
  } finally {
    resetEnv()
  }
})

test('console-url PUT refuses a duplicated key before writing anything', async () => {
  const dir = sandbox('NEXTAUTH_URL=http://a.invalid:3000\nNEXTAUTH_URL=http://b.invalid:3000\n')
  try {
    session('admin')
    const { status, body } = (await consoleUrlRoute.PUT(req({ url: 'http://127.0.0.1:3000' }))) as unknown as Answer
    assert.equal(status, 409)
    assert.deepEqual(body.duplicateKeys, ['NEXTAUTH_URL'])
    assert.equal(body.nothingChanged, true)
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /a\.invalid/)
  } finally {
    resetEnv()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// /api/system/entra
// ════════════════════════════════════════════════════════════════════════════

test('entra is super_admin ONLY — an admin is refused on both methods', async () => {
  sandbox()
  try {
    // ⛔ STRICTER THAN THE CONSOLE-ADDRESS ROUTE ON PURPOSE. An `admin` who
    // could point ENTRA_TENANT_ID at a tenant they control, map a group they
    // own to super_admin and sign in would have escalated past every other
    // guard in the product without touching the Users page. The sibling route
    // in this very suite accepts `admin`, which is what makes this assertion
    // worth having rather than obvious.
    session('admin')
    assert.equal(((await entraRoute.GET()) as unknown as unknown as Answer).status, 403)
    assert.equal(((await entraRoute.PUT(req({}))) as unknown as unknown as Answer).status, 403)
    session('site_admin')
    assert.equal(((await entraRoute.GET()) as unknown as unknown as Answer).status, 403)
    session(null)
    assert.equal(((await entraRoute.GET()) as unknown as unknown as Answer).status, 401)
    session('super_admin')
    assert.equal(((await entraRoute.GET()) as unknown as unknown as Answer).status, 200)
  } finally {
    resetEnv()
  }
})

test('entra GET reports the secret as SET and never returns it', async () => {
  sandbox(`ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\nENTRA_CLIENT_SECRET=${OLD_SECRET}\n`)
  try {
    session('super_admin')
    const { body } = (await entraRoute.GET()) as unknown as Answer
    assert.equal(body.clientSecretSet, true)
    assert.equal(body.tenantIdSet, true)
    assert.equal(body.configured, true)
    // ⛔ THE WHOLE CONTRACT IN ONE ASSERTION: the secret may not appear
    // ANYWHERE in the response, under any key, at any depth.
    assert.ok(!JSON.stringify(body).includes(OLD_SECRET))
  } finally {
    resetEnv()
  }
})

test('entra GET derives the Redirect URI from the console address', async () => {
  sandbox(`ENTRA_TENANT_ID=${TENANT}\n`)
  try {
    process.env.NEXTAUTH_URL = 'https://console.invalid:3000/'
    session('super_admin')
    const { body } = (await entraRoute.GET()) as unknown as Answer
    // ⛔ DERIVED, NEVER TYPED, and the provider id `entra` is load-bearing: a
    // mismatch fails on Microsoft's side with an error that never reaches our
    // logs, so there is no trace on this server of the commonest setup mistake
    // in the feature. The trailing slash is normalised away.
    assert.equal(body.redirectUri, 'https://console.invalid:3000/api/auth/callback/entra')
  } finally {
    resetEnv()
  }
})

test('entra GET names the address a pending console-address save will become', async () => {
  sandbox('NEXTAUTH_URL=http://new.invalid:3000\n')
  try {
    process.env.NEXTAUTH_URL = 'http://old.invalid:3000'
    session('super_admin')
    const { body } = (await entraRoute.GET()) as unknown as Answer
    assert.equal(body.redirectUri, 'http://old.invalid:3000/api/auth/callback/entra')
    assert.equal(body.redirectUriAfterRestart, 'http://new.invalid:3000/api/auth/callback/entra')
  } finally {
    resetEnv()
  }
})

test('entra GET reports an unreadable env file as unknown, not as unconfigured', async () => {
  const dir = sandbox()
  try {
    fs.rmSync(path.join(dir, '.env'))
    session('super_admin')
    const { status, body } = (await entraRoute.GET()) as unknown as Answer
    assert.equal(status, 500)
    assert.match(String(body.error), /could not be read/)
    assert.equal(body.configured, undefined)
  } finally {
    resetEnv()
  }
})

test('entra PUT writes the three keys and NEVER forwards `previous` (the old secret)', async () => {
  const dir = sandbox(
    `ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\nENTRA_CLIENT_SECRET=${OLD_SECRET}\n`,
  )
  try {
    session('super_admin')
    const answer = (await entraRoute.PUT(
      req({ tenantId: TENANT, clientId: CLIENT, clientSecret: NEW_SECRET }),
    )) as unknown as Answer
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.configured, true)
    assert.equal(answer.body.restartRequired, true)

    const serialised = JSON.stringify(answer.body)
    // ⛔ THE OLD SECRET IS WHAT `writeManagedKey.previous` HOLDS, and
    // `setEnvValue`'s per-file results hold it too. Neither may travel. The
    // sibling console-address route forwards its own `previous` quite
    // correctly, which is exactly why this route must not be written by
    // copying it.
    assert.ok(!serialised.includes(OLD_SECRET), 'the replaced secret must not be in the response')
    assert.ok(!serialised.includes(NEW_SECRET), 'the new secret must not be echoed back either')
    assert.equal(answer.body.previous, undefined)
    for (const f of (answer.body.files as Array<Record<string, unknown>>) || []) {
      assert.equal(f.previous, undefined)
    }
    // And it really did write.
    const saved = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    assert.match(saved, new RegExp(`ENTRA_CLIENT_SECRET=${NEW_SECRET}`))
    assert.match(saved, new RegExp(`ENTRA_TENANT_ID=${TENANT}`))
  } finally {
    resetEnv()
  }
})

test('entra PUT leaves the stored secret alone when the box is absent', async () => {
  const dir = sandbox(
    `ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\nENTRA_CLIENT_SECRET=${OLD_SECRET}\n`,
  )
  try {
    session('super_admin')
    const { status, body } = (await entraRoute.PUT(
      req({ tenantId: TENANT, clientId: CLIENT }),
    )) as unknown as Answer
    assert.equal(status, 200)
    // The trio is still complete, which is only knowable from the stored-secret
    // boolean the route passes to `planEntraWrite`.
    assert.equal(body.configured, true)
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), new RegExp(OLD_SECRET))
  } finally {
    resetEnv()
  }
})

test('entra PUT refuses blank ids with the name of the control that turns SSO off', async () => {
  sandbox(`ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\nENTRA_CLIENT_SECRET=${OLD_SECRET}\n`)
  try {
    session('super_admin')
    const { status, body } = (await entraRoute.PUT(req({ tenantId: '', clientId: '' }))) as unknown as Answer
    assert.equal(status, 400)
    assert.match(String(body.error), /Turn off single sign-on/)
    assert.equal(body.nothingChanged, true)
  } finally {
    resetEnv()
  }
})

test('entra PUT names the offending field without echoing its value', async () => {
  sandbox(`ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\nENTRA_CLIENT_SECRET=${OLD_SECRET}\n`)
  try {
    session('super_admin')
    // The commonest way to fail this is pasting the SECRET into an id box.
    const { status, body } = (await entraRoute.PUT(
      req({ tenantId: OLD_SECRET, clientId: CLIENT }),
    )) as unknown as Answer
    assert.equal(status, 400)
    assert.equal(body.field, 'Directory (tenant) ID')
    assert.ok(!JSON.stringify(body).includes(OLD_SECRET))
  } finally {
    resetEnv()
  }
})

test('entra PUT can turn single sign-on off by clearing all three', async () => {
  const dir = sandbox(
    `ENTRA_TENANT_ID=${TENANT}\nENTRA_CLIENT_ID=${CLIENT}\nENTRA_CLIENT_SECRET=${OLD_SECRET}\n`,
  )
  try {
    session('super_admin')
    const { status, body } = (await entraRoute.PUT(
      req({ tenantId: '', clientId: '', clientSecret: '' }),
    )) as unknown as Answer
    assert.equal(status, 200)
    assert.equal(body.disabled, true)
    assert.equal(body.configured, false)
    const saved = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    assert.ok(!saved.includes(OLD_SECRET))
    assert.match(saved, /ENTRA_TENANT_ID=\s*$/m)
  } finally {
    resetEnv()
  }
})

test('entra PUT refuses a duplicated key in either file before writing', async () => {
  const dir = sandbox(`ENTRA_TENANT_ID=${TENANT}\nENTRA_TENANT_ID=${TENANT}\n`)
  try {
    session('super_admin')
    const { status, body } = (await entraRoute.PUT(
      req({ tenantId: TENANT, clientId: CLIENT, clientSecret: NEW_SECRET }),
    )) as unknown as Answer
    assert.equal(status, 409)
    assert.deepEqual(body.duplicateKeys, ['ENTRA_TENANT_ID'])
    assert.equal(body.nothingChanged, true)
    assert.ok(!fs.readFileSync(path.join(dir, '.env'), 'utf8').includes(NEW_SECRET))
  } finally {
    resetEnv()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// /api/system/tls
// ════════════════════════════════════════════════════════════════════════════

test('tls: no session is 401 and no role is 403', async () => {
  sandbox()
  try {
    session(null)
    assert.equal(((await tlsRoute.GET()) as unknown as unknown as Answer).status, 401)
    session('viewer')
    assert.equal(((await tlsRoute.GET()) as unknown as unknown as Answer).status, 403)
    assert.equal(((await tlsRoute.POST(req({}))) as unknown as unknown as Answer).status, 403)
    session('admin')
    assert.equal(((await tlsRoute.GET()) as unknown as unknown as Answer).status, 200)
  } finally {
    resetEnv()
  }
})

test('tls GET says "not configured" for disabled, which is not an error', async () => {
  sandbox()
  try {
    session('admin')
    const { body } = (await tlsRoute.GET()) as unknown as Answer
    assert.equal(body.status, 'disabled')
    assert.match(String(body.summary), /not configured/)
    assert.equal(body.error, null)
    assert.equal(body.certificate, null)
  } finally {
    resetEnv()
  }
})

test('tls GET reports the certificate and its chain, and never the key', async () => {
  const m = mintMaterial()
  const dir = sandbox()
  try {
    const certPath = path.join(dir, 'fullchain.pem')
    const keyPath = path.join(dir, 'console.key')
    fs.writeFileSync(certPath, m.leaf + m.chain)
    fs.writeFileSync(keyPath, m.key)
    process.env.TLS_CERT_PATH = certPath
    process.env.TLS_KEY_PATH = keyPath
    process.env.NEXTAUTH_URL = 'http://console.invalid:3000'
    session('admin')
    const { body } = (await tlsRoute.GET()) as unknown as Answer
    assert.equal(body.status, 'active')
    assert.match(String(body.summary), /ACTIVE/)
    const cert = body.certificate as { subject: string; chainLength: number; sans: string[] }
    assert.match(cert.subject, /console\.invalid/)
    assert.equal(cert.chainLength, 2)
    assert.deepEqual(cert.sans, ['DNS:console.invalid'])
    assert.equal(body.keyPresent, true)
    // ⛔ THE KEY IS NEVER RETURNED, IN ANY SHAPE. The path is, because the
    // operator has to know which file an install would replace; a filename is
    // not key material.
    const serialised = JSON.stringify(body)
    assert.ok(!serialised.includes('PRIVATE KEY'))
    assert.ok(!serialised.includes(m.key.split('\n')[1]))
    // ⛔ `active` with an http:// console address breaks every sign-in with no
    // error anywhere, so it is reported here too.
    assert.match(String(body.nextAuthUrlMismatch), /TLS is active/)
  } finally {
    resetEnv()
  }
})

test('tls POST refuses a mismatched pair and writes NOTHING', async () => {
  const m = mintMaterial()
  const dir = sandbox()
  try {
    session('admin')
    // ⛔ THE GUARD THE WHOLE FEATURE RESTS ON. Both halves parse; this pair
    // fails only at the next restart, weeks later, during an unrelated upgrade.
    const { status, body } = (await tlsRoute.POST(
      req({ certificate: m.leaf, privateKey: m.otherKey }),
    )) as unknown as Answer
    assert.equal(status, 400)
    assert.match(String(body.error), /does not belong to this certificate/)
    assert.equal(fs.existsSync(path.join(dir, 'certs')), false)
    assert.ok(!fs.readFileSync(path.join(dir, '.env'), 'utf8').includes('TLS_CERT_PATH'))
  } finally {
    resetEnv()
  }
})

test('tls POST installs a pasted chain, sets the paths, and requires a restart', async () => {
  const m = mintMaterial()
  const dir = sandbox()
  try {
    process.env.NEXTAUTH_URL = 'http://console.invalid:3000'
    session('admin')
    const { status, body } = (await tlsRoute.POST(
      req({ certificate: m.leaf + m.chain, privateKey: m.key }),
    )) as unknown as Answer
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.chainLength, 2)
    assert.equal(body.chainOnly, false)
    assert.equal(body.restartRequired, true)
    assert.deepEqual(body.backups, [])
    const certPath = body.certPath as string
    assert.equal(countCerts(fs.readFileSync(certPath, 'utf8')), 2)
    assert.match(fs.readFileSync(body.keyPath as string, 'utf8'), /PRIVATE KEY/)
    // The managed keys went to the deploy source, so the next deploy keeps them.
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    assert.match(env, /TLS_CERT_PATH=/)
    assert.match(env, /TLS_KEY_PATH=/)
    assert.equal(body.envWritten, true)
    assert.equal(body.previousStatus, 'disabled')
    // ⛔ Turning TLS on makes an http:// console address fatal, so the second
    // step is named rather than left to be discovered.
    assert.match(String(body.consoleUrlActionRequired), /TLS is active/)
    // The key is not echoed back.
    assert.ok(!JSON.stringify(body).includes('PRIVATE KEY'))
  } finally {
    resetEnv()
  }
})

test('tls POST will not replace an existing certificate without being asked', async () => {
  const m = mintMaterial()
  const dir = sandbox()
  try {
    session('admin')
    const first = (await tlsRoute.POST(req({ certificate: m.leaf + m.chain, privateKey: m.key }))) as unknown as Answer
    assert.equal(first.status, 200)
    const certPath = first.body.certPath as string
    const before = fs.readFileSync(certPath, 'utf8')

    // ⛔ NEVER OVERWRITE UNASKED. The certificate being replaced may be the only
    // copy of a CA-issued one on the box, and the request may have come from a
    // retry or a stale tab.
    const second = (await tlsRoute.POST(req({ certificate: m.leaf, privateKey: m.key }))) as unknown as Answer
    assert.equal(second.status, 409)
    assert.equal(second.body.needsConfirmation, true)
    assert.equal(second.body.nothingChanged, true)
    assert.ok((second.body.existingFiles as string[]).includes(certPath))
    assert.equal(fs.readFileSync(certPath, 'utf8'), before)

    // ⛔ AND IT BACKS THE PREVIOUS PAIR UP when it does replace it.
    const third = (await tlsRoute.POST(
      req({ certificate: m.leaf, privateKey: m.key, replace: true }),
    )) as unknown as Answer
    assert.equal(third.status, 200)
    const backups = third.body.backups as string[]
    assert.equal(backups.length, 2)
    for (const b of backups) assert.ok(fs.existsSync(b))
    // The backup holds the OLD two-certificate bundle; the live file is now the
    // one-certificate upload.
    assert.equal(countCerts(fs.readFileSync(backups[0], 'utf8')), 2)
    assert.equal(countCerts(fs.readFileSync(certPath, 'utf8')), 1)
    assert.equal(third.body.chainOnly, true)
    assert.ok(fs.readdirSync(path.dirname(certPath)).some((f) => f.endsWith('.bak.key')))
  } finally {
    resetEnv()
  }
})

test('tls POST accepts a .pfx with its passphrase and installs the whole chain', async () => {
  const m = mintMaterial()
  const dir = sandbox()
  try {
    session('admin')
    const { status, body } = (await tlsRoute.POST(
      req({ certificateB64: m.pfx.toString('base64'), passphrase: 'fixturePass' }),
    )) as unknown as Answer
    assert.equal(status, 200)
    // ⛔ THE CHAIN SURVIVES THE PKCS#12 PATH END TO END — the `-clcerts` bug
    // would make this 1.
    assert.equal(body.chainLength, 2)
    assert.equal(countCerts(fs.readFileSync(body.certPath as string, 'utf8')), 2)
    assert.ok(!JSON.stringify(body).includes('PRIVATE KEY'))
    assert.ok(fs.existsSync(path.join(dir, 'certs')))
  } finally {
    resetEnv()
  }
})

test('tls POST accepts a .cer/.der plus a key plus a chain bundle', async () => {
  const m = mintMaterial()
  sandbox()
  try {
    session('admin')
    const der = new crypto.X509Certificate(m.leaf).raw
    const { status, body } = (await tlsRoute.POST(
      req({
        certificateB64: Buffer.from(der).toString('base64'),
        privateKeyB64: Buffer.from(m.key, 'utf8').toString('base64'),
        chainB64: Buffer.from(m.chain, 'utf8').toString('base64'),
      }),
    )) as unknown as Answer
    assert.equal(status, 200)
    assert.equal(body.chainLength, 2)
  } finally {
    resetEnv()
  }
})

test('tls POST with no certificate at all is a 400, not a crash', async () => {
  sandbox()
  try {
    session('admin')
    const { status, body } = (await tlsRoute.POST(req({}))) as unknown as Answer
    assert.equal(status, 400)
    assert.match(String(body.error), /No certificate was supplied/)
  } finally {
    resetEnv()
  }
})


// ── /api/system/directory-mappings ──────────────────────────────────────────
//
// The group -> role table. Everything here is a property of the route: the
// store's SQL has its own integration suite against a real PostgreSQL.

type StoreCall = [string, ...unknown[]]

function storeCalls(): StoreCall[] {
  return ((globalThis as Record<string, unknown>).__nvStoreCalls as StoreCall[]) || []
}
function resetStore(): void {
  ;(globalThis as Record<string, unknown>).__nvStoreCalls = []
  ;(globalThis as Record<string, unknown>).__nvMappings = []
  ;(globalThis as Record<string, unknown>).__nvCreateDuplicate = false
  ;(globalThis as Record<string, unknown>).__nvDeleteMissing = false
}
const jsonReq = (body: unknown) => ({ json: async () => body }) as never
const urlReq = (url: string) => ({ url }) as never

test('mappings: no session is 401 and never reaches the store', async () => {
  resetStore()
  session(null)
  const get = (await mappingsRoute.GET()) as unknown as Answer
  assert.equal(get.status, 401)
  const post = (await mappingsRoute.POST(jsonReq({ groupKey: 'g', role: 'admin' }))) as unknown as Answer
  assert.equal(post.status, 401)
  const del = (await mappingsRoute.DELETE(urlReq('http://x/?id=1'))) as unknown as Answer
  assert.equal(del.status, 401)
  assert.deepEqual(storeCalls(), [], 'an unauthenticated request must not touch the database')
})

test('mappings: an admin is 403 on every verb — this is THE escalation guard', async () => {
  // ⛔ NOT A COPY OF THE ENTRA ROUTE'S TEST, A SECOND HALF OF IT. The entra
  // route's own header names the attack as: an admin who could point the tenant
  // at a directory they control, "map a group they own to super_admin and sign
  // in". Gating the tenant on super_admin while leaving mappings at admin keeps
  // that escalation alive on any box whose tenant is already set.
  resetStore()
  session('admin')
  for (const [label, res] of [
    ['GET', (await mappingsRoute.GET()) as unknown as Answer],
    ['POST', (await mappingsRoute.POST(jsonReq({ groupKey: 'g', role: 'super_admin' }))) as unknown as Answer],
    ['DELETE', (await mappingsRoute.DELETE(urlReq('http://x/?id=1'))) as unknown as Answer],
  ] as [string, Answer][]) {
    assert.equal(res.status, 403, `${label} must be 403 for an admin, got ${res.status}`)
  }
  assert.deepEqual(storeCalls(), [], 'a forbidden request must not touch the database')

  // site_admin and viewer must fare no better.
  for (const role of ['site_admin', 'viewer']) {
    session(role)
    const res = (await mappingsRoute.POST(jsonReq({ groupKey: 'g', role: 'admin' }))) as unknown as Answer
    assert.equal(res.status, 403, `${role} must be 403, got ${res.status}`)
  }
})

test('mappings: a blank group key is 400 before any insert', async () => {
  resetStore()
  session('super_admin')
  const res = (await mappingsRoute.POST(jsonReq({ groupKey: '   ', role: 'admin' }))) as unknown as Answer
  assert.equal(res.status, 400)
  assert.match(String(res.body.error), /object ID/i)
  assert.deepEqual(storeCalls(), [], 'nothing may be written for an empty group key')
})

test('mappings: site_admin is refused with the reason, and NOT left to the CHECK constraint', async () => {
  resetStore()
  session('super_admin')
  const res = (await mappingsRoute.POST(
    jsonReq({ groupKey: '11111111-2222-3333-4444-555555555555', role: 'site_admin' }),
  )) as unknown as Answer
  assert.equal(res.status, 400, 'a 500 here means the database rejected it, not the route')
  // ⛔ THE ASSERTION THAT MATTERS. If the route let this through, the table's
  // CHECK would still refuse it — as a 500 carrying a Postgres error string, to
  // an administrator who would have no idea why. Proving the store was never
  // called is the only way to show the first line of defence exists.
  assert.deepEqual(storeCalls(), [], 'the role must be validated before the insert')
  assert.match(String(res.body.detail), /no `?user_sites`?|assigned sites|see nothing/i)
})

test('mappings: an unknown role is refused and lists the ones that work', async () => {
  resetStore()
  session('super_admin')
  const res = (await mappingsRoute.POST(
    jsonReq({ groupKey: 'g1', role: 'wizard' }),
  )) as unknown as Answer
  assert.equal(res.status, 400)
  for (const r of ['super_admin', 'admin', 'viewer']) {
    assert.ok(String(res.body.error).includes(r), `the message should name ${r}`)
  }
  assert.deepEqual(storeCalls(), [])
})

test('mappings: a duplicate is 409, distinct from a database fault', async () => {
  resetStore()
  ;(globalThis as Record<string, unknown>).__nvCreateDuplicate = true
  session('super_admin')
  const res = (await mappingsRoute.POST(
    jsonReq({ groupKey: 'g1', role: 'admin' }),
  )) as unknown as Answer
  assert.equal(res.status, 409, 'a duplicate must not be reported as a 500')
  assert.equal(res.body.duplicate, true)
})

test('mappings: a valid mapping is created and the group key is passed through untrimmed of meaning', async () => {
  resetStore()
  session('super_admin')
  const res = (await mappingsRoute.POST(
    jsonReq({ groupKey: '  ABCD-1234  ', displayName: '  Net Admins  ', role: 'admin' }),
  )) as unknown as Answer
  assert.equal(res.status, 201)
  const create = storeCalls().find((c) => c[0] === 'create')
  assert.ok(create, 'the store must be called')
  const input = create![1] as { groupKey: string; displayName: string | null; role: string }
  assert.equal(input.groupKey, 'ABCD-1234', 'surrounding whitespace must not become part of the key')
  assert.equal(input.displayName, 'Net Admins')
  assert.equal(input.role, 'admin')
})

test('mappings: DELETE requires a real id and says when the last mapping is gone', async () => {
  resetStore()
  session('super_admin')

  for (const bad of ['', 'abc', '0', '-3', '1.5']) {
    resetStore()
    const res = (await mappingsRoute.DELETE(urlReq(`http://x/?id=${bad}`))) as unknown as Answer
    assert.equal(res.status, 400, `id=${bad} must be refused, got ${res.status}`)
    assert.deepEqual(storeCalls(), [], `id=${bad} must not reach the database`)
  }

  // ⛔ lockedOut IS NOT COSMETIC. An empty table refuses EVERY directory
  // sign-in, and an administrator tidying a list has no reason to know that
  // removing the final row locks the whole directory out of the product.
  resetStore()
  const res = (await mappingsRoute.DELETE(urlReq('http://x/?id=5'))) as unknown as Answer
  assert.equal(res.status, 200)
  assert.equal(res.body.lockedOut, true, 'removing the last mapping must be reported as such')
  assert.equal(res.body.remaining, 0)

  resetStore()
  ;(globalThis as Record<string, unknown>).__nvMappings = [{ id: 9 }]
  const res2 = (await mappingsRoute.DELETE(urlReq('http://x/?id=5'))) as unknown as Answer
  assert.equal(res2.body.lockedOut, false, 'with mappings left, nobody is locked out')

  resetStore()
  ;(globalThis as Record<string, unknown>).__nvDeleteMissing = true
  const res3 = (await mappingsRoute.DELETE(urlReq('http://x/?id=5'))) as unknown as Answer
  assert.equal(res3.status, 404, 'a mapping that is already gone is a 404, not a 500')
})
