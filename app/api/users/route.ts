import { NextResponse, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const res = await query(`
    SELECT u.id, u.name, u.email, u.role, u.created_at,
      COALESCE(
        json_agg(json_build_object('id', s.id, 'name', s.name, 'code', s.code))
        FILTER (WHERE s.id IS NOT NULL), '[]'
      ) as sites
    FROM users u
    LEFT JOIN user_sites us ON us.user_id = u.id
    LEFT JOIN sites s ON s.id = us.site_id
    GROUP BY u.id ORDER BY u.created_at
  `)
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await req.json()
  if (!body.name || !body.email || !body.password)
    return NextResponse.json({ error: 'Name, email and password required' }, { status: 400 })
  const existing = await query('SELECT id FROM users WHERE email = $1', [body.email])
  if (existing.rows.length > 0)
    return NextResponse.json({ error: 'Email already exists' }, { status: 409 })
  const hash = await bcrypt.hash(body.password, 10)
  const res = await query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
    [body.name, body.email, hash, body.role || 'viewer']
  )
  const userId = res.rows[0].id
  if (body.site_ids?.length > 0) {
    for (const siteId of body.site_ids) {
      await query('INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, siteId])
    }
  }
  return NextResponse.json({ id: userId }, { status: 201 })
}
