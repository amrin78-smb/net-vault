import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

// ── This is an INTEGRATION test and it SKIPS rather than passing ────────────
//
// ⛔ A SKIP, NEVER A SILENT PASS. The paths below cannot be reached without a
// real PostgreSQL: the ON CONFLICT race, the conditional UPDATE guard, and the
// case-folded email lookup are all properties of the SQL, not of the
// TypeScript. A fake pool would assert that the strings we wrote are the
// strings we wrote.
//
// So when no database is reachable every test here reports "could not measure
// here" with the reason, which is visible in the output — where a green tick
// over an unrun check is the guard-that-cannot-fire pattern this suite names
// most often.
//
// It provisions its OWN scratch database from schema.sql and drops it again.
// It never touches a configured DATABASE_URL: if one is already set, this file
// refuses to run at all rather than risk writing users into a real database.

const DB = 'nv_dirstore_test'
const REPO = path.resolve(import.meta.dirname, '..')

let skipReason: string | null = null
let store: typeof import('../lib/directoryStore.ts') | null = null

function psql(args: string[], db?: string): string {
  return execFileSync('psql', db ? ['-d', db, ...args] : args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  })
}

before(async () => {
  // ⛔ Refuse outright rather than scribbling in someone's real database.
  if (process.env.DATABASE_URL) {
    skipReason =
      'DATABASE_URL is already set; refusing to run against a configured database. ' +
      'Unset it to run this integration test against a scratch database.'
    return
  }
  try {
    psql(['-At', '-c', 'SELECT 1'], 'postgres')
  } catch (err: any) {
    skipReason = `could not measure here: no local PostgreSQL (${String(err.message).split('\n')[0]})`
    return
  }
  try {
    try {
      execFileSync('dropdb', ['--if-exists', DB], { stdio: 'ignore' })
    } catch {
      /* nothing to drop */
    }
    execFileSync('createdb', [DB], { stdio: 'ignore' })
    // ON_ERROR_STOP is deliberately OFF: schema.sql ends with grant blocks that
    // need the `netvault` role, which a scratch database has no permission to
    // create. Everything this test touches is created long before that point,
    // and the assertions below prove the objects exist rather than trusting the
    // exit code.
    psql(['-q', '-f', path.join(REPO, 'schema.sql')], DB)
    const cols = psql(
      [
        '-At',
        '-c',
        "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name IN ('auth_provider','entra_oid')",
      ],
      DB,
    ).trim()
    if (cols !== '2') {
      skipReason = `schema.sql did not create the directory columns (found ${cols} of 2)`
      return
    }
    // ⛔ The unix socket explicitly, not `postgresql:///db`. `pg` reads an empty
    // host as localhost over TCP, where this box demands SCRAM and the test has
    // no password; `psql` defaults to the socket with peer auth, which is why
    // the setup above works while the pool would not. Pointing `pg` at the same
    // socket makes the two agree.
    // ⛔ The EMPTY-AUTHORITY form `postgresql:///<db>?host=<socket>`. Written as
    // `postgresql://<db>?host=…` the part after `//` is the authority, so the
    // database name is read as the HOST and the dbname falls back to the OS
    // user — which fails with `database "<user>" does not exist`, an error that
    // looks nothing like a URL mistake.
    const sock = process.env.PGHOST || '/var/run/postgresql'
    process.env.DATABASE_URL = `postgresql:///${DB}?host=${encodeURIComponent(sock)}`
    process.env.SSL_DISABLED = 'true'
    store = await import('../lib/directoryStore.ts')
  } catch (err: any) {
    skipReason = `could not measure here: scratch database setup failed (${String(err.message).split('\n')[0]})`
  }
})

after(() => {
  if (!store) return
  try {
    // The pool holds the connection open; close it so dropdb can succeed.
    void import('../lib/db.ts').then((m) => m.default.end())
  } catch {
    /* best effort */
  }
})

function need(t: { skip: (reason?: string) => void }): boolean {
  if (skipReason || !store) {
    t.skip(skipReason || 'store did not load')
    return false
  }
  return true
}

const OID_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const OID_B = 'bbbbbbbb-1111-2222-3333-444444444444'

test('createDirectoryUser provisions with a NULL password_hash', async (t) => {
  if (!need(t)) return
  const row = await store!.createDirectoryUser({
    email: 'dir.one@example.com',
    name: 'Dir One',
    role: 'admin',
    entra_oid: OID_A,
  })
  assert.equal(row.auth_provider, 'entra')
  assert.equal(row.entra_oid, OID_A)
  assert.equal(row.role, 'admin')
  // ⛔ No invented credential: a password nobody holds and nobody can rotate.
  assert.equal(row.password_hash, null)
})

test('a repeated create is idempotent, not a UNIQUE violation', async (t) => {
  if (!need(t)) return
  // The two-tabs race: both requests see no row and both insert.
  const first = await store!.findUserByEntraOid(OID_A)
  const again = await store!.createDirectoryUser({
    email: 'dir.one@example.com',
    name: 'Dir One',
    role: 'admin',
    entra_oid: OID_A,
  })
  assert.equal(again.id, first!.id, 'the same account must come back, not a duplicate')
})

test('concurrent first sign-ins produce ONE account', async (t) => {
  if (!need(t)) return
  const mk = () =>
    store!.createDirectoryUser({
      email: 'racer@example.com',
      name: 'Racer',
      role: 'viewer',
      entra_oid: OID_B,
    })
  const rows = await Promise.all([mk(), mk(), mk()])
  const ids = new Set(rows.map((r) => r.id))
  assert.equal(ids.size, 1, 'all three must resolve to one account')
})

test('findUserByEmail is case-insensitive', async (t) => {
  if (!need(t)) return
  // A directory can hand back a UPN in any case; a case-sensitive lookup would
  // miss the collision and hit the UNIQUE constraint on INSERT instead.
  const hit = await store!.findUserByEmail('DIR.ONE@EXAMPLE.COM')
  assert.ok(hit, 'an upper-cased address must find the row')
  assert.equal(hit!.entra_oid, OID_A)
})

test('loadDirectoryMappings returns [] only when the table really is empty', async (t) => {
  if (!need(t)) return
  assert.deepEqual(await store!.loadDirectoryMappings(), [])
  psql(
    [
      '-q',
      '-c',
      "INSERT INTO directory_role_mappings (group_key, display_name, role) VALUES ('cccccccc-1111-2222-3333-444444444444','Admins','admin')",
    ],
    DB,
  )
  const rows = await store!.loadDirectoryMappings()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'admin')
  assert.equal(rows[0].display_name, 'Admins')
})

test('loadDirectoryMappings THROWS on a database fault — never returns []', async (t) => {
  if (!need(t)) return
  // ⛔ The property the whole module rests on. `[]` is the instruction "refuse
  // every directory sign-in"; a connection fault must not be able to say that.
  // Simulated by renaming the table, the closest thing to a schema or permission
  // fault we can produce in-process.
  //
  // ⛔ A CONTROL CALL FIRST, AND A REGEX THAT NAMES THE RELATION. This test
  // FALSE-PASSED while the whole database was unreachable: it asserted only
  // `rejects(..., /does not exist/)`, and `database "amrin" does not exist`
  // matches that perfectly. So it was reporting the guard as working on a run
  // where nothing worked at all — a rejection is only evidence of THIS guard if
  // the same call succeeds moments earlier.
  const control = await store!.loadDirectoryMappings()
  assert.ok(Array.isArray(control), 'precondition: the query must work before we break it')

  psql(['-q', '-c', 'ALTER TABLE directory_role_mappings RENAME TO drm_hidden'], DB)
  try {
    await assert.rejects(
      () => store!.loadDirectoryMappings(),
      (err: any) =>
        err?.code === '42P01' && /directory_role_mappings/.test(String(err.message)),
      'must reject with undefined_table naming the relation, not any error at all',
    )
  } finally {
    psql(['-q', '-c', 'ALTER TABLE drm_hidden RENAME TO directory_role_mappings'], DB)
  }
  // And it works again afterwards, so a later test cannot inherit a broken DB.
  assert.ok(Array.isArray(await store!.loadDirectoryMappings()))
})

test('refreshDirectoryUserRole updates a directory account', async (t) => {
  if (!need(t)) return
  const changed = await store!.refreshDirectoryUserRole(
    (await store!.findUserByEntraOid(OID_A))!.id,
    'viewer',
  )
  assert.equal(changed, 1)
  assert.equal((await store!.findUserByEntraOid(OID_A))!.role, 'viewer')
})

test('an unchanged role is a no-op, reported as zero rows', async (t) => {
  if (!need(t)) return
  const id = (await store!.findUserByEntraOid(OID_A))!.id
  assert.equal(await store!.refreshDirectoryUserRole(id, 'viewer'), 0)
})

test('refreshDirectoryUserRole CANNOT touch a local account', async (t) => {
  if (!need(t)) return
  // ⛔ The `AND auth_provider = 'entra'` guard, enforced in SQL rather than
  // trusted to the caller: a bug upstream that matched a local row must not be
  // able to rewrite a local administrator's role from a directory group.
  psql(
    [
      '-q',
      '-c',
      "INSERT INTO users (name,email,password_hash,role) VALUES ('Local Admin','local.admin@example.com','$2a$hash','super_admin')",
    ],
    DB,
  )
  const local = await store!.findUserByEmail('local.admin@example.com')
  const changed = await store!.refreshDirectoryUserRole(local!.id, 'viewer')
  assert.equal(changed, 0, 'no row may be updated')
  assert.equal(
    (await store!.findUserByEmail('local.admin@example.com'))!.role,
    'super_admin',
    'the local super_admin must keep its role',
  )
})

test('loadDirectoryContext always runs BOTH lookups, so the ambiguous case is visible', async (t) => {
  if (!need(t)) return
  // A row linked to this oid, while a DIFFERENT row holds the same email —
  // what happens when a UPN is changed in the directory to an address another
  // account already has. Skipping the email lookup after an oid hit would
  // resolve this as an ordinary match and collide on the next write.
  const ctx = await store!.loadDirectoryContext(OID_A, 'local.admin@example.com')
  assert.ok(ctx.byOid, 'the oid row must be found')
  assert.ok(ctx.byEmail, 'the email row must be found too')
  assert.notEqual(ctx.byOid!.id, ctx.byEmail!.id, 'they are different rows — the ambiguous case')
})
