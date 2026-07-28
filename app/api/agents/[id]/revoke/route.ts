import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/agents/[id]/revoke (super_admin) — revoke an agent's identity. Its
// tunnels are refused suite-wide on next connect (requireAgentAuth rejects a
// still-valid JWT once revoked_at is set).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  try {
    const res = await query(
      `UPDATE agents SET revoked_at = NOW(), status = 'revoked', updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id]
    )
    if (!res.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Active-kick fan-out (Phase 3 A3): the revoke above stops the NEXT connect
    // (every app's connect-time check refuses a revoked agent), but a LIVE data
    // session would linger until it reconnects. So best-effort tell each app the
    // agent's modules cover to drop its live socket now. The connect-time check
    // is the backstop if this kick doesn't land, so this is deliberately
    // NON-FATAL — a failed/slow app must never block the revoke itself.
    await fanOutRevoke(id)

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// Fan the revoke out to the data planes the agent's modules cover. Phase 3 only
// SpanVault has a live data plane (its ws-server + loopback disconnect route) —
// DDIVault/LogVault ingest endpoints don't exist yet, so we only kick span here;
// add ddi/log fan-out when those data planes ship (Phase 4/5). Whole thing is
// best-effort: any error is logged and swallowed so revoke still returns success.
async function fanOutRevoke(id: string): Promise<void> {
  try {
    const mods = await query(
      'SELECT app FROM agent_modules WHERE agent_id = $1 AND enabled = true',
      [id]
    )
    // Normalize slugs (span/spanvault → spanvault) and de-dupe.
    const apps = new Set(
      mods.rows.map((r: { app: string }) => (r.app === 'span' ? 'spanvault' : r.app))
    )

    if (apps.has('spanvault')) {
      // 127.0.0.1, NOT localhost — localhost resolves to ::1 (IPv6) first on
      // Windows and the app listens IPv4-only, stalling ~1s per probe (CLAUDE.md).
      const base = process.env.SPANVAULT_INTERNAL_URL || 'http://127.0.0.1:3009'
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000) // short timeout
      try {
        await fetch(`${base}/api/internal/agents/disconnect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hub_agent_id: id }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    }
  } catch (e) {
    // Non-fatal: connect-time revocation check is the backstop.
    console.error('revoke active-kick fan-out failed (non-fatal):', e)
  }
}
