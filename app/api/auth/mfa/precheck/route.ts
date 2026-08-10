import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { mfaRequiredForRole } from '@/lib/mfaGate'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import bcrypt from 'bcryptjs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/mfa/precheck  { email, password } -> { mfaRequired | enrolmentRequired }
 *
 * Login step 1. Tells the sign-in form whether to reveal the code field, so a
 * user without MFA never sees one and a user with it isn't told "wrong password"
 * when the real problem is a missing code.
 *
 * THIS ROUTE GRANTS NOTHING. It issues no session, no token and no cookie.
 * NextAuth's authorize() independently re-checks the password AND the code, so a
 * client that skips this call, or lies about the answer, gains nothing — the
 * only thing on offer here is which form field to render.
 *
 * It does verify the password before answering, so it cannot be used to
 * enumerate which accounts have MFA: a wrong password returns the same generic
 * shape as a non-existent user. It is rate limited for the same reason the login
 * itself is — it accepts a password guess, so leaving it unlimited would just
 * move brute force one endpoint sideways.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const rl = checkRateLimit(`mfa-precheck:${ip}`, { maxAttempts: 20, windowMs: 5 * 60 * 1000 })
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many attempts' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const email = typeof body.email === 'string' ? body.email : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email || !password) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  try {
    const res = await query('SELECT id, role, password_hash, mfa_enabled FROM users WHERE email = $1', [email])
    const user = res.rows[0]
    // Same response for "no such user" and "wrong password" — never confirm an
    // address exists. bcrypt.compare against a dummy hash keeps the timing of
    // the unknown-user path close to the known-user one.
    const DUMMY = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
    const valid = user
      ? await bcrypt.compare(password, user.password_hash || DUMMY)
      : (await bcrypt.compare(password, DUMMY), false)
    if (!user || !valid) {
      return NextResponse.json({ ok: false }, { status: 200 })
    }

    if (user.mfa_enabled) {
      return NextResponse.json({ ok: true, mfaRequired: true })
    }
    if (await mfaRequiredForRole(user.role)) {
      // Policy demands MFA for this role but the account has none. authorize()
      // will refuse the login; say so plainly rather than let it look like a
      // wrong password.
      return NextResponse.json({ ok: true, mfaRequired: false, enrolmentRequired: true })
    }
    return NextResponse.json({ ok: true, mfaRequired: false })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
