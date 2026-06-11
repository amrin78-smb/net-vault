import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const emptyPayload = () => ({
    total: 0,
    segments: [
      { label: 'Healthy', count: 0, pct: 0, color: '#16a34a' },
      { label: 'EOL / EOS', count: 0, pct: 0, color: '#C8102E' },
      { label: 'Decommissioned', count: 0, pct: 0, color: '#f59e0b' },
      { label: 'Spare', count: 0, pct: 0, color: '#94a3b8' },
    ],
    last_updated: new Date().toISOString(),
  })

  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []
    const vFilter = isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

    let decommissioned = 0
    let spare = 0
    let eol = 0
    let healthy = 0
    try {
      // Priority bucketing so segments sum to total:
      // Decommed > Spare > EOL/EOS > Healthy
      const res = await query(`
        SELECT
          COUNT(*) FILTER (WHERE device_status = 'Decommed') AS decommed,
          COUNT(*) FILTER (WHERE device_status <> 'Decommed' AND device_status = 'Spare') AS spare,
          COUNT(*) FILTER (WHERE device_status <> 'Decommed' AND device_status <> 'Spare' AND lifecycle_status = 'EOL / EOS') AS eol,
          COUNT(*) FILTER (WHERE device_status <> 'Decommed' AND device_status <> 'Spare' AND lifecycle_status <> 'EOL / EOS') AS healthy
        FROM v_devices_flat ${vFilter}
      `)
      const row = res.rows[0] || {}
      decommissioned = parseInt(row.decommed ?? '0') || 0
      spare = parseInt(row.spare ?? '0') || 0
      eol = parseInt(row.eol ?? '0') || 0
      healthy = parseInt(row.healthy ?? '0') || 0
    } catch (err) {
      console.error('[dashboard/fleet-health] query failed:', err)
    }

    const total = healthy + eol + decommissioned + spare
    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)

    return NextResponse.json({
      total,
      segments: [
        { label: 'Healthy', count: healthy, pct: pct(healthy), color: '#16a34a' },
        { label: 'EOL / EOS', count: eol, pct: pct(eol), color: '#C8102E' },
        { label: 'Decommissioned', count: decommissioned, pct: pct(decommissioned), color: '#f59e0b' },
        { label: 'Spare', count: spare, pct: pct(spare), color: '#94a3b8' },
      ],
      last_updated: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[dashboard/fleet-health GET]', err)
    return NextResponse.json(emptyPayload())
  }
}
