import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getServerId, getLicenseStatus } from '@/lib/license'

/**
 * EOL Intelligence is a paid ADD-ON, gated on the `'eol'` license module.
 *
 * Entitled = an ACTIVE (valid, unexpired) license whose `modules` include `'eol'`.
 * Trial / expired / no-key installs are NOT entitled. This reads only
 * `app_settings` and NEVER mutates anything — gating is pure access control, so
 * all EOL data (eol_seed, device EOL dates, recommendations) is left untouched
 * when a feature call is blocked.
 */
export async function hasEolModule(): Promise<boolean> {
  try {
    const result = await query(
      "SELECT key, value FROM app_settings WHERE key IN ('install_date','license_key')"
    )
    const s: Record<string, string> = {}
    for (const row of result.rows) s[row.key] = row.value ?? ''
    const serverId = getServerId()
    const { status, payload } = getLicenseStatus(s['install_date'] ?? '', s['license_key'] ?? '', serverId)
    return status === 'active' && (payload?.modules ?? []).includes('eol')
  } catch {
    return false
  }
}

/**
 * Guard for EOL API routes. Returns a 403 NextResponse when the install is not
 * entitled, else null. Usage at the top of a handler (after auth):
 *   const gate = await requireEol(); if (gate) return gate
 */
export async function requireEol(): Promise<NextResponse | null> {
  if (await hasEolModule()) return null
  return NextResponse.json(
    { error: 'EOL Intelligence is a licensed add-on and is not enabled on this install.', code: 'EOL_NOT_LICENSED' },
    { status: 403 }
  )
}
