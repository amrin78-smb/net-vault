import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/users/:id/mfa-reset  (super_admin only)
 *
 * Clears a user's second factor so they can enrol again — the answer to "I lost
 * my phone and used all my backup codes".
 *
 * This is an authentication-bypass capability by design: afterwards that account
 * signs in with a password alone until they re-enrol. So it is restricted to
 * super_admin and written to the audit trail. An MFA reset that leaves no record
 * is indistinguishable from an attacker removing someone's second factor.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = session.user as { id: string; role: string; email: string }
  if (actor.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const targetId = parseInt(id, 10)
  if (!Number.isFinite(targetId)) return NextResponse.json({ error: 'Invalid user' }, { status: 400 })

  try {
    const res = await query('SELECT id, email, mfa_enabled FROM users WHERE id = $1', [targetId])
    const target = res.rows[0]
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await query(
      `UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_enrolled_at = NULL,
                        mfa_last_step = NULL, mfa_failed_attempts = 0, mfa_locked_until = NULL
       WHERE id = $1`,
      [targetId]
    )
    await query('DELETE FROM user_mfa_backup_codes WHERE user_id = $1', [targetId])

    // NetVault's audit_log is device-shaped
    // (device_id, changed_by, field_name, old_value, new_value) — NOT the
    // (action, entity_type, details) shape LogVault uses. device_id is nullable,
    // so a user-scoped event records NULL there and identifies the subject in
    // field_name. Getting this wrong throws, and since the write is
    // best-effort-wrapped it would fail SILENTLY — every reset unaudited while
    // the endpoint looked healthy.
    //
    // Best-effort is still right: a failed audit insert must not leave the
    // account half-reset. But it is logged loudly so it cannot pass unnoticed.
    try {
      await query(
        `INSERT INTO audit_log (device_id, changed_by, field_name, old_value, new_value)
         VALUES (NULL, $1, $2, $3, $4)`,
        [
          parseInt(actor.id),
          `mfa_reset:user:${targetId}`,
          `${target.email} — MFA ${target.mfa_enabled ? 'enabled' : 'not enabled'}`,
          `MFA cleared by ${actor.email}`,
        ]
      )
    } catch (e) {
      console.error('[mfa-reset] AUDIT WRITE FAILED — reset applied but not recorded:', e)
    }

    return NextResponse.json({ ok: true, email: target.email })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
