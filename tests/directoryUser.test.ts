import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OUTCOME,
  ASSIGNABLE_ROLES,
  DIRECTORY_PROVISIONABLE_ROLES,
  decideDirectoryUser,
  isDirectoryPermitted,
  isRole,
  canUsePassword,
  isDirectoryAccount,
  mfaPolicyApplies,
  type Outcome,
} from '../lib/directoryUser.ts'

const OID = '00000000-1111-2222-3333-444444444444'
const OTHER_OID = '99999999-8888-7777-6666-555555555555'
const CLAIMS = { oid: OID, email: 'someone@example.com', name: 'Some One' }

const localRow = (over: Partial<{ id: number; email: string; role: string; auth_provider: string }> = {}) => ({
  id: 7,
  email: 'someone@example.com',
  role: 'admin',
  auth_provider: 'local',
  ...over,
})
const entraRow = (over: Partial<{ id: number; email: string; role: string; auth_provider: string }> = {}) =>
  localRow({ auth_provider: 'entra', ...over })

// ── provisioning ────────────────────────────────────────────────────────────

test('an unknown directory identity is provisioned', () => {
  const d = decideDirectoryUser(CLAIMS, 'admin', {})
  assert.equal(d.outcome, OUTCOME.CREATE)
  assert.equal(isDirectoryPermitted(d), true)
  assert.deepEqual(d.create, {
    email: 'someone@example.com',
    name: 'Some One',
    role: 'admin',
    entra_oid: OID,
  })
})

test('a missing display name degrades to the email local part rather than refusing', () => {
  const d = decideDirectoryUser({ oid: OID, email: 'someone@example.com' }, 'viewer', {})
  assert.equal(d.outcome, OUTCOME.CREATE)
  assert.equal(d.create?.name, 'someone')
})

test('an existing oid match signs in and refreshes the role', () => {
  const d = decideDirectoryUser(CLAIMS, 'viewer', { byOid: entraRow({ role: 'admin' }) })
  assert.equal(d.outcome, OUTCOME.MATCHED)
  assert.equal(isDirectoryPermitted(d), true)
  // ⛔ The role travels from the CURRENT group mapping, not from the stored row —
  // a demotion in the directory must take effect, not be pinned by the row.
  assert.deepEqual(d.match, { id: 7, role: 'viewer' })
})

// ── the email collision: the account-takeover guard ─────────────────────────

test('a local account owning the email is REFUSED, never auto-linked', () => {
  const d = decideDirectoryUser(CLAIMS, 'viewer', { byEmail: localRow({ role: 'super_admin' }) })
  assert.equal(d.outcome, OUTCOME.EMAIL_COLLISION)
  assert.equal(isDirectoryPermitted(d), false)
  assert.equal(d.match, undefined, 'nothing may be matched')
  assert.equal(d.create, undefined, 'nothing may be created')
})

test('the collision is refused EVEN WHEN the roles agree', () => {
  // "Same role, so linking is harmless" is false — the local row's role can be
  // raised later and the directory identity would inherit the raise.
  const d = decideDirectoryUser(CLAIMS, 'admin', { byEmail: localRow({ role: 'admin' }) })
  assert.equal(d.outcome, OUTCOME.EMAIL_COLLISION)
})

test('a directory account would escalate to super_admin without this guard', () => {
  // The scenario the refusal exists for, stated as a test: the local row is the
  // only super_admin, and a directory token merely CLAIMS its email.
  const d = decideDirectoryUser(CLAIMS, 'viewer', { byEmail: localRow({ role: 'super_admin' }) })
  assert.notEqual(d.outcome, OUTCOME.MATCHED)
  assert.notEqual(d.outcome, OUTCOME.CREATE)
})

test('an oid match plus a different email owner is ambiguous, not a match', () => {
  const d = decideDirectoryUser(CLAIMS, 'admin', {
    byOid: entraRow({ id: 7 }),
    byEmail: localRow({ id: 9 }),
  })
  assert.equal(d.outcome, OUTCOME.AMBIGUOUS)
  assert.equal(isDirectoryPermitted(d), false)
})

test('an oid match whose own row also owns the email is a plain match', () => {
  const row = entraRow({ id: 7 })
  const d = decideDirectoryUser(CLAIMS, 'admin', { byOid: row, byEmail: row })
  assert.equal(d.outcome, OUTCOME.MATCHED)
})

// ── site_admin ──────────────────────────────────────────────────────────────

test('site_admin is refused for a directory account, with the cause named', () => {
  const d = decideDirectoryUser(CLAIMS, 'site_admin', {})
  assert.equal(d.outcome, OUTCOME.ROLE_UNSUPPORTED)
  assert.equal(isDirectoryPermitted(d), false)
  // The refusal must describe its OWN cause — SecVault had to reverse a refusal
  // that told the user something untrue about why.
  assert.match(d.reason, /site assignments|no sites/i)
  assert.match(d.reason, /admin or viewer|local account/i)
})

test('site_admin is refused on the matched path too, not only on create', () => {
  const d = decideDirectoryUser(CLAIMS, 'site_admin', { byOid: entraRow() })
  assert.equal(d.outcome, OUTCOME.ROLE_UNSUPPORTED)
  assert.equal(d.match, undefined)
})

test('site_admin is assignable in general but not provisionable from a directory', () => {
  assert.ok((ASSIGNABLE_ROLES as readonly string[]).includes('site_admin'))
  assert.ok(!DIRECTORY_PROVISIONABLE_ROLES.includes('site_admin'))
})

// ── incomplete claims and unresolved roles are not defaults ─────────────────

test('no oid is refused — the email is not a fallback identity key', () => {
  const d = decideDirectoryUser({ email: 'someone@example.com' }, 'admin', {})
  assert.equal(d.outcome, OUTCOME.CLAIMS_INCOMPLETE)
  assert.match(d.reason, /object id|oid/i)
})

test('no email is refused', () => {
  const d = decideDirectoryUser({ oid: OID }, 'admin', {})
  assert.equal(d.outcome, OUTCOME.CLAIMS_INCOMPLETE)
})

test('whitespace-only claims count as absent', () => {
  assert.equal(decideDirectoryUser({ oid: '   ', email: 'a@example.com' }, 'admin', {}).outcome, OUTCOME.CLAIMS_INCOMPLETE)
  assert.equal(decideDirectoryUser({ oid: OID, email: '   ' }, 'admin', {}).outcome, OUTCOME.CLAIMS_INCOMPLETE)
})

test('null claims are refused rather than throwing', () => {
  assert.equal(decideDirectoryUser(null, 'admin', {}).outcome, OUTCOME.CLAIMS_INCOMPLETE)
  assert.equal(decideDirectoryUser(undefined, 'admin', {}).outcome, OUTCOME.CLAIMS_INCOMPLETE)
})

test('an unresolved role is NOT viewer — there is no safe default', () => {
  for (const bad of [undefined, null, '', 'owner', 'Admin', 'VIEWER', 0, {}]) {
    const d = decideDirectoryUser(CLAIMS, bad, {})
    assert.equal(d.outcome, OUTCOME.ROLE_UNRESOLVED, `role ${JSON.stringify(bad)}`)
    assert.equal(d.create, undefined)
  }
})

test('the role check runs before anything is created or matched', () => {
  // An unresolved role on an otherwise-matchable identity must still refuse.
  const d = decideDirectoryUser(CLAIMS, 'nonsense', { byOid: entraRow() })
  assert.equal(d.outcome, OUTCOME.ROLE_UNRESOLVED)
  assert.equal(d.match, undefined)
})

test('isRole accepts exactly the four roles and nothing adjacent', () => {
  for (const r of ASSIGNABLE_ROLES) assert.equal(isRole(r), true, r)
  for (const r of ['superadmin', 'super-admin', 'Super_Admin', 'root', '']) {
    assert.equal(isRole(r), false, r)
  }
})

// ── every outcome is reachable ──────────────────────────────────────────────

test('every OUTCOME is returned by some input', () => {
  const seen = new Set<Outcome>()
  seen.add(decideDirectoryUser(CLAIMS, 'admin', {}).outcome)
  seen.add(decideDirectoryUser(CLAIMS, 'admin', { byOid: entraRow() }).outcome)
  seen.add(decideDirectoryUser(CLAIMS, 'admin', { byEmail: localRow() }).outcome)
  seen.add(decideDirectoryUser(CLAIMS, 'site_admin', {}).outcome)
  seen.add(decideDirectoryUser({ email: 'a@example.com' }, 'admin', {}).outcome)
  seen.add(decideDirectoryUser(CLAIMS, 'nope', {}).outcome)
  seen.add(
    decideDirectoryUser(CLAIMS, 'admin', { byOid: entraRow({ id: 1 }), byEmail: localRow({ id: 2 }) }).outcome,
  )
  for (const o of Object.values(OUTCOME)) {
    assert.ok(seen.has(o), `OUTCOME.${o} is unreachable — a guard that cannot fire`)
  }
})

test('no reason string leaks an identifier from the claims', () => {
  const d = decideDirectoryUser({ oid: OID, email: 'secret.person@example.com' }, 'site_admin', {})
  assert.ok(!d.reason.includes(OID), 'the oid must not appear in operator-facing text')
  assert.ok(!d.reason.includes('secret.person'), 'the address must not appear either')
})

// ── the local-password path ─────────────────────────────────────────────────

test('canUsePassword is false for a null or empty hash — bcryptjs THROWS on null', () => {
  assert.equal(canUsePassword({ password_hash: null }), false)
  assert.equal(canUsePassword({ password_hash: '' }), false)
  assert.equal(canUsePassword({}), false)
  assert.equal(canUsePassword(null), false)
  assert.equal(canUsePassword({ password_hash: '$2a$10$abcdefghijklmnopqrstuv' }), true)
})

test('bcryptjs really does reject on a null hash (the premise of the guard)', async () => {
  // ⛔ Pinned rather than asserted in a comment: if bcryptjs ever started
  // returning false instead of throwing, canUsePassword would be belt-only and
  // this test says so out loud.
  const bcrypt = (await import('bcryptjs')).default
  await assert.rejects(() => bcrypt.compare('x', null as any), /Illegal arguments/)
})

// ── provenance is read, never inferred ──────────────────────────────────────

test('isDirectoryAccount decides on auth_provider, never on a value shape', () => {
  assert.equal(isDirectoryAccount({ auth_provider: 'entra' }), true)
  assert.equal(isDirectoryAccount({ auth_provider: 'local' }), false)
  assert.equal(isDirectoryAccount({}), false, 'absent provider means local')
  assert.equal(isDirectoryAccount(null), false)
})

test('an unrecognised provider is NOT treated as local', () => {
  // SecVault's Phase 0 fail-open was exactly this: an unclassified provider
  // falling into the local path by default.
  assert.equal(isDirectoryAccount({ auth_provider: 'saml' }), true)
  assert.equal(isDirectoryAccount({ auth_provider: 'ldap' }), true)
})

test('the MFA role policy does not apply to a directory account', () => {
  // Without this, adding super_admin to mfa_required_roles locks out every
  // directory super_admin — they have no local secret and cannot enrol one.
  assert.equal(mfaPolicyApplies({ auth_provider: 'entra' }), false)
  assert.equal(mfaPolicyApplies({ auth_provider: 'local' }), true)
  assert.equal(mfaPolicyApplies({}), true, 'a local account is still governed')
})
