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

// ── Mapping administration (Settings → Single sign-on) ──────────────────────
//
// ⛔ THESE MUST RUN AGAINST A REAL DATABASE AND THEY ARE THE REASON THIS FILE IS
// AN INTEGRATION TEST. Every property below is a property of the SQL:
//
//   * `ON CONFLICT (provider, lower(group_key))` must match
//     `uq_directory_mapping` EXACTLY. Name the bare columns instead and
//     PostgreSQL raises 42P10 — but only when a duplicate is actually attempted,
//     so every test that inserts distinct rows still passes. That precise
//     mistake shipped once on this feature (createDirectoryUser) and a real
//     database is what caught it.
//   * the index is on `lower(group_key)`, so a GUID pasted in a different case
//     is the SAME mapping. Nothing in the TypeScript lower-cases anything.
//   * `directory_role_mappings_role_check` must really reject site_admin. The
//     API validates the role before inserting, and the comment there calls the
//     constraint a second line of defence — an untested second line of defence
//     is a comment, not a defence.

const GROUP_A = 'cccccccc-1111-2222-3333-555555555555'
const GROUP_B = 'dddddddd-1111-2222-3333-555555555555'

async function clearMappings() {
  const db = await import('../lib/db.ts')
  await db.query('DELETE FROM directory_role_mappings')
}

test('createDirectoryMapping inserts a row the panel can render and delete', async (t) => {
  if (!need(t)) return
  await clearMappings()
  const row = await store!.createDirectoryMapping({
    groupKey: GROUP_A,
    displayName: 'Firewall Admins',
    role: 'admin',
  })
  assert.ok(row, 'expected the new row back')
  assert.equal(row!.group_key, GROUP_A)
  assert.equal(row!.display_name, 'Firewall Admins')
  assert.equal(row!.role, 'admin')
  assert.equal(row!.provider, 'entra')
  assert.equal(typeof row!.id, 'number')
  assert.ok(row!.id > 0, 'the id is what DELETE addresses; 0 or NaN is unusable')
})

test('a second mapping for the same group returns null and does NOT throw 42P10', async (t) => {
  if (!need(t)) return
  await clearMappings()
  await store!.createDirectoryMapping({ groupKey: GROUP_A, role: 'admin' })

  // ⛔ The assertion is on the RETURN VALUE, not on "it did not throw". A throw
  // here is the 42P10 mismatch between the ON CONFLICT target and
  // uq_directory_mapping; `null` is the duplicate the API turns into a 409.
  let threw: unknown = null
  let second: unknown = undefined
  try {
    second = await store!.createDirectoryMapping({ groupKey: GROUP_A, role: 'viewer' })
  } catch (err) {
    threw = err
  }
  assert.equal(
    threw,
    null,
    `ON CONFLICT did not match the unique index: ${(threw as any)?.code || ''} ${(threw as any)?.message || ''}`,
  )
  assert.equal(second, null, 'a duplicate must come back as null, not as a row')

  // And the first row is untouched — a DO NOTHING that silently became an
  // UPDATE would change the role out from under the administrator.
  const rows = await store!.listDirectoryMappings()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'admin', 'the existing mapping must not be overwritten')
})

test('the same GUID in a different case is the same mapping (index is on lower(group_key))', async (t) => {
  if (!need(t)) return
  await clearMappings()
  await store!.createDirectoryMapping({ groupKey: GROUP_A.toUpperCase(), role: 'admin' })
  const again = await store!.createDirectoryMapping({ groupKey: GROUP_A.toLowerCase(), role: 'viewer' })
  assert.equal(again, null, 'case must not create a second mapping for one group')
  const rows = await store!.listDirectoryMappings()
  assert.equal(rows.length, 1, `expected 1 mapping, found ${rows.length}`)
})

test('listDirectoryMappings returns newest first', async (t) => {
  if (!need(t)) return
  await clearMappings()
  await store!.createDirectoryMapping({ groupKey: GROUP_A, role: 'viewer' })
  await store!.createDirectoryMapping({ groupKey: GROUP_B, role: 'admin' })
  const rows = await store!.listDirectoryMappings()
  assert.equal(rows.length, 2)
  // created_at can tie at this speed, which is exactly why the ORDER BY carries
  // `id DESC` as well — without it the order is arbitrary and this assertion
  // would fail intermittently rather than never.
  assert.equal(rows[0].group_key, GROUP_B, 'the most recently added mapping must come first')
})

test('deleteDirectoryMapping returns the removed row, then null', async (t) => {
  if (!need(t)) return
  await clearMappings()
  const made = await store!.createDirectoryMapping({
    groupKey: GROUP_A,
    displayName: 'Firewall Admins',
    role: 'super_admin',
  })

  // RETURNING is what the audit trail is written from: after the DELETE there is
  // nowhere left to read the group key and role out of.
  const removed = await store!.deleteDirectoryMapping(made!.id)
  assert.ok(removed, 'expected the removed row back for the audit entry')
  assert.equal(removed!.group_key, GROUP_A)
  assert.equal(removed!.role, 'super_admin')

  const again = await store!.deleteDirectoryMapping(made!.id)
  assert.equal(again, null, 'deleting a row that is gone must be null, not a throw')
  assert.equal((await store!.listDirectoryMappings()).length, 0)
})

test('deleteDirectoryMapping will not delete another provider’s row', async (t) => {
  if (!need(t)) return
  await clearMappings()
  const made = await store!.createDirectoryMapping({ groupKey: GROUP_A, role: 'admin' })
  const wrong = await store!.deleteDirectoryMapping(made!.id, 'some-other-provider')
  assert.equal(wrong, null, 'the provider is part of the identity of a mapping')
  assert.equal((await store!.listDirectoryMappings()).length, 1, 'the row must still be there')
})

test('the role CHECK constraint really rejects site_admin', async (t) => {
  if (!need(t)) return
  await clearMappings()

  // Bypasses the API's own validation on purpose: the point is whether the
  // DATABASE refuses, independently of the route.
  let err: any = null
  try {
    await store!.createDirectoryMapping({
      groupKey: GROUP_B,
      role: 'site_admin' as any,
    })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'the database accepted site_admin — the CHECK constraint is missing')
  // ⛔ ASSERT THE CODE AND THE CONSTRAINT NAME, NOT A MESSAGE SUBSTRING. A match
  // on /violates check constraint/ alone would also be satisfied by a DIFFERENT
  // constraint failing for a different reason, which is how a test passes while
  // proving nothing.
  assert.equal(err.code, '23514', `expected check_violation 23514, got ${err.code}`)
  assert.equal(
    err.constraint,
    'directory_role_mappings_role_check',
    `a different constraint rejected this row: ${err.constraint}`,
  )
  assert.equal((await store!.listDirectoryMappings()).length, 0, 'nothing may have been inserted')
})

// ── Refused sign-ins: the cap, which is a property of the SQL ───────────────
//
// ⛔ THE CAP IS THE WHOLE REASON THIS IS AN INTEGRATION TEST. This is the one
// table in the schema whose row count is driven by a FAILURE LOOP: a
// misconfigured directory refuses every attempt and the person retries. Nothing
// in a customer install runs a cleanup job, so the trim has to happen in the
// writer, and whether it does is a fact about the DELETE's OFFSET arithmetic —
// off by one and the table either grows forever or deletes the row just written.

let refusals: typeof import('../lib/directoryRefusals.ts') | null = null

test('recordDirectoryRefusal caps the table at DIRECTORY_REFUSAL_KEEP', async (t) => {
  if (!need(t)) return
  refusals = refusals || (await import('../lib/directoryRefusals.ts'))
  const db = await import('../lib/db.ts')
  await db.query('DELETE FROM directory_signin_refusals')

  const KEEP = refusals.DIRECTORY_REFUSAL_KEEP
  // Comfortably past the cap, so an off-by-one cannot hide.
  for (let i = 0; i < KEEP + 12; i++) {
    await refusals.recordDirectoryRefusal({
      email: `person${i}@example.invalid`,
      entraOid: `oid-${i}`,
      cause: 'no_matching_group: test',
      groupKeys: [`group-${i}`],
    })
  }

  const count = Number(
    (await db.query('SELECT count(*)::int AS n FROM directory_signin_refusals')).rows[0].n,
  )
  assert.equal(count, KEEP, `expected the table capped at ${KEEP}, found ${count}`)

  // ⛔ AND IT MUST KEEP THE NEWEST, NOT THE OLDEST. A trim that deleted from the
  // wrong end would also produce exactly KEEP rows and pass a count assertion.
  const rows = await refusals.listDirectoryRefusals()
  assert.equal(rows.length, KEEP)
  assert.equal(rows[0].email, `person${KEEP + 11}@example.invalid`, 'newest must be first')
  assert.equal(rows[rows.length - 1].email, `person${12}@example.invalid`, 'the oldest kept row is wrong')
})

test('a refusal round-trips its group ids, and null stays null', async (t) => {
  if (!need(t)) return
  refusals = refusals || (await import('../lib/directoryRefusals.ts'))
  const db = await import('../lib/db.ts')
  await db.query('DELETE FROM directory_signin_refusals')

  await refusals.recordDirectoryRefusal({
    email: 'someone@example.invalid',
    entraOid: 'oid-1',
    cause: 'no_matching_group: none of 2 groups is mapped',
    groupKeys: ['aaaa-1111', 'bbbb-2222'],
  })
  // The overage case: Microsoft sent no usable list, so there is nothing to
  // record. `null` must NOT come back as an empty array that reads as "this
  // person is in no groups".
  await refusals.recordDirectoryRefusal({
    email: 'overage@example.invalid',
    cause: 'groups_overage: too many groups',
    groupKeys: null,
  })

  const rows = await refusals.listDirectoryRefusals()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].email, 'overage@example.invalid')
  assert.equal(rows[0].group_keys, null, 'an overage must not be recorded as "no groups"')
  assert.equal(rows[0].entra_oid, null, 'an absent oid is null, not an empty string')
  assert.deepEqual(rows[1].group_keys, ['aaaa-1111', 'bbbb-2222'])
})

test('recordDirectoryRefusal NEVER throws — it runs inside the refusal path', async (t) => {
  if (!need(t)) return
  refusals = refusals || (await import('../lib/directoryRefusals.ts'))
  // ⛔ A THROW HERE BECOMES /api/auth/error?error=<message>, i.e. the exception
  // text published on an unauthenticated page — the one place the cause must
  // never appear. A deliberately impossible insert proves the catch is real
  // rather than merely written.
  const bad = 'x'.repeat(100)
  await assert.doesNotReject(async () => {
    await refusals!.recordDirectoryRefusal({
      // `cause` is NOT NULL in the schema; passing null makes the INSERT fail.
      cause: null as unknown as string,
      email: bad,
    })
  })
})
