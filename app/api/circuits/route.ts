import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const search = searchParams.get('search') || ''
  const isp = searchParams.get('isp') || ''
  const usage = searchParams.get('usage') || ''
  const technology = searchParams.get('technology') || ''
  const country = searchParams.get('country') || ''

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 1
  if (search) { conditions.push(`(c.circuit_id ILIKE $${p} OR c.isp ILIKE $${p} OR c.site_name_raw ILIKE $${p} OR s.name ILIKE $${p} OR c.public_subnet ILIKE $${p})`); params.push(`%${search}%`); p++ }
  if (isp) { conditions.push(`c.isp = $${p}`); params.push(isp); p++ }
  if (usage) { conditions.push(`c.usage = $${p}`); params.push(usage); p++ }
  if (technology) { conditions.push(`c.technology = $${p}`); params.push(technology); p++ }
  if (country) { conditions.push(`co.name = $${p}`); params.push(country); p++ }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const res = await query(`
    SELECT c.*, s.name as site, s.code as site_code, s.id as site_id,
           co.name as country, r.name as region
    FROM circuits c
    LEFT JOIN sites s ON s.id = c.site_id
    LEFT JOIN countries co ON co.id = s.country_id
    LEFT JOIN regions r ON r.id = co.region_id
    ${where}
    ORDER BY co.name, s.name, c.usage
  `, params)

  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.site_id || !body.isp)
    return NextResponse.json({ error: 'Site and ISP are required' }, { status: 400 })

  const res = await query(`
    INSERT INTO circuits (
      site_id, site_name_raw, it_owner, city, address,
      isp, usage, circuit_id, product, technology, circuit_type,
      interface, max_speed, guaranteed_speed, public_subnet,
      currency, cost_month, contract_term, comment, pingable
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING id
  `, [
    body.site_id, body.site_name || null, body.it_owner || null,
    body.city || null, body.address || null,
    body.isp, body.usage || 'Main', body.circuit_id || null,
    body.product || null, body.technology || null, body.circuit_type || null,
    body.interface || null, body.max_speed || null, body.guaranteed_speed || null,
    body.public_subnet || null, body.currency || 'THB',
    body.cost_month || null, body.contract_term || null,
    body.comment || null, body.pingable || null
  ])

  return NextResponse.json({ id: res.rows[0].id }, { status: 201 })
}
