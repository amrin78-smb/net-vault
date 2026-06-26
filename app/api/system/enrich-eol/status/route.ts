import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { ensureEolSchema } from '@/lib/eolEnrich'
import { requireEol } from '@/lib/entitlements'

/**
 * GET /api/system/enrich-eol/status?jobId=
 * Returns the job row (status + live progress). Any authenticated session.
 *
 * Response: { ok:true, job: { id, status, started_at, completed_at, scanned,
 *   matched, written, discrepancies, unmatched_top, error } } | 404
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const gate = await requireEol()
  if (gate) return gate

  const jobId = new URL(req.url).searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })

  try {
    await ensureEolSchema()
    const res = await query(
      `SELECT id, status, started_at, completed_at, scanned, matched, written,
              discrepancies, unmatched_top, error
       FROM eol_enrichment_jobs WHERE id = $1`,
      [jobId]
    )
    if (res.rows.length === 0) {
      return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, job: res.rows[0] })
  } catch (err) {
    console.error('[system/enrich-eol/status GET]', err)
    return NextResponse.json({ ok: false, error: 'Failed to load job' }, { status: 500 })
  }
}
