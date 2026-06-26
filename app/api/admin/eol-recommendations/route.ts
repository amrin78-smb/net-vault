import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { ensureEolSchema } from '@/lib/eolEnrich'
import { requireEol } from '@/lib/entitlements'

async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

/**
 * GET /api/admin/eol-recommendations — pending status recommendations, grouped
 * by recommended_status. super_admin only.
 *
 * Response: { ok, should_be_eol: Rec[], possibly_incorrect: Rec[], total_pending }
 *   should_be_eol      = recommended_status = 'EOL / EOS'
 *   possibly_incorrect = recommended_status = 'Active, Supported'
 *
 * Rec = { id, device_id, device_name, model, current_status, recommended_status,
 *   reason, effective_date, days, confidence, source_url }. Day math is done in
 *   SQL (tz-safe): effective_date = COALESCE(seed_eol_date, seed_eos_date)::text,
 *   days = |effective - CURRENT_DATE| (positive magnitude).
 */
export async function GET() {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const res = await query(
      `SELECT r.id, r.device_id, r.device_name, r.model, r.current_status,
              r.recommended_status, r.reason, r.confidence,
              COALESCE(r.seed_eol_date, r.seed_eos_date)::text AS effective_date,
              ABS(COALESCE(r.seed_eol_date, r.seed_eos_date) - CURRENT_DATE)::int AS days,
              s.source_url AS source_url
       FROM eol_recommendations r
       LEFT JOIN eol_seed s ON s.id = r.seed_entry_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC, r.id DESC`
    )

    const rows = res.rows as Array<{ recommended_status: string }>
    const should_be_eol = rows.filter((r) => r.recommended_status === 'EOL / EOS')
    const possibly_incorrect = rows.filter((r) => r.recommended_status === 'Active, Supported')

    return NextResponse.json({
      ok: true,
      should_be_eol,
      possibly_incorrect,
      total_pending: rows.length,
    })
  } catch (err) {
    console.error('[admin/eol-recommendations GET]', err)
    return NextResponse.json({ error: 'Failed to load recommendations' }, { status: 500 })
  }
}
