import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainRefusal, refusalCode } from '../lib/directoryRefusals.ts'

// ⛔ PURE HALF ONLY. The database half is covered in directoryStore.test.ts
// against a real PostgreSQL, because the cap is a property of the SQL.
//
// What is actually being asserted here is that SIX CAUSES STAY SIX THINGS. They
// look identical from the login page — the person authenticates at Microsoft
// and is bounced — and they need completely different fixes. SecVault collapsed
// `mappings_unreadable` into `groups_unreadable` and the result told
// administrators to go and check their app registration while the fault was its
// own database.

test('refusalCode takes the outcome and leaves the free-text reason behind', () => {
  assert.equal(refusalCode('no_matching_group: none of 3 groups is mapped'), 'no_matching_group')
  assert.equal(refusalCode('groups_overage'), 'groups_overage')
  assert.equal(refusalCode('  padded: x  '), 'padded')
  assert.equal(refusalCode(''), '')
  assert.equal(refusalCode(null), '')
  assert.equal(refusalCode(undefined), '')
  assert.equal(refusalCode(42 as unknown as string), '')
})

test('every known cause maps to a DISTINCT action an administrator can take', () => {
  const cases: Record<string, string> = {
    no_matching_group: 'map-group',
    no_mappings: 'map-group',
    role_unsupported: 'map-group',
    groups_unreadable: 'app-registration',
    groups_overage: 'app-registration',
    claims_incomplete: 'app-registration',
    mappings_unreadable: 'ours',
    email_collision: 'local-account',
    ambiguous: 'local-account',
  }
  for (const [cause, action] of Object.entries(cases)) {
    const e = explainRefusal(`${cause}: some reason written for a log`)
    assert.equal(e.action, action, `${cause} should route to ${action}, got ${e.action}`)
    assert.equal(e.code, cause)
    assert.ok(e.title.length > 0, `${cause} has no title`)
    assert.ok(e.fix.length > 0, `${cause} has no fix`)
  }
})

test('the three causes that look identical from the login page say different things', () => {
  // ⛔ THE REGRESSION THIS EXISTS FOR. All three refuse a person who
  // authenticated perfectly at Microsoft, and the login page says the same
  // sentence for all three. If their titles or fixes ever converge, the only
  // place that distinguishes them has stopped doing so.
  const a = explainRefusal('no_matching_group: x')
  const b = explainRefusal('groups_unreadable: x')
  const c = explainRefusal('mappings_unreadable: x')
  const titles = [a.title, b.title, c.title]
  assert.equal(new Set(titles).size, 3, `titles collapsed: ${JSON.stringify(titles)}`)
  const fixes = [a.fix, b.fix, c.fix]
  assert.equal(new Set(fixes).size, 3, `fixes collapsed: ${JSON.stringify(fixes)}`)
  assert.equal(new Set([a.action, b.action, c.action]).size, 3, 'actions collapsed')
})

test('mappings_unreadable blames us, and says so in words', () => {
  // Pointing an administrator at their own directory for OUR database being
  // down is the specific mistake this whole module exists to avoid.
  const e = explainRefusal('mappings_unreadable: connection terminated')
  assert.equal(e.action, 'ours')
  assert.match(e.fix, /our fault|not a directory problem/i)
  assert.doesNotMatch(e.fix, /app registration/i, 'must not send them to Entra for our own fault')
})

test('an unrecognised cause is shown, not swallowed', () => {
  // A dead end is worse than an unfamiliar string: the answer is in the string.
  const e = explainRefusal('some_future_outcome: detail')
  assert.equal(e.code, 'some_future_outcome')
  assert.ok(e.title.includes('some_future_outcome'), `title hides the code: ${e.title}`)
  assert.equal(e.action, 'unknown')
})

test('an empty cause still produces something readable', () => {
  const e = explainRefusal('')
  assert.equal(e.code, 'unknown')
  assert.ok(e.title.length > 0)
  assert.ok(e.fix.length > 0)
})
