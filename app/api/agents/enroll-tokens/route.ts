import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { query } from '@/lib/db'
import { newEnrollToken, hashToken, isKnownModule, toAppSlug } from '@/lib/agentIdentity'
import { resolveOrigin } from '@/lib/publicUrl'

export const dynamic = 'force-dynamic'

// ` -WsFingerprint "<sha256>"` for the enrolled modules, or '' when no pin is
// configured — in which case the emitted command is byte-identical to the
// pre-TLS one, so a normal install is untouched.
//
// The pin is the SHA-256 of the SELF-SIGNED certificate each app server
// generates for its ingest listener, published to the hub as
// SPANVAULT_WS_FINGERPRINT / DDIVAULT_WS_FINGERPRINT (same per-app env shape as
// *_PUBLIC_HOST and *_WS_TLS in lib/agentIdentity).
//
// Pins are stored per app (`config.wsFingerprints.span` / `.ddi`), so a
// dual-module agent verifies each ingest against its own certificate. On the
// usual single-host install both listeners share one cert and one pin covers
// both. An app with no pin connects encrypted-but-unpinned — transport.js warns
// rather than refusing, so pinning one app never strands the other.
function fingerprintFor(modules: string[]): string {
  // No preset => the agent loads span only (see install.ps1's -Modules default),
  // so span is the module whose pin applies.
  const apps = modules.length > 0 ? modules : ['span']
  const slugs = new Set(apps.map((a) => toAppSlug(a)))

  // Shape-check before interpolating: this value is pasted verbatim into a
  // PowerShell one-liner, and a fingerprint is only ever hex (with or without
  // the colon separators openssl prints). Anything else is a misconfiguration,
  // and emitting it would be a command-injection vector.
  const pin = (envName: string): string => {
    const raw = (process.env[envName] || '').trim()
    return /^[0-9a-fA-F]{2}(:?[0-9a-fA-F]{2})+$/.test(raw) ? raw : ''
  }

  // Emitted per app, because SpanVault and DDIVault present their OWN
  // self-signed certificate whenever they are on different hosts — a single pin
  // would verify one endpoint and reject the other, and the agent applies these
  // to two separate connections (config.wsFingerprints in core/transport.js).
  // On the usual single-host install one cert serves both listeners, so
  // -WsFingerprint alone is enough and install.ps1 copies it to both.
  const span = pin('SPANVAULT_WS_FINGERPRINT')
  const ddi = slugs.has('ddivault') ? pin('DDIVAULT_WS_FINGERPRINT') : ''

  let out = ''
  if (span) out += ` -WsFingerprint "${span}"`
  // Only worth emitting when it actually differs from the span pin — otherwise
  // install.ps1 already applies -WsFingerprint to both and the extra argument is
  // noise in a command the operator has to read.
  if (ddi && ddi !== span) out += ` -WsFingerprintDdi "${ddi}"`
  // ddi-only enrolment: no span pin, so carry the ddi one in the primary slot.
  if (!span && ddi) out = ` -WsFingerprintDdi "${ddi}"`
  return out
}

// POST /api/agents/enroll-tokens (super_admin) — mint a one-time enrollment
// token (+ site/module preset) and return the install one-liner. Only the
// token HASH is stored; the raw token is returned once and never persisted.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role: string; id: string }
  if (user.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = await req.json().catch(() => ({}))
    // Whitelist known module slugs (both forms) — silently drop anything else so
    // a typo'd/arbitrary slug can't be baked into the preset.
    const rawModules: unknown[] = Array.isArray(body.modules) ? body.modules : []
    const modules: string[] = rawModules.filter(isKnownModule)
    // Loud, not silent: if the admin sent a non-empty module set but NONE survived
    // the whitelist (a typo, or a now-removed slug like 'log'), reject at mint time
    // rather than baking an empty preset that would enrol a green-but-inert agent
    // with an empty JWT aud. An intentionally-empty preset (raw was empty) is fine.
    if (rawModules.length > 0 && modules.length === 0) {
      return NextResponse.json({ error: 'No valid modules (known: span, ddi)' }, { status: 400 })
    }
    const siteId = typeof body.site_id === 'number' ? body.site_id : null
    const note = typeof body.note === 'string' ? body.note : null

    const token = newEnrollToken()
    const preset = { site_id: siteId, modules }

    const res = await query(
      `INSERT INTO agent_enrollment_tokens (token_hash, created_by, expires_at, preset, note)
       VALUES ($1, $2, NOW() + interval '60 min', $3, $4)
       RETURNING expires_at`,
      [hashToken(token), parseInt(user.id), JSON.stringify(preset), note]
    )

    const origin = resolveOrigin(req, 3000, process.env.NEXTAUTH_URL || 'http://localhost:3000')
    // Carry the chosen modules into the installer so they reach the agent's
    // config.json. The preset above only seeds the HUB's agent_modules rows (what
    // the fleet page displays); the agent decides which modules to actually LOAD
    // from its own config.json alone (nocvault-agent.js moduleEnabled()). Without
    // this the two silently disagree: the hub showed "ddi enabled" while the agent
    // never loaded ddi, so DDIVault's Remote Agents page stayed empty forever and
    // module_status reported only {span:'ok'}. Slugs are already whitelisted above.
    const modulesArg = modules.length > 0 ? ` -Modules "${modules.join(',')}"` : ''
    // Carry the ingest server's TLS certificate pin in the SAME command the admin
    // copies. The agent must not learn its pin from the hub at runtime: the hub
    // channel is plain HTTP, so whoever could impersonate the ingest server could
    // also hand out a matching fingerprint and the pin would verify against the
    // attacker (see agent/core/transport.js). Riding along in the one-time install
    // command keeps it on a human-carried path, out of band from the connection it
    // authenticates. Unset env => argument omitted => byte-identical to before.
    const fingerprintArg = fingerprintFor(modules)
    const install_command = `& ([scriptblock]::Create((irm ${origin}/api/agents/install.ps1))) -Token "${token}"${modulesArg}${fingerprintArg}`

    return NextResponse.json({
      token,
      expires_at: res.rows[0].expires_at,
      install_command,
    })
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
