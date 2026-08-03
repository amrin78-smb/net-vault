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
    const rawModules: unknown[] = Array.isArray(body.modules) ? body.modules : []
    const modules: string[] = rawModules.filter(isKnownModule)
    // Loud, not silent: if the admin sent a non-empty module set but NONE survived
    // the whitelist (a typo, or a now-removed slug like 'log'), reject at mint time
    // rather than baking an empty preset that would enrol a green-but-inert agent
    // with an empty JWT aud. An intentionally-empty preset (raw was empty) is fine.
    if (rawModules.length > 0 && modules.length === 0) {
      return NextResponse.json({ error: 'No valid modules (known: span, ddi)' }, { status: 400 })
    }
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
    // Carry the chosen modules into the installer so they reach the agent's
    // config.json. The preset above only seeds the HUB's agent_modules rows (what
    // the fleet page displays); the agent decides which modules to actually LOAD
    // from its own config.json alone (nocvault-agent.js moduleEnabled()). Without
    // this the two silently disagree: the hub showed "ddi enabled" while the agent
    // never loaded ddi, so DDIVault's Remote Agents page stayed empty forever and
    // module_status reported only {span:'ok'}. Slugs are already whitelisted above.
    const modulesArg = modules.length > 0 ? ` -Modules "${modules.join(',')}"` : ''
    const install_command = `& ([scriptblock]::Create((irm ${origin}/api/agents/install.ps1))) -Token "${token}"${modulesArg}`

    return NextResponse.json({
      token,
      expires_at: res.rows[0].expires_at,
      install_command,
    })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
