import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
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
 * POST /api/admin/eol-discrepancies/[id]/resolve
 * Body: { action: 'accept_seed' | 'keep_manual' | 'ignore' }
 *
 *  - accept_seed → set device.support_end_date = seed_date (+ eol_source='seed',
 *    eol_confidence='high', eol_enriched_at=NOW()), mark status='resolved'.
 *  - keep_manual → keep the existing manual date, mark status='resolved'.
 *  - ignore      → status='ignored' (won't be re-flagged by future runs).
 * Records resolved_by (session user id) + resolved_at. super_admin only.
 *
 * Response: { ok:true, status }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error

  try {
    await ensureEolSchema()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const action = body.action as string
    if (!['accept_seed', 'keep_manual', 'ignore'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const dRes = await query(
      `SELECT id, device_id, seed_date::text AS seed_date, status FROM eol_discrepancies WHERE id = $1`,
      [id]
    )
    if (dRes.rows.length === 0) {
      return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 })
    }
    const disc = dRes.rows[0]
    const resolvedBy = guard.user.id ? String(guard.user.id) : null

    if (action === 'accept_seed') {
      // Device date UPDATE + discrepancy status UPDATE must land together.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (disc.device_id) {
          await client.query(
            `UPDATE devices
               SET support_end_date = $1::date, eol_source = 'seed', eol_confidence = 'high',
                   eol_enriched_at = NOW()
             WHERE id = $2`,
            [disc.seed_date, disc.device_id]
          )
        }
        await client.query(
          `UPDATE eol_discrepancies SET status = 'resolved', resolved_by = $1, resolved_at = NOW() WHERE id = $2`,
          [resolvedBy, id]
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

    if (action === 'keep_manual') {
      await query(
        `UPDATE eol_discrepancies SET status = 'resolved', resolved_by = $1, resolved_at = NOW() WHERE id = $2`,
        [resolvedBy, id]
      )
      return NextResponse.json({ ok: true, status: 'resolved' })
    }

    // ignore
    await query(
      `UPDATE eol_discrepancies SET status = 'ignored', resolved_by = $1, resolved_at = NOW() WHERE id = $2`,
      [resolvedBy, id]
    )
    return NextResponse.json({ ok: true, status: 'ignored' })
  } catch (err) {
    console.error('[admin/eol-discrepancies/[id]/resolve POST]', err)
    return NextResponse.json({ error: 'Failed to resolve discrepancy' }, { status: 500 })
  }
}
