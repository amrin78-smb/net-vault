import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

function relativeTime(changedAt: string | Date | null | undefined): string {
  if (!changedAt) return ''
  const then = new Date(changedAt).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))

  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min${diffMin === 1 ? '' : 's'} ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  return new Date(changedAt).toLocaleDateString()
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const sessionUser = session.user as { role: string; siteIds?: number[] }
    const isSiteAdmin = sessionUser.role === 'site_admin'
    const siteIds = sessionUser.siteIds || []

    try {
      const res = await query(`
        SELECT a.field_name, a.changed_at,
               u.name AS changed_by_name,
               d.name AS device_name
        FROM audit_log a
        LEFT JOIN users   u ON u.id = a.changed_by
        LEFT JOIN devices d ON d.id = a.device_id
        ${isSiteAdmin && siteIds.length ? `WHERE d.site_id = ANY(ARRAY[${siteIds.join(',')}])` : ''}
        ORDER BY a.changed_at DESC
        LIMIT 6
      `)
      return NextResponse.json(
        res.rows.map((row) => ({
          action: row.field_name ?? '',
          entity: row.device_name ?? '—',
          user: row.changed_by_name ?? 'System',
          time: relativeTime(row.changed_at),
        }))
      )
    } catch (err) {
      console.error('[dashboard/recent-activity] query failed:', err)
      return NextResponse.json([])
    }
  } catch (err) {
    console.error('[dashboard/recent-activity GET]', err)
    return NextResponse.json([])
  }
}
