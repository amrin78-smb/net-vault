import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

const APAC = new Set([
  'thailand', 'vietnam', 'japan', 'china', 'singapore', 'indonesia', 'malaysia',
  'australia', 'philippines', 'india', 'south korea', 'hong kong', 'taiwan', 'new zealand',
])
const NAM = new Set(['united states', 'usa', 'us', 'canada', 'mexico'])

function bucketRegion(country: string | null | undefined): 'APAC' | 'EMEA' | 'NAM' | 'Other' {
  if (!country || !country.trim()) return 'Other'
  const c = country.trim().toLowerCase()
  if (APAC.has(c)) return 'APAC'
  if (NAM.has(c)) return 'NAM'
  return 'EMEA' // catch-all for known EU/UK/Gulf/Africa names
}

export async function GET() {
  const REGIONS: Array<'APAC' | 'EMEA' | 'NAM' | 'Other'> = ['APAC', 'EMEA', 'NAM', 'Other']
  const emptyPayload = () => REGIONS.map((region) => ({ region, healthy: 0, eol: 0, total: 0 }))

  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []
    const vFilter = isSiteAdmin && siteIds.length ? `WHERE site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

    const acc: Record<'APAC' | 'EMEA' | 'NAM' | 'Other', { healthy: number; eol: number; total: number }> = {
      APAC: { healthy: 0, eol: 0, total: 0 },
      EMEA: { healthy: 0, eol: 0, total: 0 },
      NAM: { healthy: 0, eol: 0, total: 0 },
      Other: { healthy: 0, eol: 0, total: 0 },
    }

    try {
      const res = await query(`
        SELECT country,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE lifecycle_status = 'EOL / EOS') AS eol
        FROM v_devices_flat ${vFilter}
        GROUP BY country
      `)
      for (const row of res.rows) {
        const bucket = bucketRegion(row.country)
        const total = parseInt(row.total ?? '0') || 0
        const eol = parseInt(row.eol ?? '0') || 0
        acc[bucket].total += total
        acc[bucket].eol += eol
        acc[bucket].healthy += total - eol
      }
    } catch (err) {
      console.error('[dashboard/devices-by-region] query failed:', err)
    }

    return NextResponse.json(
      REGIONS.map((region) => ({
        region,
        healthy: acc[region].healthy,
        eol: acc[region].eol,
        total: acc[region].total,
      }))
    )
  } catch (err) {
    console.error('[dashboard/devices-by-region GET]', err)
    return NextResponse.json(emptyPayload())
  }
}
