import { query } from '@/lib/db'

export const ALL_APPS = ['netvault', 'logvault', 'ddivault', 'spanvault'] as const

/**
 * Resolve the list of suite apps a user can access.
 * - no `user_apps` rows → all apps (legacy / default-all)
 * - otherwise → the explicit set stored in `user_apps`
 *
 * Fails CLOSED on any DB error (returns no extra apps) so a transient
 * error never grants access an explicit deny would have blocked.
 *
 * ⛔ `role` NO LONGER SHORT-CIRCUITS, AND THAT WAS A REAL HOLE. This function
 * used to answer `[...ALL_APPS]` for `super_admin` BEFORE touching the
 * database, so an explicit `user_apps` deny was never consulted for the one
 * role whose sessions matter most. Combined with a stale `role` on a long-lived
 * JWT, a demoted-and-restricted super_admin kept a satellite token for every
 * app: the SSO handoff read `super_admin` off the token, this function returned
 * all four apps without a query, and the row that said otherwise was never
 * read. The DB is now always asked, so the stored decision always wins.
 *
 * ⛔ THE ASYMMETRY IS LOAD-BEARING AND UNCHANGED. `[]` means "no extra apps"
 * (an explicit deny-all, and the shape a failure has to take); NO ROWS means
 * "all apps" (legacy / default-all, so deploying the feature locks nobody out).
 * Never conflate the two — a query that failed is not a user with no rows.
 *
 * ⛔ `role` IS KEPT IN THE SIGNATURE. Every caller has it, the three SSO
 * handoffs stamp it into the satellite token beside this result, and removing
 * the parameter would be a breaking lib change for no gain. It is simply no
 * longer allowed to decide the answer on its own.
 */
export async function getUserApps(userId: string | number, _role?: string): Promise<string[]> {
  const id = typeof userId === 'string' ? parseInt(userId, 10) : userId
  try {
    const res = await query('SELECT app FROM user_apps WHERE user_id = $1', [id])
    if (res.rows.length === 0) return [...ALL_APPS]
    return res.rows.map((r: any) => r.app)
  } catch {
    // Fail closed — a DB error must not silently grant every app.
    return []
  }
}

/** NetVault is always accessible; otherwise the app must be in the allowed set. */
export function canAccessApp(apps: string[], slug: string): boolean {
  return slug === 'netvault' || apps.includes(slug)
}
