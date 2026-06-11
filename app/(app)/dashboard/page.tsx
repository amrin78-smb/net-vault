'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  ResponsiveContainer, Tooltip, LabelList,
} from 'recharts'

/* ----------------------------- palette ----------------------------- */
const NAVY = '#1a2744'
const RED = '#C8102E'
const GREEN = '#16a34a'
const AMBER = '#f59e0b'
const BLUE = '#0284c7'
const BG = '#f4f6f9'
const MUTED = '#6b7280'
const CARD_SHADOW = '0 4px 24px rgba(0,0,0,0.06)'

/* --------------------------- success notice ------------------------ */
function UpdatedNotice() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('updated') !== 'true') return
    setShow(true)
    window.history.replaceState({}, '', window.location.pathname)
    const dismissId = setTimeout(() => setShow(false), 5000)
    return () => clearTimeout(dismissId)
  }, [])
  if (!show) return null
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        marginBottom: 16, borderRadius: 8, fontSize: 13.5, fontWeight: 600,
        color: '#166534', background: 'rgba(22,163,74,0.10)',
        border: '1px solid rgba(22,163,74,0.30)',
      }}
    >
      <span aria-hidden>✓</span>
      <span style={{ flex: 1 }}>NetVault updated successfully</span>
      <button
        onClick={() => setShow(false)}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', color: '#166534',
          fontSize: 18, lineHeight: 1, padding: 0, opacity: 0.7,
        }}
      >
        ×
      </button>
    </div>
  )
}

/* ------------------------------ shimmer ---------------------------- */
function Shimmer({ w = '100%', h = '14px', r = 6, light = false }: { w?: string | number; h?: string | number; r?: number; light?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block', width: w, height: h, borderRadius: r,
        background: light ? 'rgba(255,255,255,0.18)' : '#e5e7eb',
        animation: 'nvShimmer 1.4s ease-in-out infinite',
      }}
    />
  )
}

/* ------------------------------- types ----------------------------- */
type Overview = {
  health_score: number; health_grade: string; health_trend: number
  trend: number | null; trend_available: boolean
  overall_status: string; status_description: string
  healthy_devices: number; healthy_devices_pct: number
  eol_assets: number; eol_assets_pct: number
  sites_at_risk: number; compliance_score: number
}
type FleetSegment = { label: string; count: number; pct: number; color: string }
type FleetHealth = { total: number; segments: FleetSegment[]; last_updated: string }
type RegionRow = { region: string; healthy: number; eol: number; total: number }
type TypeRow = { type: string; count: number }
type EolSite = { site_name: string; city: string; country: string; region: string; eol_count: number; total_count: number; eol_pct: number }
type StatsRow = { total_devices: number; total_sites: number; wan_circuits: number; main_links: number; isp_providers: number }
type ActivityRow = { action: string; entity: string; user: string; time: string }

type DashData = {
  overview: Overview
  fleet: FleetHealth
  byRegion: RegionRow[]
  byType: TypeRow[]
  topEol: EolSite[]
  stats: StatsRow
  activity: ActivityRow[]
}

/* ----------------------------- fallbacks --------------------------- */
const FALLBACK: DashData = {
  overview: {
    health_score: 0, health_grade: '–', health_trend: 0,
    trend: null, trend_available: false,
    overall_status: 'Unknown', status_description: 'Status data is unavailable.',
    healthy_devices: 0, healthy_devices_pct: 0,
    eol_assets: 0, eol_assets_pct: 0, sites_at_risk: 0, compliance_score: 0,
  },
  fleet: { total: 0, segments: [], last_updated: new Date().toISOString() },
  byRegion: [],
  byType: [],
  topEol: [],
  stats: { total_devices: 0, total_sites: 0, wan_circuits: 0, main_links: 0, isp_providers: 0 },
  activity: [],
}

async function safeFetch<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return fallback
    const j = await r.json()
    return (j ?? fallback) as T
  } catch {
    return fallback
  }
}

/* ----------------------- deterministic sparklines ------------------ */
// Precomputed constant arrays so SSR/CSR match (no Math.random at render).
const SPARK_HEALTHY = [40, 42, 41, 44, 45, 46, 48, 50]   // stable / gentle up
const SPARK_EOL     = [20, 24, 27, 33, 38, 44, 52, 60]   // upward
const SPARK_SITES   = [32, 30, 33, 31, 34, 32, 33, 31]   // amber flat-ish
const SPARK_COMP    = [44, 45, 44, 46, 45, 45, 46, 45]   // stable

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const W = 96, H = 26, PAD = 2
  const max = Math.max(...points), min = Math.min(...points)
  const span = max - min || 1
  const stepX = (W - PAD * 2) / (points.length - 1)
  const coords = points.map((p, i) => {
    const x = PAD + i * stepX
    const y = PAD + (H - PAD * 2) * (1 - (p - min) / span)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const areaPath = `M${coords[0]} L${coords.slice(1).join(' L')} L${(PAD + (points.length - 1) * stepX).toFixed(1)},${H} L${PAD},${H} Z`
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%' }} preserveAspectRatio="none">
      <path d={areaPath} fill={color} opacity={0.12} />
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* -------------------------------- icons ---------------------------- */
const ico = (path: React.ReactNode, size = 18, color = 'currentColor', sw = 1.7) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{path}</svg>
)
const IconMonitor = (s?: number, c?: string) => ico(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>, s, c)
const IconWarning = (s?: number, c?: string) => ico(<><path d="M12 2 2 20h20L12 2Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>, s, c)
const IconShield = (s?: number, c?: string) => ico(<path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z" />, s, c)
const IconClipboard = (s?: number, c?: string) => ico(<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></>, s, c)
const IconSites = (s?: number, c?: string) => ico(<><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-3" /></>, s, c)
const IconCircuit = (s?: number, c?: string) => ico(<><path d="M6 2v6a6 6 0 0 0 12 0V2M6 22v-6a6 6 0 0 1 12 0v6" /></>, s, c)
const IconLink = (s?: number, c?: string) => ico(<><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>, s, c)
const IconGlobe = (s?: number, c?: string) => ico(<><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" /></>, s, c)
const IconRefresh = (s?: number, c?: string) => ico(<><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></>, s, c)
const IconChevron = (s?: number, c?: string) => ico(<polyline points="9 18 15 12 9 6" />, s, c)
const IconGrid = (s?: number, c?: string) => ico(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>, s, c)

/* --------------------------- small helpers ------------------------- */
function minutesAgo(iso: string) {
  if (!iso) return 'recently'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.max(0, Math.floor(diff / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) === 1 ? '' : 's'} ago`
}
function scoreColor(score: number) {
  if (score >= 75) return GREEN
  if (score >= 50) return AMBER
  return RED
}
function statusColor(status: string) {
  const s = (status || '').toLowerCase()
  if (s === 'healthy') return GREEN
  if (s === 'warning') return AMBER
  if (s === 'critical') return RED
  return MUTED
}
function activityColor(action: string) {
  if (/create|import/i.test(action)) return GREEN
  if (/update/i.test(action)) return BLUE
  if (/scan/i.test(action)) return AMBER
  return MUTED
}

/* ------------------------------ card shell ------------------------- */
const cardStyle: React.CSSProperties = {
  background: 'white', borderRadius: 12, boxShadow: CARD_SHADOW,
  border: '1px solid #eef1f5', padding: 20, boxSizing: 'border-box',
}
const cardStyleCompact: React.CSSProperties = { ...cardStyle, padding: 16 }
const cardTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#111827', margin: 0 }
const viewLink: React.CSSProperties = { fontSize: 12.5, color: RED, textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' }

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', boxShadow: '0 2px 10px rgba(0,0,0,0.08)', fontSize: 12 }}>
      {label != null && <div style={{ fontWeight: 700, color: '#111827', marginBottom: 4 }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, color: MUTED }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: p.color || p.payload?.color, display: 'inline-block' }} />
          <span>{p.name}: <b style={{ color: '#111827' }}>{Number(p.value).toLocaleString()}</b></span>
        </div>
      ))}
    </div>
  )
}

/* ============================== PAGE =============================== */
export default function DashboardPage() {
  const [data, setData] = useState<DashData>(FALLBACK)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [clock, setClock] = useState('')

  const loadAll = useCallback(async () => {
    setRefreshing(true)
    const [overview, fleet, byRegion, byType, topEol, stats, activity] = await Promise.all([
      safeFetch<Overview>('/api/dashboard/overview', FALLBACK.overview),
      safeFetch<FleetHealth>('/api/dashboard/fleet-health', FALLBACK.fleet),
      safeFetch<RegionRow[]>('/api/dashboard/devices-by-region', FALLBACK.byRegion),
      safeFetch<TypeRow[]>('/api/dashboard/devices-by-type', FALLBACK.byType),
      safeFetch<EolSite[]>('/api/dashboard/top-eol-sites', FALLBACK.topEol),
      safeFetch<StatsRow>('/api/dashboard/stats-row', FALLBACK.stats),
      safeFetch<ActivityRow[]>('/api/dashboard/recent-activity', FALLBACK.activity),
    ])
    setData({
      overview: overview ?? FALLBACK.overview,
      fleet: fleet ?? FALLBACK.fleet,
      byRegion: Array.isArray(byRegion) ? byRegion : FALLBACK.byRegion,
      byType: Array.isArray(byType) ? byType : FALLBACK.byType,
      topEol: Array.isArray(topEol) ? topEol : FALLBACK.topEol,
      stats: stats ?? FALLBACK.stats,
      activity: Array.isArray(activity) ? activity : FALLBACK.activity,
    })
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // live ICT clock (Asia/Bangkok) — updates every minute
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const tick = () => setClock(fmt.format(new Date()))
    tick()
    const id = setInterval(tick, 60000)
    return () => clearInterval(id)
  }, [])

  const { overview, fleet, byRegion, byType, topEol, stats, activity } = data

  /* ------------------------- gauge geometry ------------------------ */
  const R = 40, STROKE = 8
  const C = 2 * Math.PI * R
  const pct = Math.max(0, Math.min(100, overview.health_score)) / 100
  const gColor = scoreColor(overview.health_score)
  const dashOffset = loading ? C : C * (1 - pct)

  /* ------------------------- tiles config -------------------------- */
  const tiles = [
    { icon: IconMonitor, value: overview.healthy_devices, label: 'Healthy Devices', sub: `${overview.healthy_devices_pct}% of fleet`, color: GREEN, spark: SPARK_HEALTHY },
    { icon: IconWarning, value: overview.eol_assets, label: 'EOL Assets', sub: `${overview.eol_assets_pct}% action needed`, color: RED, spark: SPARK_EOL },
    { icon: IconShield, value: overview.sites_at_risk, label: 'Sites at Risk', sub: 'High impact', color: AMBER, spark: SPARK_SITES },
    { icon: IconClipboard, value: `${overview.compliance_score}%`, label: 'Compliance Score', sub: 'Good standing', color: BLUE, spark: SPARK_COMP },
  ]

  /* --------------------------- stats row --------------------------- */
  const statCards = [
    { icon: IconMonitor, value: stats.total_devices, label: 'Total Devices', sub: 'across fleet', href: '/devices' },
    { icon: IconSites, value: stats.total_sites, label: 'Total Sites', sub: 'global footprint', href: '/sites' },
    { icon: IconCircuit, value: stats.wan_circuits, label: 'WAN Circuits', sub: 'connectivity links', href: '/circuits' },
    { icon: IconLink, value: stats.main_links, label: 'Main Links', sub: 'primary uplinks', href: '/circuits' },
    { icon: IconGlobe, value: stats.isp_providers, label: 'ISP Providers', sub: 'service partners', href: '/circuits' },
  ]

  const sitesBadgeCount = topEol.length || overview.sites_at_risk
  const maxType = Math.max(1, ...byType.map(t => t.count))

  /* ----------------------- health trend node ---------------------- */
  const trendStyle: React.CSSProperties = { fontSize: 10.5, lineHeight: 1.25, fontWeight: 600 }
  let trendNode: React.ReactNode = null
  if (overview.trend_available && overview.trend !== null) {
    const t = overview.trend
    if (t > 0) {
      trendNode = <span style={{ ...trendStyle, color: '#86efac' }}>▲ {t} points vs last month</span>
    } else if (t < 0) {
      trendNode = <span style={{ ...trendStyle, color: '#fca5a5' }}>▼ {Math.abs(t)} points vs last month</span>
    } else {
      trendNode = <span style={{ ...trendStyle, color: 'rgba(255,255,255,0.6)' }}>→ No change vs last month</span>
    }
  }

  return (
    <div style={{ padding: '24px 28px', background: BG, minHeight: '100%' }}>
      <style>{`
        @keyframes nvShimmer { 0%,100% { opacity: 0.35 } 50% { opacity: 0.85 } }
        .nv-ghost-btn:hover { background:#f9fafb !important; }
        .nv-icon-btn:hover { background:#eef1f5 !important; }
        .nv-row:hover { background:#f9fafb !important; }
        .nv-spin { animation: nvSpin 0.8s linear infinite; }
        @keyframes nvSpin { to { transform: rotate(360deg) } }
        @media (max-width: 1100px) {
          .nv-sec2, .nv-sec4 { grid-template-columns: 1fr !important; }
          .nv-stats { grid-template-columns: repeat(2,1fr) !important; }
          .nv-health { flex-direction: column !important; }
          .nv-health-right { width: 100% !important; }
        }
      `}</style>

      <UpdatedNotice />

      {/* ============================ HEADER ========================= */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 22, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: 0 }}>Dashboard</h1>
          <p style={{ fontSize: 13.5, color: MUTED, margin: '4px 0 0' }}>Infrastructure overview</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="nv-ghost-btn"
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', background: 'white', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {IconGrid(15, '#6b7280')} Custom View
          </button>
          <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{clock || '—'}</div>
            <div style={{ fontSize: 11, color: MUTED }}>ICT · Asia/Bangkok</div>
          </div>
          <button
            onClick={loadAll}
            className="nv-icon-btn"
            aria-label="Refresh"
            title="Refresh"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', color: NAVY }}
          >
            <span className={refreshing ? 'nv-spin' : ''} style={{ display: 'flex' }}>{IconRefresh(17, NAVY)}</span>
          </button>
        </div>
      </div>

      {/* ============== SECTION 1 — HEALTH SCORE (navy) ============== */}
      <div style={{ background: NAVY, borderRadius: 12, padding: 18, color: 'white', marginBottom: 20, boxShadow: CARD_SHADOW }}>
        <div className="nv-health" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 24 }}>

          {/* LEFT — gauge */}
          <div style={{ flexShrink: 0, width: 140, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: (R + STROKE) * 2, height: (R + STROKE) * 2 }}>
              <svg width={(R + STROKE) * 2} height={(R + STROKE) * 2} style={{ transform: 'rotate(-90deg)' }}>
                <circle cx={R + STROKE} cy={R + STROKE} r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={STROKE} />
                <circle
                  cx={R + STROKE} cy={R + STROKE} r={R} fill="none" stroke={gColor} strokeWidth={STROKE}
                  strokeLinecap="round" strokeDasharray={C} strokeDashoffset={dashOffset}
                  style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(0.22,1,0.36,1), stroke 0.6s ease' }}
                />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                {loading ? <Shimmer w={40} h={24} light /> : (
                  <>
                    <span style={{ fontSize: 26, fontWeight: 800, lineHeight: 1 }}>{overview.health_score}</span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>/ 100</span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: gColor, color: 'white', fontWeight: 800, fontSize: 13 }}>
                {overview.health_grade}
              </span>
              {trendNode}
            </div>
          </div>

          {/* CENTER — overall status */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', borderLeft: '1px solid rgba(255,255,255,0.08)', borderRight: '1px solid rgba(255,255,255,0.08)', padding: '0 24px' }}>
            <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', fontWeight: 700 }}>Overall Status</div>
            {loading ? <div style={{ margin: '6px 0' }}><Shimmer w={150} h={28} light /></div> : (
              <div style={{ fontSize: 28, fontWeight: 800, color: statusColor(overview.overall_status), margin: '4px 0 6px' }}>
                {overview.overall_status}
              </div>
            )}
            <p style={{ fontSize: 12.5, lineHeight: 1.45, color: 'rgba(255,255,255,0.66)', margin: 0, maxWidth: 420 }}>
              {overview.status_description}
            </p>
          </div>

          {/* RIGHT — metric tiles in a row */}
          <div className="nv-health-right" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, flexShrink: 0 }}>
            {tiles.map((t, i) => (
              <div key={i} style={{ width: 180, flexShrink: 0, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: `${t.color}22`, color: t.color }}>
                    {t.icon(15, t.color)}
                  </span>
                </div>
                {loading ? <div style={{ margin: '6px 0' }}><Shimmer w={50} h={22} light /></div> : (
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6, lineHeight: 1 }}>
                    {typeof t.value === 'number' ? t.value.toLocaleString() : t.value}
                  </div>
                )}
                <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 3 }}>{t.label}</div>
                <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginBottom: 5 }}>{t.sub}</div>
                <div style={{ marginTop: 'auto' }}><Sparkline points={t.spark} color={t.color} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ===================== SECTION 2 — 40/35/25 ================== */}
      <div className="nv-sec2" style={{ display: 'grid', gridTemplateColumns: '40fr 35fr 25fr', gap: 20, marginBottom: 20 }}>

        {/* LEFT — Fleet Health donut */}
        <div style={cardStyleCompact}>
          <h2 style={cardTitle}>Fleet Health</h2>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 24, alignItems: 'center', marginTop: 8 }}>
            {/* pie — left */}
            <div style={{ position: 'relative', width: 190, height: 180, flexShrink: 0 }}>
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><Shimmer w={150} h={150} r={75} /></div>
              ) : fleet.segments.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 13 }}>No data</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={fleet.segments} dataKey="count" nameKey="label" innerRadius={58} outerRadius={84} paddingAngle={2} stroke="none">
                        {fleet.segments.map((s, i) => <Cell key={i} fill={s.color} />)}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                    <span style={{ fontSize: 26, fontWeight: 800, color: '#111827' }}>{fleet.total.toLocaleString()}</span>
                    <span style={{ fontSize: 11, color: MUTED }}>Total Devices</span>
                  </div>
                </>
              )}
            </div>
            {/* legend — right */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {fleet.segments.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12.5 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, color: '#374151' }}>{s.label}</span>
                  <span style={{ fontWeight: 700, color: '#111827' }}>{s.count.toLocaleString()}</span>
                  <span style={{ color: MUTED, width: 42, textAlign: 'right' }}>{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, borderTop: '1px solid #f3f4f6', paddingTop: 10 }}>
            Last updated: {minutesAgo(fleet.last_updated)}
          </div>
        </div>

        {/* CENTER — Devices by Region */}
        <div style={cardStyleCompact}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={cardTitle}>Devices by Region</h2>
            <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: MUTED }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: NAVY }} />Healthy</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: RED }} />EOL</span>
            </div>
          </div>
          <div style={{ height: 180, marginTop: 12 }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: '100%', padding: '20px 8px' }}>
                {[60, 80, 45, 70].map((h, i) => <Shimmer key={i} w="100%" h={`${h}%`} />)}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byRegion} barGap={4} barCategoryGap="28%" margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <XAxis dataKey="region" tickLine={false} axisLine={{ stroke: '#e5e7eb' }} tick={{ fontSize: 12, fill: MUTED }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: MUTED }} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                  <Bar dataKey="healthy" name="Healthy" fill={NAVY} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="eol" name="EOL" fill={RED} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div style={{ marginTop: 10, textAlign: 'right' }}>
            <Link href="/devices" style={viewLink}>View detailed report →</Link>
          </div>
        </div>

        {/* RIGHT — Sites Requiring Attention */}
        <div style={cardStyleCompact}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h2 style={cardTitle}>Sites Requiring Attention</h2>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 6px', borderRadius: 11, background: RED, color: 'white', fontSize: 12, fontWeight: 700 }}>
              {sitesBadgeCount}
            </span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loading ? (
              [0, 1, 2].map(i => <div key={i} style={{ padding: '6px 0' }}><Shimmer w="70%" h={14} /><div style={{ marginTop: 6 }}><Shimmer w="40%" h={11} /></div></div>)
            ) : topEol.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '20px 0', textAlign: 'center' }}>No sites at risk</div>
            ) : topEol.slice(0, 3).map((s, i) => {
              const high = s.eol_pct >= 50
              return (
                <Link key={i} href="/sites?filter=eol" style={{ textDecoration: 'none' }}>
                  <div className="nv-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderRadius: 8, borderBottom: i < 2 ? '1px solid #f3f4f6' : 'none', cursor: 'pointer' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.site_name}</div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 1 }}>{s.city} • {s.region}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 5, color: high ? '#991b1b' : '#92400e', background: high ? '#fee2e2' : '#fef3c7' }}>
                          {high ? 'HIGH' : 'MEDIUM'}
                        </span>
                        <span style={{ fontSize: 11.5, color: '#991b1b', fontWeight: 600 }}>{s.eol_count} EOL Devices</span>
                      </div>
                    </div>
                    <span style={{ color: '#9ca3af', display: 'flex' }}>{IconChevron(18, '#9ca3af')}</span>
                  </div>
                </Link>
              )
            })}
          </div>
          <div style={{ marginTop: 8, paddingTop: 10, borderTop: '1px solid #f3f4f6' }}>
            <Link href="/sites?filter=eol" style={viewLink}>View all EOL sites →</Link>
          </div>
        </div>
      </div>

      {/* ===================== SECTION 3 — stats row ================= */}
      <div className="nv-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 16, marginBottom: 20 }}>
        {statCards.map((s, i) => (
          <Link key={i} href={s.href} style={{ textDecoration: 'none' }}>
            <div className="nv-row" style={{ ...cardStyle, padding: 18, cursor: 'pointer', height: '100%' }}>
              <span style={{ display: 'inline-flex', width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: '#f0f4f9', color: NAVY }}>
                {s.icon(18, NAVY)}
              </span>
              {loading ? <div style={{ margin: '10px 0 2px' }}><Shimmer w={60} h={26} /></div> : (
                <div style={{ fontSize: 26, fontWeight: 800, color: '#111827', marginTop: 10 }}>{s.value.toLocaleString()}</div>
              )}
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginTop: 2 }}>{s.label}</div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 1 }}>{s.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* ===================== SECTION 4 — 35/35/30 ================== */}
      <div className="nv-sec4" style={{ display: 'grid', gridTemplateColumns: '35fr 35fr 30fr', gap: 20 }}>

        {/* LEFT — Devices by Type (horizontal bars) */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={cardTitle}>Devices by Type</h2>
            <Link href="/devices" style={viewLink}>View all device types →</Link>
          </div>
          <div style={{ height: Math.max(180, byType.length * 34), marginTop: 14 }}>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 }}>
                {[80, 65, 55, 40, 30].map((w, i) => <Shimmer key={i} w={`${w}%`} h={16} />)}
              </div>
            ) : byType.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 13 }}>No data</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={byType} margin={{ top: 0, right: 28, left: 0, bottom: 0 }}>
                  <XAxis type="number" hide domain={[0, maxType]} />
                  <YAxis type="category" dataKey="type" width={96} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: MUTED }} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                  <Bar dataKey="count" name="Devices" fill={NAVY} radius={[0, 4, 4, 0]} barSize={16}>
                    <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: '#374151', fontWeight: 600 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* CENTER — Top EOL Sites */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={cardTitle}>Top EOL Sites</h2>
            <Link href="/eol" style={viewLink}>View all →</Link>
          </div>
          <div style={{ marginTop: 12 }}>
            {loading ? (
              [0, 1, 2, 3, 4].map(i => <div key={i} style={{ padding: '9px 0' }}><Shimmer w="60%" h={13} /><div style={{ marginTop: 6 }}><Shimmer w="100%" h={6} r={3} /></div></div>)
            ) : topEol.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '20px 0', textAlign: 'center' }}>No EOL sites</div>
            ) : topEol.slice(0, 5).map((s, i) => (
              <Link key={i} href="/sites?filter=eol" style={{ textDecoration: 'none', display: 'block' }}>
                <div className="nv-row" style={{ padding: '10px 8px', margin: '0 -8px', borderRadius: 8, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.site_name}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#991b1b', flexShrink: 0 }}>{s.eol_count}</span>
                  </div>
                  <div style={{ fontSize: 11, color: MUTED, margin: '2px 0 5px' }}>{s.city} • {s.region}</div>
                  <div style={{ height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, s.eol_pct)}%`, height: '100%', background: RED, borderRadius: 3 }} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* RIGHT — Recent Activity */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={cardTitle}>Recent Activity</h2>
            <Link href="/audit" style={viewLink}>View all →</Link>
          </div>
          <div style={{ marginTop: 12 }}>
            {loading ? (
              [0, 1, 2, 3, 4, 5].map(i => <div key={i} style={{ padding: '9px 0' }}><Shimmer w="80%" h={13} /><div style={{ marginTop: 5 }}><Shimmer w="50%" h={11} /></div></div>)
            ) : activity.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '20px 0', textAlign: 'center' }}>No recent activity</div>
            ) : activity.slice(0, 6).map((a, i) => {
              const c = activityColor(a.action)
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: i < Math.min(6, activity.length) - 1 ? '1px solid #f3f4f6' : 'none' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, flexShrink: 0, marginTop: 5 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111827', textTransform: 'capitalize' }}>{a.action}</div>
                    <div style={{ fontSize: 11.5, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.entity}{a.user ? ` · ${a.user}` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0, whiteSpace: 'nowrap' }}>{a.time}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
