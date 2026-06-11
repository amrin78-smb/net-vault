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
  return 'EMEA'
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []
    const siteFilter = isSiteAdmin && siteIds.length ? `WHERE d.site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''

    try {
      // Join devices -> sites (for city) -> countries -> regions.
      const res = await query(`
        SELECT
          s.name AS site_name,
          s.city AS city,
          c.name AS country,
          r.name AS region,
          COUNT(*) FILTER (WHERE d.lifecycle_status = 'EOL / EOS') AS eol_count,
          COUNT(*) AS total_count
        FROM devices d
        LEFT JOIN sites     s ON s.id = d.site_id
        LEFT JOIN countries c ON c.id = s.country_id
        LEFT JOIN regions   r ON r.id = c.region_id
        ${siteFilter}
        GROUP BY s.id, s.name, s.city, c.name, r.name
        HAVING COUNT(*) FILTER (WHERE d.lifecycle_status = 'EOL / EOS') > 0
        ORDER BY eol_count DESC
        LIMIT 5
      `)
      return NextResponse.json(
        res.rows.map((row) => {
          const eol_count = parseInt(row.eol_count ?? '0') || 0
          const total_count = parseInt(row.total_count ?? '0') || 0
          return {
            site_name: row.site_name,
            city: row.city,
            country: row.country,
            region: bucketRegion(row.country),
            eol_count,
            total_count,
            eol_pct: total_count > 0 ? Math.round((eol_count / total_count) * 100) : 0,
          }
        })
      )
    } catch (err) {
      console.error('[dashboard/top-eol-sites] query failed:', err)
      return NextResponse.json([])
    }
  } catch (err) {
    console.error('[dashboard/top-eol-sites GET]', err)
    return NextResponse.json([])
  }
}
