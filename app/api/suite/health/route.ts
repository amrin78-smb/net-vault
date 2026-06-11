import { NextResponse } from 'next/server'

// Server-side health aggregator. Fetches each app's /api/health to avoid
// browser CORS against the 192.168.x backends. Never throws.

type AppStatus = 'Healthy' | 'Warning' | 'Unavailable'

const APPS: { app: string; url: string }[] = [
  { app: 'NetVault', url: process.env.NETVAULT_HEALTH_URL || 'http://localhost:3000/api/health' },
  { app: 'LogVault', url: process.env.LOGVAULT_HEALTH_URL || 'http://192.168.6.111:3004/api/health' },
  { app: 'DDIVault', url: process.env.DDIVAULT_HEALTH_URL || 'http://192.168.6.111:3006/api/health' },
  { app: 'SpanVault', url: process.env.SPANVAULT_HEALTH_URL || 'http://192.168.6.111:3008/api/health' },
]

async function checkOne(url: string): Promise<AppStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
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
  const results = await Promise.all(
    APPS.map(async ({ app, url }) => ({ app, status: await checkOne(url) }))
  )
  return NextResponse.json(results)
}
