import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Derive the fleet-view status from the stored row + latest health.
//   revoked  → revoked_at set
//   offline  → never seen, or last_seen_at older than 90s (edge is spooling)
//   degraded → connected but a module reports a non-'ok' status string
//   online   → healthy
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

// GET /api/agents (super_admin) — fleet list for the launcher Agents page.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const res = await query(`
      SELECT
        a.id, a.name, a.hostname, a.os, a.local_ip, a.site_id,
        a.agent_version, a.cert_fpr, a.enrolled_at, a.last_seen_at,
        a.revoked_at, a.created_at, a.updated_at,
        s.name AS site_name,
        COALESCE(
          (SELECT json_agg(json_build_object('app', m.app, 'enabled', m.enabled) ORDER BY m.app)
             FROM agent_modules m WHERE m.agent_id = a.id),
          '[]'
        ) AS modules,
        h.buffer_depth   AS buffer_depth,
        h.module_status  AS module_status
      FROM agents a
      LEFT JOIN sites s ON s.id = a.site_id
      LEFT JOIN LATERAL (
        SELECT buffer_depth, module_status
        FROM agent_health
        WHERE agent_id = a.id
        ORDER BY ts DESC
        LIMIT 1
      ) h ON TRUE
      ORDER BY a.created_at DESC
    `)

    const agents = res.rows.map((r: {
      id: string; name: string; hostname: string | null; os: string | null; local_ip: string | null;
      site_id: number | null; agent_version: string | null; cert_fpr: string | null;
      enrolled_at: string | null; last_seen_at: string | null; revoked_at: string | null;
      created_at: string; updated_at: string; site_name: string | null;
      modules: { app: string; enabled: boolean }[]; buffer_depth: number | null;
      module_status: Record<string, unknown> | null
    }) => ({
      id: r.id,
      name: r.name,
      hostname: r.hostname,
      os: r.os,
      local_ip: r.local_ip,
      site_id: r.site_id,
      site_name: r.site_name,
      agent_version: r.agent_version,
      cert_fpr: r.cert_fpr,
      enrolled_at: r.enrolled_at,
      last_seen_at: r.last_seen_at,
      revoked_at: r.revoked_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      modules: r.modules,
      buffer_depth: r.buffer_depth,
      status: deriveStatus(r.revoked_at, r.last_seen_at, r.module_status),
    }))

    return NextResponse.json({ agents })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
