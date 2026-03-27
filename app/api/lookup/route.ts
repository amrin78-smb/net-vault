import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  const [regions, sites, types, brands] = await Promise.all([
    query('SELECT name FROM regions ORDER BY name'),
    query('SELECT id, name, code FROM sites ORDER BY name'),
    query('SELECT name FROM device_types ORDER BY name'),
    query('SELECT name FROM brands ORDER BY name'),
  ])
  return NextResponse.json({
    regions: regions.rows.map(r => r.name),
    sites: sites.rows,
    types: types.rows.map(r => r.name),
    brands: brands.rows.map(r => r.name),
  })
}
