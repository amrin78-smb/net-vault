import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LOCAL_EMAIL_OUTCOME,
  decideLocalAccountEmail,
  sameRow,
  type LocalEmailOutcome,
  type EmailHolderRow,
} from '../lib/localAccountPolicy.ts'

const EMAIL = 'someone@example.com'

const localRow = (over: Partial<EmailHolderRow> = {}): EmailHolderRow => ({
  id: 7,
  email: EMAIL,
  role: 'admin',
  auth_provider: 'local',
  ...over,
})
const entraRow = (over: Partial<EmailHolderRow> = {}): EmailHolderRow =>
  localRow({ auth_provider: 'entra', ...over })

// ── the policy: a local account must not use a directory address ────────────

test('a directory account holding the email refuses the local write', () => {
  const d = decideLocalAccountEmail(EMAIL, entraRow())
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL)
  assert.equal(d.allowed, false)
})

test('the refusal is a 409 conflict, not a 400 — and names the field', () => {
  // The request is well formed; it conflicts with existing state. A 400 would
  // tell the administrator they mistyped something.
  const d = decideLocalAccountEmail(EMAIL, entraRow())
  assert.equal(d.status, 409)
  assert.equal(d.field, 'email')
})

test('the refusal says to sign in with the directory account', () => {
  const d = decideLocalAccountEmail(EMAIL, entraRow())
  assert.match(d.reason, /directory/i)
  assert.match(d.reason, /signs? in with their directory account/i)
  // And it says what to do about permissions, since the role on this form is
  // not where a directory account's role comes from.
  assert.match(d.reason, /group/i)
})

test('⛔ no refusal tells anyone to LINK the accounts — there is no such action', () => {
  // decideDirectoryUser carries the same constraint: an earlier draft of its
  // reason pointed operators at a "link the two in Settings → Users" feature
  // that never existed and never will.
  const reasons = [
    decideLocalAccountEmail(EMAIL, entraRow()).reason,
    decideLocalAccountEmail(EMAIL, localRow({ id: 9 })).reason,
    decideLocalAccountEmail('', null).reason,
    decideLocalAccountEmail(EMAIL, null).reason,
  ]
  for (const reason of reasons) {
    assert.doesNotMatch(reason, /\blink/i, `must not instruct anyone to link: ${reason}`)
    assert.doesNotMatch(reason, /\bmerge/i, `must not instruct anyone to merge: ${reason}`)
  }
})

test('an unrecognised auth_provider is treated as a directory account, not as local', () => {
  // The fail-closed direction: a row we cannot classify must not fall into the
  // weaker "just a duplicate" message. Decided on auth_provider by the shared
  // isDirectoryAccount helper, never re-derived from the shape of a value.
  const d = decideLocalAccountEmail(EMAIL, localRow({ auth_provider: 'ldap' }))
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL)
})

test('a missing auth_provider reads as local', () => {
  const d = decideLocalAccountEmail(EMAIL, { id: 9, email: EMAIL })
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.LOCAL_HOLDS_EMAIL)
})

// ── the same row is NOT a collision (the off-by-one) ────────────────────────

test('editing a LOCAL account without changing its email is not a collision', () => {
  // Every edit that leaves the email alone finds its OWN row by that email.
  // Without the same-row exemption the Users form could not save any existing
  // account at all.
  const d = decideLocalAccountEmail(EMAIL, localRow({ id: 7 }), 7)
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.OK)
  assert.equal(d.allowed, true)
})

test("editing a DIRECTORY account's own record is not a collision either", () => {
  const d = decideLocalAccountEmail(EMAIL, entraRow({ id: 7 }), 7)
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.OK)
  assert.equal(d.allowed, true)
})

test('the row id arrives as a path STRING and still matches', () => {
  // app/api/users/[id]/route.ts gets `id` from the URL, so it is a string while
  // the row id is a number. A strict === on the raw values would make every
  // edit a collision.
  const d = decideLocalAccountEmail(EMAIL, localRow({ id: 7 }), '7')
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.OK)
})

test('a DIFFERENT row holding the email is still a collision on the edit path', () => {
  const d = decideLocalAccountEmail(EMAIL, entraRow({ id: 9 }), 7)
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL)
  assert.equal(d.allowed, false)
})

test('a CREATE passes no row id and can never be exempted as its own row', () => {
  const d = decideLocalAccountEmail(EMAIL, entraRow({ id: 7 }))
  assert.equal(d.allowed, false)
  assert.equal(decideLocalAccountEmail(EMAIL, entraRow({ id: 7 }), undefined).allowed, false)
  assert.equal(decideLocalAccountEmail(EMAIL, entraRow({ id: 7 }), null).allowed, false)
})

test('an unreadable row id is NOT a match — the exemption cannot be switched off', () => {
  assert.equal(sameRow(7, '7 '), true, 'a padded path segment is still that row')
  assert.equal(sameRow(7, 'abc'), false)
  assert.equal(sameRow(7, ''), false)
  assert.equal(sameRow(7, NaN), false)
  assert.equal(sameRow(7, 7.5), false)
  assert.equal(sameRow(undefined, undefined), false, 'two absent ids are not the same row')
  assert.equal(sameRow(7, '07'), true, 'a zero-padded id is the same integer')
  assert.equal(
    decideLocalAccountEmail(EMAIL, entraRow({ id: 7 }), 'abc').allowed,
    false,
    'a garbage path id must fall through to the refusal, not past it',
  )
})

// ── case ────────────────────────────────────────────────────────────────────

test('⛔ the stored address may differ in CASE and is still the same address', () => {
  // The lookup (lib/directoryStore.ts findUserByEmail) matches with LOWER() on
  // both sides, precisely so a directory UPN in any case finds the row. So the
  // holder's stored email can differ in case from what was typed. This module
  // must NOT re-compare them: a `holder.email === email` precondition would
  // silently un-refuse exactly the collision the policy exists for.
  const d = decideLocalAccountEmail('SomeOne@Example.com', entraRow({ email: EMAIL }))
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL)

  const e = decideLocalAccountEmail(EMAIL, entraRow({ email: 'SOMEONE@EXAMPLE.COM' }))
  assert.equal(e.outcome, LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL)
})

test('surrounding whitespace on the typed address does not change the answer', () => {
  const d = decideLocalAccountEmail(`  ${EMAIL}  `, entraRow())
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL)
})

// ── the local-vs-local duplicate ────────────────────────────────────────────

test('another LOCAL account holding the email is refused with a cause, not a 500', () => {
  // Chosen over leaving it to the UNIQUE constraint: the create path already
  // pre-checked and answered 409, while the EDIT path reached the constraint and
  // surfaced a 500. The lookup has already happened, so answering both costs one
  // branch and removes the 500.
  const d = decideLocalAccountEmail(EMAIL, localRow({ id: 9 }))
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.LOCAL_HOLDS_EMAIL)
  assert.equal(d.allowed, false)
  assert.equal(d.status, 409)
  assert.match(d.reason, /local/i)
  // ⛔ It must NOT claim the address belongs to the directory — a refusal that
  // misdescribes its own cause sends the administrator to the wrong fix.
  assert.doesNotMatch(d.reason, /directory|entra/i)
})

// ── nobody holds it ─────────────────────────────────────────────────────────

test('a free address is permitted', () => {
  const d = decideLocalAccountEmail(EMAIL, null)
  assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.OK)
  assert.equal(d.allowed, true)
  assert.equal(d.status, 200)
  assert.equal(decideLocalAccountEmail(EMAIL, undefined).allowed, true)
})

// ── no address at all ───────────────────────────────────────────────────────

test('a blank or non-string email is refused as a 400, not silently permitted', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}] as unknown[]) {
    const d = decideLocalAccountEmail(bad, null)
    assert.equal(d.outcome, LOCAL_EMAIL_OUTCOME.EMAIL_MISSING, `input: ${String(bad)}`)
    assert.equal(d.allowed, false)
    assert.equal(d.status, 400, 'a missing field IS a bad request, unlike a conflict')
  }
})

// ── structural ──────────────────────────────────────────────────────────────

test('every LOCAL_EMAIL_OUTCOME is returned by some input', () => {
  // A state nothing can reach invites the next reader to branch on a value that
  // never arrives, which is a guard that cannot fire.
  const seen = new Set<LocalEmailOutcome>([
    decideLocalAccountEmail(EMAIL, null).outcome,
    decideLocalAccountEmail(EMAIL, entraRow()).outcome,
    decideLocalAccountEmail(EMAIL, localRow({ id: 9 })).outcome,
    decideLocalAccountEmail('', null).outcome,
  ])
  for (const outcome of Object.values(LOCAL_EMAIL_OUTCOME)) {
    assert.ok(seen.has(outcome), `nothing reaches ${outcome}`)
  }
})

test('`allowed` agrees with the outcome on every branch — it is never set apart', () => {
  const cases: Array<[LocalEmailDecisionLike, boolean]> = [
    [decideLocalAccountEmail(EMAIL, null), true],
    [decideLocalAccountEmail(EMAIL, localRow({ id: 7 }), 7), true],
    [decideLocalAccountEmail(EMAIL, entraRow({ id: 9 }), 7), false],
    [decideLocalAccountEmail(EMAIL, localRow({ id: 9 })), false],
    [decideLocalAccountEmail('', null), false],
  ]
  for (const [d, expected] of cases) {
    assert.equal(d.allowed, expected)
    assert.equal(d.outcome === LOCAL_EMAIL_OUTCOME.OK, expected, `outcome/allowed disagree: ${d.outcome}`)
    assert.equal(d.status === 200, expected, `status/allowed disagree: ${d.status}`)
  }
})

type LocalEmailDecisionLike = ReturnType<typeof decideLocalAccountEmail>

test('no reason leaks anything but the policy — no address, no role, no id', () => {
  const d = decideLocalAccountEmail(EMAIL, entraRow({ id: 7, role: 'super_admin' }))
  assert.doesNotMatch(d.reason, /example\.com/i, 'the address is in the form already')
  assert.doesNotMatch(d.reason, /super_admin/, 'the holder\'s role is not this caller\'s business')
})
