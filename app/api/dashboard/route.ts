import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string; siteIds?: number[] }

  const isSiteAdmin = sessionUser.role === 'site_admin'
  const siteIds = sessionUser.siteIds || []
  const siteFilter = isSiteAdmin && siteIds.length ? `AND site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''
  const vFilter = isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

  const [summary, byRegion, byType, topEol, recentActivity, circuitStats] = await Promise.all([
    query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE device_status = 'Active') as active,
        COUNT(*) FILTER (WHERE device_status = 'Decommed') as decommed,
        COUNT(*) FILTER (WHERE device_status = 'Spare') as spare,
        COUNT(*) FILTER (WHERE lifecycle_status = 'EOL / EOS') as eol,
        COUNT(*) FILTER (WHERE lifecycle_status = 'Active, Supported') as supported,
        COUNT(*) FILTER (WHERE lifecycle_status = 'Unknown') as unknown_lifecycle
      FROM v_devices_flat ${vFilter}
    `),
    query(`
      SELECT region,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE lifecycle_status = 'EOL / EOS') as eol_count
      FROM v_devices_flat ${vFilter}
      WHERE region IS NOT NULL ${siteFilter ? 'AND site_id = ANY(ARRAY[' + siteIds.join(',') + '])' : ''}
      GROUP BY region ORDER BY total DESC
    `),
    query(`
      SELECT device_type, COUNT(*) as total
      FROM v_devices_flat ${vFilter}
      WHERE device_type IS NOT NULL ${siteFilter ? 'AND site_id = ANY(ARRAY[' + siteIds.join(',') + '])' : ''}
      GROUP BY device_type ORDER BY total DESC LIMIT 8
    `),
    query(`
      SELECT site, country, region,
        COUNT(*) FILTER (WHERE lifecycle_status = 'EOL / EOS') as eol_count,
        COUNT(*) as total_count
      FROM v_devices_flat
      WHERE lifecycle_status = 'EOL / EOS' ${siteFilter}
      GROUP BY site, country, region
      ORDER BY eol_count DESC LIMIT 8
    `),
    query(`
      SELECT a.field_name, a.changed_at,
             u.name as changed_by_name,
             d.name as device_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
      LEFT JOIN devices d ON d.id = a.device_id
      ${isSiteAdmin && siteIds.length ? `WHERE d.site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''}
      ORDER BY a.changed_at DESC LIMIT 6
    `),
    query(`
      SELECT
        COUNT(*) as total_circuits,
        COUNT(*) FILTER (WHERE usage ILIKE 'main') as main_circuits,
        COUNT(*) FILTER (WHERE usage ILIKE 'backup') as backup_circuits,
        COUNT(DISTINCT site_id) as sites_with_circuits,
        COALESCE(SUM(cost_month) FILTER (WHERE currency = 'THB'), 0) as total_cost_thb,
        COALESCE(SUM(cost_month) FILTER (WHERE currency = 'USD'), 0) as total_cost_usd,
        COALESCE(SUM(cost_month) FILTER (WHERE currency = 'EUR'), 0) as total_cost_eur,
        COUNT(DISTINCT isp) as total_isps,
        COUNT(*) FILTER (WHERE pingable = 'Yes') as pingable_count
      FROM circuits
      ${isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''}
    `),
  ])

  return NextResponse.json({
    summary: summary.rows[0],
    byRegion: byRegion.rows,
    byType: byType.rows,
    topEol: topEol.rows,
    recentActivity: recentActivity.rows,
    circuitStats: circuitStats.rows[0],
  })
}
