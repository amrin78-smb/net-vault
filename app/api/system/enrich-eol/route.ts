import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { requireEol } from '@/lib/entitlements'
import { query } from '@/lib/db'
import { ensureEolSchema, runEnrichment } from '@/lib/eolEnrich'

/**
 * POST /api/system/enrich-eol — start an EOL enrichment BACKGROUND job.
 *
 * Auth (either):
 *   - Authorization: Bearer ${CRON_SECRET}  (the scheduled task / cron), OR
 *   - an authenticated super_admin session   (the UI "Run now" button).
 * 401 if neither, 403 if a session exists but isn't super_admin.
 *
 * Behaviour:
 *   - If a job with status='running' already exists, return that job's id
 *     instead of starting a new one (no overlapping runs).
 *   - Otherwise INSERT a job (status='running', started_at=NOW()), return
 *     { ok:true, jobId } IMMEDIATELY, and run the enrichment in the background
 *     (setImmediate) against the persistent node server. Progress + terminal
 *     state are written onto the job row by the background runner.
 *
 * Response: { ok: true, jobId: number, status: 'running', reused?: boolean }
 */
export async function POST(req: NextRequest) {
  // 1) Cron secret path.
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('authorization') || ''
  const cronOk = !!secret && provided === `Bearer ${secret}`

  // 2) Session path (only checked when the cron secret didn't match).
  if (!cronOk) {
    const session = await getServerSession(authOptions)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const role = (session.user as { role?: string } | undefined)?.role
    if (role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // EOL Intelligence is a licensed add-on — block enrichment (incl. the daily
  // scheduled task) when the install isn't entitled. Leaves all data untouched.
  const gate = await requireEol()
  if (gate) return gate

  try {
    const init = await ensureEolSchema()

    // Reap zombie runs: if node restarted mid-run, a job row can be stuck at
    // status='running' forever (nothing flips it to 'failed'). Treat a 'running'
    // job whose started_at is older than 30 min as abandoned — mark it failed so
    // it no longer blocks new runs (and so the partial unique index is free).
    await query(
      `UPDATE eol_enrichment_jobs
         SET status = 'failed', completed_at = NOW(),
             error = 'superseded: stale/abandoned run'
       WHERE status = 'running'
         AND (started_at IS NULL OR started_at <= NOW() - INTERVAL '30 minutes')`
    )

    // No overlap: if a FRESH run is already in flight (< 30 min), hand back its id.
    const running = await query(
      `SELECT id FROM eol_enrichment_jobs
       WHERE status = 'running' AND started_at > NOW() - INTERVAL '30 minutes'
       ORDER BY id DESC LIMIT 1`
    )
    if (running.rows.length > 0) {
      return NextResponse.json({ ok: true, jobId: running.rows[0].id, status: 'running', reused: true })
    }

    let jobId: number
    try {
      const inserted = await query(
        `INSERT INTO eol_enrichment_jobs (status, started_at) VALUES ('running', NOW()) RETURNING id`
      )
      jobId = inserted.rows[0].id as number
    } catch (err: any) {
      // Lost the check-then-insert race: a concurrent POST inserted the running
      // job first and the partial unique index (eol_jobs_one_running) rejected
      // ours. Hand back the existing running job instead of failing.
      if (err && err.code === '23505') {
        const existing = await query(
          `SELECT id FROM eol_enrichment_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1`
        )
        if (existing.rows.length > 0) {
          return NextResponse.json({ ok: true, jobId: existing.rows[0].id, status: 'running', reused: true })
        }
      }
      throw err
    }

    // Run in the background against the persistent node server.
    setImmediate(() => {
      runEnrichment(jobId, init.fuzzyAvailable).catch((err) => {
        console.error('[system/enrich-eol background]', err)
      })
    })

    return NextResponse.json({ ok: true, jobId, status: 'running' })
  } catch (err) {
    console.error('[system/enrich-eol POST]', err)
    return NextResponse.json({ ok: false, error: 'Enrichment failed to start' }, { status: 500 })
  }
}
