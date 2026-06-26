import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { ensureEolSchema } from '@/lib/eolEnrich'
import { requireEol } from '@/lib/entitlements'

/**
 * GET /api/system/enrich-eol/latest
 * Most recent COMPLETED job, full summary including unmatched_top. Any
 * authenticated session.
 *
 * Response: { ok:true, job: {…} | null }
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const res = await query(
      `SELECT id, status, started_at, completed_at, scanned, matched, written,
              discrepancies, unmatched_top, error
       FROM eol_enrichment_jobs
       WHERE status = 'completed'
       ORDER BY completed_at DESC NULLS LAST, id DESC
       LIMIT 1`
    )
    return NextResponse.json({ ok: true, job: res.rows[0] ?? null })
  } catch (err) {
    console.error('[system/enrich-eol/latest GET]', err)
    return NextResponse.json({ ok: false, error: 'Failed to load latest job' }, { status: 500 })
  }
}
