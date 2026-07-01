import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { requireEol } from '@/lib/entitlements'
import { query } from '@/lib/db'
import { ensureEolSchema } from '@/lib/eolEnrich'

async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { user }
}

/**
 * POST /api/admin/eol-seed/purge-dateless — remove dateless placeholder entries.
 *
 * Dateless seed rows (no eol_date AND no eos_date) carry no EOL data, so they
 * cannot enrich a device — but they DO create false "matches": a device matches
 * the placeholder's normalized key and is counted as matched while nothing is
 * written, which inflates the "matched" metric and masks the true coverage gap.
 * They are created by the "Add all uncovered models to seed" flow. This purges
 * them so matching reflects reality.
 *
 * Feed rows are excluded: they are never dateless today, and a feed sync would
 * just re-add anything it owns, so deleting them here would only churn. This
 * targets the manually/bulk-added dateless placeholders. super_admin only.
 *
 * Response: { ok, deleted }
 */
export async function POST() {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const res = await query(
      `DELETE FROM eol_seed
       WHERE eol_date IS NULL AND eos_date IS NULL AND added_by IS DISTINCT FROM 'feed'
       RETURNING id`
    )
    return NextResponse.json({ ok: true, deleted: res.rowCount ?? 0 })
  } catch (err) {
    console.error('[eol-seed/purge-dateless] failed:', err)
    return NextResponse.json({ error: 'Failed to purge dateless entries' }, { status: 500 })
  }
}
