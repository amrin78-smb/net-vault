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
 * POST /api/admin/eol-recommendations/[id]/resolve
 * Body: { action: 'accept' | 'ignore' }
 *
 *  - accept → apply devices.lifecycle_status = recommended_status, write an
 *    audit_log row, mark the recommendation status='resolved'.
 *  - ignore → mark status='ignored' (cooled down for 90 days by the engine).
 * Records reviewed_by (session user id) + reviewed_at. super_admin only.
 *
 * Response: { ok:true, status }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    await ensureEolSchema()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const action = body.action as string
    if (!['accept', 'ignore'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const rRes = await query(
      `SELECT id, device_id, current_status, recommended_status, reason, status
       FROM eol_recommendations WHERE id = $1`,
      [id]
    )
    if (rRes.rows.length === 0) {
      return NextResponse.json({ error: 'Recommendation not found' }, { status: 404 })
    }
    const rec = rRes.rows[0]
    const reviewedBy = guard.user.id ? String(guard.user.id) : null

    if (action === 'accept') {
      // Multi-write: device UPDATE + audit INSERT + recommendation status UPDATE
      // must all land or none — run them in one transaction on a single client.
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
          [reviewedBy, id]
        )
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
      return NextResponse.json({ ok: true, status: 'resolved' })
    }

    // ignore
    await query(
      `UPDATE eol_recommendations SET status = 'ignored', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
      [reviewedBy, id]
    )
    return NextResponse.json({ ok: true, status: 'ignored' })
  } catch (err) {
    console.error('[admin/eol-recommendations/[id]/resolve POST]', err)
    return NextResponse.json({ error: 'Failed to resolve recommendation' }, { status: 500 })
  }
}
