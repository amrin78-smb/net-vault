import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

async function safeCount(sql: string): Promise<number> {
  try {
    const res = await query(sql)
    return parseInt(res.rows[0]?.n ?? res.rows[0]?.total ?? res.rows[0]?.fail ?? '0')
  } catch (err) {
    console.error('[compliance] query failed (column may not exist yet):', err)
    return 0
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'

    // Site admin scoping prefix — joined with AND when present
    const sitePrefix = isSiteAdmin && sessionUser.siteIds?.length
      ? `site_id = ANY(ARRAY[${sessionUser.siteIds.join(',')}]) AND `
      : ''

    // Base: active devices only (Decommed / Spare are excluded from compliance)
    const activeBase = `${sitePrefix}device_status = 'Active'`

    const total = await safeCount(
      `SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase}`
    )

    const [
      missingSerial,
      missingIp,
      missingVendor,
      missingContract,
      missingEndDate,
      expiredSupport,
      eolActive,
      missingSite,
      missingType,
    ] = await Promise.all([
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (serial_number IS NULL OR serial_number = '')`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (ip_address IS NULL OR ip_address::text = '')`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (purchase_vendor IS NULL OR purchase_vendor = '')`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (support_contract_number IS NULL OR support_contract_number = '')`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND support_end_date IS NULL`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND support_end_date IS NOT NULL AND support_end_date < CURRENT_DATE`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND lifecycle_status = 'EOL / EOS'`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (site IS NULL OR site = '' OR site_id IS NULL)`),
      safeCount(`SELECT COUNT(*) AS n FROM v_devices_flat WHERE ${activeBase} AND (device_type IS NULL OR device_type = '')`),
    ])

    const rawFails = [
      missingSerial, missingIp, missingVendor, missingContract,
      missingEndDate, expiredSupport, eolActive, missingSite, missingType,
    ]

    const definitions = [
      { key: 'missing_serial',   label: 'Devices missing serial number',         href: '/devices' },
      { key: 'missing_ip',       label: 'Devices missing IP address',            href: '/devices' },
      { key: 'missing_vendor',   label: 'Devices missing purchase vendor',       href: '/devices' },
      { key: 'missing_contract', label: 'Devices missing support contract #',    href: '/devices' },
      { key: 'missing_end_date', label: 'Devices missing support end date',      href: '/devices' },
      { key: 'expired_support',  label: 'Devices with expired support contract', href: '/devices?support_expiry=expired' },
      { key: 'eol_active',       label: 'EOL/EOS devices still Active',          href: '/devices?lifecycle=EOL+%2F+EOS' },
      { key: 'missing_site',     label: 'Devices missing site assignment',       href: '/devices' },
      { key: 'missing_type',     label: 'Devices missing device type',           href: '/devices' },
    ]

    const checks = definitions.map((def, i) => {
      const fail = rawFails[i]
      const pass = total - fail
      const pct  = total > 0 ? Math.round((pass / total) * 100) : 100
      return { ...def, total, fail, pass, pct }
    })

    const score = checks.length > 0
      ? Math.round(checks.reduce((s, c) => s + c.pct, 0) / checks.length)
      : 100

    return NextResponse.json({ score, total, checks })
  } catch (err) {
    console.error('[compliance GET]', err)
    return NextResponse.json({ error: 'Failed to load compliance data' }, { status: 500 })
  }
}
