import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

function buildWhere(siteClause: string, extra: string) {
  const parts = [siteClause, extra].filter(Boolean)
  return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sessionUser = session.user as { role: string; siteIds?: number[] }
  const isSiteAdmin = sessionUser.role === 'site_admin'
  const sc = isSiteAdmin && sessionUser.siteIds?.length
    ? `site_id = ANY(ARRAY[${sessionUser.siteIds.join(',')}])`
    : ''

  const totalRes = await query(`SELECT COUNT(*) as total FROM v_devices_flat ${buildWhere(sc, '')}`)
  const total = parseInt(totalRes.rows[0].total)

  const failCounts = await Promise.all([
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, "(serial_number IS NULL OR serial_number = '')")}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, "(ip_address IS NULL OR ip_address = '')")}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, 'purchase_vendor IS NULL')}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, "(support_contract_number IS NULL OR support_contract_number = '')")}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, 'support_end_date IS NULL')}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, 'support_end_date IS NOT NULL AND support_end_date < CURRENT_DATE')}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, "lifecycle_status = 'EOL / EOS' AND device_status = 'Active'")}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, 'site_id IS NULL')}`),
    query(`SELECT COUNT(*) as fail FROM v_devices_flat ${buildWhere(sc, "(device_type IS NULL OR device_type = '')")}`),
  ])

  const definitions = [
    { key: 'missing_serial',   label: 'Devices missing serial number',       href: '/devices' },
    { key: 'missing_ip',       label: 'Devices missing IP address',          href: '/devices' },
    { key: 'missing_vendor',   label: 'Devices missing purchase vendor',     href: '/devices' },
    { key: 'missing_contract', label: 'Devices missing support contract #',  href: '/devices' },
    { key: 'missing_end_date', label: 'Devices missing support end date',    href: '/devices' },
    { key: 'expired_support',  label: 'Devices with expired support',        href: '/devices?support_expiry=expired' },
    { key: 'eol_active',       label: 'EOL/EOS devices still Active',        href: '/devices?lifecycle=EOL+%2F+EOS' },
    { key: 'missing_site',     label: 'Devices missing site assignment',     href: '/devices' },
    { key: 'missing_type',     label: 'Devices missing device type',         href: '/devices' },
  ]

  const checks = definitions.map((def, i) => {
    const fail = parseInt(failCounts[i].rows[0].fail)
    const pass = total - fail
    const pct = total > 0 ? Math.round((pass / total) * 100) : 100
    return { ...def, total, fail, pass, pct }
  })

  const score = checks.length > 0 ? Math.round(checks.reduce((s, c) => s + c.pct, 0) / checks.length) : 100

  return NextResponse.json({ score, total, checks })
}
