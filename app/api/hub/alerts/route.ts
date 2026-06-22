// NocVault Hub — correlated suite alerts (cross-app, read-only).
// Surfaces signals no single app can see: EOL assets under attack, IPAM
// exhaustion, and notable security alerts. Degrades to [] when unconfigured.
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { queryDb } from '@/lib/suiteDb'

export const dynamic = 'force-dynamic'

type Severity = 'critical' | 'warning' | 'info'
interface HubAlert {
  severity: Severity
  title: string
  detail: string
  sources: string[]
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const alerts: HubAlert[] = []

  // ── 1. EOL devices (NetVault) correlated with live monitoring/security signal ──
  try {
    const [eol, spanOpen, logSec] = await Promise.all([
      queryDb<{ name: string; ip: string }>(
        'netvault',
        `SELECT name, ip_address AS ip FROM devices
          WHERE ip_address IS NOT NULL
            AND (lifecycle_status ILIKE '%EOL%' OR lifecycle_status ILIKE '%EOS%')`,
      ),
      queryDb<{ ip: string; n: string }>(
        'spanvault',
        `SELECT d.ip_address AS ip, count(*) AS n
           FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
          WHERE a.status NOT IN ('resolved', 'suppressed') AND d.ip_address IS NOT NULL
          GROUP BY 1`,
      ),
      queryDb<{ ip: string; n: string }>(
        'logvault',
        `SELECT host(source_ip) AS ip, count(*) AS n
           FROM syslog_entries
          WHERE category = 'security' AND source_ip IS NOT NULL
            AND received_at > now() - INTERVAL '24 hours'
          GROUP BY 1`,
      ),
    ])
    if (eol && eol.length) {
      const spanMap = new Map((spanOpen ?? []).map((r) => [r.ip, Number(r.n)]))
      const logMap = new Map((logSec ?? []).map((r) => [r.ip, Number(r.n)]))
      for (const d of eol) {
        const sa = spanMap.get(d.ip) ?? 0
        const le = logMap.get(d.ip) ?? 0
        if (sa > 0 || le > 0) {
          alerts.push({
            severity: 'critical',
            title: `EOL device under attack — ${d.name}`,
            detail:
              `End-of-life asset` +
              (sa ? ` · ${sa} active monitoring alert${sa === 1 ? '' : 's'}` : '') +
              (le ? ` · ${le} security event${le === 1 ? '' : 's'} (24h)` : ''),
            sources: ['NetVault', ...(sa ? ['SpanVault'] : []), ...(le ? ['LogVault'] : [])],
          })
          if (alerts.length >= 3) break
        }
      }
    }
  } catch {
    /* graceful */
  }

  // ── 2. IPAM subnets trending to exhaustion (DDIVault) ──
  try {
    const subnets = await queryDb<{ name: string; network: string; pct: string }>(
      'ddivault',
      `SELECT name, host(network) AS network,
              round(100.0 * used_hosts / NULLIF(total_hosts, 0), 1) AS pct
         FROM ipam_subnets
        WHERE total_hosts > 0 AND used_hosts::numeric / total_hosts > 0.85
        ORDER BY used_hosts::numeric / total_hosts DESC
        LIMIT 3`,
    )
    for (const s of subnets ?? []) {
      alerts.push({
        severity: Number(s.pct) >= 95 ? 'critical' : 'warning',
        title: `Subnet ${s.name || s.network} at ${s.pct}%`,
        detail: 'IPAM utilization is high and trending toward exhaustion',
        sources: ['DDIVault'],
      })
    }
  } catch {
    /* graceful */
  }

  // ── 3. Notable open security alerts (LogVault) — fill to a useful count ──
  try {
    if (alerts.length < 6) {
      const sec = await queryDb<{ name: string; src: string; n: string }>(
        'logvault',
        `SELECT COALESCE(r.name, 'Security alert') AS name, host(e.source_ip) AS src, e.match_count AS n
           FROM alert_events e LEFT JOIN alert_rules r ON r.id = e.rule_id
          WHERE e.acknowledged = false
          ORDER BY e.fired_at DESC
          LIMIT ${6 - alerts.length}`,
      )
      for (const a of sec ?? []) {
        alerts.push({
          severity: 'warning',
          title: a.name + (a.src ? ` from ${a.src}` : ''),
          detail: a.n ? `${a.n} matching events` : 'Unacknowledged security alert',
          sources: ['LogVault'],
        })
      }
    }
  } catch {
    /* graceful */
  }

  return NextResponse.json({ alerts })
}
