import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sessionUser = session.user as { role?: string; siteIds?: number[] }
  const isSiteAdmin = sessionUser.role === 'site_admin'
  const siteIds = sessionUser.siteIds || []

  // Check if vendors table exists
  const vendorsCheck = await query(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'vendors'
     ) AS exists`
  )
  const vendorsExist = vendorsCheck.rows[0]?.exists === true

  // For site admins, restrict sites and regions to their assigned sites
  const siteFilter = isSiteAdmin && siteIds.length
    ? `AND s.id = ANY(ARRAY[${siteIds.join(',')}])`
    : ''

  const [regions, sites, types, brands, vendorsResult] = await Promise.all([
    isSiteAdmin && siteIds.length
      ? query(`SELECT DISTINCT region FROM v_devices_flat WHERE region IS NOT NULL AND site_id = ANY($1) ORDER BY region`, [siteIds])
      : query('SELECT DISTINCT region FROM v_devices_flat WHERE region IS NOT NULL ORDER BY region'),
    query(`SELECT DISTINCT s.id, s.name AS site, c.name AS country, r.name AS region
           FROM sites s
           JOIN countries c ON c.id = s.country_id
           JOIN regions r ON r.id = c.region_id
           WHERE s.name IS NOT NULL ${siteFilter}
           ORDER BY s.name`),
    query('SELECT name FROM device_types ORDER BY name'),
    query('SELECT name FROM brands ORDER BY name'),
    vendorsExist
      ? query('SELECT name FROM vendors ORDER BY name')
      : Promise.resolve({ rows: [] }),
  ])

  return NextResponse.json({
    regions: regions.rows.map(r => r.region),
    sites: sites.rows,
    deviceTypes: types.rows.map(r => r.name),
    brands: brands.rows.map(r => r.name),
    vendors: vendorsResult.rows.map(r => r.name),
    lifecycleStatuses: ['Active, Supported', 'EOL / EOS', 'Unknown'],
    deviceStatuses: ['Active', 'Decommed', 'Faulty, Replaced', 'Spare'],
    mgmtProtocols: ['Browser', 'SSH', 'Console', 'Cloud', 'Controller', 'Browser/Telnet', 'Webservice'],
  })
}
