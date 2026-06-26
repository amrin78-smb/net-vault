import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { requireEol } from '@/lib/entitlements'
import { query } from '@/lib/db'
import pool from '@/lib/db'
import { ensureEolSchema } from '@/lib/eolEnrich'

async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

/**
 * POST /api/admin/eol-recommendations/bulk
 * Body: { action: 'accept_all' | 'ignore_all', type: 'should_be_eol' | 'possibly_incorrect' }
 *
 * Resolves all PENDING recommendations of the given type (type → recommended_status:
 * should_be_eol → 'EOL / EOS', possibly_incorrect → 'Active, Supported').
 *  - accept_all → applies the device lifecycle_status change + an audit_log row per
 *    recommendation, marks each resolved.
 *  - ignore_all → marks all of them ignored.
 * super_admin only.
 *
 * Response: { ok:true, count }
 */
export async function POST(req: NextRequest) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const body = await req.json().catch(() => ({}))
    const action = body.action as string
    const type = body.type as string

    if (!['accept_all', 'ignore_all'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
    if (!['should_be_eol', 'possibly_incorrect'].includes(type)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }

    const recommendedStatus = type === 'should_be_eol' ? 'EOL / EOS' : 'Active, Supported'
    const reviewedBy = guard.user.id ? String(guard.user.id) : null

    const rRes = await query(
      `SELECT id, device_id, current_status, recommended_status, reason
       FROM eol_recommendations
       WHERE status = 'pending' AND recommended_status = $1`,
      [recommendedStatus]
    )
    const recs = rRes.rows as Array<{
      id: number
      device_id: string | null
      current_status: string | null
      recommended_status: string
      reason: string | null
    }>

    let count = 0
    let failed = 0

    if (action === 'accept_all') {
      // Each recommendation is its own transaction (device UPDATE + audit INSERT
      // + status UPDATE land together or not at all). A failure on one item rolls
      // back ONLY that item and is counted as a failure — the rest still apply,
      // and we report an accurate success count instead of a blanket 500.
      for (const rec of recs) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          if (rec.device_id) {
            await client.query(
              `UPDATE devices SET lifecycle_status = $1 WHERE id = $2`,
              [rec.recommended_status, rec.device_id]
            )
            if (guard.user.id) {
              await client.query(
                `INSERT INTO audit_log (device_id, changed_by, field_name, old_value, new_value)
                 VALUES ($1, $2, 'lifecycle_status', $3, $4)`,
                [
                  rec.device_id,
                  parseInt(guard.user.id),
                  rec.current_status,
                  `${rec.recommended_status} — EOL Intelligence: ${rec.reason}`,
                ]
              )
            }
          }
          await client.query(
            `UPDATE eol_recommendations SET status = 'resolved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
            [reviewedBy, rec.id]
          )
          await client.query('COMMIT')
          count++
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          failed++
          console.error('[admin/eol-recommendations/bulk] item failed', rec.id, e)
        } finally {
          client.release()
        }
      }
      return NextResponse.json({ ok: true, count, ...(failed > 0 ? { failed } : {}) })
    } else {
      // ignore_all
      const upd = await query(
        `UPDATE eol_recommendations
           SET status = 'ignored', reviewed_by = $1, reviewed_at = NOW()
         WHERE status = 'pending' AND recommended_status = $2`,
        [reviewedBy, recommendedStatus]
      )
      count = upd.rowCount ?? recs.length
    }

    return NextResponse.json({ ok: true, count })
  } catch (err) {
    console.error('[admin/eol-recommendations/bulk POST]', err)
    return NextResponse.json({ error: 'Failed to bulk resolve recommendations' }, { status: 500 })
  }
}
