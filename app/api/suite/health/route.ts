import { NextResponse } from 'next/server'

import { probeStatus, type AppStatus } from '@/lib/suiteProbe'

// Server-side health aggregator. Fetches each app's /api/health to avoid
// browser CORS against the 192.168.x backends. Never throws.
//
// The probe policy itself — budget, retry, and why a timeout is NOT reported as
// 'Unavailable' — lives in lib/suiteProbe.ts, shared with suite/stats so the two
// cannot drift apart. Read the note there before changing any of it.

// Use 127.0.0.1, NOT localhost: on Windows `localhost` resolves to ::1 (IPv6)
// first, and the sibling apps listen on IPv4 — so each probe stalls ~1s on the
// dead ::1 connect before falling back, intermittently blowing the timeout and
// showing "Unavailable" until a refresh. (Same IPv6-stall fix already applied to
// the installer health checks.) Env overrides still win for proxied deployments —
// and on a TLS install they are REQUIRED, because the public ports belong to the
// terminator: the cutover points these at the consoles' loopback ports.
const APPS: { app: string; url: string }[] = [
  { app: 'NetVault', url: process.env.NETVAULT_HEALTH_URL || 'http://127.0.0.1:3000/api/health' },
  { app: 'LogVault', url: process.env.LOGVAULT_HEALTH_URL || 'http://127.0.0.1:3004/api/health' },
  { app: 'DDIVault', url: process.env.DDIVAULT_HEALTH_URL || 'http://127.0.0.1:3006/api/health' },
  { app: 'SpanVault', url: process.env.SPANVAULT_HEALTH_URL || 'http://127.0.0.1:3008/api/health' },
]

type HealthResult = { app: string; status: AppStatus }

// Module-level TTL cache so rapid/repeat launcher loads don't re-probe every sibling.
// A BAD verdict is cached for far less time than a good one: the launcher fetches
// this exactly once on mount, so caching a transient failure for a full 20 s left a
// red "Critical" panel on screen that a reload would have cleared.
let _cache: { until: number; data: HealthResult[] } | null = null
const TTL_OK_MS = 20000
const TTL_BAD_MS = 5000

export async function GET() {
  if (_cache && Date.now() < _cache.until) {
    return NextResponse.json(_cache.data)
  }
  const results = await Promise.all(
    APPS.map(async ({ app, url }) => ({ app, status: await probeStatus(url) }))
  )
  const allOk = results.every((r) => r.status === 'Healthy')
  _cache = { until: Date.now() + (allOk ? TTL_OK_MS : TTL_BAD_MS), data: results }
  return NextResponse.json(results)
}
