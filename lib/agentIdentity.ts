import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import type { NextRequest } from 'next/server'
import { query } from '@/lib/db'

// Data-plane ingest ports per module. The agent opens a direct wss tunnel to
// each assigned app on these ports (the hub only carries control traffic).
// spanvault:3010 (Phase 1) and ddivault:3011 (Phase 4b) are the live ingest ports.
// Both long ('spanvault') and short ('span') slugs resolve, since either may appear
// in an enrollment preset. (A LogVault agent module was considered and DEFERRED —
// see docs/nocvault-agents-phase5-plan.md — so there is no `log`/`logvault` module.)
export const PORT_MAP: Record<string, number> = {
  spanvault: 3010, span: 3010, // real (SpanVault Phase 1)
  ddivault: 3011,  ddi: 3011,  // real (DDIVault Phase 4b)
}

// Allow-set of module slugs an agent may be assigned. Both the short canonical
// form ('span'/'ddi') and the long form ('spanvault'/'ddivault')
// are accepted — either may appear in an enrollment preset — and derived straight
// from PORT_MAP so the two never drift. Any other value is rejected before it can
// be written to agent_modules.app (guards against a typo'd/arbitrary slug).
export const KNOWN_MODULE_SLUGS: ReadonlySet<string> = new Set(Object.keys(PORT_MAP))

// Type-guard: true only for a string that is a known module slug.
export function isKnownModule(app: unknown): app is string {
  return typeof app === 'string' && KNOWN_MODULE_SLUGS.has(app)
}

// Map any accepted spelling of a module slug to the APP name ('spanvault' /
// 'ddivault'). agent_modules.app stores whichever form the enrollment preset used
// — in practice the SHORT one ('span','ddi') — so anything matching a module
// against an app name must normalize first. Both revoke and delete fan-outs did
// this for span only, leaving `apps.has('ddivault')` permanently false and the
// DDIVault half of each fan-out silently dead. One helper so they cannot drift.
export function toAppSlug(app: string): string {
  const a = String(app || '').toLowerCase().trim()
  if (a === 'span') return 'spanvault'
  if (a === 'ddi') return 'ddivault'
  return a
}

// Derive the data-plane ingest URL for a module from the CURRENT request host
// (so it follows whatever hostname the agent reached the hub through — same
// host-resolution shape as lib/publicUrl.resolveOrigin). ws over http, wss over
// https. Returns null for an unknown module slug.
export function deriveIngest(app: string, req: NextRequest): string | null {
  const port = PORT_MAP[app]
  if (!port) return null

  // Split deployments: the request host is the HUB's host, which is only the right
  // answer when the satellite is co-located with it. Deriving from the request
  // merely moves the assumption (it used to be "co-located with SpanVault"); it
  // does not remove it. An operator running a satellite on its own box sets
  // SPANVAULT_PUBLIC_HOST / DDIVAULT_PUBLIC_HOST and the agent is told the truth.
  // Unset — the overwhelmingly common single-server install — behaves exactly as
  // before, so this is additive.
  const overrideEnv = toAppSlug(app) === 'ddivault' ? 'DDIVAULT_PUBLIC_HOST' : 'SPANVAULT_PUBLIC_HOST'
  const override = (process.env[overrideEnv] || '').trim()

  const rawHost = override || req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const host = rawHost.split(':')[0].trim()
  if (!host) return null
  const proto = (req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'http')
    .split(',')[0]
    .trim()
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}:${port}/`
}

// NocVault Agents Phase 2 — hub-issued agent identity.
//
// The hub signs a per-agent JWT with the suite-shared NEXTAUTH_SECRET (the same
// trust root SSO already uses). Each satellite app verifies that signature to
// accept an agent's data tunnel — no app runs its own enrollment. Tokens carry
// `typ:'agent'` so they can never be confused with a user SSO token, and
// `aud` = the modules (apps) the agent is assigned to.

export interface AgentIdentity {
  jwt: string
  expires_at: string
}

export interface AgentAuth {
  agentId: string
  modules: string[]
}

interface AgentTokenClaims {
  sub: string
  typ: string
  aud: string[]
  iat: number
  exp: number
}

// Sign a durable agent identity. `modules` become the token audience; the agent
// presents this to each assigned app's ingest endpoint.
//
// Default TTL is 7 days: now that agents refresh their identity before expiry
// (POST /api/agents/[id]/refresh, Phase 3 A5), a shorter TTL shrinks the window
// a revoked-but-unexpired token stays usable between reconnects. Callers may
// still override `ttlDays`.
export function issueAgentIdentity(
  agentId: string,
  modules: string[],
  ttlDays = 7
): AgentIdentity {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttlDays * 24 * 60 * 60
  const token = jwt.sign(
    { sub: agentId, typ: 'agent', aud: modules, iat, exp },
    process.env.NEXTAUTH_SECRET!,
    { algorithm: 'HS256' }
  )
  return { jwt: token, expires_at: new Date(exp * 1000).toISOString() }
}

// Verify signature + typ + expiry. Returns null on ANY failure (bad sig,
// wrong typ, expired) — callers treat null as "reject".
export function verifyAgentIdentity(token: string): AgentAuth | null {
  try {
    // Pin HS256 so a hub-symmetric secret can never be tricked into accepting a
    // different algorithm (defence-in-depth; we only ever sign HS256).
    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!, {
      algorithms: ['HS256'],
    }) as AgentTokenClaims
    if (!decoded || decoded.typ !== 'agent' || !decoded.sub) return null
    const aud = decoded.aud
    const modules = Array.isArray(aud) ? aud : aud ? [aud] : []
    return { agentId: decoded.sub, modules }
  } catch {
    return null
  }
}

// sha256 hex — used to store enrollment tokens as a hash (never the raw token).
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// One-time enrollment token handed to an admin for the install one-liner.
export function newEnrollToken(): string {
  return 'enr_' + crypto.randomBytes(24).toString('hex')
}

// Opaque durable agent id.
export function newAgentId(): string {
  return 'agt_' + crypto.randomBytes(9).toString('hex')
}

// Bearer-token gate for agent-authed routes. Reads `Authorization: Bearer <jwt>`,
// verifies the signature, AND confirms the agent row still exists and is not
// revoked — so a still-valid JWT for a revoked agent is rejected. Returns the
// agent auth (id + modules) or null.
export async function requireAgentAuth(req: {
  headers: { get(name: string): string | null }
}): Promise<AgentAuth | null> {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const auth = verifyAgentIdentity(match[1].trim())
  if (!auth) return null
  try {
    const res = await query(
      'SELECT id FROM agents WHERE id = $1 AND revoked_at IS NULL',
      [auth.agentId]
    )
    if (!res.rows.length) return null
  } catch {
    return null
  }
  return auth
}
