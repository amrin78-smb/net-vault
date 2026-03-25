import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const [siteRes, devicesRes] = await Promise.all([
    query(`
      SELECT s.id, s.name as site, s.code,
             c.name as country, c.iso_code, r.name as region
      FROM sites s
      JOIN countries c ON c.id = s.country_id
      JOIN regions r ON r.id = c.region_id
      WHERE s.id = $1
    `, [id]),
    query(`
      SELECT
        d.id, d.name, d.model, d.serial_number,
        d.ip_address, d.device_status, d.lifecycle_status,
        d.location_detail, d.risk_score,
        dt.name as device_type,
        b.name as brand,
        s.name as site,
        s.id as site_id
      FROM devices d
      LEFT JOIN device_types dt ON dt.id = d.device_type_id
      LEFT JOIN brands b ON b.id = d.brand_id
      LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.site_id = $1
      ORDER BY dt.name, d.name
    `, [id]),
  ])

  if (!siteRes.rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ site: siteRes.rows[0], devices: devicesRes.rows })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await req.json()
  await query(
    \`UPDATE sites SET
      name=$1, code=$2, city=$3, address=$4, postal_code=$5,
      coordinates=$6, site_type=$7, phone=$8, contact_name=$9, contact_email=$10
     WHERE id=$11\`,
    [body.name, body.code||null, body.city||null, body.address||null,
     body.postal_code||null, body.coordinates||null, body.site_type||null,
     body.phone||null, body.contact_name||null, body.contact_email||null, id]
  )
  return NextResponse.json({ success: true })
}
