import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'

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
