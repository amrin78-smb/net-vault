import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { computeHealthScore } from '@/lib/healthScore'

// Ensure the history table exists. Self-heals on existing installs that never
// re-ran schema.sql, so the daily snapshot works without a manual migration.
async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS health_score_history (
      id SERIAL PRIMARY KEY,
      score INTEGER NOT NULL,
      grade CHAR(1) NOT NULL,
      healthy_devices INTEGER,
      eol_assets INTEGER,
      sites_at_risk INTEGER,
      compliance_score INTEGER,
      calculated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_health_score_history_date ON health_score_history (calculated_at DESC)`)
}

/**
 * POST /api/system/health-snapshot
 * Internal daily job (Windows Task Scheduler). Protected by a shared secret:
 *   Authorization: Bearer $CRON_SECRET
 * Computes the global fleet health score, persists it, and prunes >90 days.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('authorization') || ''
  if (!secret || provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await ensureTable()

    const h = await computeHealthScore() // global (no site scoping)

    const inserted = await query(
      `INSERT INTO health_score_history
         (score, grade, healthy_devices, eol_assets, sites_at_risk, compliance_score)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING calculated_at`,
      [h.health_score, h.health_grade, h.healthy_devices, h.eol_assets, h.sites_at_risk, h.compliance_score]
    )

    // Retain only the last 90 days of history.
    await query(`DELETE FROM health_score_history WHERE calculated_at < NOW() - INTERVAL '90 days'`)

    return NextResponse.json({
      ok: true,
      score: h.health_score,
      calculated_at: inserted.rows[0].calculated_at,
    })
  } catch (err) {
    console.error('[system/health-snapshot POST]', err)
    return NextResponse.json({ ok: false, error: 'Snapshot failed' }, { status: 500 })
  }
}
