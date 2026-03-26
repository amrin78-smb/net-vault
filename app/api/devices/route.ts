import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string; siteIds?: number[] }
  const { searchParams } = new URL(req.url)
  const search = searchParams.get('search') || ''
  const region = searchParams.get('region') || ''
  const site = searchParams.get('site') || ''
  const type = searchParams.get('type') || ''
  const status = searchParams.get('status') || ''
  const lifecycle = searchParams.get('lifecycle') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 1

  // Site filter for site_admin
  if (sessionUser.role === 'site_admin' && sessionUser.siteIds?.length) {
    conditions.push(`site_id = ANY($${p})`)
    params.push(sessionUser.siteIds); p++
  } else if (sessionUser.role === 'site_admin') {
    return NextResponse.json({ devices: [], total: 0 })
  }

  if (search) { conditions.push(`(name ILIKE $${p} OR ip_address::text ILIKE $${p} OR model ILIKE $${p} OR serial_number ILIKE $${p})`); params.push(`%${search}%`); p++ }
  if (region) { conditions.push(`region = $${p}`); params.push(region); p++ }
  if (site) { conditions.push(`site_id = $${p}`); params.push(parseInt(site)); p++ }
  if (type) { conditions.push(`device_type = $${p}`); params.push(type); p++ }
  if (status) { conditions.push(`device_status = $${p}`); params.push(status); p++ }
  if (lifecycle) { conditions.push(`lifecycle_status = $${p}`); params.push(lifecycle); p++ }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const [devRes, countRes] = await Promise.all([
    query(`SELECT * FROM v_devices_flat ${where} ORDER BY site, name LIMIT $${p} OFFSET $${p+1}`, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM v_devices_flat ${where}`, params)
  ])
  return NextResponse.json({ devices: devRes.rows, total: parseInt(countRes.rows[0].count) })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string; id: string; siteIds?: number[] }
  if (sessionUser.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await req.json()
  // site_admin can only add to assigned sites
  if (sessionUser.role === 'site_admin' && !sessionUser.siteIds?.includes(parseInt(body.site_id))) {
    return NextResponse.json({ error: 'You can only add devices to your assigned sites' }, { status: 403 })
  }
  const res = await query(`
    INSERT INTO devices (name, brand_id, model, serial_number, device_type_id, ip_address, site_id, lifecycle_status, device_status, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
    [body.name||null, body.brand_id||null, body.model||null, body.serial_number||null,
     body.device_type_id||null, body.ip_address||null, body.site_id,
     body.lifecycle_status||'Unknown', body.device_status||'Active', parseInt(sessionUser.id)]
  )
  return NextResponse.json({ id: res.rows[0].id }, { status: 201 })
}
