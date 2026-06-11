import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { computeHealthScore } from '@/lib/healthScore'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = isSiteAdmin ? (sessionUser.siteIds || []) : []

    const h = await computeHealthScore({ siteIds })

    // Real month-over-month trend from the snapshot history (~29 days back).
    // Table may not exist yet (no snapshot taken) → trend stays null.
    let trend: number | null = null
    let trend_available = false
    try {
      const past = await query(
        `SELECT score FROM health_score_history
         WHERE calculated_at <= NOW() - INTERVAL '29 days'
         ORDER BY calculated_at DESC
         LIMIT 1`
      )
      if (past.rows.length > 0) {
        trend = h.health_score - (parseInt(past.rows[0].score, 10) || 0)
        trend_available = true
      }
    } catch (err) {
      console.error('[dashboard/overview] trend lookup failed (history table may be missing):', err)
    }

    return NextResponse.json({
      ...h,
      trend,
      trend_available,
      // Kept for backward compatibility; prefer `trend` / `trend_available`.
      health_trend: trend ?? 0,
    })
  } catch (err) {
    console.error('[dashboard/overview GET]', err)
    return NextResponse.json({
      health_score: 0,
      health_grade: 'F',
      overall_status: 'Critical',
      status_description: 'Immediate action required',
      healthy_devices: 0,
      healthy_devices_pct: 0,
      eol_assets: 0,
      eol_assets_pct: 0,
      sites_at_risk: 0,
      compliance_score: 100,
      trend: null,
      trend_available: false,
      health_trend: 0,
    })
  }
}
