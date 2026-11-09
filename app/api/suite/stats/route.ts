import { NextResponse } from 'next/server'

import { probeJson } from '@/lib/suiteProbe'

// Server-side stats aggregator. Fetches each external app's /api/stats in
// parallel (avoids browser CORS). Any failure/timeout yields null for that app.

// Use 127.0.0.1, NOT localhost — see the note in suite/health/route.ts: on Windows
// `localhost` hits ::1 (IPv6) first and stalls ~1s against the IPv4-only siblings,
// intermittently timing out. Env overrides win — and on a TLS install they are
// REQUIRED, since the public ports belong to the terminator.
// The probe policy (budget, retry, why a timeout is not a dead app) lives in
// lib/suiteProbe.ts, shared with suite/health so the two cannot drift apart.
const APPS: { key: 'logvault' | 'ddivault' | 'spanvault'; url: string }[] = [
  { key: 'logvault', url: process.env.LOGVAULT_STATS_URL || 'http://127.0.0.1:3004/api/stats' },
  { key: 'ddivault', url: process.env.DDIVAULT_STATS_URL || 'http://127.0.0.1:3006/api/stats' },
  { key: 'spanvault', url: process.env.SPANVAULT_STATS_URL || 'http://127.0.0.1:3008/api/stats' },
]

type StatsResult = Record<string, unknown | null>

// Module-level TTL cache so rapid/repeat launcher loads don't re-probe every sibling.
// A page where some tile failed is re-probed sooner than a fully good one: the
// launcher fetches this exactly once on mount, so caching a blip for the full 20 s
// leaves em-dashes on screen that a reload would have filled in.
let _cache: { until: number; data: StatsResult } | null = null
const TTL_OK_MS = 20000
const TTL_BAD_MS = 5000

export async function GET() {
  if (_cache && Date.now() < _cache.until) {
    return NextResponse.json(_cache.data)
  }
  const entries = await Promise.all(
    APPS.map(async ({ key, url }) => [key, await probeJson(url)] as const)
  )
  const out: Record<string, unknown | null> = { logvault: null, ddivault: null, spanvault: null }
  for (const [key, value] of entries) out[key] = value
  const allOk = Object.values(out).every((v) => v !== null)
  _cache = { until: Date.now() + (allOk ? TTL_OK_MS : TTL_BAD_MS), data: out }
  return NextResponse.json(out)
}
