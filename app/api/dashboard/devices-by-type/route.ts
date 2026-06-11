import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []
    const siteFilter = isSiteAdmin && siteIds.length ? `AND site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

    try {
      const res = await query(`
        SELECT device_type AS type, COUNT(*) AS count
        FROM v_devices_flat
        WHERE device_type IS NOT NULL AND device_status <> 'Decommed' ${siteFilter}
        GROUP BY device_type
        ORDER BY count DESC
        LIMIT 8
      `)
      return NextResponse.json(
        res.rows.map((row) => ({
          type: row.type,
          count: parseInt(row.count ?? '0') || 0,
        }))
      )
    } catch (err) {
      console.error('[dashboard/devices-by-type] query failed:', err)
      return NextResponse.json([])
    }
  } catch (err) {
    console.error('[dashboard/devices-by-type GET]', err)
    return NextResponse.json([])
  }
}
