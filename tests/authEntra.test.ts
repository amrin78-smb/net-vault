//
// tests/authEntra.test.ts — the Entra ID branch of NextAuth's route.
//
// ⛔ WHY THERE IS A MODULE LOADER AT THE TOP OF THIS FILE. The thing worth
// testing here is the ROUTE ITSELF: whether `callbacks.signIn` actually returns
// a refusal, whether `callbacks.jwt` actually clears a role. Those are the two
// places SecVault got wrong, and both of them are properties of the route and
// not of any library it calls — so a test that only exercised
// `lib/directoryRoles.ts` and `lib/directoryUser.ts` (both already covered by
// their own suites) would assert nothing about the bug class.
//
// The route cannot be imported by `node --test` as it stands: it uses the `@/*`
// path alias, which only a bundler resolves, and it pulls three CommonJS
// next-auth entry points whose default export Node's ESM interop hands back as
// a namespace object rather than the function (`CredentialsProvider is not a
// function`). Both are resolution problems, not design problems, so they are
// fixed in the loader rather than by reshaping production code around the test
// runner:
//
//   `@/x`          -> <repo>/x.ts
//   `@/lib/db`     -> an in-memory stand-in, so `authorize()` is reachable
//   the three next-auth entry points -> the REAL modules, with the same
//                     `esModuleInterop` unwrapping the bundler applies
//
// Everything else — next-auth, bcryptjs, `lib/directory*.ts`, `lib/mfaGate.ts`
// — is the real code. `NextAuth(authOptions)` really runs at import.
//
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'

const ROOT = new URL('../', import.meta.url).href

// The stand-in for `lib/db`. Built here so the URL this file imports and the
// URL the loader substitutes are byte-identical — Node caches ES modules by
// URL, so that is what makes it the same instance on both sides.
const DB_STUB = `
let handler = async () => ({ rows: [], rowCount: 0 });
export const calls = [];
export function setDb(fn) { handler = fn; calls.length = 0 }
export async function query(text, params) { calls.push({ text, params }); return handler(text, params) }
export async function withTransaction(fn) { return fn({ query }) }
export default {}
`
const DB_URL = 'data:text/javascript,' + encodeURIComponent(DB_STUB)

const INTEROP = ['next-auth', 'next-auth/providers/credentials', 'next-auth/providers/azure-ad']

const HOOK = `
const ROOT = ${JSON.stringify(ROOT)};
const DB_URL = ${JSON.stringify(DB_URL)};
const INTEROP = ${JSON.stringify(INTEROP)};
export async function resolve(specifier, context, next) {
  if (specifier === '@/lib/db') return { url: DB_URL, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const rest = specifier.slice(2);
    return next(ROOT + rest + (rest.endsWith('.ts') ? '' : '.ts'), context);
  }
  if (INTEROP.includes(specifier)) {
    const src = "import { createRequire } from 'node:module';"
      + "const req = createRequire(" + JSON.stringify(ROOT) + ");"
      + "const m = req(" + JSON.stringify(specifier) + ");"
      + "export default (m && m.default !== undefined) ? m.default : m;";
    return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
  }
  return next(specifier, context);
}
`
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url)

const db: any = await import(DB_URL)
const route: any = await import('../app/api/auth/[...nextauth]/route.ts')

const { authOptions, entraProviders, tokenRoleFrom, directoryDeps, ENTRA_PROVIDER_ID } = route
const signIn = authOptions.callbacks.signIn
const jwt = authOptions.callbacks.jwt
const session = authOptions.callbacks.session
const credentials = authOptions.providers.find((p: any) => p.id === 'credentials')
const authorize = credentials.options.authorize

// ── fixtures ────────────────────────────────────────────────────────────────
// ⛔ Nothing here is a real tenant, client, secret or host.
const CONFIGURED = {
  ENTRA_TENANT_ID: 'tenant-placeholder',
  ENTRA_CLIENT_ID: 'client-placeholder',
  ENTRA_CLIENT_SECRET: 'secret-placeholder',
}
const OID = '00000000-1111-2222-3333-444444444444'
const EMAIL = 'someone@example.test'
const GROUP_ADMIN = 'aaaaaaaa-0000-0000-0000-000000000001'
const GROUP_VIEW = 'bbbbbbbb-0000-0000-0000-000000000002'

const claims = (over: Record<string, unknown> = {}) => ({
  oid: OID,
  email: EMAIL,
  name: 'Some One',
  groups: [GROUP_ADMIN],
  ...over,
})

const entraUser = (over: Record<string, unknown> = {}): any => ({
  id: OID,
  email: EMAIL,
  name: 'Some One',
  role: null,
  entraClaims: claims(),
  ...over,
})

const MAPPINGS = [
  { group_key: GROUP_ADMIN, role: 'admin', display_name: 'NocVault Admins' },
  { group_key: GROUP_VIEW, role: 'viewer', display_name: 'NocVault Viewers' },
]

const ALL_APPS = ['netvault', 'logvault', 'ddivault', 'spanvault']

type Recorder = { created: any[]; refreshed: any[]; mappingLoads: number; appsFor: any[] }

/**
 * Replace the route's injectable directory store. `directoryDeps` is the
 * route's own test seam — the callbacks run inside NextAuth, which fixes their
 * signatures, so there is nowhere else to pass a fake.
 */
function stubDeps(over: Record<string, unknown> = {}): Recorder {
  const rec: Recorder = { created: [], refreshed: [], mappingLoads: 0, appsFor: [] }
  const base: Record<string, unknown> = {
    loadMappings: async () => MAPPINGS,
    loadContext: async () => ({ byOid: null, byEmail: null }),
    createUser: async (input: any) => {
      rec.created.push(input)
      return {
        id: 42,
        name: input.name,
        email: input.email,
        role: input.role,
        auth_provider: 'entra',
        entra_oid: input.entra_oid,
        password_hash: null,
      }
    },
    refreshRole: async (id: number, role: string) => {
      rec.refreshed.push({ id, role })
      return 1
    },
    userApps: async (id: number, role: string) => {
      rec.appsFor.push({ id, role })
      return [...ALL_APPS]
    },
  }
  const merged = { ...base, ...over }
  // The mapping-load count is taken AFTER the override is applied, so a test
  // that supplies its own loadMappings is still counted — otherwise "the
  // mappings were re-read" silently asserts nothing in exactly the tests that
  // care about it.
  const inner = merged.loadMappings as () => Promise<unknown>
  merged.loadMappings = async () => {
    rec.mappingLoads++
    return inner()
  }
  Object.assign(directoryDeps, merged)
  return rec
}

async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; warns: string[]; logs: string[] }> {
  const warns: string[] = []
  const logs: string[] = []
  const realWarn = console.warn
  const realLog = console.log
  console.warn = (...a: unknown[]) => void warns.push(a.join(' '))
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    const value = await fn()
    return { value, warns, logs }
  } finally {
    console.warn = realWarn
    console.log = realLog
  }
}

// ─── 1. provider registration ───────────────────────────────────────────────

test('the provider id is entra, and NextAuth derives /api/auth/callback/entra from it', () => {
  assert.equal(ENTRA_PROVIDER_ID, 'entra')

  const built = entraProviders(CONFIGURED)
  assert.equal(built.length, 1)
  // ⛔ READ THROUGH `.options`, BECAUSE THAT IS WHERE NEXTAUTH READS IT.
  // `AzureADProvider(x)` returns its own defaults with `options: x` attached;
  // `core/lib/providers.js` merges `options` over the defaults at init and
  // takes the id from `options.id` in preference to its own. So an id set
  // anywhere else would be silently ignored.
  assert.equal(built[0].options.id, 'entra')

  // The callback URL is not ours to choose — next-auth builds it from the id.
  // This asserts the real derivation rather than restating it, because the
  // string it produces is what a customer pastes into their app registration.
  // Required by absolute path on purpose: `core/lib/providers` is not in
  // next-auth's `exports` map, and this is the real merge step the shipped
  // runtime performs. If next-auth ever moves it this fails loudly, which is
  // the right outcome for a test guarding a URL every customer has pasted into
  // their tenant.
  const req = createRequire(import.meta.url)
  const parseProviders = req(
    fileURLToPath(new URL('../node_modules/next-auth/core/lib/providers.js', import.meta.url)),
  ).default
  const { providers } = parseProviders({ url: 'https://console.example.test/api/auth', providers: built })
  assert.equal(providers[0].id, 'entra')
  assert.equal(providers[0].callbackUrl, 'https://console.example.test/api/auth/callback/entra')
})

test('no Entra provider is registered unless all three ENTRA_* values are present', () => {
  assert.deepEqual(entraProviders({}), [])
  // ⛔ A HALF-CONFIGURATION IS NOT A CONFIGURATION. Each of these would render
  // a "Sign in with Microsoft" button that cannot complete, and an operator
  // meeting a button that fails concludes the product is broken.
  for (const missing of Object.keys(CONFIGURED)) {
    const partial: Record<string, string> = { ...CONFIGURED }
    delete partial[missing]
    assert.deepEqual(entraProviders(partial), [], `${missing} missing must mean not configured`)
    assert.deepEqual(entraProviders({ ...CONFIGURED, [missing]: '   ' }), [], `${missing} blank`)
  }
  assert.equal(entraProviders(CONFIGURED).length, 1)
})

test('the configured provider is appended without disturbing local sign-in', () => {
  // This process has no ENTRA_* values, so the real `authOptions` must carry
  // credentials alone — the shipped default for every install that does not use
  // Entra, and the reason an unreachable login.microsoftonline.com can never
  // lock an administrator out.
  assert.deepEqual(
    authOptions.providers.map((p: any) => p.options?.id ?? p.id),
    ['credentials'],
  )
  // And when it IS configured it goes on the END, after credentials.
  const both = [...authOptions.providers, ...entraProviders(CONFIGURED)]
  assert.deepEqual(both.map((p: any) => p.options?.id ?? p.id), ['credentials', 'entra'])
})

test('profile() carries the oid and the whole group claim, and keys identity on the oid rather than the email', () => {
  const provider = entraProviders(CONFIGURED)[0]
  const out: any = provider.options.profile({
    oid: OID,
    sub: 'subject-is-not-the-oid',
    email: EMAIL,
    name: 'Some One',
    groups: [GROUP_ADMIN],
    _claim_names: { groups: 'src1' },
    _claim_sources: { src1: { endpoint: 'https://graph.example.test/x' } },
  })

  // ⛔ The oid, not the email — an oid is immutable, a UPN is not.
  assert.equal(out.id, OID)
  assert.equal(out.entraClaims.oid, OID)
  assert.notEqual(out.id, EMAIL)
  // ⛔ The role is never taken from the token.
  assert.equal(out.role, null)
  // ⛔ The group claim travels WHOLE, overage pointer included. Dropping
  // `_claim_names`/`_claim_sources` would make a user in 201 groups read as a
  // user in none — see the overage note in lib/directoryRoles.ts.
  assert.deepEqual(out.entraClaims.groups, [GROUP_ADMIN])
  assert.deepEqual(out.entraClaims._claim_names, { groups: 'src1' })
  assert.deepEqual(out.entraClaims._claim_sources, {
    src1: { endpoint: 'https://graph.example.test/x' },
  })
})

// ─── 2. signIn: the front door ──────────────────────────────────────────────

test('a permitted directory sign-in stamps the hub user id, role and apps onto the user object', async () => {
  const rec = stubDeps()
  const user = entraUser()
  const { value } = await captured(() => signIn({ user, account: { provider: 'entra' } }))

  assert.equal(value, true)
  assert.deepEqual(rec.created, [
    { email: EMAIL, name: 'Some One', role: 'admin', entra_oid: OID },
  ])
  // ⛔ THE HUB'S users.id, NOT THE OID. LogVault selects `WHERE id = $1` and
  // DDIVault asks /api/auth/sso-verify; both fail on an oid, and SpanVault
  // silently demotes to viewer instead of failing.
  assert.equal(user.id, '42')
  assert.equal(user.role, 'admin')
  // ⛔ The same source of truth for apps a local sign-in uses.
  assert.deepEqual(user.apps, ALL_APPS)
  assert.deepEqual(rec.appsFor, [{ id: 42, role: 'admin' }])
  // ⛔ Empty, and it cannot be anything else — site_admin is refused upstream
  // for a directory account, so no directory account has site assignments.
  assert.deepEqual(user.siteIds, [])
})

test('signIn returns exactly false for a refusal — the only value that travels', async () => {
  stubDeps({ loadMappings: async () => [] })
  const { value } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  // ⛔ STRICTLY `false`. NextAuth's default signIn returns true, so a refusal
  // expressed only inside jwt() is not a refusal at all — it is logged and then
  // the sign-in completes (SecVault shipped exactly that). And `false` is the
  // only return value that cannot carry a cause: a string return is a redirect
  // of our own choosing, and the cause must never appear in one.
  assert.equal(value, false)
  assert.notEqual(value, true)
  assert.equal(typeof value, 'boolean')
})

test('the named cause goes to the server log only', async () => {
  stubDeps({ loadMappings: async () => MAPPINGS })
  const { value, warns } = await captured(() =>
    signIn({ user: entraUser({ entraClaims: claims({ groups: ['unmapped-group'] }) }), account: { provider: 'entra' } }),
  )

  // One line, naming the outcome AND its reason, for the operator reading logs.
  assert.equal(warns.length, 1)
  assert.match(warns[0], /no_matching_group/)
  assert.match(warns[0], /not in any group mapped to a hub role/)
  assert.match(warns[0], /someone@example\.test/)

  // ⛔ AND NONE OF IT TRAVELS. The sign-in page is reachable without
  // authentication; naming which of six causes applies would tell an
  // unauthenticated visitor how this customer's directory is wired.
  assert.doesNotMatch(JSON.stringify(value), /no_matching_group|mapped to a hub role/)
})

test('an unreadable mapping table refuses as our fault, not as "nothing is mapped"', async () => {
  stubDeps({
    loadMappings: async () => {
      throw new Error('connection terminated unexpectedly')
    },
  })
  const { value, warns } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  assert.equal(value, false)
  // ⛔ `mappings_unreadable`, NOT `no_mappings`. An empty mapping list is a
  // deliberate, correct, fail-closed configuration; a dropped connection is our
  // fault. Collapsing them sends an administrator to fix a configuration that
  // is already right — SecVault told them to check their app registration
  // while the database was down.
  assert.match(warns[0], /mappings_unreadable/)
  assert.doesNotMatch(warns[0], /no_mappings/)
  // The exception text must not travel either.
  assert.doesNotMatch(JSON.stringify(value), /connection terminated/)
})

test('an unreadable users table refuses as our fault rather than provisioning a duplicate', async () => {
  const rec = stubDeps({
    loadContext: async () => {
      throw new Error('relation "users" does not exist')
    },
  })
  const { value, warns } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  assert.equal(value, false)
  // ⛔ A FAILED LOOKUP IS NOT "NO ROW". `null` would read as "provision a new
  // account" and create a second row for somebody who already has one.
  assert.match(warns[0], /directory_context_unreadable/)
  assert.deepEqual(rec.created, [])
})

test('an email collision with a local account is refused', async () => {
  const rec = stubDeps({
    loadContext: async () => ({
      byOid: null,
      byEmail: { id: 9, email: EMAIL, role: 'super_admin', auth_provider: 'local' },
    }),
  })
  const { value, warns } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  assert.equal(value, false)
  assert.match(warns[0], /email_collision/)
  // ⛔ Never auto-linked: whoever obtains a directory account bearing that
  // address would inherit the local account's role, up to super_admin.
  assert.deepEqual(rec.created, [])
  assert.deepEqual(rec.refreshed, [])
})

test('a site_admin mapping is refused rather than signed in with no sites', async () => {
  const rec = stubDeps({
    loadMappings: async () => [{ group_key: GROUP_ADMIN, role: 'site_admin', display_name: 'Site Admins' }],
  })
  const { value, warns } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  assert.equal(value, false)
  assert.deepEqual(rec.created, [])
  // The role never resolves at all for site_admin (lib/directoryRoles.ts's
  // isDirectoryRole excludes it), so the cause is the mapping not matching —
  // what matters here is that nobody is provisioned into an empty product.
  assert.match(warns[0], /no_matching_group|role_unsupported/)
})

test('a group-claim overage is refused by name, not read as "no groups"', async () => {
  stubDeps()
  const { value, warns } = await captured(() =>
    signIn({
      user: entraUser({
        entraClaims: claims({ groups: undefined, _claim_names: { groups: 'src1' }, _claim_sources: { src1: {} } }),
      }),
      account: { provider: 'entra' },
    }),
  )

  assert.equal(value, false)
  // ⛔ The dangerous case that looks exactly like innocence: Entra drops the
  // groups claim past ~200 memberships, which lands on the most group-heavy
  // accounts in a directory — usually the administrators.
  assert.match(warns[0], /groups_overage/)
  assert.doesNotMatch(warns[0], /no_matching_group/)
})

test('a credentials sign-in never touches the directory store', async () => {
  const rec = stubDeps()
  const { value } = await captured(() =>
    signIn({ user: { id: '3', role: 'admin' }, account: { provider: 'credentials' } }),
  )
  assert.equal(value, true)
  assert.equal(rec.mappingLoads, 0)
  // And a sign-in with no account at all (nothing in next-auth produces one
  // today) must not fall into the directory branch either.
  const { value: noAccount } = await captured(() => signIn({ user: { id: '3' }, account: null }))
  assert.equal(noAccount, true)
  assert.equal(rec.mappingLoads, 0)
})

test('an existing directory account is matched and its role refreshed from the mapping', async () => {
  const rec = stubDeps({
    loadMappings: async () => [{ group_key: GROUP_VIEW, role: 'viewer', display_name: 'Viewers' }],
    loadContext: async () => ({
      byOid: {
        id: 7,
        name: 'Some One',
        email: EMAIL,
        role: 'super_admin',
        auth_provider: 'entra',
        entra_oid: OID,
        password_hash: null,
      },
      byEmail: {
        id: 7,
        name: 'Some One',
        email: EMAIL,
        role: 'super_admin',
        auth_provider: 'entra',
        entra_oid: OID,
        password_hash: null,
      },
    }),
  })
  const user = entraUser({ entraClaims: claims({ groups: [GROUP_VIEW] }) })
  const { value } = await captured(() => signIn({ user, account: { provider: 'entra' } }))

  assert.equal(value, true)
  assert.deepEqual(rec.created, [])
  // ⛔ The MAPPING is authoritative on every sign-in, not only the first — the
  // stored super_admin is demoted, not honoured.
  assert.deepEqual(rec.refreshed, [{ id: 7, role: 'viewer' }])
  assert.equal(user.id, '7')
  assert.equal(user.role, 'viewer')
})

test('a failed provisioning write refuses instead of throwing out of signIn', async () => {
  stubDeps({
    createUser: async () => {
      throw new Error('duplicate key value violates unique constraint "users_email_key"')
    },
  })
  const { value, warns } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  assert.equal(value, false)
  assert.match(warns[0], /provisioning_failed/)
  // ⛔ NextAuth turns a THROW into `/api/auth/error?error=<error.message>` —
  // the exception text would be published on an unauthenticated page.
  assert.doesNotMatch(warns[0], /users_email_key/)
})

test('an unexpected throw inside signIn is a refusal, not an error page carrying its message', async () => {
  stubDeps({
    userApps: async () => {
      throw new Error('a secret-bearing message nobody vetted')
    },
  })
  const { value, warns } = await captured(() => signIn({ user: entraUser(), account: { provider: 'entra' } }))

  assert.equal(value, false)
  assert.match(warns[0], /unexpected_error/)
})

// ─── 3. jwt: re-resolution on every token use ───────────────────────────────

test('jwt() re-resolves the directory role on every token use', async () => {
  const rec = stubDeps({
    loadMappings: async () => [{ group_key: GROUP_ADMIN, role: 'viewer', display_name: 'Demoted' }],
  })
  // A token minted earlier, carrying admin. No `user` and no `account`: this is
  // an ordinary later request, which is the case that matters.
  const token: any = { provider: 'entra', role: 'admin', id: '42', apps: [...ALL_APPS], siteIds: [], entraClaims: claims() }
  const { value } = await captured<any>(() => jwt({ token }))

  // ⛔ The mapping changed; the session must follow at once, not at the end of
  // the JWT's life. The mappings are re-read — the DIRECTORY is not.
  assert.equal(value.role, 'viewer')
  assert.equal(rec.mappingLoads, 1)
})

test('jwt() clears the role when the re-resolution is refused', async () => {
  stubDeps({ loadMappings: async () => [] })
  const token: any = { provider: 'entra', role: 'super_admin', id: '42', entraClaims: claims() }
  const { value } = await captured<any>(() => jwt({ token }))

  // ⛔ CLEARED, NOT KEPT. This is the layer that catches a mid-session
  // revocation, which signIn() cannot — by then the front door has been passed.
  assert.equal(value.role, null)
})

test('jwt() fails closed to no role when the mapping table cannot be read', async () => {
  stubDeps({
    loadMappings: async () => {
      throw new Error('pool timeout')
    },
  })
  const token: any = { provider: 'entra', role: 'super_admin', id: '42', entraClaims: claims() }
  const { value } = await captured<any>(() => jwt({ token }))

  // ⛔ A database blip must not extend a privilege the directory may already
  // have revoked, and it must not reach the caller as a thrown error either.
  assert.equal(value.role, null)
})

test('tokenRoleFrom reads the outcome, not the truthiness of the role', () => {
  assert.equal(tokenRoleFrom({ outcome: 'mapped', role: 'admin' }), 'admin')
  // ⛔ THE MUTATION THIS CATCHES is `again.role || null`, which happens to
  // behave identically today only because resolveDirectoryRole nulls the role
  // on every refusal. A decision that refuses while still naming a role must
  // yield NO role — the guard reads the verdict, not a truthy field beside it.
  assert.equal(tokenRoleFrom({ outcome: 'no_matching_group', role: 'super_admin' } as any), null)
  assert.equal(tokenRoleFrom({ outcome: 'mappings_unreadable', role: 'admin' } as any), null)
})

test('a local token is not re-resolved against the directory mappings', async () => {
  const rec = stubDeps()
  const token: any = { provider: 'credentials', role: 'admin', id: '3' }
  const { value } = await captured<any>(() => jwt({ token }))
  assert.equal(value.role, 'admin')
  assert.equal(rec.mappingLoads, 0)

  // A token issued BEFORE this feature shipped carries no provider at all, and
  // must stay on the local path rather than being nulled by the directory
  // branch — that would sign out every existing session on deploy.
  const legacy: any = { role: 'super_admin', id: '1' }
  const { value: out } = await captured<any>(() => jwt({ token: legacy }))
  assert.equal(out.role, 'super_admin')
  assert.equal(rec.mappingLoads, 0)
})

test('apps and siteIds survive onto the token and into the session', async () => {
  stubDeps()
  const { value: token } = await captured<any>(() =>
    jwt({
      token: {},
      user: { id: '5', role: 'site_admin', siteIds: [2, 4], apps: ['netvault', 'logvault'] },
      account: { provider: 'credentials' },
    }),
  )
  assert.deepEqual(token.apps, ['netvault', 'logvault'])
  assert.deepEqual(token.siteIds, [2, 4])

  // ⛔ getUserApps() feeds the SSO handoffs to the three satellites, so this is
  // the path a directory account has to share with a local one.
  const s = await session({ session: { user: {} }, token })
  assert.deepEqual(s.user.apps, ['netvault', 'logvault'])
  assert.deepEqual(s.user.siteIds, [2, 4])
  assert.equal(s.user.role, 'site_admin')
})

// ─── 4. the local password path ─────────────────────────────────────────────

test('a directory account typing a password gets the ordinary failure, not an exception', async () => {
  const hash = await bcrypt.hash('right-password', 4)

  // A directory-backed row: password_hash is NULL by design.
  db.setDb(async (text: string) => {
    if (/FROM users WHERE email/.test(text)) {
      return {
        rows: [
          { id: 42, name: 'Some One', email: EMAIL, role: 'admin', auth_provider: 'entra', password_hash: null, mfa_enabled: false },
        ],
      }
    }
    return { rows: [] }
  })
  // ⛔ MEASURED: bcryptjs REJECTS on a null hash with
  // `Illegal arguments: string, object`. Without the canUsePassword guard this
  // line throws and the user meets an opaque error instead of a failed login.
  const directoryAttempt = await authorize({ email: EMAIL, password: 'anything', totp: '' })

  // A local row with the wrong password, for comparison.
  db.setDb(async (text: string) => {
    if (/FROM users WHERE email/.test(text)) {
      return {
        rows: [
          { id: 7, name: 'Local', email: 'local@example.test', role: 'admin', auth_provider: 'local', password_hash: hash, mfa_enabled: false },
        ],
      }
    }
    return { rows: [] }
  })
  const wrongPassword = await authorize({ email: 'local@example.test', password: 'wrong', totp: '' })

  // ⛔ THE SAME GENERIC FAILURE, so the form cannot become an oracle for which
  // addresses are directory-backed — that is a map of the customer's directory
  // handed to an unauthenticated visitor.
  assert.equal(directoryAttempt, null)
  assert.equal(wrongPassword, null)
  assert.deepEqual(directoryAttempt, wrongPassword)
})

test('the hub MFA policy does not apply to a directory account', async () => {
  const hash = await bcrypt.hash('right-password', 4)
  const row = (over: Record<string, unknown>) => ({
    id: 42,
    name: 'Some One',
    email: EMAIL,
    role: 'super_admin',
    password_hash: hash,
    mfa_enabled: false,
    ...over,
  })
  const respond = (user: Record<string, unknown>) => async (text: string) => {
    if (/FROM users WHERE email/.test(text)) return { rows: [user] }
    // The policy names super_admin, and neither account has enrolled.
    if (/mfa_required_roles/.test(text)) return { rows: [{ value: '["super_admin"]' }] }
    if (/install_date/.test(text)) return { rows: [{ value: '2026-01-01' }] }
    if (/user_apps/.test(text)) return { rows: [] }
    return { rows: [] }
  }

  // ⛔ A LOCAL super_admin with no TOTP is refused — the policy must bite.
  db.setDb(respond(row({ auth_provider: 'local' })))
  assert.equal(await authorize({ email: EMAIL, password: 'right-password', totp: '' }), null)

  // ⛔ A DIRECTORY super_admin is NOT, because it has no local TOTP secret and
  // cannot enrol one. Without the exemption, the day somebody adds super_admin
  // to app_settings.mfa_required_roles every directory super_admin stops being
  // able to sign in. Their second factor belongs in Conditional Access.
  db.setDb(respond(row({ auth_provider: 'entra' })))
  const ok: any = await authorize({ email: EMAIL, password: 'right-password', totp: '' })
  assert.ok(ok, 'a directory account must not be held to the local MFA policy')
  assert.equal(ok.role, 'super_admin')
})
