import { NextResponse } from 'next/server'

// Server-side stats aggregator. Fetches each external app's /api/stats in
// parallel (avoids browser CORS). Any failure/timeout yields null for that app.

const APPS: { key: 'logvault' | 'ddivault' | 'spanvault'; url: string }[] = [
  { key: 'logvault', url: process.env.LOGVAULT_STATS_URL || 'http://192.168.6.111:3004/api/stats' },
  { key: 'ddivault', url: process.env.DDIVAULT_STATS_URL || 'http://192.168.6.111:3006/api/stats' },
  { key: 'spanvault', url: process.env.SPANVAULT_STATS_URL || 'http://192.168.6.111:3008/api/stats' },
]

async function fetchOne(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
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
  const entries = await Promise.all(
    APPS.map(async ({ key, url }) => [key, await fetchOne(url)] as const)
  )
  const out: Record<string, unknown | null> = { logvault: null, ddivault: null, spanvault: null }
  for (const [key, value] of entries) out[key] = value
  return NextResponse.json(out)
}
