import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OUTCOME,
  ROLE_PRECEDENCE,
  resolveDirectoryRole,
  groupsFromClaims,
  hasGroupOverage,
  isDirectoryRole,
  isDirectoryRolePermitted,
  type Outcome,
} from '../lib/directoryRoles.ts'

const G_SUPER = 'aaaaaaaa-0000-0000-0000-000000000001'
const G_ADMIN = 'bbbbbbbb-0000-0000-0000-000000000002'
const G_VIEW = 'cccccccc-0000-0000-0000-000000000003'
const G_OTHER = 'dddddddd-0000-0000-0000-000000000004'

const MAPPINGS = [
  { group_key: G_SUPER, role: 'super_admin', display_name: 'Suite Super Admins' },
  { group_key: G_ADMIN, role: 'admin', display_name: 'Suite Admins' },
  { group_key: G_VIEW, role: 'viewer', display_name: 'Suite Viewers' },
]

// ── the happy path ──────────────────────────────────────────────────────────

test('a mapped group grants its role', () => {
  const d = resolveDirectoryRole({ groups: [G_ADMIN] }, MAPPINGS)
  assert.equal(d.outcome, OUTCOME.MAPPED)
  assert.equal(d.role, 'admin')
  assert.equal(isDirectoryRolePermitted(d), true)
  assert.equal(d.via, 'Suite Admins')
})

test('THE MOST PRIVILEGED MATCH WINS — adding a group can only ever add access', () => {
  // Resolving downwards would mean adding someone to a second group silently
  // REMOVED access.
  assert.equal(resolveDirectoryRole({ groups: [G_VIEW, G_SUPER] }, MAPPINGS).role, 'super_admin')
  assert.equal(resolveDirectoryRole({ groups: [G_SUPER, G_VIEW] }, MAPPINGS).role, 'super_admin')
  assert.equal(resolveDirectoryRole({ groups: [G_VIEW, G_ADMIN] }, MAPPINGS).role, 'admin')
  assert.equal(resolveDirectoryRole({ groups: [G_ADMIN, G_SUPER, G_VIEW] }, MAPPINGS).role, 'super_admin')
})

test('the result does not depend on the order of the mapping rows', () => {
  const reversed = [...MAPPINGS].reverse()
  assert.equal(resolveDirectoryRole({ groups: [G_VIEW, G_SUPER] }, reversed).role, 'super_admin')
})

test('group ids match case-insensitively, as the schema index does', () => {
  const d = resolveDirectoryRole({ groups: [G_ADMIN.toUpperCase()] }, MAPPINGS)
  assert.equal(d.role, 'admin')
})

test('a group the user holds but nobody mapped is ignored', () => {
  assert.equal(resolveDirectoryRole({ groups: [G_OTHER, G_VIEW] }, MAPPINGS).role, 'viewer')
})

// ── the three kinds of "no", kept apart ─────────────────────────────────────

test('ZERO MAPPINGS refuses everyone — the opposite of user_apps default-all', () => {
  const d = resolveDirectoryRole({ groups: [G_ADMIN] }, [])
  assert.equal(d.outcome, OUTCOME.NO_MAPPINGS)
  assert.equal(d.role, null)
  assert.equal(isDirectoryRolePermitted(d), false)
  assert.match(d.reason, /Settings/i, 'the reason must say where to fix it')
})

test('mappings exist but none match — a different outcome from zero mappings', () => {
  const d = resolveDirectoryRole({ groups: [G_OTHER] }, MAPPINGS)
  assert.equal(d.outcome, OUTCOME.NO_MATCHING_GROUP)
  assert.notEqual(d.outcome, OUTCOME.NO_MAPPINGS)
  // The single most likely setup failure gets named.
  assert.match(d.reason, /assigned to the enterprise application/i)
})

test('a FAILED mapping load is MAPPINGS_UNREADABLE, and blames us not the tenant', () => {
  for (const bad of [null, undefined]) {
    const d = resolveDirectoryRole({ groups: [G_ADMIN] }, bad)
    assert.equal(d.outcome, OUTCOME.MAPPINGS_UNREADABLE)
    assert.equal(d.role, null)
    assert.match(d.reason, /fault in the hub/i)
    // SecVault collapsed this into the group-claim outcome and told
    // administrators to check the app registration while the DB was down.
    assert.ok(!/app registration/i.test(d.reason), 'must not point at Entra')
  }
})

test('an unreadable mapping load is checked BEFORE the claims, so bad claims cannot mask it', () => {
  const d = resolveDirectoryRole({ groups: 'not-an-array' }, null)
  assert.equal(d.outcome, OUTCOME.MAPPINGS_UNREADABLE)
})

// ── the overage: the dangerous case ─────────────────────────────────────────

test('OVERAGE is refused by name, never read as "no groups"', () => {
  // A user in 201 groups is not a user in zero. Entra drops the claim and sends
  // a pointer instead.
  const d = resolveDirectoryRole(
    { _claim_names: { groups: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph.example.com/x' } } },
    MAPPINGS,
  )
  assert.equal(d.outcome, OUTCOME.GROUPS_OVERAGE)
  assert.equal(d.role, null)
  assert.notEqual(d.outcome, OUTCOME.NO_MATCHING_GROUP)
  assert.match(d.reason, /Groups assigned to the application/i, 'the fix must be named')
})

test('overage wins even when an empty groups array is also present', () => {
  const d = resolveDirectoryRole({ groups: [], _claim_names: { groups: 'src1' } }, MAPPINGS)
  assert.equal(d.outcome, OUTCOME.GROUPS_OVERAGE)
})

test('overage wins even when a groups array would otherwise MATCH', () => {
  // A truncated claim that happens to contain one group is still truncated —
  // the privileged group may be the one that was dropped.
  const d = resolveDirectoryRole({ groups: [G_VIEW], _claim_sources: { s: {} }, _claim_names: { groups: 's' } }, MAPPINGS)
  assert.equal(d.outcome, OUTCOME.GROUPS_OVERAGE)
  assert.equal(d.role, null)
})

test('hasGroupOverage only fires on a pointer that names `groups`', () => {
  assert.equal(hasGroupOverage({ _claim_names: { groups: 'src1' } }), true)
  assert.equal(hasGroupOverage({ _claim_sources: { groups: {} } }), true)
  // A pointer for some OTHER claim is not a group overage.
  assert.equal(hasGroupOverage({ _claim_names: { roles: 'src1' } }), false)
  assert.equal(hasGroupOverage({}), false)
  assert.equal(hasGroupOverage(null), false)
  assert.equal(hasGroupOverage({ _claim_names: 'groups' }), false, 'a string is not a pointer object')
})

// ── unreadable vs empty ─────────────────────────────────────────────────────

test('UNREADABLE GROUPS IS NOT "NO GROUPS" — distinct outcomes, distinct fixes', () => {
  const unreadable = resolveDirectoryRole({}, MAPPINGS)
  assert.equal(unreadable.outcome, OUTCOME.GROUPS_UNREADABLE)

  const none = resolveDirectoryRole({ groups: [] }, MAPPINGS)
  assert.equal(none.outcome, OUTCOME.NO_MATCHING_GROUP)

  assert.notEqual(unreadable.outcome, none.outcome)
  assert.notEqual(unreadable.reason, none.reason)
})

test('groupsFromClaims has three outcomes, not two', () => {
  assert.deepEqual(groupsFromClaims({ groups: [G_ADMIN] }), { groups: [G_ADMIN], overage: false })
  assert.deepEqual(groupsFromClaims({ groups: [] }), { groups: [], overage: false })
  // null = we could not ask. Never [].
  assert.deepEqual(groupsFromClaims({}), { groups: null, overage: false })
  assert.deepEqual(groupsFromClaims({ groups: null }), { groups: null, overage: false })
  assert.deepEqual(groupsFromClaims({ groups: 'x' }), { groups: null, overage: false })
  assert.deepEqual(groupsFromClaims({ groups: 42 }), { groups: null, overage: false })
  assert.deepEqual(groupsFromClaims(null), { groups: null, overage: false })
})

test('non-string group entries are dropped, never coerced', () => {
  // A coerced "[object Object]" is a group id that can never match — a silent
  // denial dressed as a real comparison.
  const { groups } = groupsFromClaims({ groups: [G_ADMIN, { x: 1 }, null, 42, '', '  ', G_VIEW] })
  assert.deepEqual(groups, [G_ADMIN, G_VIEW])
})

test('a claims array of ONLY junk is an empty list, not unreadable', () => {
  // We could read the claim; it contained nothing usable. That is a real
  // (if odd) answer, distinct from "no claim arrived".
  const d = resolveDirectoryRole({ groups: [{ x: 1 }, 42] }, MAPPINGS)
  assert.equal(d.outcome, OUTCOME.NO_MATCHING_GROUP)
})

// ── the plumbing tripwire ───────────────────────────────────────────────────

test('mappings with no usable group key are MALFORMED, not NO_MATCHING_GROUP', () => {
  // Without this a renamed column makes every comparison fail and the answer
  // looks like an ordinary configuration problem — a code defect that would be
  // debugged in the customer's tenant.
  const d = resolveDirectoryRole({ groups: [G_ADMIN] }, [
    { group_key: null, role: 'admin' },
    { group_key: '  ', role: 'viewer' },
    { role: 'super_admin' },
  ])
  assert.equal(d.outcome, OUTCOME.MAPPINGS_MALFORMED)
  assert.match(d.reason, /fault in the hub/i)
})

test('a mix of usable and unusable rows still resolves from the usable ones', () => {
  const d = resolveDirectoryRole({ groups: [G_ADMIN] }, [
    { group_key: null, role: 'super_admin' },
    { group_key: G_ADMIN, role: 'admin', display_name: 'Suite Admins' },
  ])
  assert.equal(d.outcome, OUTCOME.MAPPED)
  assert.equal(d.role, 'admin')
})

// ── role validation ─────────────────────────────────────────────────────────

test('a matched row with an unrecognised role is SKIPPED, never trusted', () => {
  const d = resolveDirectoryRole({ groups: [G_ADMIN] }, [{ group_key: G_ADMIN, role: 'root' }])
  assert.equal(d.outcome, OUTCOME.NO_MATCHING_GROUP)
  assert.equal(d.role, null)
})

test('site_admin in a mapping row does not resolve, even though it is a real hub role', () => {
  // A directory account cannot hold it — it would sign in and see no sites.
  // The schema CHECK forbids the row; this is the code half of the same rule.
  const d = resolveDirectoryRole({ groups: [G_ADMIN] }, [{ group_key: G_ADMIN, role: 'site_admin' }])
  assert.equal(d.outcome, OUTCOME.NO_MATCHING_GROUP)
  assert.equal(d.role, null)
  assert.equal(isDirectoryRole('site_admin'), false)
})

test('a skipped bad row does not shadow a good one', () => {
  const d = resolveDirectoryRole({ groups: [G_ADMIN, G_VIEW] }, [
    { group_key: G_ADMIN, role: 'site_admin' },
    { group_key: G_VIEW, role: 'viewer', display_name: 'Suite Viewers' },
  ])
  assert.equal(d.role, 'viewer')
})

test('isDirectoryRole accepts exactly the three provisionable roles', () => {
  assert.deepEqual(ROLE_PRECEDENCE, ['super_admin', 'admin', 'viewer'])
  for (const r of ROLE_PRECEDENCE) assert.equal(isDirectoryRole(r), true, r)
  for (const r of ['site_admin', 'root', 'Admin', '', null, undefined, 1]) {
    assert.equal(isDirectoryRole(r), false, String(r))
  }
})

// ── completeness and hygiene ────────────────────────────────────────────────

test('every OUTCOME is returned by some input', () => {
  const seen = new Set<Outcome>()
  seen.add(resolveDirectoryRole({ groups: [G_ADMIN] }, MAPPINGS).outcome)
  seen.add(resolveDirectoryRole({ groups: [G_ADMIN] }, []).outcome)
  seen.add(resolveDirectoryRole({ groups: [G_OTHER] }, MAPPINGS).outcome)
  seen.add(resolveDirectoryRole({}, MAPPINGS).outcome)
  seen.add(resolveDirectoryRole({ _claim_names: { groups: 's' } }, MAPPINGS).outcome)
  seen.add(resolveDirectoryRole({ groups: [G_ADMIN] }, null).outcome)
  seen.add(resolveDirectoryRole({ groups: [G_ADMIN] }, [{ group_key: '', role: 'admin' }]).outcome)
  for (const o of Object.values(OUTCOME)) {
    assert.ok(seen.has(o), `OUTCOME.${o} is unreachable — a guard that cannot fire`)
  }
})

test('MAPPED is the only permitted outcome', () => {
  for (const o of Object.values(OUTCOME)) {
    assert.equal(isDirectoryRolePermitted({ outcome: o }), o === OUTCOME.MAPPED, o)
  }
})

test('no refusal reason leaks a group id', () => {
  for (const d of [
    resolveDirectoryRole({ groups: [G_OTHER] }, MAPPINGS),
    resolveDirectoryRole({ groups: [G_ADMIN] }, []),
    resolveDirectoryRole({}, MAPPINGS),
    resolveDirectoryRole({ _claim_names: { groups: 's' } }, MAPPINGS),
  ]) {
    for (const g of [G_SUPER, G_ADMIN, G_VIEW, G_OTHER]) {
      assert.ok(!d.reason.includes(g), `${d.outcome} leaked a group id`)
    }
  }
})

test('every refusal returns role null — no outcome may carry a role it did not grant', () => {
  for (const d of [
    resolveDirectoryRole({ groups: [G_ADMIN] }, []),
    resolveDirectoryRole({ groups: [G_OTHER] }, MAPPINGS),
    resolveDirectoryRole({}, MAPPINGS),
    resolveDirectoryRole({ _claim_names: { groups: 's' } }, MAPPINGS),
    resolveDirectoryRole({ groups: [G_ADMIN] }, null),
    resolveDirectoryRole({ groups: [G_ADMIN] }, [{ group_key: '', role: 'admin' }]),
  ]) {
    assert.equal(d.role, null, d.outcome)
  }
})
