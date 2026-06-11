import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

// Public stats endpoint (no auth), mirrors /api/health's openness.
export async function GET() {
  try {
    const [devices, sites, eol] = await Promise.all([
      query(`SELECT COUNT(*) AS count FROM devices`),
      query(`SELECT COUNT(*) AS count FROM sites`),
      query(`SELECT COUNT(*) AS count FROM devices WHERE lifecycle_status = 'EOL / EOS'`),
    ])
    return NextResponse.json({
      devices_total: parseInt(devices.rows[0].count, 10),
      sites_total: parseInt(sites.rows[0].count, 10),
      eol_total: parseInt(eol.rows[0].count, 10),
    })
  } catch {
    // Never 500 — degrade to zeros so the dashboard widget stays alive.
    return NextResponse.json({ devices_total: 0, sites_total: 0, eol_total: 0 })
  }
}
