import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { syncFromFeed } from '@/lib/eolFeed'
import { requireEol } from '@/lib/entitlements'

export const dynamic = 'force-dynamic'

// Inline super_admin guard (mirrors /api/admin/eol-seed).
async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { user }
}

/**
 * POST /api/admin/eol-seed/sync — pull the central signed EOL feed into eol_seed.
 * super_admin only. Writes ONLY to eol_seed (never devices); signature-verified.
 */
export async function POST() {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    const result = await syncFromFeed()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[admin/eol-seed/sync]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Feed sync failed' },
      { status: 500 }
    )
  }
}
