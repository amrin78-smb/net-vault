//
// lib/directoryUser.ts — what a directory (Entra ID) identity is allowed to
// become in the hub's `users` table, and when it must be refused instead.
//
// ⛔ WHY THIS EXISTS AT ALL, AND WHY SECVAULT HAS NO EQUIVALENT. SecVault is one
// app with one identity store, so a directory account can sign in without ever
// having a local row — and SecVault deliberately left shadow rows unbuilt. The
// NocVault suite cannot: all three satellites resolve identity by looking up
// the hub's `users` table, and two of them hard-fail without a row.
//
//   logvault/frontend/src/auth.ts   SELECT ... FROM users WHERE id = $1
//                                   no row -> no session.
//   ddivault/frontend/src/lib/auth.ts
//                                   calls the hub's /api/auth/sso-verify, which
//                                   answers 404 "User not found".
//   spanvault/frontend/src/lib/auth.ts
//                                   best-effort lookup, then falls through to
//                                   `payload.role || 'viewer'`.
//
// ⛔ THE SPANVAULT CASE IS THE DANGEROUS ONE, because it does not fail. A
// directory super_admin with no hub row lands in SpanVault as a VIEWER — a
// silently wrong authorization outcome that looks like a working sign-in. That
// is the reason provisioning is a day-one requirement here and not a later
// phase: "no row" is not a neutral state in this suite.
//
// This module is PURE. It takes an already-verified directory identity plus
// whatever the database says, and returns a decision. It opens no connection,
// reads no environment and performs no I/O, so every branch below is reachable
// from a test.

/** NetVault's roles. `viewer` is the floor; there is no unprivileged default. */
export const ASSIGNABLE_ROLES = ['super_admin', 'admin', 'site_admin', 'viewer'] as const
export type Role = (typeof ASSIGNABLE_ROLES)[number]

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(v)
}

/**
 * Every way this can end. ⛔ EVERY MEMBER IS RETURNED BY SOME INPUT and a test
 * proves it — a state nothing can reach invites the next reader to branch on a
 * value that never arrives, which is a guard that cannot fire.
 */
export const OUTCOME = {
  /** Provision a new row for this directory identity. */
  CREATE: 'create',
  /** An existing row already carries this oid — sign in as it, refresh the role. */
  MATCHED: 'matched',
  /** A LOCAL account owns this email. Refused — see below. */
  EMAIL_COLLISION: 'email_collision',
  /** The resolved role cannot be represented for a directory account. */
  ROLE_UNSUPPORTED: 'role_unsupported',
  /** The token did not carry the claims a row needs. */
  CLAIMS_INCOMPLETE: 'claims_incomplete',
  /** The resolved role was absent or not a role at all. */
  ROLE_UNRESOLVED: 'role_unresolved',
  /** A row carries this oid AND a different row owns the email. */
  AMBIGUOUS: 'ambiguous',
} as const
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME]

const PERMITTED: Outcome[] = [OUTCOME.CREATE, OUTCOME.MATCHED]

/** Does this outcome let the sign-in proceed? */
export function isDirectoryPermitted(d: { outcome: Outcome }): boolean {
  return PERMITTED.includes(d.outcome)
}

/**
 * ⛔ A DIRECTORY ACCOUNT MAY NOT BE PROVISIONED AS `site_admin`, AND THIS IS A
 * REFUSAL RATHER THAN A DEGRADE.
 *
 * NetVault's authorize() loads a site_admin's scope from `user_sites`:
 *   if (user.role === 'site_admin') siteIds = SELECT site_id FROM user_sites ...
 * A freshly provisioned row has no `user_sites` rows, so a directory site_admin
 * signs in perfectly and sees NOTHING — an empty product with no stated cause.
 *
 * SecVault shipped exactly that shape for Entra device scoping and had to
 * reverse it (v2.212.0): an Entra Super Admin saw an empty fleet under a banner
 * claiming their account was restricted to specific firewalls, which was untrue
 * — nobody had restricted them, the product simply could not represent their
 * identity. A refusal that misdescribes its own cause is worse than the
 * limitation it guards.
 *
 * So the sign-in is refused with a cause an administrator can act on: map the
 * group to `admin` or `viewer`, or give that person a local account with site
 * assignments. Lifting this means provisioning `user_sites` from the directory
 * in the SAME change, never before.
 */
export const DIRECTORY_PROVISIONABLE_ROLES: Role[] = ['super_admin', 'admin', 'viewer']

export type DirectoryClaims = {
  /** The Entra object id (`oid`). Immutable, and the only safe join key. */
  oid?: string | null
  /** UPN or email. ⛔ MUTABLE — a display/contact value, never an identity key. */
  email?: string | null
  name?: string | null
}

/** What the database already knows, resolved by the caller. */
export type ExistingRows = {
  /** A row whose `entra_oid` equals this oid, if any. */
  byOid?: { id: number; email: string; role: string; auth_provider: string } | null
  /** A row whose email equals this email, if any. */
  byEmail?: { id: number; email: string; role: string; auth_provider: string } | null
}

export type DirectoryDecision = {
  outcome: Outcome
  /** Safe to show an administrator. Never contains a token or a secret. */
  reason: string
  /** Set for CREATE: the row to insert. */
  create?: { email: string; name: string; role: Role; entra_oid: string }
  /** Set for MATCHED: the row to sign in as, and the role to refresh it to. */
  match?: { id: number; role: Role }
}

/**
 * Decide what to do with a verified directory identity.
 *
 * @param claims  from the verified id_token — NEVER from a request body
 * @param role    the role already resolved from the group mapping
 * @param rows    what the database holds for this oid / email
 */
export function decideDirectoryUser(
  claims: DirectoryClaims | null | undefined,
  role: unknown,
  rows: ExistingRows = {},
): DirectoryDecision {
  const oid = typeof claims?.oid === 'string' ? claims.oid.trim() : ''
  const email = typeof claims?.email === 'string' ? claims.email.trim() : ''

  // ⛔ NO OID, NO IDENTITY. The oid is the only immutable claim; without it
  // there is nothing stable to key a row on, and falling back to the email
  // would make the account's identity a mutable directory attribute.
  if (!oid) {
    return {
      outcome: OUTCOME.CLAIMS_INCOMPLETE,
      reason:
        'The directory token carried no object id (oid), so there is no stable identifier to ' +
        'attach an account to. Check the app registration emits standard profile claims.',
    }
  }
  // The email is required too — not as a key, but because `users.email` is NOT
  // NULL and every satellite displays it. A row cannot be built without one.
  if (!email) {
    return {
      outcome: OUTCOME.CLAIMS_INCOMPLETE,
      reason:
        'The directory token carried no email or UPN. The hub stores an email for every ' +
        'account, so one is required even though sign-in is keyed on the object id.',
    }
  }

  // ⛔ CHECKED BEFORE ANYTHING IS CREATED OR MATCHED. An unresolved role is not
  // "viewer" — it means the group mapping produced no answer, and substituting
  // the least-privileged role would silently admit every directory user to the
  // hub. There is no safe default here, so there is no default.
  if (!isRole(role)) {
    return {
      outcome: OUTCOME.ROLE_UNRESOLVED,
      reason:
        'No hub role was resolved for this account, so there is nothing to provision it as. ' +
        'Map one of the user\'s directory groups to a role.',
    }
  }

  const byOid = rows.byOid || null
  const byEmail = rows.byEmail || null

  // ── already ours ─────────────────────────────────────────────────────────
  if (byOid) {
    // ⛔ AN OID MATCH AND A DIFFERENT EMAIL OWNER IS AMBIGUOUS, NOT A MATCH.
    // Someone's UPN changed in the directory to an address a second hub account
    // already holds. Signing in as the oid row would be defensible, but the
    // email is UNIQUE in this schema so any later write of it collides — and
    // guessing which of two rows the person meant is exactly the kind of
    // decision that must not be made silently.
    if (byEmail && byEmail.id !== byOid.id) {
      return {
        outcome: OUTCOME.AMBIGUOUS,
        reason:
          'This directory account is already linked to one hub account, while a different hub ' +
          'account holds the same email address. An administrator must resolve which is correct ' +
          'before this person can sign in.',
      }
    }
    if (!DIRECTORY_PROVISIONABLE_ROLES.includes(role)) {
      return { outcome: OUTCOME.ROLE_UNSUPPORTED, reason: roleRefusalReason(role) }
    }
    return {
      outcome: OUTCOME.MATCHED,
      reason: `Signed in as an existing directory account; role refreshed to ${role}.`,
      match: { id: byOid.id, role },
    }
  }

  // ── a local account owns this email ──────────────────────────────────────
  // ⛔ REFUSED, NEVER AUTO-LINKED, AND THIS IS THE MOST IMPORTANT DECISION IN
  // THIS FILE. Linking on email would mean: whoever can obtain a directory
  // account bearing address X inherits whatever role the local account X holds
  // — up to and including super_admin, which is the only role that can manage
  // users and the licence. The email in a token is a claim about a MUTABLE
  // directory attribute, and in Entra a UPN can be changed by a tenant
  // administrator; treating it as proof of ownership of a pre-existing
  // privileged account is privilege escalation with an audit trail that looks
  // like a normal sign-in.
  //
  // ⛔ AND IT IS REFUSED EVEN WHEN THE ROLES HAPPEN TO AGREE. "Same role, so
  // linking is harmless" is false: the match is what would be trusted, and the
  // local row's role can be raised later by any route that edits users, at
  // which point the directory identity silently inherits the raise.
  //
  // ⛔ AND THERE IS NO "LINK THESE TWO" ACTION, BY POLICY (decided 2026-11-05):
  // a local account must not use a directory email address at all. So this is
  // not a migration step waiting for a UI — it is a configuration error with
  // exactly one correct fix, and the message says which. An earlier draft of
  // this reason told the operator to "link the two in Settings → Users", which
  // described a feature that does not exist and never will.
  //
  // Note `users.email` is UNIQUE, so the two rows cannot coexist in any case:
  // refusing is not one option among several, it is the only reachable
  // behaviour. What the policy settles is who has to move — the local account.
  if (byEmail) {
    return {
      outcome: OUTCOME.EMAIL_COLLISION,
      reason:
        'A local hub account already uses this email address. A local account must not use a ' +
        'directory address — remove it, or change its address, and this person will be ' +
        'provisioned from the directory on their next sign-in.',
    }
  }

  // ── provision ────────────────────────────────────────────────────────────
  if (!DIRECTORY_PROVISIONABLE_ROLES.includes(role)) {
    return { outcome: OUTCOME.ROLE_UNSUPPORTED, reason: roleRefusalReason(role) }
  }

  return {
    outcome: OUTCOME.CREATE,
    reason: `No hub account exists for this directory identity; creating one as ${role}.`,
    create: {
      email,
      // A display name is cosmetic, so it degrades rather than refusing. The
      // local part of the email beats an empty header on every satellite.
      name: (typeof claims?.name === 'string' && claims.name.trim()) || email.split('@')[0],
      role,
      entra_oid: oid,
    },
  }
}

function roleRefusalReason(role: Role): string {
  if (role === 'site_admin') {
    return (
      'This account resolved to the site_admin role, which the hub cannot represent for a ' +
      'directory account: a site administrator\'s visible sites come from per-user site ' +
      'assignments, and a directory account has none — it would sign in successfully and see ' +
      'no sites at all. Map the group to admin or viewer, or give this person a local account ' +
      'with site assignments.'
    )
  }
  return `The role ${role} cannot be assigned to a directory account.`
}

// ─── the local-password path ─────────────────────────────────────────────────

/**
 * May this row be authenticated with a password?
 *
 * ⛔ THIS GUARD EXISTS BECAUSE bcryptjs THROWS RATHER THAN RETURNING false.
 * Measured: `bcrypt.compare('x', null)` rejects with
 * `Illegal arguments: string, object`. NetVault's authorize() calls
 * `bcrypt.compare(credentials.password, user.password_hash)` with no guard, and
 * `users.password_hash` is nullable — so a directory-only account typing a
 * password into the hub's form produces a thrown exception and an opaque error,
 * instead of the ordinary "invalid credentials" every other wrong attempt gets.
 *
 * ⛔ IT MUST ALSO NOT BECOME AN ACCOUNT ORACLE. The caller returns the SAME
 * generic failure it returns for a wrong password; this function only decides
 * whether to attempt the comparison at all, never what the user is told.
 */
export function canUsePassword(row: { password_hash?: string | null } | null | undefined): boolean {
  return typeof row?.password_hash === 'string' && row.password_hash.length > 0
}

/**
 * Is this a directory-backed account?
 *
 * ⛔ DECIDED ON `auth_provider`, NEVER ON THE SHAPE OF ANYTHING. SecVault's
 * Phase 0 was a live fail-open created by exactly that mistake: `deviceScope.js`
 * decided whether an account could be scoped from whether its id LOOKED like a
 * local UUID, and an Entra `oid` is a GUID that passed the test — so a
 * directory account was read as local, found to have no scope rows, and handed
 * the whole fleet silently. Provenance is not a property you can read off a
 * value's format.
 *
 * ⛔ An unrecognised provider is NOT local. A row whose provider we cannot
 * classify must not fall into the password path by default.
 */
export function isDirectoryAccount(row: { auth_provider?: string | null } | null | undefined): boolean {
  return (row?.auth_provider || 'local') !== 'local'
}

/**
 * Must this account satisfy the hub's role-MFA policy?
 *
 * ⛔ NO, FOR A DIRECTORY ACCOUNT, AND LEAVING THIS OUT WOULD LOCK THEM ALL OUT.
 * `mfaGate.mfaRequiredForRole()` refuses an account whose role is listed in
 * `app_settings.mfa_required_roles` and which has not enrolled locally. A
 * directory account has no local TOTP secret and cannot enrol one, so the day
 * someone adds `super_admin` to that policy, every directory super_admin stops
 * being able to sign in — with the login form reporting nothing more specific
 * than a failure.
 *
 * Their second factor belongs in the directory that owns the identity, where
 * Conditional Access enforces it better than a hand-rolled TOTP. This is the
 * same call SecVault makes for both LDAP and Entra accounts.
 */
export function mfaPolicyApplies(
  row: { auth_provider?: string | null } | null | undefined,
): boolean {
  return !isDirectoryAccount(row)
}
