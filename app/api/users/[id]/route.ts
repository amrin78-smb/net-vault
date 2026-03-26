import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string }
  if (sessionUser.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await req.json()
  if (body.password) {
    const hash = await bcrypt.hash(body.password, 10)
    await query('UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5',
      [body.name, body.email, body.role, hash, id])
  } else {
    await query('UPDATE users SET name=$1, email=$2, role=$3 WHERE id=$4',
      [body.name, body.email, body.role, id])
  }
  // Update site assignments
  await query('DELETE FROM user_sites WHERE user_id=$1', [id])
  if (body.site_ids?.length > 0) {
    for (const siteId of body.site_ids) {
      await query('INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [parseInt(id), siteId])
    }
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  await query('DELETE FROM users WHERE id=$1', [id])
  return NextResponse.json({ success: true })
}
