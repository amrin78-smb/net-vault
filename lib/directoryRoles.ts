//
// lib/directoryRoles.ts — "a directory says this person is in these groups.
// What hub role is that?"
//
// Pure. Takes the claims from an already-verified id_token plus the mapping rows
// and returns a decision. No pool, no environment, no I/O — so every branch
// below is reachable from a test, including the ones that matter most.
//
// ⛔ THE WHOLE FILE IS ABOUT TELLING THREE DIFFERENT KINDS OF "NO" APART:
//
//   no mappings exist          an administrator has configured nothing
//   no mapping matched         they configured something, this person isn't in it
//   the groups could not be read   we do not know what groups they are in
//
// Each needs a different fix and the third must never be rendered as either of
// the first two. Collapsing them is this suite's signature bug — a failed read
// recorded as an affirmative value — landing on the authorization path.

import { ASSIGNABLE_ROLES, DIRECTORY_PROVISIONABLE_ROLES, type Role } from './directoryUser.ts'

/**
 * Role precedence, most privileged first.
 *
 * ⛔ DERIVED FROM NOTHING AND STATED EXPLICITLY. A precedence computed from the
 * order of `ASSIGNABLE_ROLES`, or from a capability count, silently re-ranks
 * itself the day a role is added — and the failure is a privilege decision, not
 * a crash. `site_admin` is absent because a directory account cannot hold it
 * (see DIRECTORY_PROVISIONABLE_ROLES and the schema constraint); a mapping row
 * claiming it is a data error, handled below rather than ranked.
 */
export const ROLE_PRECEDENCE: Role[] = ['super_admin', 'admin', 'viewer']

export const OUTCOME = {
  MAPPED: 'mapped',
  /** No mapping rows exist at all. Refused — see the note below. */
  NO_MAPPINGS: 'no_mappings',
  /** Mappings exist; this person is in none of them. */
  NO_MATCHING_GROUP: 'no_matching_group',
  /** The token carried no readable group claim. NOT "no groups". */
  GROUPS_UNREADABLE: 'groups_unreadable',
  /** Entra truncated the claim because the user is in too many groups. */
  GROUPS_OVERAGE: 'groups_overage',
  /** The mapping rows could not be loaded — OUR fault, not the customer's. */
  MAPPINGS_UNREADABLE: 'mappings_unreadable',
  /** Rows loaded but carry no usable group key — a plumbing error. */
  MAPPINGS_MALFORMED: 'mappings_malformed',
} as const
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME]

/** The only outcome that admits anyone. */
export function isDirectoryRolePermitted(d: { outcome: Outcome }): boolean {
  return d.outcome === OUTCOME.MAPPED
}

// ⛔ THE OVERAGE IS THE DANGEROUS CASE, AND IT LOOKS EXACTLY LIKE INNOCENCE.
// Entra omits the `groups` claim once a user exceeds roughly 200 memberships and
// sends a `_claim_names` / `_claim_sources` pointer instead, to be followed with
// a Microsoft Graph call. Unhandled, the token simply has no `groups` array —
// which reads as "this user is in no groups" and resolves to no role.
//
// A user in 201 groups is not a user in zero. And it lands on the most
// heavily-group-assigned accounts in a customer's directory, which in practice
// means their administrators: the people for whom a confusing refusal is most
// expensive.
//
// We deliberately do NOT follow the pointer. Doing so needs GroupMember.Read.All
// — an admin-consent Graph permission the setup instructions explicitly ask the
// customer's tenant administrator NOT to grant — plus a second outbound
// dependency on the login path. Instead the app registration is configured to
// emit only "Groups assigned to the application", which keeps the claim small so
// the overage never happens; and if it happens anyway, it is REFUSED BY NAME.
const OVERAGE_KEYS = ['_claim_names', '_claim_sources'] as const

export type DirectoryClaims = {
  groups?: unknown
  _claim_names?: unknown
  _claim_sources?: unknown
}

export type Mapping = {
  /** The Entra group object id. */
  group_key?: string | null
  role?: string | null
  display_name?: string | null
}

export type RoleDecision = {
  outcome: Outcome
  /** Null unless MAPPED. */
  role: Role | null
  /** Operator-facing. Never contains a token, a secret or a group id. */
  reason: string
  /** For MAPPED: the label of the mapping that granted it, for the audit line. */
  via?: string | null
}

/**
 * Is this token telling us the group claim was TRUNCATED rather than empty?
 *
 * ⛔ CHECKED BEFORE THE GROUPS ARRAY IS TRUSTED. An overage token may carry no
 * `groups` key at all, or an empty one; neither means the user has no groups.
 */
export function hasGroupOverage(claims: DirectoryClaims | null | undefined): boolean {
  if (!claims || typeof claims !== 'object') return false
  for (const key of OVERAGE_KEYS) {
    const v = (claims as Record<string, unknown>)[key]
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'groups')) return true
  }
  return false
}

/**
 * Extract group ids from the claims.
 *
 * ⛔ THREE OUTCOMES, NOT TWO, AND THE THIRD IS THE WHOLE POINT:
 *   - an array      -> the groups, however many (possibly zero)
 *   - `null`        -> WE COULD NOT ASK. Overage, or a malformed claim.
 *                      Never "no groups".
 *   - an empty array -> the directory genuinely reports no memberships
 *
 * `null` and `[]` must reach the resolver as different things.
 */
export function groupsFromClaims(
  claims: DirectoryClaims | null | undefined,
): { groups: string[] | null; overage: boolean } {
  if (!claims || typeof claims !== 'object') return { groups: null, overage: false }
  if (hasGroupOverage(claims)) return { groups: null, overage: true }

  const raw = (claims as Record<string, unknown>).groups
  if (raw === undefined || raw === null) return { groups: null, overage: false }
  if (!Array.isArray(raw)) return { groups: null, overage: false }

  // Non-string entries are DROPPED rather than coerced — a coerced
  // "[object Object]" would be a group id that can never match, i.e. a silent
  // denial dressed as a real comparison.
  const groups = raw.filter((g): g is string => typeof g === 'string' && g.trim() !== '')
  return { groups, overage: false }
}

/** Normalise a group key for comparison. Mirrors the schema's lower(group_key). */
function normaliseKey(k: unknown): string | null {
  if (typeof k !== 'string') return null
  const t = k.trim().toLowerCase()
  return t === '' ? null : t
}

/**
 * Decide the hub role for a directory sign-in.
 *
 * @param claims        from the VERIFIED id_token
 * @param mappings      the rows, or `null` meaning THE LOAD FAILED
 */
export function resolveDirectoryRole(
  claims: DirectoryClaims | null | undefined,
  mappings: Mapping[] | null | undefined,
): RoleDecision {
  // ⛔ A FAILED MAPPING LOAD IS OUR FAULT AND MUST SAY SO. SecVault collapsed
  // this into GROUPS_UNREADABLE and the result told administrators to "check
  // that the app registration emits group claims" — pointing at Entra while the
  // database was the problem. Two causes, two completely different fixes, one
  // label.
  //
  // ⛔ AND `null` MUST NOT ARRIVE AS `[]`. The loader must THROW rather than
  // return an empty array on a database error, because an empty array is an
  // INSTRUCTION here (it means "nobody is permitted") and a transient blip
  // would otherwise be indistinguishable from a deliberate configuration.
  if (mappings === null || mappings === undefined) {
    return {
      outcome: OUTCOME.MAPPINGS_UNREADABLE,
      role: null,
      reason:
        'The directory group mappings could not be read, so no role could be resolved. This is ' +
        'a fault in the hub or its database, not a problem with the directory configuration.',
    }
  }

  // ⛔ ZERO MAPPINGS = NOBODY SIGNS IN, AND THIS IS THE OPPOSITE OF HOW
  // user_apps BEHAVES IN THIS SUITE. `getUserApps` treats "no rows" as
  // default-all, and that is right there: the feature shipped onto installs
  // whose users already had access, and making an empty table mean deny would
  // have locked out an existing base on the deploy that delivered it.
  //
  // There is no existing base of directory sign-ins. Nobody has ever signed in
  // this way, so failing open could only ever create a hole. The Settings panel
  // must say this plainly while the list is empty, or the first customer to
  // enable Entra will conclude the integration is broken.
  if (mappings.length === 0) {
    return {
      outcome: OUTCOME.NO_MAPPINGS,
      role: null,
      reason:
        'No directory groups are mapped to a role yet, so no directory account can sign in. ' +
        'Map at least one group in Settings → Single sign-on.',
    }
  }

  const { groups, overage } = groupsFromClaims(claims)

  if (overage) {
    return {
      outcome: OUTCOME.GROUPS_OVERAGE,
      role: null,
      reason:
        'The directory reported that this account is in too many groups to list in the sign-in ' +
        'token, so its group memberships could not be read. Configure the app registration to ' +
        'emit only "Groups assigned to the application" rather than all groups.',
    }
  }

  // ⛔ UNREADABLE GROUPS IS NOT "NO GROUPS". Distinct outcome, distinct fix: the
  // app registration is not emitting a groups claim at all.
  if (groups === null) {
    return {
      outcome: OUTCOME.GROUPS_UNREADABLE,
      role: null,
      reason:
        'The sign-in token carried no readable group claim. Add a groups claim to the app ' +
        'registration\'s token configuration.',
    }
  }

  // ⛔ THE USABLE-KEY CHECK — A PLUMBING TRIPWIRE, NOT A CUSTOMER PROBLEM. If
  // every row's key is unusable the rows did not arrive in the shape this
  // function expects (a renamed column, a caller re-shaping rows on the way in).
  // Without this, every comparison silently fails to match and the answer is an
  // ordinary-looking NO_MATCHING_GROUP — a code defect wearing a configuration
  // error's clothes, which would be debugged in the customer's tenant.
  const usable = mappings.filter((m) => normaliseKey(m.group_key) !== null)
  if (usable.length === 0) {
    return {
      outcome: OUTCOME.MAPPINGS_MALFORMED,
      role: null,
      reason:
        'The directory group mappings carry no usable group identifiers. This is a fault in the ' +
        'hub, not in the directory configuration.',
    }
  }

  if (groups.length === 0) {
    return {
      outcome: OUTCOME.NO_MATCHING_GROUP,
      role: null,
      reason:
        'The directory reported no group memberships for this account. Add the account to a ' +
        'mapped group, and check the group is assigned to the enterprise application.',
    }
  }

  const held = new Set(groups.map((g) => normaliseKey(g)).filter((g): g is string => g !== null))

  // ⛔ THE MOST PRIVILEGED MATCH WINS. A user in both "Admins" and "Viewers" is
  // an admin. Resolving downwards would mean adding someone to a SECOND group
  // silently REMOVED access, which is the opposite of what anyone expects from
  // adding a group membership.
  let best: { role: Role; label: string | null } | null = null
  for (const m of usable) {
    const key = normaliseKey(m.group_key)
    if (key === null || !held.has(key)) continue
    const role = m.role
    // ⛔ An unrecognised role on a matched row is SKIPPED, never trusted and
    // never defaulted. The schema constrains this column, but a role arriving
    // here that this code does not know is a disagreement between the two, and
    // the safe reading of a disagreement on an authorization path is "no".
    if (!isDirectoryRole(role)) continue
    if (best === null || ROLE_PRECEDENCE.indexOf(role) < ROLE_PRECEDENCE.indexOf(best.role)) {
      best = { role, label: m.display_name || null }
    }
  }

  if (best === null) {
    return {
      outcome: OUTCOME.NO_MATCHING_GROUP,
      role: null,
      reason:
        'This account is not in any group mapped to a hub role. Map one of its groups, and ' +
        'check the group is assigned to the enterprise application — a group that is mapped but ' +
        'not assigned never appears in the sign-in token.',
    }
  }

  return {
    outcome: OUTCOME.MAPPED,
    role: best.role,
    reason: `Granted ${best.role} by a mapped directory group.`,
    via: best.label,
  }
}

/**
 * A role a directory mapping may legitimately carry.
 *
 * ⛔ NARROWER THAN `isRole`. `site_admin` is an assignable hub role but cannot
 * be held by a directory account, so a mapping row naming it must not resolve —
 * see DIRECTORY_PROVISIONABLE_ROLES and the schema CHECK that enforces the same
 * thing one layer down.
 */
export function isDirectoryRole(v: unknown): v is Role {
  return (
    typeof v === 'string' &&
    (ASSIGNABLE_ROLES as readonly string[]).includes(v) &&
    DIRECTORY_PROVISIONABLE_ROLES.includes(v as Role) &&
    ROLE_PRECEDENCE.includes(v as Role)
  )
}
