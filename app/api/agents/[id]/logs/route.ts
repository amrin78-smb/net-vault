import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { requireAgentAuth } from '@/lib/agentIdentity'

export const dynamic = 'force-dynamic'

// POST /api/agents/[id]/logs — AGENT-authed (hub-signed JWT, sub must == [id],
// same guard shape as the heartbeat route). The return path for a get_logs
// command: the hub has no socket to receive the agent's push, so the agent POSTs
// its log tail here. Stashes it on agents.last_logs for the fleet page's GET to
// read, and — if the tail carries the originating command_id — marks that
// agent_commands row 'done' (the log POST IS the get_logs ack).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAgentAuth(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (auth.agentId !== id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = await req.json().catch(() => ({}))
    const lines = Array.isArray(body.lines)
      ? body.lines.filter((l: unknown): l is string => typeof l === 'string')
      : []
    // command_id ties the log tail back to the queued get_logs row so we can mark
    // it done. Accept a number or numeric string (BIGSERIAL id); ignore anything else.
    const rawCmd = body.command_id
    const commandId =
      typeof rawCmd === 'number' && Number.isFinite(rawCmd) ? String(Math.trunc(rawCmd))
      : typeof rawCmd === 'string' && /^\d+$/.test(rawCmd) ? rawCmd
      : null

    await query(
      `UPDATE agents SET last_logs = $1::jsonb, last_logs_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(lines), id]
    )

    if (commandId) {
      // Scope to this agent's own get_logs row so one agent's token can't close
      // another's command. Only flips a not-yet-done row.
      await query(
        `UPDATE agent_commands SET status = 'done', done_at = NOW()
         WHERE id = $1 AND agent_id = $2 AND type = 'get_logs' AND status <> 'done'`,
        [commandId, id]
      )
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// GET /api/agents/[id]/logs (super_admin) — the fleet page reads the last log
// tail the agent returned for a get_logs command. { lines, ts } (both null until
// the agent has ever answered a get_logs).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  try {
    const res = await query('SELECT last_logs, last_logs_at FROM agents WHERE id = $1', [id])
    if (!res.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const row = res.rows[0]
    const lines = Array.isArray(row.last_logs) ? row.last_logs : null
    return NextResponse.json({ lines, ts: row.last_logs_at ?? null })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
