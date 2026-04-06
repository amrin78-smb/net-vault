import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const page     = parseInt(searchParams.get('page') || '1')
  const action   = searchParams.get('action') || ''
  const userId   = searchParams.get('user') || ''
  const dateFrom = searchParams.get('from') || ''
  const dateTo   = searchParams.get('to') || ''
  const limit    = 50
  const offset   = (page - 1) * limit

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 1

  if (action)   { conditions.push(`a.field_name = $${p}`);               params.push(action);   p++ }
  if (userId)   { conditions.push(`a.changed_by = $${p}`);               params.push(parseInt(userId)); p++ }
  if (dateFrom) { conditions.push(`a.changed_at >= $${p}`);              params.push(dateFrom); p++ }
  if (dateTo)   { conditions.push(`a.changed_at < ($${p}::date + 1)`);   params.push(dateTo);   p++ }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [res, count, users] = await Promise.all([
    query(`
      SELECT a.id, a.field_name, a.old_value, a.new_value, a.changed_at,
             u.name as changed_by_name, u.email as changed_by_email,
             d.name as device_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.changed_by
      LEFT JOIN devices d ON d.id = a.device_id
      ${where}
      ORDER BY a.changed_at DESC LIMIT $${p} OFFSET $${p+1}
    `, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM audit_log a ${where}`, params),
    query(`SELECT DISTINCT u.id, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.changed_by WHERE u.id IS NOT NULL ORDER BY u.name`),
  ])

  return NextResponse.json({
    logs: res.rows,
    total: parseInt(count.rows[0].count),
    users: users.rows,
  })
}
