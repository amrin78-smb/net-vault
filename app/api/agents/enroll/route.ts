import { NextRequest, NextResponse } from 'next/server'
import { withTransaction } from '@/lib/db'
import {
  hashToken,
  newAgentId,
  issueAgentIdentity,
  deriveIngest,
  isKnownModule,
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
    const tokenHash = hashToken(token)
    const agentId = newAgentId() // random — no collision risk generating it up front

    // Whole flow is one transaction so the token BURN and the agent creation
    // commit together or not at all.
    const result = await withTransaction(async (client) => {
      // ── ATOMIC ONE-TIME BURN (fixes the TOCTOU) ──────────────────────────────
      // The `used_at IS NULL` predicate is the gate, not a JS check-then-act: two
      // concurrent redemptions of one token serialize on this row lock and only
      // the first matches (the loser gets 0 rows → we throw → the whole tx rolls
      // back, so no orphan agent). used_by is set in a follow-up UPDATE below
      // because the FK (used_by → agents.id) needs the agent row to exist first.
      const burn = await client.query(
        `UPDATE agent_enrollment_tokens
            SET used_at = NOW()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING created_by, preset`,
        [tokenHash]
      )
      if (!burn.rows.length) {
        const err = new Error('Invalid or expired token') as Error & { code?: string }
        err.code = 'INVALID_TOKEN'
        throw err
      }

      const row = burn.rows[0]
      const preset = (row.preset || {}) as {
        site_id?: number | null
        modules?: string[]
        configs?: Record<string, unknown>
      }
      // Drop any unknown/typo'd slug before it can be stored (whitelist).
      const modules: string[] = Array.isArray(preset.modules)
        ? preset.modules.filter(isKnownModule)
        : []
      const siteId = typeof preset.site_id === 'number' ? preset.site_id : null
      const name = (typeof hostname === 'string' && hostname.trim()) || agentId

      // Create the agent row (status online — it just checked in).
      await client.query(
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
          row.created_by,
        ]
      )

      // Now the agent exists — attach it to the burned token (FK satisfied).
      await client.query(
        `UPDATE agent_enrollment_tokens SET used_by = $1 WHERE token_hash = $2`,
        [agentId, tokenHash]
      )

      // Seed module assignments from the preset (enabled + optional per-module config).
      const presetConfigs = (preset.configs || {}) as Record<string, unknown>
      for (const app of modules) {
        const config =
          presetConfigs[app] && typeof presetConfigs[app] === 'object' ? presetConfigs[app] : {}
        await client.query(
          `INSERT INTO agent_modules (agent_id, app, enabled, config)
           VALUES ($1, $2, TRUE, $3)
           ON CONFLICT (agent_id, app) DO NOTHING`,
          [agentId, app, JSON.stringify(config)]
        )
      }

      const modRes = await client.query(
        `SELECT app, enabled, config FROM agent_modules WHERE agent_id = $1 ORDER BY app`,
        [agentId]
      )
      return { modules, modRows: modRes.rows as { app: string; enabled: boolean; config: unknown }[] }
    })

    // Build the module policy response (with data-plane ingest URLs).
    const modOut = result.modRows.map((m) => ({
      app: m.app,
      enabled: m.enabled,
      config: m.config,
      ingest: deriveIngest(m.app, req),
    }))

    return NextResponse.json({
      agent_id: agentId,
      identity: issueAgentIdentity(agentId, result.modules),
      modules: modOut,
    })
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'INVALID_TOKEN') {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
