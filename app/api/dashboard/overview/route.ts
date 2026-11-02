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
    // 503 rather than a zero payload. This used to answer 200 with
    // healthy_devices 0, eol_assets 0, sites_at_risk 0 and compliance_score
    // 100 - so a database failure was presented to an operator as a fleet
    // with nothing wrong with it, which is the single worst thing a health
    // endpoint can say. The dashboard now shows those tiles as unavailable.
    return NextResponse.json({ error: 'overview_unavailable' }, { status: 503 })
  }
}
