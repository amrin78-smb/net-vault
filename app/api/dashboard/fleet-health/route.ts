import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

/**
 * Fleet health breakdown for the dashboard donut.
 *
 * Two things were wrong here and both made the dashboard contradict itself on
 * a single screen:
 *
 * 1. "Healthy" meant `device_status <> 'Decommed' AND <> 'Spare'`, which puts
 *    every `Faulty, Replaced` device in the green slice. Broken hardware was
 *    being counted as healthy, and the number disagreed with the hero KPI
 *    right above it (which uses `device_status = 'Active'`).
 * 2. The EOL slice excluded decommissioned and spare devices while the hero's
 *    "EOL Assets" counted every device with an EOL lifecycle, so the two EOL
 *    figures differed too.
 *
 * The buckets below are a strict partition in this precedence:
 *     EOL / EOS  >  Decommed  >  Spare  >  Faulty  >  Healthy
 * EOL first so the EOL slice equals the hero's eol_assets exactly, and
 * "Healthy" now means Active-and-not-EOL — the hero's definition. The segments
 * still sum to the device total.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []
    const vFilter = isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

    const res = await query(`
      SELECT
        COUNT(*) FILTER (WHERE lifecycle_status = 'EOL / EOS') AS eol,
        COUNT(*) FILTER (WHERE lifecycle_status <> 'EOL / EOS' AND device_status = 'Decommed') AS decommed,
        COUNT(*) FILTER (WHERE lifecycle_status <> 'EOL / EOS' AND device_status = 'Spare') AS spare,
        COUNT(*) FILTER (WHERE lifecycle_status <> 'EOL / EOS' AND device_status NOT IN ('Decommed','Spare','Active')) AS faulty,
        COUNT(*) FILTER (WHERE lifecycle_status <> 'EOL / EOS' AND device_status = 'Active') AS healthy
      FROM v_devices_flat ${vFilter}
    `)
    const row = res.rows[0] || {}
    const n = (v: unknown) => parseInt(String(v ?? '0'), 10) || 0
    const eol = n(row.eol)
    const decommissioned = n(row.decommed)
    const spare = n(row.spare)
    const faulty = n(row.faulty)
    const healthy = n(row.healthy)

    const total = healthy + eol + decommissioned + spare + faulty
    const pct = (x: number) => (total > 0 ? Math.round((x / total) * 100) : 0)

    return NextResponse.json({
      total,
      segments: [
        { label: 'Healthy',         count: healthy,         pct: pct(healthy),         color: '#16a34a' },
        { label: 'EOL / EOS',       count: eol,             pct: pct(eol),             color: '#C8102E' },
        { label: 'Faulty',          count: faulty,          pct: pct(faulty),          color: '#ea580c' },
        { label: 'Spare',           count: spare,           pct: pct(spare),           color: '#94a3b8' },
        { label: 'Decommissioned',  count: decommissioned,  pct: pct(decommissioned),  color: '#f59e0b' },
      ],
      last_updated: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[dashboard/fleet-health GET]', err)
    // 503, NOT a zero-filled payload. This used to answer 200 with every count
    // at zero, which the dashboard rendered as a real, empty, perfectly
    // healthy fleet — an outage shown as an all-clear.
    return NextResponse.json({ error: 'fleet_health_unavailable' }, { status: 503 })
  }
}
