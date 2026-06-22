// NocVault Hub — suite-wide KPI rollup (cross-app, read-only).
// Each KPI is resolved independently via the nocvault_readonly role; a failing or
// unconfigured DB leaves that tile null while the rest still populate.
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { queryOne } from '@/lib/suiteDb'

export const dynamic = 'force-dynamic'

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v)

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [fleet, past, avail, anomalies, ipam, spanOpen, logOpen] = await Promise.all([
    queryOne<{ score: string; grade: string }>(
      'netvault',
      `SELECT score, grade FROM health_score_history ORDER BY calculated_at DESC LIMIT 1`,
    ),
    queryOne<{ score: string }>(
      'netvault',
      `SELECT score FROM health_score_history WHERE calculated_at <= now() - INTERVAL '7 days' ORDER BY calculated_at DESC LIMIT 1`,
    ),
    queryOne<{ up: string; total: string }>(
      'spanvault',
      `SELECT count(*) FILTER (WHERE current_status = 'up') AS up, count(*) AS total FROM monitored_devices`,
    ),
    queryOne<{ total: string; today: string }>(
      'logvault',
      `SELECT count(*) AS total, count(*) FILTER (WHERE detected_at::date = now()::date) AS today FROM anomaly_events`,
    ),
    queryOne<{ pct: string; over85: string }>(
      'ddivault',
      `SELECT round(100.0 * sum(used_hosts) / NULLIF(sum(total_hosts), 0), 1) AS pct,
              count(*) FILTER (WHERE total_hosts > 0 AND used_hosts::numeric / total_hosts > 0.85) AS over85
         FROM ipam_subnets`,
    ),
    queryOne<{ open: string }>(
      'spanvault',
      `SELECT count(*) AS open FROM alerts WHERE status NOT IN ('resolved', 'suppressed')`,
    ),
    queryOne<{ open: string }>(
      'logvault',
      `SELECT count(*) AS open FROM alert_events WHERE acknowledged = false`,
    ),
  ])

  const upPct =
    avail && Number(avail.total) > 0
      ? Math.round((Number(avail.up) / Number(avail.total)) * 1000) / 10
      : null
  const spanOpenN = spanOpen ? num(spanOpen.open) : null
  const logOpenN = logOpen ? num(logOpen.open) : null
  const openTotal =
    spanOpenN === null && logOpenN === null ? null : (spanOpenN ?? 0) + (logOpenN ?? 0)

  return NextResponse.json({
    fleetHealth: {
      score: fleet ? num(fleet.score) : null,
      grade: fleet ? fleet.grade : null,
      delta7d: fleet && past ? (num(fleet.score) as number) - (num(past.score) as number) : null,
    },
    availability: { pct: upPct, devices: avail ? num(avail.total) : null, alerts: spanOpenN },
    logAnomalies: {
      total: anomalies ? num(anomalies.total) : null,
      newToday: anomalies ? num(anomalies.today) : null,
    },
    ipamUtilization: {
      pct: ipam ? num(ipam.pct) : null,
      subnetsOver85: ipam ? num(ipam.over85) : null,
    },
    openAlerts: { total: openTotal },
  })
}
