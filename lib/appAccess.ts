import { query } from '@/lib/db'

export const ALL_APPS = ['netvault', 'logvault', 'ddivault', 'spanvault'] as const

/**
 * Resolve the list of suite apps a user can access.
 * - super_admin  → always all apps
 * - no user_apps rows → all apps (legacy / default-all)
 * - otherwise → the explicit set stored in user_apps
 * Fails CLOSED on any DB error (returns no extra apps) so a transient
 * error never grants access an explicit deny would have blocked.
 */
export async function getUserApps(userId: string | number, role: string): Promise<string[]> {
  if (role === 'super_admin') return [...ALL_APPS]
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
