import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { mfaRequiredForRole } from '@/lib/mfaGate'
import {
  generateSecret,
  encryptSecret,
  decryptSecret,
  verifyTotp,
  otpauthUri,
  generateBackupCodes,
  hashBackupCode,
  BACKUP_CODE_COUNT,
} from '@/lib/mfa'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'

export const dynamic = 'force-dynamic'

/**
 * Self-service MFA for the signed-in user.
 *
 *   GET                     -> current state
 *   POST { action:'setup'  } -> new secret + QR (does NOT enable)
 *   POST { action:'enable', token } -> verify a code, then enable + backup codes
 *   POST { action:'disable', password } -> turn it off (password re-confirmed)
 *
 * Every branch acts on the SESSION's user id. A user id is never taken from the
 * request body — that would let any signed-in user enrol or disable MFA on
 * someone else's account.
 */

async function sessionUser() {
  const session = await getServerSession(authOptions)
  if (!session) return null
  const u = session.user as { id: string; role: string; email: string }
  if (!u?.id) return null
  const res = await query('SELECT * FROM users WHERE id = $1', [parseInt(u.id)])
  return res.rows[0] || null
}

export async function GET() {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const codes = await query(
    'SELECT COUNT(*)::int AS remaining FROM user_mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [user.id]
  )
  return NextResponse.json({
    enabled: !!user.mfa_enabled,
    enrolled_at: user.mfa_enrolled_at,
    backup_codes_remaining: codes.rows[0]?.remaining ?? 0,
    required_for_your_role: await mfaRequiredForRole(user.role),
  })
}

export async function POST(req: NextRequest) {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // ── setup: mint a candidate secret, show the QR. Deliberately does NOT set
  // mfa_enabled — the secret is stored but inert until a code proves the user
  // actually scanned it. Enabling on generation is how people lock themselves
  // out of their own account with a mis-scanned QR.
  if (body.action === 'setup') {
    if (user.mfa_enabled) {
      return NextResponse.json({ error: 'MFA is already enabled — disable it first' }, { status: 400 })
    }
    const secret = generateSecret()
    await query('UPDATE users SET mfa_secret = $1, mfa_last_step = NULL WHERE id = $2', [
      encryptSecret(secret),
      user.id,
    ])
    const uri = otpauthUri(secret, user.email)
    // Rendered server-side to a data URI: no QR library ships to the browser and
    // the secret never appears in a URL the browser might log or cache.
    const qr = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
    return NextResponse.json({ secret, uri, qr })
  }

  // ── enable: prove possession, then switch it on and issue backup codes.
  if (body.action === 'enable') {
    if (user.mfa_enabled) return NextResponse.json({ error: 'Already enabled' }, { status: 400 })
    const secret = decryptSecret(user.mfa_secret)
    if (!secret) return NextResponse.json({ error: 'Start setup first' }, { status: 400 })
    const step = verifyTotp(secret, String(body.token || ''))
    if (step == null) return NextResponse.json({ error: 'That code is not valid' }, { status: 400 })

    const codes = generateBackupCodes(BACKUP_CODE_COUNT)
    const hashes = await Promise.all(codes.map(hashBackupCode))
    // Replace any codes from a previous enrolment so an old printout can't be
    // used against the new secret.
    await query('DELETE FROM user_mfa_backup_codes WHERE user_id = $1', [user.id])
    for (const h of hashes) {
      await query('INSERT INTO user_mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)', [user.id, h])
    }
    await query(
      `UPDATE users SET mfa_enabled = TRUE, mfa_enrolled_at = NOW(), mfa_last_step = $1,
                        mfa_failed_attempts = 0, mfa_locked_until = NULL
       WHERE id = $2`,
      [step, user.id]
    )
    // Returned ONCE. Nothing stores them in readable form after this response.
    return NextResponse.json({ enabled: true, backup_codes: codes })
  }

  // ── disable: re-confirm the password. A hijacked open session should not be
  // able to quietly remove the factor that would have stopped it.
  if (body.action === 'disable') {
    if (!user.mfa_enabled) return NextResponse.json({ error: 'Not enabled' }, { status: 400 })
    if (await mfaRequiredForRole(user.role)) {
      return NextResponse.json(
        { error: 'Your role requires MFA — an administrator must change the policy first' },
        { status: 403 }
      )
    }
    const ok = await bcrypt.compare(String(body.password || ''), user.password_hash || '')
    if (!ok) return NextResponse.json({ error: 'Password is incorrect' }, { status: 400 })
    await query(
      `UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_enrolled_at = NULL,
                        mfa_last_step = NULL, mfa_failed_attempts = 0, mfa_locked_until = NULL
       WHERE id = $1`,
      [user.id]
    )
    await query('DELETE FROM user_mfa_backup_codes WHERE user_id = $1', [user.id])
    return NextResponse.json({ enabled: false })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
