import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.name || !body.country_id)
    return NextResponse.json({ error: 'Site name and country are required' }, { status: 400 })

  const existing = await query('SELECT id FROM sites WHERE name = $1 AND country_id = $2', [body.name, body.country_id])
  if (existing.rows.length > 0)
    return NextResponse.json({ error: 'A site with this name already exists in that country' }, { status: 409 })

  const res = await query(
    'INSERT INTO sites (name, code, country_id) VALUES ($1, $2, $3) RETURNING id',
    [body.name, body.code || null, body.country_id]
  )
  return NextResponse.json({ id: res.rows[0].id }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.id) return NextResponse.json({ error: 'Site ID required' }, { status: 400 })

  const deviceCheck = await query('SELECT COUNT(*) FROM devices WHERE site_id = $1', [body.id])
  const deviceCount = parseInt(deviceCheck.rows[0].count)
  if (deviceCount > 0)
    return NextResponse.json({
      error: `Cannot delete — this site has ${deviceCount} device${deviceCount > 1 ? 's' : ''} assigned to it. Reassign or delete them first.`
    }, { status: 409 })

  const circuitCheck = await query('SELECT COUNT(*) FROM circuits WHERE site_id = $1', [body.id])
  const circuitCount = parseInt(circuitCheck.rows[0].count)
  if (circuitCount > 0)
    return NextResponse.json({
      error: `Cannot delete — this site has ${circuitCount} circuit${circuitCount > 1 ? 's' : ''} assigned to it. Remove them first.`
    }, { status: 409 })

  await query('DELETE FROM sites WHERE id = $1', [body.id])
  return NextResponse.json({ success: true })
}
