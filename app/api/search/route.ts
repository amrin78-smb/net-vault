import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string; siteIds?: number[] }
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q') || ''
  if (q.length < 2) return NextResponse.json({ devices: [], sites: [], circuits: [] })

  const isSiteAdmin = sessionUser.role === 'site_admin'
  const siteIds = sessionUser.siteIds || []
  const siteFilter = isSiteAdmin && siteIds.length ? `AND site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

  const [devices, sites, circuits] = await Promise.all([
    query(`
      SELECT id, name, device_type, ip_address, site, device_status
      FROM v_devices_flat
      WHERE (name ILIKE $1 OR ip_address::text ILIKE $1 OR brand ILIKE $1 OR model ILIKE $1 OR serial_number ILIKE $1) ${siteFilter}
      ORDER BY CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END, name
      LIMIT 5
    `, [`%${q}%`, `${q}%`]),
    query(`
      SELECT s.id, s.name, s.code, c.name AS country, r.name AS region
      FROM sites s
      JOIN countries c ON c.id = s.country_id
      JOIN regions r ON r.id = c.region_id
      WHERE (s.name ILIKE $1 OR s.code ILIKE $1 OR c.name ILIKE $1)
      ${isSiteAdmin && siteIds.length ? `AND s.id = ANY(ARRAY[${siteIds.join(',')}])` : ''}
      ORDER BY CASE WHEN s.name ILIKE $2 THEN 0 ELSE 1 END, s.name
      LIMIT 5
    `, [`%${q}%`, `${q}%`]),
    query(`
      SELECT c.id, c.circuit_id, c.isp, c.usage, s.name AS site
      FROM circuits c
      LEFT JOIN sites s ON s.id = c.site_id
      WHERE (c.circuit_id ILIKE $1 OR c.isp ILIKE $1 OR s.name ILIKE $1)
      ${isSiteAdmin && siteIds.length ? `AND c.site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''}
      ORDER BY CASE WHEN c.isp ILIKE $2 THEN 0 ELSE 1 END, c.isp
      LIMIT 5
    `, [`%${q}%`, `${q}%`]),
  ])

  return NextResponse.json({
    devices: devices.rows,
    sites: sites.rows,
    circuits: circuits.rows,
  })
}
