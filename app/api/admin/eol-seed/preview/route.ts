import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { requireEol } from '@/lib/entitlements'
import { previewMatch } from '@/lib/eolEnrich'

async function requireSuperAdmin() {
  const session = await getServerSession(authOptions)
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const user = session.user as { id?: string; role?: string }
  if (user.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

/**
 * GET /api/admin/eol-seed/preview?vendor=&model=
 * Read-only: how many devices the matching engine would match for this
 * (vendor, model) candidate. No writes. super_admin only.
 *
 * Response: { normalized, count, sample: [{ id, name, model }] }
 */
export async function GET(req: NextRequest) {
  const guard = await requireSuperAdmin()
  if (guard.error) return guard.error
  const gate = await requireEol()
  if (gate) return gate

  try {
    const sp = new URL(req.url).searchParams
    const vendor = sp.get('vendor') || ''
    const model = sp.get('model') || ''
    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 })
    }
    const preview = await previewMatch(vendor, model)
    return NextResponse.json(preview)
  } catch (err) {
    console.error('[admin/eol-seed/preview GET]', err)
    return NextResponse.json({ error: 'Preview failed' }, { status: 500 })
  }
}
