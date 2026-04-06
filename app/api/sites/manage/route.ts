import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.name || !body.country_id)
    return NextResponse.json({ error: 'Site name and country are required' }, { status: 400 })

  const existing = await query('SELECT id FROM sites WHERE name = $1 AND country_id = $2', [body.name, body.country_id])
  if (existing.rows.length > 0)
    return NextResponse.json({ error: 'A site with this name already exists in that country' }, { status: 409 })

  const res = await query(
    `INSERT INTO sites (name, code, country_id, address, city, postal_code, coordinates, site_type, phone, contact_name, contact_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [body.name, body.code||null, body.country_id,
     body.address||null, body.city||null, body.postal_code||null,
     body.coordinates||null, body.site_type||null,
     body.phone||null, body.contact_name||null, body.contact_email||null]
  )
  return NextResponse.json({ id: res.rows[0].id }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.id || !body.site_status) return NextResponse.json({ error: 'Site ID and status required' }, { status: 400 })

  if (body.site_status === 'Decommed') {
    const activeCheck = await query(
      `SELECT COUNT(*) FROM devices WHERE site_id = $1 AND device_status = 'Active'`,
      [body.id]
    )
    if (parseInt(activeCheck.rows[0].count) > 0) {
      return NextResponse.json({
        error: `Cannot decommission — this site has ${activeCheck.rows[0].count} active devices. Set them to Decommed first.`
      }, { status: 409 })
    }
  }

  await query('UPDATE sites SET site_status = $1 WHERE id = $2', [body.site_status, body.id])
  return NextResponse.json({ success: true })
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Only super admins can delete sites' }, { status: 403 })

  const body = await req.json()
  if (!body.id) return NextResponse.json({ error: 'Site ID required' }, { status: 400 })

  const deviceCheck = await query('SELECT COUNT(*) FROM devices WHERE site_id = $1', [body.id])
  if (parseInt(deviceCheck.rows[0].count) > 0)
    return NextResponse.json({ error: `Cannot delete — this site has ${deviceCheck.rows[0].count} devices assigned to it. Reassign or delete them first.` }, { status: 409 })

  const circuitCheck = await query('SELECT COUNT(*) FROM circuits WHERE site_id = $1', [body.id])
  if (parseInt(circuitCheck.rows[0].count) > 0)
    return NextResponse.json({ error: `Cannot delete — this site has ${circuitCheck.rows[0].count} circuits assigned to it. Remove them first.` }, { status: 409 })

  await query('DELETE FROM sites WHERE id = $1', [body.id])
  return NextResponse.json({ success: true })
}
