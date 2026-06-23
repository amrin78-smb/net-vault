import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { computeCompliance } from '@/lib/compliance'

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

    const result = await computeCompliance(activeBase)

    return NextResponse.json(result)
  } catch (err) {
    console.error('[compliance GET]', err)
    return NextResponse.json({ error: 'Failed to load compliance data' }, { status: 500 })
  }
}
