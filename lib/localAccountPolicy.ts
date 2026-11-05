//
// lib/localAccountPolicy.ts — what a LOCAL hub account may be created or edited
// as, when the email address it was given may already belong to somebody.
//
// ⛔ THIS IS THE SECOND HALF OF ONE POLICY, AND THE FIRST HALF IS ALREADY
// SHIPPED. `lib/directoryUser.ts`'s `decideDirectoryUser` refuses a DIRECTORY
// sign-in whose email a LOCAL account already holds (OUTCOME.EMAIL_COLLISION),
// because linking on email would mean whoever obtains a directory account
// bearing that address inherits the local account's role — and a UPN is a
// mutable attribute a tenant administrator can change.
//
// The policy the product owner decided (2026-11-05) is symmetric:
//
//     A LOCAL HUB ACCOUNT MUST NOT USE AN ENTRA DIRECTORY EMAIL ADDRESS.
//
// With only the directory half enforced, the two halves disagree in a way that
// is invisible until it is somebody else's problem: an administrator creates a
// local account on an address a directory user owns, nothing complains, and the
// refusal arrives weeks later at the directory user's sign-in — with the cause
// in a server log rather than in front of the person who typed the address.
// This module moves that refusal to the moment of typing.
//
// ⛔ WHAT IS MISSING IS THE *REASON*, NOT THE REFUSAL. `users.email` is UNIQUE,
// so the two rows can never coexist: without this guard the create path still
// fails, as a generic "email already exists" that does not say the address
// belongs to the directory, and the edit path fails as a 500 from the constraint
// itself. Nothing here makes the database stricter; it makes the answer true.
//
// ⛔ WHY THIS IS A FUNCTION AND NOT THREE `if`s. The same comparison inlined in
// the create route, the edit route and the next write path to be added is how
// three copies drift — CLAUDE.md records the site-scope check that was fixed one
// route at a time over a week for exactly that reason. The decision lives here
// once; the routes supply the row and render the answer.
//
// This module is PURE. It takes the candidate email and whatever the database
// said about the row holding it, and returns a decision. It opens no connection
// and performs no I/O, so every branch below is reachable from a test. The
// lookup it is paired with is `lib/directoryStore.ts`'s `findUserByEmail`, which
// matches case-insensitively (`LOWER(email) = LOWER($1)`) — see below for why
// that matters here.

import { isDirectoryAccount } from './directoryUser.ts'

/**
 * Every way the email check can end.
 *
 * ⛔ EVERY MEMBER IS RETURNED BY SOME INPUT and a test proves it — a state
 * nothing can reach invites the next reader to branch on a value that never
 * arrives, which is a guard that cannot fire.
 */
export const LOCAL_EMAIL_OUTCOME = {
  /** Nobody else holds this address (or the holder IS this row). Proceed. */
  OK: 'ok',
  /** A directory account holds it. Refused — this is the policy. */
  DIRECTORY_HOLDS_EMAIL: 'directory_holds_email',
  /** Another LOCAL account holds it. Refused, with a cause instead of a 500. */
  LOCAL_HOLDS_EMAIL: 'local_holds_email',
  /** No address was supplied, so there is nothing to judge. */
  EMAIL_MISSING: 'email_missing',
} as const
export type LocalEmailOutcome = (typeof LOCAL_EMAIL_OUTCOME)[keyof typeof LOCAL_EMAIL_OUTCOME]

/** The row the database says holds this email, as `findUserByEmail` returns it. */
export type EmailHolderRow = {
  id: number
  email: string
  role?: string
  auth_provider?: string | null
}

export type LocalEmailDecision = {
  outcome: LocalEmailOutcome
  /** May the write proceed? Derived from the outcome, never set independently. */
  allowed: boolean
  /**
   * The status the route answers with on a refusal.
   *
   * ⛔ A COLLISION IS 409, NOT 400. The request is well formed — it conflicts
   * with existing state, and the administrator who sent it did nothing wrong
   * except choose an address that is already spoken for. 400 would say they
   * mistyped. The status lives in the decision so three routes cannot each pick
   * their own.
   */
  status: 200 | 400 | 409
  /** The request field at fault, so a form can mark it rather than just alert. */
  field: 'email'
  /** Operator-facing and safe to return in a response body. Never a secret. */
  reason: string
}

/**
 * ⛔ THE REFUSAL MUST NOT TELL ANYONE TO LINK THE ACCOUNTS. There is no such
 * action in this product and none is planned — `decideDirectoryUser` carries the
 * same warning, because an earlier draft of its reason pointed operators at a
 * "link the two in Settings → Users" feature that never existed. The only
 * correct outcome is that this person signs in with their directory account, so
 * the message says that, and says what to do if their permissions are wrong
 * (the role comes from the group mapping, not from this form).
 */
const DIRECTORY_REFUSAL =
  'That email address belongs to a directory (Entra ID) account, so a local hub account ' +
  'cannot use it. This person signs in with their directory account instead — if the ' +
  'permissions they get are wrong, change the hub role mapped to their directory group. ' +
  'If a separate local account is genuinely wanted, give it a different email address.'

/**
 * A plain duplicate between two LOCAL accounts.
 *
 * ⛔ HANDLED HERE RATHER THAN LEFT TO THE UNIQUE CONSTRAINT, and the reason is
 * the edit path. The create route already pre-checked for a duplicate and
 * answered 409; the edit route never did, so renaming one account onto another's
 * address reached the constraint and surfaced as a 500 with nothing an
 * administrator could act on. The lookup this decision needs has already
 * happened by the time we are here, so answering both cases costs one extra
 * branch and removes a 500.
 */
const LOCAL_REFUSAL =
  'Another local hub account already uses that email address. Give this account a ' +
  'different address, or edit the existing account instead.'

const MISSING_REFUSAL =
  'An email address is required. Every hub account stores one, and all four suite apps ' +
  'display it.'

/**
 * Decide whether a local account may be written with this email address.
 *
 * @param candidateEmail the address from the request body — never from a token
 * @param holder         the row `findUserByEmail(candidateEmail)` returned, or null
 * @param rowId          on an EDIT, the id of the row being edited; omitted on a create
 *
 * ⛔ THE CANDIDATE EMAIL IS NOT RE-COMPARED AGAINST `holder.email`, AND A GUARD
 * THAT DOES SO MUST NOT BE ADDED. `findUserByEmail` matches with `LOWER()` on
 * both sides, precisely so a directory UPN in a different case still finds the
 * row; a `holder.email === email` precondition here would silently un-refuse
 * exactly the collision this exists for, and would do it for the inputs least
 * likely to appear in a hand-written test. The holder is authoritative: if a row
 * came back, that row holds this address.
 */
export function decideLocalAccountEmail(
  candidateEmail: unknown,
  holder: EmailHolderRow | null | undefined,
  rowId?: unknown,
): LocalEmailDecision {
  const email = typeof candidateEmail === 'string' ? candidateEmail.trim() : ''

  // Nothing to judge. The create route already answers 400 for a missing field
  // before it gets here; the edit route did not, and used to write a NULL into a
  // NOT NULL column instead — so this branch is reachable and worth keeping.
  if (!email) {
    return refuse(LOCAL_EMAIL_OUTCOME.EMAIL_MISSING, 400, MISSING_REFUSAL)
  }

  if (!holder) return permit()

  // ⛔ THE SAME ROW IS NOT A COLLISION, AND THIS IS THE OBVIOUS OFF-BY-ONE HERE.
  // Every edit that does not change the email finds its OWN row by that email —
  // including a directory account's own record. Without this the Users form
  // would refuse to save any existing account at all, which is a far louder bug
  // than the one being fixed, and it would arrive the first time an
  // administrator corrected a typo in somebody's name.
  if (sameRow(holder.id, rowId)) return permit()

  // ⛔ PROVENANCE IS DECIDED ON `auth_provider` BY THE SHARED HELPER, never
  // re-derived here. `isDirectoryAccount` also treats an UNRECOGNISED provider
  // as not-local, which is the fail-closed direction: a row we cannot classify
  // must not fall into the weaker "just a duplicate" message.
  if (isDirectoryAccount(holder)) {
    return refuse(LOCAL_EMAIL_OUTCOME.DIRECTORY_HOLDS_EMAIL, 409, DIRECTORY_REFUSAL)
  }

  return refuse(LOCAL_EMAIL_OUTCOME.LOCAL_HOLDS_EMAIL, 409, LOCAL_REFUSAL)
}

/**
 * Is the row holding this email the very row being edited?
 *
 * ⛔ A ROW ID THAT CANNOT BE READ AS ONE IS NOT A MATCH. The edit route's `id`
 * arrives as a path string, so it is parsed — but an unparseable id must fall
 * through to the collision refusal rather than quietly satisfying the
 * "it's my own row" exemption, which is the one way to turn this guard off from
 * outside. A create passes no id at all and must never match anything.
 */
export function sameRow(holderId: unknown, rowId: unknown): boolean {
  const a = toRowId(holderId)
  const b = toRowId(rowId)
  return a !== null && b !== null && a === b
}

function toRowId(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

function permit(): LocalEmailDecision {
  return {
    outcome: LOCAL_EMAIL_OUTCOME.OK,
    allowed: true,
    status: 200,
    field: 'email',
    reason: 'No other hub account holds this email address.',
  }
}

function refuse(outcome: LocalEmailOutcome, status: 400 | 409, reason: string): LocalEmailDecision {
  return { outcome, allowed: false, status, field: 'email', reason }
}

// ─── editing a DIRECTORY account from the Users page ─────────────────────────
//
// ⛔ THIS CLOSES A REAL HOLE, NOT A TIDINESS PROBLEM. `PUT /api/users/[id]`
// writes `password_hash` whenever the body carries a `password`, with no regard
// for whose row it is. Nothing in the schema forbids a hash on an `entra` row,
// and the moment one exists `canUsePassword()` (lib/directoryUser.ts) returns
// true — so an administrator could, without meaning to, create a local password
// path for a directory identity. That is the exact bypass the whole design
// refuses: a directory account's credential belongs to the directory, which is
// where the customer's MFA and conditional access live.
//
// ⛔ AND IT IS NOT A BLANKET REFUSAL OF THE PUT, DELIBERATELY. `user_apps` and
// `user_sites` are hub-owned data the directory cannot supply, and this route is
// the ONLY way to set them. Refusing the whole request would make a directory
// account unmanageable — removing a capability to fix a hole, which is a
// regression wearing a fix's clothes. So the restriction is per FIELD.

export const DIRECTORY_EDIT_OUTCOME = {
  /** Nothing in this request is forbidden for this row. */
  OK: 'ok',
  /** A local password would create a credential path for a directory identity. */
  PASSWORD_FORBIDDEN: 'password_forbidden',
  /** The role comes from the group mapping and would be silently overwritten. */
  ROLE_FORBIDDEN: 'role_forbidden',
  /** The address comes from the directory; editing it diverges or locks out. */
  EMAIL_FORBIDDEN: 'email_forbidden',
} as const
export type DirectoryEditOutcome =
  (typeof DIRECTORY_EDIT_OUTCOME)[keyof typeof DIRECTORY_EDIT_OUTCOME]

export type DirectoryEditDecision = {
  outcome: DirectoryEditOutcome
  allowed: boolean
  status: 200 | 409
  /** Which request field is at fault, so a form can mark it. */
  field: 'password' | 'role' | 'email' | null
  reason: string
}

/** The target row as the route already selects it. */
export type EditTargetRow = {
  email?: string | null
  role?: string | null
  auth_provider?: string | null
}

/** What the request is asking to change. */
export type EditRequest = {
  email?: unknown
  role?: unknown
  password?: unknown
}

function forbid(
  outcome: DirectoryEditOutcome,
  field: 'password' | 'role' | 'email',
  reason: string,
): DirectoryEditDecision {
  return { outcome, allowed: false, status: 409, field, reason }
}

/**
 * May this request edit this row?
 *
 * ⛔ CHECKED IN SEVERITY ORDER, AND THE PASSWORD COMES FIRST. A request that
 * changes several forbidden fields at once must name the most dangerous one,
 * because that is the sentence the administrator will read and act on.
 *
 * ⛔ A CHANGE IS COMPARED, NOT MERELY SUPPLIED — except for the password. The
 * Users form posts every field on every save, so refusing any request that
 * merely CONTAINS `email` or `role` would make a directory account's name and
 * app access unsavable, which is the blanket refusal this function exists to
 * avoid. A password is different: there is no "unchanged password" to compare
 * against, so any non-empty password at all is the thing being refused.
 */
export function decideDirectoryAccountEdit(
  target: EditTargetRow | null | undefined,
  request: EditRequest,
): DirectoryEditDecision {
  const ok: DirectoryEditDecision = {
    outcome: DIRECTORY_EDIT_OUTCOME.OK,
    allowed: true,
    status: 200,
    field: null,
    reason: '',
  }
  // ⛔ Provenance from the shared helper, never a second `auth_provider`
  // comparison — and an UNRECOGNISED provider counts as a directory account, so
  // a row this code cannot classify gets the stricter treatment rather than the
  // looser one. A missing target is left to the route's own 404/no-op handling;
  // this function refuses nothing it cannot see.
  if (!target || !isDirectoryAccount(target)) return ok

  if (typeof request.password === 'string' && request.password !== '') {
    return forbid(
      DIRECTORY_EDIT_OUTCOME.PASSWORD_FORBIDDEN,
      'password',
      'This account signs in through your directory, so it cannot be given a password here. ' +
        'Its credentials and any second factor are managed in the directory.',
    )
  }

  const wantsRole = typeof request.role === 'string' && request.role !== ''
  if (wantsRole && request.role !== (target.role || '')) {
    return forbid(
      DIRECTORY_EDIT_OUTCOME.ROLE_FORBIDDEN,
      'role',
      "This account's role comes from its directory group, and is re-read every time it " +
        'signs in — a role set here would be overwritten without warning. Change the group ' +
        'mapping in Settings → Single sign-on instead.',
    )
  }

  const wantsEmail = typeof request.email === 'string' && request.email.trim() !== ''
  if (wantsEmail) {
    const next = String(request.email).trim().toLowerCase()
    const now = String(target.email || '').trim().toLowerCase()
    // Case-folded, matching findUserByEmail — otherwise merely re-casing an
    // address would read as a change and be refused.
    if (next !== now) {
      return forbid(
        DIRECTORY_EDIT_OUTCOME.EMAIL_FORBIDDEN,
        'email',
        "This account's address comes from your directory. Changing it here would leave the " +
          'hub disagreeing with the directory, and pointing it at an address another account ' +
          'holds would lock this person out. Change it in the directory instead.',
      )
    }
  }

  return ok
}
