import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import {
  hashToken,
  newAgentId,
  issueAgentIdentity,
  deriveIngest,
} from '@/lib/agentIdentity'

export const dynamic = 'force-dynamic'

// POST /api/agents/enroll — PUBLIC, token-authed (NO session). An agent redeems
// a one-time enrollment token + host facts and receives a durable agent id, a
// hub-signed identity, and its initial module policy.
//
// This is an intentionally public WRITE route: enrollment is gated by the
// one-time token, not by a user session. NetVault has no global request gate
// (per-route auth only), so we simply do NOT call getServerSession here. We also
// deliberately do NOT call the license `checkWriteAllowed()` guard the
// user-facing write routes use — enrollment is token-gated infrastructure
// provisioning, not licensed application data entry.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { token, hostname, os, agent_version, local_ip } = body || {}
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Token required' }, { status: 401 })
    }

    // Look up the token by hash; reject if missing / expired / already used.
    const tokRes = await query(
      `SELECT token_hash, created_by, expires_at, preset, used_at
       FROM agent_enrollment_tokens
       WHERE token_hash = $1`,
      [hashToken(token)]
    )
    const tok = tokRes.rows[0]
    if (!tok || tok.used_at || new Date(tok.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const preset = (tok.preset || {}) as {
      site_id?: number | null
      modules?: string[]
      configs?: Record<string, unknown>
    }
    const modules: string[] = Array.isArray(preset.modules)
      ? preset.modules.filter((m) => typeof m === 'string')
      : []
    const siteId = typeof preset.site_id === 'number' ? preset.site_id : null

    const agentId = newAgentId()
    const name = (typeof hostname === 'string' && hostname.trim()) || agentId

    // Create the agent row (status online — it just checked in).
    await query(
      `INSERT INTO agents
         (id, name, hostname, os, local_ip, site_id, status, agent_version,
          enrolled_at, last_seen_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'online', $7, NOW(), NOW(), $8)`,
      [
        agentId,
        name,
        hostname || null,
        os || null,
        local_ip || null,
        siteId,
        agent_version || null,
        tok.created_by,
      ]
    )

    // Seed module assignments from the preset (enabled + optional per-module config).
    const presetConfigs = (preset.configs || {}) as Record<string, unknown>
    for (const app of modules) {
      const config = presetConfigs[app] && typeof presetConfigs[app] === 'object' ? presetConfigs[app] : {}
      await query(
        `INSERT INTO agent_modules (agent_id, app, enabled, config)
         VALUES ($1, $2, TRUE, $3)
         ON CONFLICT (agent_id, app) DO NOTHING`,
        [agentId, app, JSON.stringify(config)]
      )
    }

    // Burn the token.
    await query(
      `UPDATE agent_enrollment_tokens SET used_at = NOW(), used_by = $1 WHERE token_hash = $2`,
      [agentId, hashToken(token)]
    )

    // Build the module policy response (with data-plane ingest URLs).
    const modRes = await query(
      `SELECT app, enabled, config FROM agent_modules WHERE agent_id = $1 ORDER BY app`,
      [agentId]
    )
    const modOut = modRes.rows.map((m: { app: string; enabled: boolean; config: unknown }) => ({
      app: m.app,
      enabled: m.enabled,
      config: m.config,
      ingest: deriveIngest(m.app, req),
    }))

    return NextResponse.json({
      agent_id: agentId,
      identity: issueAgentIdentity(agentId, modules),
      modules: modOut,
    })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
