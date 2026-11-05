//
// lib/directoryRefusals.ts — why a directory sign-in was turned away.
//
// The refusal is deliberately split in two (see the signIn callback): the person
// is told only to ask an administrator, because the login page is reachable
// without authenticating and the cause describes how the customer's directory is
// wired. That split left the ADMINISTRATOR with nothing either — the cause went
// to the Windows service log and the group ids the person presented went
// nowhere. This module is the other half: the same facts, behind super_admin.
//
// Two halves here, for the usual reason: `explainRefusal` is pure and carries
// every judgement about what a cause MEANS, so it is testable without a
// database; the two functions below it only read and write.
//

import { query } from './db.ts'

/**
 * How many refusals are kept.
 *
 * ⛔ THE WRITER TRIMS, AND IT HAS TO. This is the one table in the schema whose
 * row count is driven by a FAILURE LOOP: a directory that is misconfigured
 * refuses every attempt, and a person who cannot get in retries. Nothing in a
 * customer install runs a cleanup job, so a cap that depended on one would be a
 * cap in name only.
 *
 * 50 is enough to see a pattern and small enough that the trim is never the
 * expensive part of a sign-in.
 */
export const DIRECTORY_REFUSAL_KEEP = 50

export type RefusalRow = {
  id: string
  occurred_at: string
  provider: string
  email: string | null
  entra_oid: string | null
  cause: string
  group_keys: string[] | null
}

/**
 * What an administrator should DO about a cause.
 *
 * ⛔ THE POINT IS THE DISTINCTION, NOT THE PROSE. These six causes have six
 * different fixes, and three of them look identical from the login page — the
 * person authenticates at Microsoft and is bounced. SecVault collapsed
 * `mappings_unreadable` into `groups_unreadable` and so told administrators to
 * go and check their app registration while the fault was our own database.
 * Keeping them apart is the whole value of recording anything at all.
 */
export type RefusalAction =
  | 'map-group'       // the group ids are here; map one
  | 'app-registration' // Entra is not sending what we need
  | 'ours'            // our fault, not the customer's
  | 'local-account'   // a local account is in the way
  | 'unknown'

export type RefusalExplanation = {
  code: string
  title: string
  fix: string
  action: RefusalAction
}

/** The outcome code is everything before the first colon; the rest is detail. */
export function refusalCode(cause: string | null | undefined): string {
  if (typeof cause !== 'string') return ''
  const i = cause.indexOf(':')
  return (i === -1 ? cause : cause.slice(0, i)).trim()
}

export function explainRefusal(cause: string | null | undefined): RefusalExplanation {
  const code = refusalCode(cause)
  switch (code) {
    case 'no_matching_group':
      return {
        code,
        title: 'None of this person’s groups is mapped',
        fix: 'Map one of the group ids listed beside this entry to a role below.',
        action: 'map-group',
      }
    case 'no_mappings':
      return {
        code,
        title: 'No group is mapped at all',
        fix: 'The mapping table is empty, so every directory sign-in is refused. Add a mapping below.',
        action: 'map-group',
      }
    case 'groups_unreadable':
      return {
        code,
        title: 'The token carried no group claim',
        fix: 'The Entra app registration is not sending group memberships. Add a groups claim to the ID token in its Token configuration.',
        action: 'app-registration',
      }
    case 'groups_overage':
      return {
        code,
        title: 'This person is in too many groups for Entra to list them',
        fix: 'Microsoft replaced the group list with a link, so the token proves nothing about membership and the sign-in was refused rather than treated as "no groups". Set the app registration to send only groups assigned to the application.',
        action: 'app-registration',
      }
    case 'mappings_unreadable':
      return {
        code,
        title: 'NocVault could not read its own mapping table',
        fix: 'This is our fault, not a directory problem — the hub’s database was unreachable. Nothing needs changing in Entra.',
        action: 'ours',
      }
    case 'email_collision':
      return {
        code,
        title: 'A local account already uses this email address',
        fix: 'A local account must not use a directory address. Remove it, or change its address, and this person will be provisioned on their next sign-in.',
        action: 'local-account',
      }
    case 'role_unsupported':
      return {
        code,
        title: 'The mapped role cannot be granted from a directory',
        fix: 'Only super_admin, admin and viewer can be provisioned from a group. Change the mapping below.',
        action: 'map-group',
      }
    case 'claims_incomplete':
      return {
        code,
        title: 'The token was missing something we need',
        fix: 'The sign-in token carried no usable object id or email address. Check what the app registration sends in the ID token.',
        action: 'app-registration',
      }
    case 'ambiguous':
      return {
        code,
        title: 'Two accounts match this person',
        fix: 'One hub account is already linked to this directory identity while a different one holds the same email address — usually a UPN changed in the directory to an address another account has. Resolve the duplicate on the Users page.',
        action: 'local-account',
      }
    default:
      // ⛔ NOT "unknown error". An unrecognised code is still shown verbatim,
      // because the alternative is an administrator staring at a dead end while
      // the answer sits in a string we chose not to print.
      return {
        code: code || 'unknown',
        title: code ? `Refused: ${code}` : 'Refused for an unrecorded reason',
        fix: 'The full reason is in the NetVault service log.',
        action: 'unknown',
      }
  }
}

/**
 * Record one refusal, and trim the table.
 *
 * ⛔ BEST-EFFORT, AND LOUD — the same contract as recordSystemChanges, and here
 * it matters more. This runs inside NextAuth's signIn callback on a path that
 * has ALREADY DECIDED to refuse. A throw escaping this function would become
 * `/api/auth/error?error=<message>` — the exception text published on an
 * unauthenticated page, which is the one place the cause must never appear.
 * So every failure is caught and logged, and the refusal proceeds unchanged.
 */
export async function recordDirectoryRefusal(input: {
  provider?: string
  email?: string | null
  entraOid?: string | null
  cause: string
  groupKeys?: string[] | null
}): Promise<void> {
  try {
    const groups = Array.isArray(input.groupKeys)
      ? input.groupKeys.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim())
      : null
    await query(
      `INSERT INTO directory_signin_refusals (provider, email, entra_oid, cause, group_keys)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        (input.provider || 'entra').trim(),
        (input.email || '').trim() || null,
        (input.entraOid || '').trim() || null,
        input.cause,
        groups && groups.length ? groups : null,
      ],
    )
    // ⛔ TRIMMED HERE, IN THE SAME CALL PATH THAT GREW IT. Deleting by id keeps
    // this to one index scan; ordering by occurred_at alone would not be
    // deterministic when several refusals share a timestamp, which during a
    // retry loop they will.
    await query(
      `DELETE FROM directory_signin_refusals
        WHERE id <= COALESCE(
          (SELECT id FROM directory_signin_refusals ORDER BY id DESC OFFSET $1 LIMIT 1),
          0)`,
      [DIRECTORY_REFUSAL_KEEP],
    )
  } catch (err) {
    console.error(
      '[directory-refusal] COULD NOT RECORD a refused sign-in — the refusal itself stands, but an administrator will not see it in Settings:',
      err,
    )
  }
}

/** Newest first. Throws on failure: a read error must not look like "none". */
export async function listDirectoryRefusals(limit = DIRECTORY_REFUSAL_KEEP): Promise<RefusalRow[]> {
  const res = await query(
    `SELECT id, occurred_at, provider, email, entra_oid, cause, group_keys
       FROM directory_signin_refusals
      ORDER BY id DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, DIRECTORY_REFUSAL_KEEP))],
  )
  return (res.rows || []) as RefusalRow[]
}
