import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; siteIds?: number[] }
  const { id } = await params

  const deviceRes = await query('SELECT site_id FROM devices WHERE id = $1', [id])
  if (!deviceRes.rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (user.role === 'site_admin' && !user.siteIds?.includes(deviceRes.rows[0].site_id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const res = await query(`
    SELECT a.field_name, a.old_value, a.new_value, a.changed_at,
           u.name as changed_by_name, u.email as changed_by_email
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.changed_by
    WHERE a.device_id = $1
    ORDER BY a.changed_at DESC
    LIMIT 20
  `, [id])
  return NextResponse.json({ logs: res.rows })
}
