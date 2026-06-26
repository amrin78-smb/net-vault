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
 * GET /api/admin/eol-discrepancies — pending discrepancies. super_admin only.
 *
 * Response: { discrepancies: [{ id, device_id, device_name, model, manual_date,
 *   seed_date, difference_days, seed_entry_id, status, created_at,
 *   seed_vendor, seed_model_raw, seed_source_url }] }
 */
export async function GET() {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const res = await query(
      `SELECT dsc.id, dsc.device_id, dsc.device_name, dsc.model, dsc.manual_date,
              dsc.seed_date, dsc.difference_days, dsc.seed_entry_id, dsc.status,
              dsc.created_at,
              s.vendor     AS seed_vendor,
              s.model_raw  AS seed_model_raw,
              s.source_url AS seed_source_url
       FROM eol_discrepancies dsc
       LEFT JOIN eol_seed s ON s.id = dsc.seed_entry_id
       WHERE dsc.status = 'pending'
       ORDER BY dsc.created_at DESC, dsc.id DESC`
    )
    return NextResponse.json({ discrepancies: res.rows })
  } catch (err) {
    console.error('[admin/eol-discrepancies GET]', err)
    return NextResponse.json({ error: 'Failed to load discrepancies' }, { status: 500 })
  }
}
