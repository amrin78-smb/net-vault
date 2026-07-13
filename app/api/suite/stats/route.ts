import { NextResponse } from 'next/server'

// Server-side stats aggregator. Fetches each external app's /api/stats in
// parallel (avoids browser CORS). Any failure/timeout yields null for that app.

// Use 127.0.0.1, NOT localhost — see the note in suite/health/route.ts: on Windows
// `localhost` hits ::1 (IPv6) first and stalls ~1s against the IPv4-only siblings,
// intermittently timing out. LogVault's /api/stats is the heaviest query (logs_today
// across daily partitions), so it was the one most often blanked out. Env overrides win.
const APPS: { key: 'logvault' | 'ddivault' | 'spanvault'; url: string }[] = [
  { key: 'logvault', url: process.env.LOGVAULT_STATS_URL || 'http://127.0.0.1:3004/api/stats' },
  { key: 'ddivault', url: process.env.DDIVAULT_STATS_URL || 'http://127.0.0.1:3006/api/stats' },
  { key: 'spanvault', url: process.env.SPANVAULT_STATS_URL || 'http://127.0.0.1:3008/api/stats' },
]

type StatsResult = Record<string, unknown | null>

// Module-level TTL cache so rapid/repeat launcher loads don't re-probe every sibling.
let _cache: { at: number; data: StatsResult } | null = null
const TTL_MS = 20000

async function fetchOne(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  if (_cache && Date.now() - _cache.at < TTL_MS) {
    return NextResponse.json(_cache.data)
  }
  const entries = await Promise.all(
    APPS.map(async ({ key, url }) => [key, await fetchOne(url)] as const)
  )
  const out: Record<string, unknown | null> = { logvault: null, ddivault: null, spanvault: null }
  for (const [key, value] of entries) out[key] = value
  _cache = { at: Date.now(), data: out }
  return NextResponse.json(out)
}
