import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { requireAgentAuth, deriveIngest } from '@/lib/agentIdentity'

export const dynamic = 'force-dynamic'

// GET /api/agents/[id]/policy — agent-authed. Returns the module assignment +
// per-module work-plan (config) and the data-plane ingest URL. An agent may
// only read its OWN policy (JWT sub must match [id]).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAgentAuth(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (auth.agentId !== id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const res = await query(
      `SELECT app, enabled, config FROM agent_modules WHERE agent_id = $1 ORDER BY app`,
      [id]
    )
    const modules = res.rows.map((m: { app: string; enabled: boolean; config: unknown }) => ({
      app: m.app,
      enabled: m.enabled,
      config: m.config,
      ingest: deriveIngest(m.app, req),
    }))
    return NextResponse.json({ modules })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
