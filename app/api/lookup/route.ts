import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [regions, sites, types, brands, vendors] = await Promise.all([
    query('SELECT DISTINCT region FROM v_devices_flat WHERE region IS NOT NULL ORDER BY region'),
    query('SELECT DISTINCT site, country, region FROM v_devices_flat WHERE site IS NOT NULL ORDER BY site'),
    query('SELECT name FROM device_types ORDER BY name'),
    query('SELECT name FROM brands ORDER BY name'),
    query('SELECT name FROM vendors ORDER BY name'),
  ])
  return NextResponse.json({
    regions: regions.rows.map(r => r.region),
    sites: sites.rows,
    deviceTypes: types.rows.map(r => r.name),
    brands: brands.rows.map(r => r.name),
    vendors: vendors.rows.map(r => r.name),
    lifecycleStatuses: ['Active, Supported', 'EOL / EOS', 'Unknown'],
    deviceStatuses: ['Active', 'Decommed', 'Faulty, Replaced', 'Spare'],
    mgmtProtocols: ['Browser', 'SSH', 'Console', 'Cloud', 'Controller', 'Browser/Telnet', 'Webservice'],
  })
}
