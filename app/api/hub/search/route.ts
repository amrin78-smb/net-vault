// NocVault Hub — unified suite search.
// Searches every suite DB (read-only) by IP / hostname / device name and merges
// matches into one result per asset, tagged with the apps it appears in.
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { queryDb } from '@/lib/suiteDb'

export const dynamic = 'force-dynamic'

interface Hit {
  ip: string | null
  label: string
  netvaultId: string | null
  site: number | null
  sources: Set<string>
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = (new URL(req.url).searchParams.get('q') || '').trim()
  if (q.length < 2) return NextResponse.json({ results: [] })
  const like = `%${q}%`
  const ipLike = `${q}%`

  const [nv, lv, sv, ddi] = await Promise.all([
    queryDb<{ id: string; name: string; ip: string | null; site_id: number | null }>(
      'netvault',
      `SELECT id, name, ip_address AS ip, site_id FROM devices
        WHERE name ILIKE $1 OR ip_address LIKE $2 ORDER BY name LIMIT 12`,
      [like, ipLike],
    ),
    queryDb<{ hostname: string | null; ip: string | null; netvault_id: string | null }>(
      'logvault',
      `SELECT hostname, host(ip_address) AS ip, netvault_id FROM known_hosts
        WHERE hostname ILIKE $1 OR host(ip_address) LIKE $2 LIMIT 12`,
      [like, ipLike],
    ),
    queryDb<{ name: string; ip: string | null }>(
      'spanvault',
      `SELECT name, ip_address AS ip FROM monitored_devices
        WHERE name ILIKE $1 OR ip_address LIKE $2 LIMIT 12`,
      [like, ipLike],
    ),
    queryDb<{ hostname: string | null; ip: string | null }>(
      'ddivault',
      `SELECT hostname, host(ip_address) AS ip FROM ipam_addresses
        WHERE hostname ILIKE $1 OR host(ip_address) LIKE $2 LIMIT 12`,
      [like, ipLike],
    ),
  ])

  // Merge by IP when present, else by lowercased label.
  const byKey = new Map<string, Hit>()
  const add = (
    app: string,
    ip: string | null,
    label: string | null,
    netvaultId: string | null = null,
    site: number | null = null,
  ) => {
    const key = ip || (label ? `name:${label.toLowerCase()}` : null)
    if (!key) return
    let h = byKey.get(key)
    if (!h) {
      h = { ip, label: label || ip || key, netvaultId, site, sources: new Set() }
      byKey.set(key, h)
    }
    h.sources.add(app)
    if (netvaultId != null) h.netvaultId = netvaultId
    if (site != null) h.site = site
    // Prefer a human name over a bare IP as the label.
    if (label && (h.label === h.ip || !h.label)) h.label = label
  }

  for (const r of nv ?? []) add('NetVault', r.ip, r.name, r.id, r.site_id)
  for (const r of lv ?? []) add('LogVault', r.ip, r.hostname, r.netvault_id || null)
  for (const r of sv ?? []) add('SpanVault', r.ip, r.name)
  for (const r of ddi ?? []) add('DDIVault', r.ip, r.hostname)

  const results = [...byKey.values()]
    .sort((a, b) => b.sources.size - a.sources.size)
    .slice(0, 8)
    .map((h) => ({
      ip: h.ip,
      label: h.label,
      netvaultId: h.netvaultId,
      sources: [...h.sources],
    }))

  return NextResponse.json({ results })
}
