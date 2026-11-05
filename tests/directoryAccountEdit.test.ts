import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DIRECTORY_EDIT_OUTCOME,
  decideDirectoryAccountEdit,
  type DirectoryEditOutcome,
} from '../lib/localAccountPolicy.ts'

const dirRow = { email: 'dir@example.com', role: 'admin', auth_provider: 'entra' }
const localRow = { email: 'local@example.com', role: 'admin', auth_provider: 'local' }

// ── the hole this exists to close ───────────────────────────────────────────

test('a password on a DIRECTORY account is refused', () => {
  // Without this the UPDATE writes password_hash onto an entra row, and
  // canUsePassword() then returns true — a local credential path for an
  // identity whose credentials belong to the directory.
  const d = decideDirectoryAccountEdit(dirRow, { password: 'hunter2' })
  assert.equal(d.outcome, DIRECTORY_EDIT_OUTCOME.PASSWORD_FORBIDDEN)
  assert.equal(d.allowed, false)
  assert.equal(d.status, 409)
  assert.equal(d.field, 'password')
})

test('a password on a LOCAL account is untouched', () => {
  assert.equal(decideDirectoryAccountEdit(localRow, { password: 'hunter2' }).allowed, true)
})

test('an EMPTY password is not a change — the form posts the field on every save', () => {
  for (const password of ['', undefined, null]) {
    assert.equal(decideDirectoryAccountEdit(dirRow, { password }).allowed, true, String(password))
  }
})

test('the password is refused BEFORE the role and email, being the most dangerous', () => {
  const d = decideDirectoryAccountEdit(dirRow, {
    password: 'hunter2',
    role: 'super_admin',
    email: 'other@example.com',
  })
  assert.equal(d.field, 'password', 'the sentence the administrator reads must name the worst one')
})

// ── role: silently overwritten, so refused ─────────────────────────────────

test('CHANGING the role of a directory account is refused', () => {
  const d = decideDirectoryAccountEdit(dirRow, { role: 'super_admin' })
  assert.equal(d.outcome, DIRECTORY_EDIT_OUTCOME.ROLE_FORBIDDEN)
  assert.equal(d.field, 'role')
  assert.match(d.reason, /group/i, 'must say where the role really comes from')
  assert.match(d.reason, /overwritten/i, 'must say what would happen otherwise')
})

test('RESUBMITTING the same role is NOT a change', () => {
  // ⛔ The form posts every field on every save. Refusing a request that merely
  // CONTAINS `role` would make a directory account's name and app access
  // unsavable — the blanket refusal this guard exists to avoid.
  assert.equal(decideDirectoryAccountEdit(dirRow, { role: 'admin' }).allowed, true)
})

// ── email: divergence or lockout, so refused ───────────────────────────────

test('CHANGING the email of a directory account is refused', () => {
  const d = decideDirectoryAccountEdit(dirRow, { email: 'new@example.com' })
  assert.equal(d.outcome, DIRECTORY_EDIT_OUTCOME.EMAIL_FORBIDDEN)
  assert.equal(d.field, 'email')
  assert.match(d.reason, /lock this person out|another account/i)
})

test('RESUBMITTING the same email is NOT a change, in any case or spacing', () => {
  for (const email of ['dir@example.com', 'DIR@EXAMPLE.COM', '  dir@example.com  ']) {
    assert.equal(decideDirectoryAccountEdit(dirRow, { email }).allowed, true, email)
  }
})

// ── what must still get through ────────────────────────────────────────────

test('name, sites and app access are NOT refused — a blanket refusal is a regression', () => {
  // user_apps and user_sites are hub-owned data the directory cannot supply,
  // and this route is the only way to set them.
  const d = decideDirectoryAccountEdit(dirRow, {
    email: 'dir@example.com',
    role: 'admin',
  } as any)
  assert.equal(d.allowed, true)
  assert.equal(d.status, 200)
  assert.equal(d.field, null)
})

test('a local account is never restricted', () => {
  const d = decideDirectoryAccountEdit(localRow, {
    email: 'moved@example.com',
    role: 'super_admin',
    password: 'x',
  })
  assert.equal(d.allowed, true)
})

// ── provenance and absent rows ─────────────────────────────────────────────

test('an UNRECOGNISED provider gets the stricter treatment, not the looser one', () => {
  const d = decideDirectoryAccountEdit({ ...dirRow, auth_provider: 'saml' }, { password: 'x' })
  assert.equal(d.allowed, false)
})

test('a missing auth_provider is local', () => {
  assert.equal(decideDirectoryAccountEdit({ email: 'a@example.com', role: 'admin' }, { password: 'x' }).allowed, true)
})

test('an absent target refuses nothing — the route owns its own 404', () => {
  assert.equal(decideDirectoryAccountEdit(null, { password: 'x' }).allowed, true)
  assert.equal(decideDirectoryAccountEdit(undefined, { password: 'x' }).allowed, true)
})

// ── hygiene ────────────────────────────────────────────────────────────────

test('allowed is never set independently of the outcome', () => {
  const cases = [
    decideDirectoryAccountEdit(dirRow, { password: 'x' }),
    decideDirectoryAccountEdit(dirRow, { role: 'viewer' }),
    decideDirectoryAccountEdit(dirRow, { email: 'z@example.com' }),
    decideDirectoryAccountEdit(dirRow, {}),
    decideDirectoryAccountEdit(localRow, { password: 'x' }),
  ]
  for (const d of cases) {
    assert.equal(d.allowed, d.outcome === DIRECTORY_EDIT_OUTCOME.OK, d.outcome)
    assert.equal(d.status, d.allowed ? 200 : 409, d.outcome)
    assert.equal(d.field === null, d.allowed, d.outcome)
    assert.equal(d.reason === '', d.allowed, d.outcome)
  }
})

test('every DIRECTORY_EDIT_OUTCOME is reachable', () => {
  const seen = new Set<DirectoryEditOutcome>()
  seen.add(decideDirectoryAccountEdit(dirRow, {}).outcome)
  seen.add(decideDirectoryAccountEdit(dirRow, { password: 'x' }).outcome)
  seen.add(decideDirectoryAccountEdit(dirRow, { role: 'viewer' }).outcome)
  seen.add(decideDirectoryAccountEdit(dirRow, { email: 'z@example.com' }).outcome)
  for (const o of Object.values(DIRECTORY_EDIT_OUTCOME)) {
    assert.ok(seen.has(o), `DIRECTORY_EDIT_OUTCOME.${o} is unreachable — a guard that cannot fire`)
  }
})

test('no refusal tells anyone to link accounts', () => {
  for (const d of [
    decideDirectoryAccountEdit(dirRow, { password: 'x' }),
    decideDirectoryAccountEdit(dirRow, { role: 'viewer' }),
    decideDirectoryAccountEdit(dirRow, { email: 'z@example.com' }),
  ]) {
    assert.ok(!/\blink\b/i.test(d.reason), `${d.outcome} suggested linking, which does not exist`)
  }
})
