import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const res = await query('SELECT key, value FROM app_settings')
  const settings: Record<string, string> = {}
  res.rows.forEach(r => { settings[r.key] = r.value })
  return NextResponse.json(settings)
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })
  if (user.role === 'admin') return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })
  if (user.role === 'admin') return NextResponse.json({ error: 'Only super admins can change branding' }, { status: 403 })
  const body = await req.json()
  for (const [key, value] of Object.entries(body)) {
    await query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    )
  }
  return NextResponse.json({ success: true })
}
