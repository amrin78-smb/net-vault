import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const search    = searchParams.get('search') || ''
  const region    = searchParams.get('region') || ''
  const site      = searchParams.get('site') || ''
  const type      = searchParams.get('type') || ''
  const status    = searchParams.get('status') || ''
  const lifecycle = searchParams.get('lifecycle') || ''

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 1

  if (search) {
    conditions.push(`(name ILIKE $${p} OR ip_address::text ILIKE $${p} OR model ILIKE $${p} OR serial_number ILIKE $${p})`)
    params.push(`%${search}%`); p++
  }
  if (region)    { conditions.push(`region = $${p}`);           params.push(region);    p++ }
  if (site)      { conditions.push(`site = $${p}`);             params.push(site);      p++ }
  if (type)      { conditions.push(`device_type = $${p}`);      params.push(type);      p++ }
  if (status)    { conditions.push(`device_status = $${p}`);    params.push(status);    p++ }
  if (lifecycle) { conditions.push(`lifecycle_status = $${p}`); params.push(lifecycle); p++ }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const res = await query(
    `SELECT name, brand, model, serial_number, device_type, ip_address,
            site, location_detail, country, lifecycle_status, region,
            device_status, technical_debt, risk_score, mgmt_protocol,
            remark, cost, purchase_date, purchase_vendor, ma_vendor
     FROM v_devices_flat ${where} ORDER BY region, country, site, name`, params)

  // PowerBI-friendly column names matching expected format
  const colMap: Record<string, string> = {
    name: 'Name',
    brand: 'Brand',
    model: 'Model',
    serial_number: 'S/N',
    device_type: 'Type',
    ip_address: 'IP Address',
    site: 'Site',
    location_detail: 'Location',
    country: 'Country',
    lifecycle_status: 'Lifecycle Status',
    region: 'Region',
    device_status: 'Device Status',
    technical_debt: 'Technical Debt',
    risk_score: 'Risk Score',
    mgmt_protocol: 'Mgmt Protocol',
    remark: 'Remark',
    cost: 'Cost',
    purchase_date: 'Purchase Date',
    purchase_vendor: 'Purchase Vendor',
    ma_vendor: 'MA Vendor',
  }

  const dbCols = Object.keys(colMap)
  const headers = dbCols.map(c => colMap[c])

  const csv = [
    headers.join(','),
    ...res.rows.map(row => dbCols.map(h => {
      const val = row[h] ?? ''
      const str = String(val)
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str
    }).join(','))
  ].join('\n')

  const dateStr = new Date().toISOString().split('T')[0]
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="NetVault_Export_${dateStr}.csv"`,
    },
  })
}
