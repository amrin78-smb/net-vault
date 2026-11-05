//
// lib/directoryStore.ts — the database half of directory sign-in.
//
// The judgements live in the two pure modules beside this one
// (lib/directoryRoles.ts decides the role, lib/directoryUser.ts decides what
// the row may become). This file only fetches and writes, so that those
// decisions stay testable without a database.
//
// ⛔ ONE RULE GOVERNS THIS WHOLE FILE: A FAILED READ MUST NOT LOOK LIKE AN
// ANSWER. Every function here either returns real data or throws. None of them
// returns an empty array, a null row or a `false` to paper over a database
// error, because on this path those values are INSTRUCTIONS:
//
//   loadDirectoryMappings() -> []      means "nobody may sign in"
//   findUserByEntraOid()    -> null    means "provision a new account"
//
// Returning either of those for a connection blip would turn a transient fault
// into a silent authorization decision — in the first case locking everyone
// out, in the second creating a duplicate account for someone who already has
// one.

import { query } from './db.ts'
import type { Mapping } from './directoryRoles.ts'
import type { Role } from './directoryUser.ts'

export type DirectoryUserRow = {
  id: number
  name: string
  email: string
  role: string
  auth_provider: string
  entra_oid: string | null
  password_hash: string | null
}

/** The columns every lookup here selects. Kept in one place so they cannot drift. */
const USER_COLS = 'id, name, email, role, auth_provider, entra_oid, password_hash'

/**
 * Load the group -> role mappings.
 *
 * ⛔ THROWS ON FAILURE. IT MUST NEVER RETURN `[]`. An empty array is the
 * instruction "no group is mapped, so refuse every directory sign-in"
 * (lib/directoryRoles.ts, OUTCOME.NO_MAPPINGS) — a deliberate, correct,
 * fail-closed state. Catching a database error here and returning `[]` would
 * make a dropped connection indistinguishable from that state, and the caller
 * would report a configuration problem to an administrator whose configuration
 * is fine.
 *
 * The caller turns a throw into OUTCOME.MAPPINGS_UNREADABLE, which says plainly
 * that the fault is ours.
 */
export async function loadDirectoryMappings(provider = 'entra'): Promise<Mapping[]> {
  const res = await query(
    `SELECT group_key, role, display_name
       FROM directory_role_mappings
      WHERE provider = $1`,
    [provider],
  )
  // ⛔ No try/catch, by design — see above. If `query` throws, it propagates.
  return res.rows.map((r: any) => ({
    group_key: r.group_key,
    role: r.role,
    display_name: r.display_name,
  }))
}

/**
 * Find the account linked to this directory object id.
 *
 * ⛔ `null` MEANS "no such row", AND ONLY THAT. A throw propagates, because the
 * caller reads `null` as "provision a new account" — so swallowing an error here
 * would create a second account for a person who already has one, with the
 * first one's app access and site assignments left behind on the orphan.
 */
export async function findUserByEntraOid(oid: string): Promise<DirectoryUserRow | null> {
  const res = await query(`SELECT ${USER_COLS} FROM users WHERE entra_oid = $1`, [oid])
  return res.rows[0] || null
}

/**
 * Find the account holding this email.
 *
 * ⛔ CASE-INSENSITIVE, because `users.email` is UNIQUE but not case-folded, and
 * a directory can hand back a UPN in any case. A case-sensitive lookup would
 * miss the collision this is here to detect and then hit the UNIQUE constraint
 * on the INSERT instead — turning a refusal with a clear cause into a 500.
 */
export async function findUserByEmail(email: string): Promise<DirectoryUserRow | null> {
  const res = await query(`SELECT ${USER_COLS} FROM users WHERE LOWER(email) = LOWER($1)`, [email])
  return res.rows[0] || null
}

/**
 * Create the account for a directory identity.
 *
 * ⛔ `password_hash` IS LEFT NULL, DELIBERATELY. There is no password to set and
 * inventing one (even a random unguessable one) would create a credential
 * nobody holds and nobody can rotate, on an account that is supposed to have no
 * local password path at all. `lib/directoryUser.ts`'s `canUsePassword()` is
 * what keeps the login form from ever calling bcrypt against this row.
 *
 * ⛔ `ON CONFLICT ... DO NOTHING` + a re-read, NOT a bare INSERT. Two browser
 * tabs completing a first sign-in at once both see no row and both insert; the
 * loser would otherwise get a UNIQUE violation and a failed sign-in on an
 * account that now exists.
 *
 * ⛔ THE CONFLICT TARGET MUST REPEAT THE INDEX PREDICATE —
 * `(entra_oid) WHERE entra_oid IS NOT NULL`, matching `uq_users_entra_oid`
 * exactly. That index is PARTIAL (every local account leaves the column NULL),
 * and PostgreSQL only infers a partial index for conflict resolution when the
 * statement restates its predicate. Without the WHERE this fails at runtime
 * with 42P10, "there is no unique or exclusion constraint matching the ON
 * CONFLICT specification" — and it fails on the FIRST directory sign-in, not at
 * build time. Caught by tests/directoryStore.test.ts, which is the reason that
 * test runs against a real database instead of a mocked pool.
 *
 * ⛔ It does NOT handle an email conflict, and must not. That collision is
 * refused upstream by `decideDirectoryUser` (OUTCOME.EMAIL_COLLISION) because
 * linking a directory identity to a pre-existing local account by email is an
 * account takeover. If one somehow reaches here the UNIQUE constraint on
 * `users.email` rejects it, which is the correct outcome — a failed sign-in, not
 * a silent link.
 */
export async function createDirectoryUser(input: {
  email: string
  name: string
  role: Role
  entra_oid: string
}): Promise<DirectoryUserRow> {
  const res = await query(
    `INSERT INTO users (name, email, role, auth_provider, entra_oid, password_hash)
     VALUES ($1, $2, $3, 'entra', $4, NULL)
     ON CONFLICT (entra_oid) WHERE entra_oid IS NOT NULL DO NOTHING
     RETURNING ${USER_COLS}`,
    [input.name, input.email, input.role, input.entra_oid],
  )
  if (res.rows[0]) return res.rows[0]

  // The conflict path: another request created it microseconds ago.
  const existing = await findUserByEntraOid(input.entra_oid)
  if (existing) return existing
  // ⛔ Neither inserted nor found. Something is wrong that we cannot describe,
  // so it throws rather than returning a fabricated row — a sign-in that fails
  // loudly beats a session built on an account that may not exist.
  throw new Error(
    'The directory account could not be created and could not be found afterwards.',
  )
}

/**
 * Bring a linked account's role into line with the current group mapping.
 *
 * ⛔ THE MAPPING IS AUTHORITATIVE ON EVERY SIGN-IN, NOT ONLY THE FIRST. A role
 * stored on the row would keep working after an administrator removed the
 * mapping that granted it, or after the person was taken out of the group — the
 * row would pin a privilege the directory has already revoked.
 *
 * ⛔ The UPDATE is CONDITIONAL on the row still being a directory account.
 * Without that `AND auth_provider = 'entra'`, a bug upstream that matched a
 * local row could rewrite a local administrator's role from a directory group.
 * The guard makes that impossible in SQL rather than relying on the caller.
 *
 * Returns the number of rows changed so the caller can tell a real refresh from
 * a no-op; zero means the role already agreed, or the row is not a directory
 * account.
 */
export async function refreshDirectoryUserRole(id: number, role: Role): Promise<number> {
  const res = await query(
    `UPDATE users SET role = $2
      WHERE id = $1 AND auth_provider = 'entra' AND role <> $2`,
    [id, role],
  )
  return res.rowCount || 0
}

/**
 * Everything `decideDirectoryUser` needs, in one place.
 *
 * ⛔ BOTH LOOKUPS ALWAYS RUN. It is tempting to skip the email lookup once the
 * oid matched — but that is exactly the ambiguous case
 * (OUTCOME.AMBIGUOUS): a row linked to this directory identity while a
 * DIFFERENT row holds the same email, which happens when someone's UPN is
 * changed in the directory to an address another account already has. Skipping
 * the second query would resolve it as an ordinary match and then collide on the
 * next write of that email.
 */
export async function loadDirectoryContext(
  oid: string,
  email: string,
): Promise<{ byOid: DirectoryUserRow | null; byEmail: DirectoryUserRow | null }> {
  const [byOid, byEmail] = await Promise.all([
    findUserByEntraOid(oid),
    email ? findUserByEmail(email) : Promise.resolve(null),
  ])
  return { byOid, byEmail }
}
