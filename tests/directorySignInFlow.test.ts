import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { resolveDirectoryRole, isDirectoryRolePermitted } from '../lib/directoryRoles.ts'
import { decideDirectoryUser, isDirectoryPermitted } from '../lib/directoryUser.ts'

// ── END-TO-END, AND IT EXISTS TO PROVE THE DESIGN'S CENTRAL CLAIM ───────────
//
// The whole reason this feature provisions a shadow `users` row — rather than
// letting a directory account sign in with no local row, as SecVault does — is
// that all three satellites resolve identity by querying the HUB'S `users`
// table, each with its own SQL:
//
//   logvault/frontend/src/auth.ts   SELECT id, name, email, role
//                                     FROM users WHERE id = $1
//   ddivault  (via the hub's /api/auth/sso-verify)
//                                   SELECT id, email, role
//                                     FROM users WHERE email = $1
//   spanvault/frontend/src/lib/auth.ts
//                                   SELECT id, name, email, role FROM users
//                                    WHERE ($1 <> '' AND LOWER(email)=LOWER($1))
//                                       OR ($2 <> '' AND id::text = $2) LIMIT 1
//
// ⛔ THOSE THREE QUERIES ARE COPIED VERBATIM BELOW AND RUN AGAINST THE REAL
// PROVISIONED ROW. Until now that claim rested on reading the three files and
// reasoning about them. Reasoning is what produced the 42P10 bug: the ON
// CONFLICT predicate looked right in review and failed on the first sign-in.
// ⛔ If a satellite ever changes its query, update the copy here in the SAME
// change — a stale copy here would prove the old query still works while the
// live one no longer does, which is worse than having no test.
//
// SKIPS (never silently passes) when no local PostgreSQL is reachable.

const DB = 'nv_signin_flow_test'
const REPO = path.resolve(import.meta.dirname, '..')
const OID = 'f0f0f0f0-1111-2222-3333-444444444444'
const GROUP = 'c0ffee00-1111-2222-3333-444444444444'

let skipReason: string | null = null
let store: typeof import('../lib/directoryStore.ts') | null = null
let db: typeof import('../lib/db.ts') | null = null

function psql(args: string[], database = DB): string {
  return execFileSync('psql', ['-d', database, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  })
}

before(async () => {
  if (process.env.DATABASE_URL) {
    skipReason = 'DATABASE_URL is already set; refusing to run against a configured database.'
    return
  }
  try {
    psql(['-At', '-c', 'SELECT 1'], 'postgres')
    try { execFileSync('dropdb', ['--if-exists', DB], { stdio: 'ignore' }) } catch { /* none */ }
    execFileSync('createdb', [DB], { stdio: 'ignore' })
    psql(['-q', '-f', path.join(REPO, 'schema.sql')])
    const sock = process.env.PGHOST || '/var/run/postgresql'
    process.env.DATABASE_URL = `postgresql:///${DB}?host=${encodeURIComponent(sock)}`
    process.env.SSL_DISABLED = 'true'
    store = await import('../lib/directoryStore.ts')
    db = await import('../lib/db.ts')
    psql([
      '-q', '-c',
      `INSERT INTO directory_role_mappings (group_key, display_name, role)
       VALUES ('${GROUP}', 'Suite Admins', 'admin')`,
    ])
  } catch (err: any) {
    skipReason = `could not measure here: ${String(err.message).split('\n')[0]}`
  }
})

function need(t: { skip: (reason?: string) => void }): boolean {
  if (skipReason || !store || !db) {
    t.skip(skipReason || 'modules did not load')
    return false
  }
  return true
}

/** The full admission path the signIn callback walks. */
async function admit(claims: any) {
  const mappings = await store!.loadDirectoryMappings()
  const roleDecision = resolveDirectoryRole(claims, mappings)
  if (!isDirectoryRolePermitted(roleDecision)) return { ok: false as const, why: roleDecision.outcome }

  const rows = await store!.loadDirectoryContext(claims.oid, claims.email)
  const decision = decideDirectoryUser(claims, roleDecision.role, rows)
  if (!isDirectoryPermitted(decision)) return { ok: false as const, why: decision.outcome }

  if (decision.create) {
    const row = await store!.createDirectoryUser(decision.create)
    return { ok: true as const, id: row.id, role: row.role }
  }
  await store!.refreshDirectoryUserRole(decision.match!.id, decision.match!.role)
  return { ok: true as const, id: decision.match!.id, role: decision.match!.role }
}

test('a first directory sign-in provisions, and a second one reuses the row', async (t) => {
  if (!need(t)) return
  const claims = { oid: OID, email: 'alice@example.com', name: 'Alice', groups: [GROUP] }

  const first = await admit(claims)
  assert.equal(first.ok, true)
  assert.equal(first.ok && first.role, 'admin')

  const second = await admit(claims)
  assert.equal(second.ok, true)
  assert.equal(second.ok && second.id, first.ok && first.id, 'the SAME row, not a second account')

  const count = psql(['-At', '-c', `SELECT count(*) FROM users WHERE entra_oid = '${OID}'`]).trim()
  assert.equal(count, '1')
})

test('ALL THREE SATELLITES resolve the provisioned row with their OWN query', async (t) => {
  if (!need(t)) return
  const row = await store!.findUserByEntraOid(OID)
  assert.ok(row, 'precondition: the row exists')
  const id = row!.id

  // logvault/frontend/src/auth.ts — by id
  const lv = await db!.query('SELECT id, name, email, role FROM users WHERE id = $1', [id])
  assert.equal(lv.rows.length, 1, 'LogVault would have failed to create a session')
  assert.equal(lv.rows[0].role, 'admin')
  assert.ok(lv.rows[0].name, 'LogVault reads name; it must not be empty')

  // ddivault, via the hub's /api/auth/sso-verify — by email
  const ddi = await db!.query('SELECT id, email, role FROM users WHERE email = $1', [
    'alice@example.com',
  ])
  assert.equal(ddi.rows.length, 1, 'sso-verify would have answered 404 User not found')
  assert.equal(ddi.rows[0].role, 'admin')

  // spanvault/frontend/src/lib/auth.ts — email OR id, case-insensitive
  const sv = await db!.query(
    `SELECT id, name, email, role FROM users
      WHERE ($1 <> '' AND LOWER(email) = LOWER($1))
         OR ($2 <> '' AND id::text = $2)
      LIMIT 1`,
    ['ALICE@EXAMPLE.COM', String(id)],
  )
  assert.equal(sv.rows.length, 1)
  // ⛔ THE POINT OF THE WHOLE SHADOW ROW. Without one, SpanVault does not fail —
  // it falls through to `payload.role || 'viewer'`, so a directory admin becomes
  // a SpanVault VIEWER and nothing reports it.
  assert.equal(sv.rows[0].role, 'admin', 'SpanVault would have silently downgraded this account')
})

test('a role change in the directory takes effect on the next sign-in', async (t) => {
  if (!need(t)) return
  psql(['-q', '-c', `UPDATE directory_role_mappings SET role='viewer' WHERE group_key='${GROUP}'`])
  const again = await admit({ oid: OID, email: 'alice@example.com', name: 'Alice', groups: [GROUP] })
  assert.equal(again.ok && again.role, 'viewer')
  assert.equal((await store!.findUserByEntraOid(OID))!.role, 'viewer', 'the row must be refreshed')
  psql(['-q', '-c', `UPDATE directory_role_mappings SET role='admin' WHERE group_key='${GROUP}'`])
})

test('a LOCAL account holding the address blocks the directory sign-in', async (t) => {
  if (!need(t)) return
  psql([
    '-q', '-c',
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Bob Local', 'bob@example.com', '$2a$hash', 'super_admin')`,
  ])
  const r = await admit({
    oid: 'bbbb0000-1111-2222-3333-444444444444',
    email: 'bob@example.com',
    name: 'Bob',
    groups: [GROUP],
  })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.why, 'email_collision')
  // ⛔ And the local super_admin is untouched — the refusal must not have
  // written anything at all.
  const bob = psql(['-At', '-c', "SELECT role, auth_provider FROM users WHERE email='bob@example.com'"]).trim()
  assert.equal(bob, 'super_admin|local')
})

test('an unmapped group is refused and provisions nothing', async (t) => {
  if (!need(t)) return
  const before = psql(['-At', '-c', 'SELECT count(*) FROM users']).trim()
  const r = await admit({
    oid: 'dddd0000-1111-2222-3333-444444444444',
    email: 'carol@example.com',
    name: 'Carol',
    groups: ['99999999-9999-9999-9999-999999999999'],
  })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.why, 'no_matching_group')
  assert.equal(psql(['-At', '-c', 'SELECT count(*) FROM users']).trim(), before, 'no row may appear')
})

test('a group-claim overage is refused and provisions nothing', async (t) => {
  if (!need(t)) return
  const before = psql(['-At', '-c', 'SELECT count(*) FROM users']).trim()
  const r = await admit({
    oid: 'eeee0000-1111-2222-3333-444444444444',
    email: 'dave@example.com',
    name: 'Dave',
    _claim_names: { groups: 'src1' },
  })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.why, 'groups_overage')
  assert.equal(psql(['-At', '-c', 'SELECT count(*) FROM users']).trim(), before)
})
