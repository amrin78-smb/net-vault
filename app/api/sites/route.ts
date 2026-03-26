import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string; siteIds?: number[] }

  let siteFilter = ''
  let params: unknown[] = []
  if (sessionUser.role === 'site_admin' && sessionUser.siteIds?.length) {
    siteFilter = 'WHERE s.id = ANY($1)'
    params = [sessionUser.siteIds]
  } else if (sessionUser.role === 'site_admin') {
    return NextResponse.json([])
  }

  const res = await query(`
    SELECT s.id, s.name as site, s.code,
      c.name as country, c.iso_code, r.name as region,
      COUNT(d.id) as total,
      COUNT(d.id) FILTER (WHERE d.device_status = 'Active') as active,
      COUNT(d.id) FILTER (WHERE d.device_status = 'Decommed') as decommed,
      COUNT(d.id) FILTER (WHERE d.lifecycle_status = 'EOL / EOS') as eol,
      COUNT(d.id) FILTER (WHERE d.device_status = 'Spare') as spare,
      MAX(d.updated_at) as last_updated
    FROM sites s
    JOIN countries c ON c.id = s.country_id
    JOIN regions r ON r.id = c.region_id
    LEFT JOIN devices d ON d.site_id = s.id
    ${siteFilter}
    GROUP BY s.id, s.name, s.code, c.name, c.iso_code, r.name
    ORDER BY r.name, c.name, s.name
  `, params)
  return NextResponse.json(res.rows)
}
