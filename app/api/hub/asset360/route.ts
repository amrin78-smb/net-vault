// NocVault Hub — Asset 360: one device's full story across all four apps.
// Anchored on the NetVault asset (by id or IP); correlates SpanVault monitoring,
// LogVault logs/security, and DDIVault DNS/IPAM by IP. Every section degrades to
// null independently (read-only via nocvault_readonly).
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { queryDb, queryOne } from '@/lib/suiteDb'

export const dynamic = 'force-dynamic'

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = new URL(req.url).searchParams
  const id = sp.get('id')
  let ip = sp.get('ip')

  // ── 1. NetVault asset of record ──
  const deviceSql = `
    SELECT d.id, d.name, d.ip_address AS ip, d.lifecycle_status, d.device_status,
           d.model, d.serial_number, d.support_end_date, d.os_type, d.os_version, d.os_eol_date,
           s.name AS site
      FROM devices d LEFT JOIN sites s ON s.id = d.site_id`
  const device = id
    ? await queryOne<Record<string, unknown>>('netvault', `${deviceSql} WHERE d.id = $1`, [id])
    : ip
      ? await queryOne<Record<string, unknown>>('netvault', `${deviceSql} WHERE d.ip_address = $1`, [ip])
      : null
  if (device && device.ip) ip = device.ip as string

  // ── 2. SpanVault monitoring ──
  let monitoring: Record<string, unknown> | null = null
  if (ip) {
    const md = await queryOne<{ id: number; current_status: string }>(
      'spanvault',
      `SELECT id, current_status FROM monitored_devices WHERE ip_address = $1 LIMIT 1`,
      [ip],
    )
    if (md) {
      const [hs, av, open, alertList] = await Promise.all([
        queryOne<{ score: string; grade: string }>('spanvault',
          `SELECT score, grade FROM device_health_scores WHERE device_id = $1 ORDER BY computed_at DESC LIMIT 1`, [md.id]),
        queryOne<{ uptime_pct: string; avg_response_ms: string }>('spanvault',
          `SELECT uptime_pct, avg_response_ms FROM availability_summary WHERE device_id = $1 ORDER BY date DESC LIMIT 1`, [md.id]),
        queryOne<{ n: string }>('spanvault',
          `SELECT count(*) AS n FROM alerts WHERE device_id = $1 AND status NOT IN ('resolved','suppressed')`, [md.id]),
        queryDb<{ alert_type: string; severity: string; triggered_at: string }>('spanvault',
          `SELECT alert_type, severity, triggered_at FROM alerts WHERE device_id = $1 AND status NOT IN ('resolved','suppressed') ORDER BY triggered_at DESC LIMIT 5`, [md.id]),
      ])
      monitoring = {
        status: md.current_status,
        healthScore: hs ? n(hs.score) : null,
        grade: hs ? hs.grade : null,
        uptimePct: av ? n(av.uptime_pct) : null,
        latencyAvg: av ? n(av.avg_response_ms) : null,
        openAlerts: open ? n(open.n) : null,
        alerts: (alertList ?? []).map((a) => ({ type: a.alert_type, severity: a.severity, since: a.triggered_at })),
      }
    }
  }

  // ── 3. LogVault logs & security ──
  let logs: Record<string, unknown> | null = null
  if (ip) {
    const [risk, kh, sec, recent] = await Promise.all([
      queryOne<{ risk_score: string; event_count: string; anomaly_count: string }>('logvault',
        `SELECT risk_score, event_count, anomaly_count FROM entity_risk WHERE source_ip = $1::inet ORDER BY updated_at DESC LIMIT 1`, [ip]),
      queryOne<{ country_code: string; asn_org: string; is_known_bad: boolean }>('logvault',
        `SELECT country_code, asn_org, is_known_bad FROM known_hosts WHERE host(ip_address) = $1 LIMIT 1`, [ip]),
      queryOne<{ n: string }>('logvault',
        `SELECT count(*) AS n FROM syslog_entries WHERE source_ip = $1::inet AND category = 'security' AND received_at > now() - INTERVAL '24 hours'`, [ip]),
      queryDb<{ received_at: string; severity: string; message: string }>('logvault',
        `SELECT received_at, severity, left(message, 140) AS message FROM syslog_entries WHERE source_ip = $1::inet ORDER BY received_at DESC LIMIT 5`, [ip]),
    ])
    if (risk || kh || sec || (recent && recent.length)) {
      logs = {
        riskScore: risk ? n(risk.risk_score) : null,
        eventCount: risk ? n(risk.event_count) : null,
        anomalyCount: risk ? n(risk.anomaly_count) : null,
        securityEvents24h: sec ? n(sec.n) : null,
        country: kh ? kh.country_code : null,
        asnOrg: kh ? kh.asn_org : null,
        isKnownBad: kh ? !!kh.is_known_bad : null,
        recent: (recent ?? []).map((e) => ({ time: e.received_at, severity: e.severity, message: e.message })),
      }
    }
  }

  // ── 4. DDIVault DNS & IPAM ──
  let dns: Record<string, unknown> | null = null
  if (ip) {
    const [records, ipam] = await Promise.all([
      queryDb<{ record_type: string; hostname: string; record_data: string }>('ddivault',
        `SELECT record_type, hostname, record_data FROM dns_records WHERE record_data = $1 ORDER BY record_type LIMIT 8`, [ip]),
      queryOne<{ status: string; subnet: string }>('ddivault',
        `SELECT a.status, s.name AS subnet FROM ipam_addresses a LEFT JOIN ipam_subnets s ON s.id = a.subnet_id WHERE host(a.ip_address) = $1 LIMIT 1`, [ip]),
    ])
    if ((records && records.length) || ipam) {
      dns = {
        records: (records ?? []).map((r) => ({ type: r.record_type, name: r.hostname, data: r.record_data })),
        ipam: ipam ? { status: ipam.status, subnet: ipam.subnet } : null,
      }
    }
  }

  return NextResponse.json({ device, monitoring, logs, dns })
}
