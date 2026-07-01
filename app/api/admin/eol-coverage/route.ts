import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { ensureEolSchema } from '@/lib/eolEnrich'
import { requireEol } from '@/lib/entitlements'

// Inline super_admin guard (mirrors /api/admin/eol-seed).
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
 * GET /api/admin/eol-coverage — EOL coverage aggregates. super_admin only.
 *
 * Response: {
 *   inventory: { total, dated, dateless },
 *   datelessByBrand: [{ brand, count }],
 *   seedByVendor: [{ vendor, count, dateless }]
 * }
 */
export async function GET() {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()

    const [inventoryRes, datelessByBrandRes, seedByVendorRes] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE support_end_date IS NOT NULL OR os_eol_date IS NOT NULL)::int AS dated,
                COUNT(*) FILTER (WHERE support_end_date IS NULL AND os_eol_date IS NULL)::int AS dateless
         FROM devices`
      ),
      query(
        `SELECT COALESCE(b.name, '(no brand)') AS brand, COUNT(*)::int AS count
         FROM devices d LEFT JOIN brands b ON b.id = d.brand_id
         WHERE d.support_end_date IS NULL AND d.os_eol_date IS NULL
         GROUP BY b.name
         ORDER BY count DESC`
      ),
      query(
        `SELECT vendor,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE eol_date IS NULL AND eos_date IS NULL)::int AS dateless
         FROM eol_seed
         GROUP BY vendor
         ORDER BY count DESC`
      ),
    ])

    return NextResponse.json({
      inventory: inventoryRes.rows[0],
      datelessByBrand: datelessByBrandRes.rows,
      seedByVendor: seedByVendorRes.rows,
    })
  } catch (err) {
    console.error('[admin/eol-coverage GET]', err)
    return NextResponse.json({ error: 'Failed to load EOL coverage' }, { status: 500 })
  }
}
