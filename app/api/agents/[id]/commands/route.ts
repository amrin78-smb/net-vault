import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

// The only instructions the hub command channel may carry. The agent already
// handles both (restart -> process.exit(0) under NSSM; get_logs -> logger.tail
// + POST back to /api/agents/[id]/logs). Any other type is rejected up front.
const ALLOWED_TYPES = new Set(['restart', 'get_logs'])

// POST /api/agents/[id]/commands (super_admin) — enqueue a pending command for
// the agent. There is NO server→agent socket: the row sits 'pending' until the
// agent's next heartbeat carries it back in the response (see the heartbeat
// route). This is the hub analog of SpanVault's sendToAgentId over its WS.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  try {
    const body = await req.json().catch(() => ({}))
    const type = typeof body.type === 'string' ? body.type : ''
    if (!ALLOWED_TYPES.has(type)) {
      return NextResponse.json({ error: `Unsupported command type: ${type || '(none)'}` }, { status: 400 })
    }

    // Confirm the agent exists before queuing (the FK would also reject an
    // unknown id, but a clean 404 is friendlier than a 500).
    const exists = await query('SELECT id FROM agents WHERE id = $1', [id])
    if (!exists.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const res = await query(
      `INSERT INTO agent_commands (agent_id, type)
       VALUES ($1, $2)
       RETURNING id, type, status`,
      [id, type]
    )
    const row = res.rows[0]
    return NextResponse.json({ id: row.id, type: row.type, status: row.status })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
