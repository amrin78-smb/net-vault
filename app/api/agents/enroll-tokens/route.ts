import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { newEnrollToken, hashToken, isKnownModule } from '@/lib/agentIdentity'
import { resolveOrigin } from '@/lib/publicUrl'

export const dynamic = 'force-dynamic'

// POST /api/agents/enroll-tokens (super_admin) — mint a one-time enrollment
// token (+ site/module preset) and return the install one-liner. Only the
// token HASH is stored; the raw token is returned once and never persisted.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; id: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = await req.json().catch(() => ({}))
    // Whitelist known module slugs (both forms) — silently drop anything else so
    // a typo'd/arbitrary slug can't be baked into the preset.
    const modules: string[] = Array.isArray(body.modules)
      ? body.modules.filter(isKnownModule)
      : []
    const siteId = typeof body.site_id === 'number' ? body.site_id : null
    const note = typeof body.note === 'string' ? body.note : null

    const token = newEnrollToken()
    const preset = { site_id: siteId, modules }

    const res = await query(
      `INSERT INTO agent_enrollment_tokens (token_hash, created_by, expires_at, preset, note)
       VALUES ($1, $2, NOW() + interval '60 min', $3, $4)
       RETURNING expires_at`,
      [hashToken(token), parseInt(user.id), JSON.stringify(preset), note]
    )

    const origin = resolveOrigin(req, 3000, process.env.NEXTAUTH_URL || 'http://localhost:3000')
    const install_command = `& ([scriptblock]::Create((irm ${origin}/api/agents/install.ps1))) -Token "${token}"`

    return NextResponse.json({
      token,
      expires_at: res.rows[0].expires_at,
      install_command,
    })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
