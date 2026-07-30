import type { NextRequest } from 'next/server'

// In-memory, per-key fixed-window rate limiter for public/unauthenticated POST
// routes (first use: POST /api/agents/enroll — a token-authed but session-less
// route any client can hit, with no other throttle in front of it).
//
// Deliberately simple (fixed window, not sliding) — matches this codebase's own
// "simple over clever" bar, and mirrors the shape of LogVault's opt-in per-source
// collector rate limiter (collector/collector.js's isRateLimited: a bucket keyed
// by source, reset once its window elapses). Unlike LogVault's collector guard
// (DB-backed settings, default OFF), this one is always-on with fixed in-code
// defaults — there's no admin-facing "ingestion settings" surface for a control
// route the way there is for raw syslog ingestion.
//
// FAILS OPEN: any unexpected error here returns "not limited" rather than
// blocking the caller, matching this codebase's established convention for
// defensive infrastructure (e.g. license/health checks degrade gracefully
// rather than hard-failing — see lib/license.ts).

interface Bucket {
  windowStart: number
  count: number
}

// Keyed by caller-supplied string (e.g. `${routeName}:${ip}`) so one Map can
// back multiple call sites without their windows colliding.
const buckets = new Map<string, Bucket>()

// Opportunistic cleanup so long-lived processes don't accumulate one bucket
// per distinct source IP forever (an attacker rotating source IPs, or just
// organic traffic over weeks of uptime). Swept lazily off the hot path — no
// timer/interval — at most every SWEEP_INTERVAL_MS, on whichever call happens
// to land after the interval elapses.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
let lastSweepAt = 0

function sweepExpired(now: number, windowMs: number) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const [key, b] of buckets) {
    if (now - b.windowStart >= windowMs) buckets.delete(key)
  }
}

export interface RateLimitResult {
  limited: boolean
  retryAfterSec: number
}

// checkRateLimit('agents-enroll:203.0.113.5', { maxAttempts: 10, windowMs: 10*60*1000 })
// -> { limited: true, retryAfterSec: 342 } once `key` exceeds maxAttempts within
// the current window; the window resets (a fresh count starting at 1) once
// windowMs has elapsed since it opened — a classic fixed window, so a caller
// right at the boundary can burst up to ~2x maxAttempts across the seam. That
// trade-off is fine for "stop a hammering/brute-force client", not a precise
// quota.
export function checkRateLimit(
  key: string,
  opts: { maxAttempts: number; windowMs: number }
): RateLimitResult {
  try {
    const { maxAttempts, windowMs } = opts
    const now = Date.now()
    sweepExpired(now, windowMs)

    const existing = buckets.get(key)
    if (!existing || now - existing.windowStart >= windowMs) {
      buckets.set(key, { windowStart: now, count: 1 })
      return { limited: false, retryAfterSec: 0 }
    }

    existing.count++
    if (existing.count > maxAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.windowStart + windowMs - now) / 1000))
      return { limited: true, retryAfterSec }
    }
    return { limited: false, retryAfterSec: 0 }
  } catch {
    // The limiter itself must never be the reason a legitimate request fails.
    return { limited: false, retryAfterSec: 0 }
  }
}

// Best-effort source IP for a request, for rate-limiting/logging purposes only
// — NOT an authentication signal. This Next.js version's NextRequest carries no
// `.ip` (that platform-provided field was removed for self-hosted deployments),
// so — same as lib/publicUrl.ts's resolveOrigin() reading x-forwarded-host — we
// read the standard reverse-proxy header, preferring the first (client) hop of
// a comma-separated x-forwarded-for chain, then x-real-ip, then a shared
// 'unknown' bucket if neither header is present (a direct, no-proxy connection
// on this LAN-deployed suite). NOTE: like resolveOrigin's own documented gap,
// these headers are trusted on shape alone with no identity/allowlist check
// (KIV TRUST_PROXY_HEADERS in CLAUDE.md) — a caller that reaches the app
// directly could spoof x-forwarded-for to get a fresh bucket per request. Only
// used here to throttle noise/brute-force, not to gate access, so that's an
// acceptable trade-off today.
export function getClientIp(req: NextRequest): string {
  try {
    const xff = req.headers.get('x-forwarded-for')
    if (xff) {
      const first = xff.split(',')[0]?.trim()
      if (first) return first
    }
    const xri = req.headers.get('x-real-ip')
    if (xri && xri.trim()) return xri.trim()
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
