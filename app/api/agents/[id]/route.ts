import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { isKnownModule } from '@/lib/agentIdentity'

export const dynamic = 'force-dynamic'

function deriveStatus(
  revokedAt: string | null,
  lastSeenAt: string | null,
  moduleStatus: Record<string, unknown> | null
): string {
  if (revokedAt) return 'revoked'
  if (!lastSeenAt || new Date(lastSeenAt).getTime() < Date.now() - 90_000) return 'offline'
  if (moduleStatus && typeof moduleStatus === 'object') {
    for (const v of Object.values(moduleStatus)) {
      if (typeof v === 'string' && v && v !== 'ok') return 'degraded'
    }
  }
  return 'online'
}

// Assemble the full agent detail: row + site name + modules + last ~20 health
// rows + derived status. Returns null if the agent does not exist.
async function getAgentDetail(id: string) {
  const res = await query(
    `SELECT a.*, s.name AS site_name
       FROM agents a LEFT JOIN sites s ON s.id = a.site_id
      WHERE a.id = $1`,
    [id]
  )
  const a = res.rows[0]
  if (!a) return null

  const modRes = await query(
    `SELECT app, enabled, config FROM agent_modules WHERE agent_id = $1 ORDER BY app`,
    [id]
  )
  const healthRes = await query(
    `SELECT ts, cpu_pct, mem_pct, buffer_depth, module_status
       FROM agent_health WHERE agent_id = $1 ORDER BY ts DESC LIMIT 20`,
    [id]
  )
  const latest = healthRes.rows[0] || null

  return {
    id: a.id,
    name: a.name,
    hostname: a.hostname,
    os: a.os,
    local_ip: a.local_ip,
    site_id: a.site_id,
    site_name: a.site_name,
    agent_version: a.agent_version,
    cert_fpr: a.cert_fpr,
    enrolled_at: a.enrolled_at,
    last_seen_at: a.last_seen_at,
    revoked_at: a.revoked_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
    status: deriveStatus(a.revoked_at, a.last_seen_at, latest?.module_status ?? null),
    buffer_depth: latest?.buffer_depth ?? null,
    modules: modRes.rows,
    health: healthRes.rows,
  }
}

// GET /api/agents/[id] (super_admin) — detail + last ~20 health rows.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  try {
    const detail = await getAgentDetail(id)
    if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(detail)
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// PATCH /api/agents/[id] (super_admin) — update name/site_id + upsert/toggle
// module assignments. Returns the updated detail.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  try {
    const exists = await query('SELECT id FROM agents WHERE id = $1', [id])
    if (!exists.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name : null
    const siteIdProvided = Object.prototype.hasOwnProperty.call(body, 'site_id')
    const siteId = typeof body.site_id === 'number' ? body.site_id : null

    // Whitelist module slugs up front — reject an unknown slug with 400 (this
    // route's stricter validation style) BEFORE any DB write, so a partial
    // update can't land.
    if (Array.isArray(body.modules)) {
      for (const m of body.modules) {
        if (m && typeof m.app === 'string' && !isKnownModule(m.app)) {
          return NextResponse.json({ error: `Unknown module slug: ${m.app}` }, { status: 400 })
        }
      }
    }

    // COALESCE keeps the existing value when the field is absent; site_id is
    // explicitly settable to NULL when the caller sends site_id:null.
    await query(
      `UPDATE agents SET
         name    = COALESCE($1, name),
         site_id = CASE WHEN $2 THEN $3 ELSE site_id END,
         updated_at = NOW()
       WHERE id = $4`,
      [name, siteIdProvided, siteId, id]
    )

    if (Array.isArray(body.modules)) {
      for (const m of body.modules) {
        if (!isKnownModule(m?.app)) continue
        // Only overwrite `enabled` when the caller actually sent it — mirroring
        // the `config` handling below — so a body like {app:'log'} (no enabled)
        // does NOT silently re-enable a module an admin had disabled.
        const hasEnabled = Object.prototype.hasOwnProperty.call(m, 'enabled')
        const enabled = hasEnabled && typeof m.enabled === 'boolean' ? m.enabled : true
        const hasConfig = Object.prototype.hasOwnProperty.call(m, 'config')
        const config = hasConfig && m.config && typeof m.config === 'object' ? m.config : {}
        await query(
          `INSERT INTO agent_modules (agent_id, app, enabled, config)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (agent_id, app) DO UPDATE SET
             enabled = CASE WHEN $6 THEN EXCLUDED.enabled ELSE agent_modules.enabled END,
             config  = CASE WHEN $5 THEN EXCLUDED.config ELSE agent_modules.config END`,
          [id, m.app, enabled, JSON.stringify(config), hasConfig, hasEnabled]
        )
      }
    }

    const detail = await getAgentDetail(id)
    return NextResponse.json(detail)
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
