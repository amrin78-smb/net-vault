import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'

// Change your own password.
//
// ⛔ AUDITED FOR THE LOCAL-ACCOUNT EMAIL POLICY AND DELIBERATELY NOT GUARDED:
// this is the third write path to `users` under app/api/users/**, and the only
// column it writes is `password_hash`. It takes no email from the request, so
// `decideLocalAccountEmail` has nothing to decide here. If an email (or any
// other identity field) is ever added to this body, the guard in
// `app/api/users/route.ts` and `app/api/users/[id]/route.ts` must be added here
// in the SAME change — a fixed access-control bug is a fixed instance, not a
// fixed class.
//
// (It also cannot work for a directory account: `password_hash` is NULL there,
// so `bcrypt.compare` below would reject the current-password check — the same
// `canUsePassword` premise lib/directoryUser.ts documents. Out of scope here.)
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sessionUser = session.user as { id: string }
  const body = await req.json()

  if (!body.current_password || !body.new_password) {
    return NextResponse.json({ error: 'Current and new password are required' }, { status: 400 })
  }
  if (body.new_password.length < 8) {
    return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
  }

  const res = await query('SELECT password_hash FROM users WHERE id = $1', [sessionUser.id])
  if (!res.rows[0]) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const valid = await bcrypt.compare(body.current_password, res.rows[0].password_hash)
  if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 })

  const hash = await bcrypt.hash(body.new_password, 10)
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, sessionUser.id])

  return NextResponse.json({ success: true })
}
