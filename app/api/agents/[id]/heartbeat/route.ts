import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { requireAgentAuth } from '@/lib/agentIdentity'

export const dynamic = 'force-dynamic'

// POST /api/agents/[id]/heartbeat — agent-authed (hub-signed JWT). Records
// liveness + a health sample. The JWT `sub` must match the [id] in the path, so
// one agent's token can't post heartbeats for another.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAgentAuth(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (auth.agentId !== id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = await req.json().catch(() => ({}))
    const version = typeof body.version === 'string' ? body.version : null
    const health = (body.health && typeof body.health === 'object' ? body.health : {}) as {
      cpu_pct?: number
      mem_pct?: number
    }
    const cpu = typeof health.cpu_pct === 'number' ? health.cpu_pct : null
    const mem = typeof health.mem_pct === 'number' ? health.mem_pct : null
    const bufferDepth = typeof body.buffer_depth === 'number' ? body.buffer_depth : null
    const moduleStatus =
      body.module_status && typeof body.module_status === 'object' ? body.module_status : null

    await query(
      `UPDATE agents SET
         last_seen_at = NOW(),
         status = 'online',
         agent_version = COALESCE($1, agent_version),
         updated_at = NOW()
       WHERE id = $2`,
      [version, id]
    )

    await query(
      `INSERT INTO agent_health (agent_id, cpu_pct, mem_pct, buffer_depth, module_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, cpu, mem, bufferDepth, moduleStatus ? JSON.stringify(moduleStatus) : null]
    )

    // Opportunistic bound on agent_health growth: prune THIS agent's rows older
    // than 7 days. Runs AFTER the liveness UPDATE + health INSERT above so a
    // prune error can never lose the heartbeat that already committed.
    await query(
      `DELETE FROM agent_health WHERE agent_id = $1 AND ts < NOW() - interval '7 days'`,
      [id]
    )

    // Poll-carried command channel (Phase 4a): the heartbeat RESPONSE is the only
    // way the hub reaches the agent (no server→agent socket). Atomically claim
    // this agent's pending commands — the UPDATE … RETURNING flips them to
    // 'delivered' and hands them back in the SAME statement, so a command is
    // carried exactly once (a concurrent beat can't re-read a still-pending row).
    const cmds = await query(
      `UPDATE agent_commands
          SET status = 'delivered', delivered_at = NOW()
        WHERE agent_id = $1 AND status = 'pending'
      RETURNING id, type, args`,
      [id]
    )
    const commands = cmds.rows.map((c: { id: string | number; type: string; args: unknown }) => ({
      id: c.id,
      type: c.type,
      args: c.args ?? {},
    }))

    return NextResponse.json({ ok: true, commands })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
