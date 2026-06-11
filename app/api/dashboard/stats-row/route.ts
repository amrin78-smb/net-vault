import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

async function safeCount(sql: string): Promise<number> {
  try {
    const res = await query(sql)
    return parseInt(res.rows[0]?.n ?? '0') || 0
  } catch (err) {
    console.error('[dashboard/stats-row] query failed:', err)
    return 0
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []

    const vFilter = isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''
    const circuitFilter = isSiteAdmin && siteIds.length ? `AND site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''
    const circuitWhere = isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

    const [total_devices, total_sites, wan_circuits, main_links, isp_providers] = await Promise.all([
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat ${vFilter}`),
      isSiteAdmin && siteIds.length
        ? Promise.resolve(siteIds.length)
        : safeCount(`SELECT COUNT(*) AS n FROM sites`),
      safeCount(`SELECT COUNT(*) AS n FROM circuits ${circuitWhere}`),
      safeCount(`SELECT COUNT(*) AS n FROM circuits WHERE usage ILIKE 'main' ${circuitFilter}`),
      safeCount(`SELECT COUNT(DISTINCT isp) AS n FROM circuits WHERE isp IS NOT NULL AND isp <> '' ${circuitFilter}`),
    ])

    return NextResponse.json({ total_devices, total_sites, wan_circuits, main_links, isp_providers })
  } catch (err) {
    console.error('[dashboard/stats-row GET]', err)
    return NextResponse.json({
      total_devices: 0,
      total_sites: 0,
      wan_circuits: 0,
      main_links: 0,
      isp_providers: 0,
    })
  }
}
