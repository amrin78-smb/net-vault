import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { requireAgentAuth, issueAgentIdentity } from '@/lib/agentIdentity'

export const dynamic = 'force-dynamic'

// POST /api/agents/[id]/refresh — agent-authed (hub-signed JWT). Re-issues a
// fresh identity so an agent's data-path credential never dies at the TTL. The
// JWT `sub` must match the [id] in the path, so one agent can't refresh another.
//
// requireAgentAuth already rejects a revoked agent (it checks revoked_at IS
// NULL), so a revoked agent's refresh returns 401 — the intended stop signal
// the agent uses to give up (no-spin), matching the revocation window shrink
// that motivates the shorter default TTL (see issueAgentIdentity).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAgentAuth(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (auth.agentId !== id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    // Re-read the CURRENT enabled modules from the DB (not the token's `aud`), so
    // a refreshed identity reflects any module changes an admin made since enroll.
    const res = await query(
      'SELECT app FROM agent_modules WHERE agent_id = $1 AND enabled = true',
      [id]
    )
    const modules = res.rows.map((r: { app: string }) => r.app)

    // A refresh proves liveness — treat it like a light heartbeat.
    await query('UPDATE agents SET last_seen_at = NOW() WHERE id = $1', [id])

    // Return the AgentIdentity object directly: { jwt, expires_at }. CONTRACT —
    // the agent persists this and presents `jwt` as its Bearer everywhere; keep
    // the field names `jwt` and `expires_at` (same shape enroll returns).
    return NextResponse.json(issueAgentIdentity(id, modules))
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
