//
// lib/localIdentity.ts — re-reading a LOCAL account's privileges mid-session.
//
// ⛔ THE COMMENT IN THE JWT CALLBACK USED TO CLAIM THIS EXISTED AND IT DID NOT.
// `[...nextauth]`'s `jwt` callback set `token.role` only inside `if (user)` —
// i.e. once, at sign-in — and re-resolved on every later token use ONLY for a
// directory account. The sentence beside it said local users "are re-read from
// `users` on every token use", which was simply false. The consequences were
// not theoretical:
//
//   - a demotion or a deletion took up to the JWT's whole lifetime to apply,
//     and nothing invalidated a token on either event;
//   - the hub's own routes read `session.user.role` straight off that token;
//   - `getUserApps` used to answer "all four apps" for `super_admin` WITHOUT
//     querying `user_apps`, so a stale `super_admin` role minted satellite
//     tokens for apps an explicit deny had already taken away.
//
// This module is the missing half: the local equivalent of
// `reresolveDirectoryRole`, with the same shape and the same "a privilege is
// re-read, never remembered" rule.
//
// ⛔ IT RUNS ON EVERY TOKEN USE, SO IT HAS TO BE CHEAP AND IT MUST NOT BE ABLE
// TO WEDGE THE HUB. Two deliberate choices make that true:
//
//   1. A SHORT PER-PROCESS MEMO (see `LOCAL_IDENTITY_TTL_MS`). One page load is
//      many requests; without it this would be two queries per request per
//      user. The staleness it buys is seconds, against the 30 days the bug it
//      replaces allowed.
//   2. A FAILED READ CHANGES NOTHING (`read: false`). This is the one place
//      this suite does NOT fail closed, and the reasoning is stated rather than
//      assumed: the read that failed is `SELECT ... FROM users`, so a failure
//      here means the hub's own database is unreachable — every page is already
//      500ing — and clearing the role of every live session on a pool blip
//      would turn a database hiccup into a sign-out of the whole product,
//      including the operator trying to diagnose it. The privilege is still
//      BOUNDED, by `session.maxAge` in `[...nextauth]`, and the memo is not
//      written on a failure so the very next request retries. Compare
//      `reresolveDirectoryRole`, which fails CLOSED because the read that fails
//      there is a small MAPPING table — a configuration-shaped fault that says
//      nothing about whether the rest of the hub is healthy.

import { query } from '@/lib/db'
import { getUserApps } from '@/lib/appAccess'

export type LocalIdentityReading = {
  /**
   * Whether `users` could be read at all.
   *
   * ⛔ `false` IS NOT "NO SUCH USER". The caller must leave the token exactly
   * as it found it; collapsing the two is how a database blip becomes either a
   * mass sign-out or a kept privilege, depending which way you collapse it.
   */
  read: boolean
  /** `null` with `read: true` means the row is GONE — the account was deleted. */
  role: string | null
  /** `null` only when `read` is false. */
  apps: string[] | null
}

/**
 * How long one answer is reused inside this process.
 *
 * ⛔ SECONDS, NOT MINUTES. This is the upper bound on how long a revoked
 * privilege keeps working, so it is chosen to be shorter than the time it takes
 * an operator to switch windows and check.
 */
export const LOCAL_IDENTITY_TTL_MS = 15_000

/** A per-process cap, so a large user base cannot grow this without bound. */
const MAX_CACHE_ENTRIES = 500

const cache = new Map<number, { at: number; value: LocalIdentityReading }>()

/** For tests, and for anything that has just changed a user's row. */
export function clearLocalIdentityCache(userId?: string | number): void {
  if (userId === undefined) { cache.clear(); return }
  const id = normalizeId(userId)
  if (id !== null) cache.delete(id)
}

function normalizeId(userId: string | number | null | undefined): number | null {
  if (userId === null || userId === undefined) return null
  const n = typeof userId === 'string' ? Number.parseInt(userId, 10) : userId
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * Read a local account's CURRENT role and app set, uncached.
 *
 * ⛔ THE ROLE COMES FROM `users`, THE APPS FROM `getUserApps`. Re-deriving the
 * app set here would be a second implementation of the "no rows means all
 * apps" asymmetry documented in lib/appAccess.ts, and two copies of that rule
 * is how one of them ends up fail-open.
 */
export async function readLocalIdentity(userId: string | number): Promise<LocalIdentityReading> {
  const id = normalizeId(userId)
  // ⛔ AN UNUSABLE ID IS A READ FAILURE, NOT A DELETED USER. A token with no
  // `id` at all (or a non-numeric one) is a token this build cannot check; that
  // is "we could not ask", and querying for NaN would answer "no such row" and
  // clear a role on the strength of a malformed token.
  if (id === null) return { read: false, role: null, apps: null }
  let role: string | null
  try {
    const res = await query('SELECT role FROM users WHERE id = $1', [id])
    if (res.rows.length === 0) {
      // ⛔ A REAL ANSWER: the account is gone. The caller clears the role, and
      // every role check in the hub then refuses this token.
      return { read: true, role: null, apps: [] }
    }
    const raw = res.rows[0]?.role
    role = typeof raw === 'string' && raw.trim() !== '' ? raw : null
  } catch {
    return { read: false, role: null, apps: null }
  }
  // getUserApps owns its own fail-closed behaviour (`[]`), so a failure there
  // narrows the app set rather than widening it, and does not make this a
  // failed read: the ROLE was read successfully and must still be applied.
  const apps = await getUserApps(id, role ?? undefined)
  return { read: true, role, apps }
}

/**
 * The memoized form — what the `jwt` callback calls.
 *
 * ⛔ ONLY A SUCCESSFUL READ IS CACHED. Caching a failure would extend a
 * database blip into a window in which nobody's privileges are re-checked at
 * all, which is the bug this module exists to close, just shorter.
 */
export async function resolveLocalIdentity(userId: string | number): Promise<LocalIdentityReading> {
  const id = normalizeId(userId)
  if (id === null) return { read: false, role: null, apps: null }
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < LOCAL_IDENTITY_TTL_MS) return hit.value
  const value = await readLocalIdentity(id)
  if (value.read) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      // Oldest insertion first — Map preserves it, and an exact LRU is not
      // worth a second data structure for a cache this short-lived.
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(id, { at: Date.now(), value })
  }
  return value
}
