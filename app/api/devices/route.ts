import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { calcTechnicalDebt } from '@/lib/techDebt'

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
  const model = searchParams.get('model') || ''
  const supportExpiry = searchParams.get('support_expiry') || ''
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
  if (model) { conditions.push(`(REGEXP_REPLACE(LOWER(model), '[^a-z0-9]', '', 'g') LIKE $${p} OR LOWER(brand) LIKE $${p})`); params.push(`%${model.toLowerCase().replace(/[^a-z0-9]/gi, '')}%`); p++ }
  if (region) { conditions.push(`region = $${p}`); params.push(region); p++ }
  if (site) { conditions.push(`site = $${p}`); params.push(site); p++ }
  if (type) { conditions.push(`device_type = $${p}`); params.push(type); p++ }
  if (status) { conditions.push(`device_status = $${p}`); params.push(status); p++ }
  if (lifecycle) { conditions.push(`lifecycle_status = $${p}`); params.push(lifecycle); p++ }
  if (supportExpiry === 'expired')  conditions.push(`support_end_date IS NOT NULL AND support_end_date < CURRENT_DATE`)
  if (supportExpiry === 'expiring') conditions.push(`support_end_date IS NOT NULL AND support_end_date >= CURRENT_DATE AND support_end_date <= CURRENT_DATE + INTERVAL '90 days'`)
  if (supportExpiry === 'active')   conditions.push(`support_end_date IS NOT NULL AND support_end_date > CURRENT_DATE + INTERVAL '90 days'`)

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

  // Look up site_id from site name
  const siteRes = await query('SELECT id FROM sites WHERE name = $1', [body.site])
  if (!siteRes.rows[0]) return NextResponse.json({ error: 'Site not found' }, { status: 400 })
  const siteId = siteRes.rows[0].id

  // Look up brand_id and type_id from names
  const brandRes = body.brand ? await query('SELECT id FROM brands WHERE name = $1', [body.brand]) : { rows: [] as any[] }
  const brandId = brandRes.rows[0]?.id || null
  const typeRes = body.device_type ? await query('SELECT id FROM device_types WHERE name = $1', [body.device_type]) : { rows: [] as any[] }
  const typeId = typeRes.rows[0]?.id || null

  // site_admin can only add to assigned sites
  if (sessionUser.role === 'site_admin' && !sessionUser.siteIds?.includes(siteId)) {
    return NextResponse.json({ error: 'You can only add devices to your assigned sites' }, { status: 403 })
  }

  const res = await query(`
    INSERT INTO devices (name, brand_id, model, serial_number, device_type_id, ip_address, site_id, lifecycle_status, device_status, technical_debt, os_type, os_version, os_eol_date, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
    [body.name||null, brandId, body.model||null, body.serial_number||null,
     typeId, body.ip_address||null, siteId,
     body.lifecycle_status||'Unknown', body.device_status||'Active',
     calcTechnicalDebt(body.lifecycle_status||'Unknown', body.device_status||'Active', body.device_type||''),
     body.os_type||null, body.os_version||null, body.os_eol_date||null,
     parseInt(sessionUser.id)]
  )
  return NextResponse.json({ id: res.rows[0].id, name: body.name, site: body.site }, { status: 201 })
}
