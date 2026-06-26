import { NextResponse } from 'next/server'

// Server-side health aggregator. Fetches each app's /api/health to avoid
// browser CORS against the 192.168.x backends. Never throws.

type AppStatus = 'Healthy' | 'Warning' | 'Unavailable'

const APPS: { app: string; url: string }[] = [
  { app: 'NetVault', url: process.env.NETVAULT_HEALTH_URL || 'http://localhost:3000/api/health' },
  { app: 'LogVault', url: process.env.LOGVAULT_HEALTH_URL || 'http://localhost:3004/api/health' },
  { app: 'DDIVault', url: process.env.DDIVAULT_HEALTH_URL || 'http://localhost:3006/api/health' },
  { app: 'SpanVault', url: process.env.SPANVAULT_HEALTH_URL || 'http://localhost:3008/api/health' },
]

type HealthResult = { app: string; status: AppStatus }

// Module-level TTL cache so rapid/repeat launcher loads don't re-probe every sibling.
let _cache: { at: number; data: HealthResult[] } | null = null
const TTL_MS = 20000

async function checkOne(url: string): Promise<AppStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return 'Warning'
    const body = await res.json().catch(() => null)
    if (body && body.status === 'ok') return 'Healthy'
    return 'Warning'
  } catch {
    return 'Unavailable'
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  if (_cache && Date.now() - _cache.at < TTL_MS) {
    return NextResponse.json(_cache.data)
  }
  const results = await Promise.all(
    APPS.map(async ({ app, url }) => ({ app, status: await checkOne(url) }))
  )
  _cache = { at: Date.now(), data: results }
  return NextResponse.json(results)
}
