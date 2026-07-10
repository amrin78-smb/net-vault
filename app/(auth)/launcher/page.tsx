'use client'
import { useSession, signOut } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import ThemeToggle from '@/components/ThemeToggle'
import LicenseBanner from '@/components/LicenseBanner'

type LicenseInfo = { status: string; daysRemaining: number; expiry: string | null; modules?: string[] }
type HealthStatus = 'Healthy' | 'Warning' | 'Unavailable'
type SuiteHealth = { app: string; status: HealthStatus }
type NetvaultStats = { devices_total: number; sites_total: number; eol_total: number }
type SuiteStats = {
  logvault: Record<string, unknown> | null
  ddivault: Record<string, unknown> | null
  spanvault: Record<string, unknown> | null
}
type ServerStats = {
  host?: string
  disk: { total: number; used: number; free: number; percent: number; path: string }
  memory: { total: number; used: number; free: number; percent: number }
  cpu: { percent: number }
  uptime_seconds: number
  disk_forecast_days: number | null
}
// NocVault Hub — cross-app suite intelligence (from /api/hub/*)
type HubKpis = {
  fleetHealth: { score: number | null; grade: string | null; delta7d: number | null }
  availability: { pct: number | null; devices: number | null; alerts: number | null }
  logAnomalies: { total: number | null; newToday: number | null }
  ipamUtilization: { pct: number | null; subnetsOver85: number | null }
  openAlerts: { total: number | null }
}
type HubAlert = { severity: 'critical' | 'warning' | 'info'; title: string; detail: string; sources: string[] }
// Unified suite search + Asset 360 (from /api/hub/search and /api/hub/asset360)
type SearchResult = { ip: string | null; label: string; netvaultId: string | null; sources: string[] }
type Asset360 = {
  device: {
    id: string; name: string; ip: string | null; lifecycle_status: string | null; device_status: string | null
    model: string | null; serial_number: string | null; support_end_date: string | null
    os_type: string | null; os_version: string | null; os_eol_date: string | null; site: string | null
  } | null
  monitoring: {
    status: string; healthScore: number | null; grade: string | null; uptimePct: number | null
    latencyAvg: number | null; openAlerts: number | null; alerts: { type: string; severity: string; since: string }[]
  } | null
  logs: {
    riskScore: number | null; eventCount: number | null; anomalyCount: number | null; securityEvents24h: number | null
    country: string | null; asnOrg: string | null; isKnownBad: boolean | null
    recent: { time: string; severity: string; message: string }[]
  } | null
  dns: { records: { type: string; name: string; data: string }[]; ipam: { status: string; subnet: string | null } | null } | null
}

const NAVY = '#1a2744'
const RED = '#C8102E'
const CARD_SHADOW = '0 4px 24px rgba(0,0,0,0.15)'

// ── lightweight inline metric icons ─────────────────────────────────
const ICONS: Record<string, React.ReactNode> = {
  device: <path d="M4 4h16v12H4zM2 20h20M9 16v4M15 16v4" />,
  site: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />,
  warning: <><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  log: <><path d="M4 4h16v16H4z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="12" y2="17" /></>,
  source: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></>,
  bell: <><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></>,
  dns: <><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></>,
  dhcp: <><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>,
  ip: <><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M7 13l3-3 2 2 4-4" /></>,
  availability: <><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
  alert: <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
}

function MetricIcon({ name }: { name: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {ICONS[name] ?? ICONS.device}
    </svg>
  )
}

const HEALTH_COLORS: Record<HealthStatus, string> = {
  Healthy: '#16a34a',
  Warning: '#d97706',
  Unavailable: '#9ca3af',
}

// Compact icon-only marks for the Suite Health pills (no wordmark).
function AppIcon({ name }: { name: string }) {
  switch (name) {
    case 'NetVault':
      return (
        <svg viewBox="0 0 38 42" width="20" height="22" style={{ flexShrink: 0 }}>
          <line x1="19" y1="4" x2="4" y2="36" stroke="#C8102E" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="19" y1="4" x2="34" y2="36" stroke="#C8102E" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="4" y1="36" x2="34" y2="36" stroke="#C8102E" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="19" cy="4" r="3" fill="#C8102E" />
          <circle cx="4" cy="36" r="3" fill="#C8102E" />
          <circle cx="34" cy="36" r="3" fill="#C8102E" />
        </svg>
      )
    case 'LogVault':
      return (
        <svg viewBox="0 0 32 46" width="16" height="22" style={{ flexShrink: 0 }}>
          <rect x="2" y="6" width="3" height="34" rx="1.5" fill="#2563eb" />
          <rect x="9" y="7" width="20" height="3" rx="1.5" fill="#2563eb" />
          <rect x="9" y="15" width="14" height="3" rx="1.5" fill="#2563eb" opacity="0.7" />
          <rect x="9" y="23" width="18" height="3" rx="1.5" fill="#2563eb" opacity="0.85" />
          <rect x="9" y="31" width="10" height="3" rx="1.5" fill="#2563eb" opacity="0.6" />
        </svg>
      )
    case 'DDIVault':
      return (
        <svg viewBox="0 0 38 44" width="20" height="22" style={{ flexShrink: 0 }}>
          <circle cx="19" cy="22" r="15" fill="none" stroke="#d97706" strokeWidth="2" />
          <ellipse cx="19" cy="22" rx="7" ry="15" fill="none" stroke="#d97706" strokeWidth="1.5" />
          <line x1="4" y1="22" x2="34" y2="22" stroke="#d97706" strokeWidth="1.5" />
        </svg>
      )
    case 'SpanVault':
      return (
        <svg viewBox="0 0 40 46" width="22" height="22" style={{ flexShrink: 0 }}>
          <path d="M1,23 L7,23 L11,8 L16,38 L21,8 L26,38 L30,23 L38,23" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    default:
      return null
  }
}

function num(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v).toLocaleString()
  if (typeof v === 'string') return v
  return '—'
}

function Skeleton() {
  return (
    <span style={{ display: 'inline-block', width: '38px', height: '15px', borderRadius: '4px', background: 'rgba(255,255,255,0.18)', animation: 'nvShimmer 1.4s ease-in-out infinite' }} />
  )
}

// ── Server Status helpers ───────────────────────────────────────────
function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d >= 1) return `${d} day${d !== 1 ? 's' : ''} ${h} hour${h !== 1 ? 's' : ''}`
  return `${h}h ${m}m`
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: '8px', background: 'var(--surface-subtle)', borderRadius: '4px', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color, borderRadius: '4px', transition: 'width 0.5s' }} />
    </div>
  )
}

function ValueSkeleton({ w = '120px', h = '16px' }: { w?: string; h?: string }) {
  return <span style={{ display: 'inline-block', width: w, height: h, borderRadius: '4px', background: 'var(--surface-subtle)', animation: 'nvShimmer 1.4s ease-in-out infinite' }} />
}

const SS_LABEL: React.CSSProperties = { fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }

const SEV_BAR: Record<string, string> = { critical: '#dc2626', warning: '#d97706', info: '#2563eb' }
const SRC_COLOR: Record<string, string> = { NetVault: '#C8102E', LogVault: '#2563eb', DDIVault: '#d97706', SpanVault: '#16a34a' }
function fmtKpi(v: number | null | undefined, suffix = ''): string {
  return v === null || v === undefined ? '—' : `${v}${suffix}`
}
function scoreColorVal(s: number | null | undefined): string {
  if (s === null || s === undefined) return 'var(--text-muted)'
  return s >= 80 ? '#16a34a' : s >= 60 ? '#d97706' : '#dc2626'
}

// ── Asset 360 drawer helpers ────────────────────────────────────────
function r1(v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : Math.round(v * 10) / 10
}
function fmtDate(d: string | null | undefined): string | null {
  if (!d) return null
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) } catch { return String(d) }
}
function DRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '7px 0', borderBottom: '1px solid var(--border-light)' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', fontFamily: mono ? 'var(--font-mono)' : 'inherit', wordBreak: 'break-word' }}>
        {value === null || value === undefined || value === '' ? '—' : value}
      </span>
    </div>
  )
}
function DHead({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '16px 0 6px' }}>{children}</div>
}
function DEmpty({ app }: { app: string }) {
  return <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '12px 0' }}>No {app} data correlated for this asset.</div>
}

function LauncherInner() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  // Per-user SSO access denial → ?denied=<slug> (set by the SSO route on refusal).
  const deniedSlug = searchParams.get('denied')
  const [deniedDismissed, setDeniedDismissed] = useState(false)
  const [settings, setSettings] = useState({ app_primary_color: '#C8102E', app_navy_color: '#1a2744' })
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null)
  const [health, setHealth] = useState<SuiteHealth[] | null>(null)
  const [netStats, setNetStats] = useState<NetvaultStats | null>(null)
  const [suiteStats, setSuiteStats] = useState<SuiteStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [serverStats, setServerStats] = useState<ServerStats | null>(null)
  const [serverLoading, setServerLoading] = useState(true)
  const [serverError, setServerError] = useState(false)
  const [clock, setClock] = useState('')
  const [hubKpis, setHubKpis] = useState<HubKpis | null>(null)
  const [hubAlerts, setHubAlerts] = useState<HubAlert[] | null>(null)
  // Unified suite search + Asset 360 drawer
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [asset, setAsset] = useState<Asset360 | null>(null)
  const [assetTab, setAssetTab] = useState<'overview' | 'monitoring' | 'logs' | 'dns'>('overview')
  const [assetLoading, setAssetLoading] = useState(false)
  const [assetOpen, setAssetOpen] = useState(false)
  const [assetLabel, setAssetLabel] = useState('')

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => { if (d && !d.error) setSettings(d) }).catch(() => {})
    fetch('/api/license').then(r => r.json()).then(d => { if (!d.error) setLicenseInfo(d) }).catch(() => {})
    fetch('/api/suite/health').then(r => r.json()).then(d => { if (Array.isArray(d)) setHealth(d) }).catch(() => setHealth([]))
    fetch('/api/netvault-stats').then(r => r.json()).then(d => { if (d && !d.error) setNetStats(d) }).catch(() => {}).finally(() => setStatsLoading(false))
    fetch('/api/suite/stats').then(r => r.json()).then(d => { if (d && !d.error) setSuiteStats(d) }).catch(() => {})
    fetch('/api/hub/kpis').then(r => r.json()).then(d => { if (d && !d.error) setHubKpis(d) }).catch(() => {})
    fetch('/api/hub/alerts').then(r => r.json()).then(d => { if (d && Array.isArray(d.alerts)) setHubAlerts(d.alerts) }).catch(() => setHubAlerts([]))
  }, [])

  // Server status — fetch on load, auto-refresh every 30s. Never crash the page.
  useEffect(() => {
    let alive = true
    const load = () => {
      fetch('/api/server-stats')
        .then(r => r.json())
        .then(d => {
          if (!alive) return
          if (d && !d.error && d.disk && d.memory && d.cpu) {
            setServerStats(d)
            setServerError(false)
          } else {
            setServerError(true)
          }
        })
        .catch(() => { if (alive) setServerError(true) })
        .finally(() => { if (alive) setServerLoading(false) })
    }
    load()
    const id = setInterval(load, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Live clock — Asia/Bangkok (ICT), refresh every minute.
  useEffect(() => {
    const fmt = () => {
      try {
        const f = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Bangkok',
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true,
        })
        const parts = f.formatToParts(new Date())
        const get = (t: string) => parts.find(p => p.type === t)?.value || ''
        const date = `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}`
        const time = `${get('hour')}:${get('minute')} ${get('dayPeriod')}`
        setClock(`${date} • ${time} (ICT)`)
      } catch {
        setClock('')
      }
    }
    fmt()
    const id = setInterval(fmt, 60000)
    return () => clearInterval(id)
  }, [])

  // Unified suite search — debounced; queries all four apps via /api/hub/search.
  useEffect(() => {
    const q = searchQ.trim()
    if (q.length < 2) { setSearchResults([]); setSearchOpen(false); return }
    setSearchLoading(true)
    const id = setTimeout(() => {
      fetch(`/api/hub/search?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(d => { setSearchResults(Array.isArray(d.results) ? d.results : []); setSearchOpen(true) })
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false))
    }, 250)
    return () => clearTimeout(id)
  }, [searchQ])

  if (status === 'loading') return null
  if (status === 'unauthenticated') { router.push('/login'); return null }

  const user = session?.user as { name?: string; email?: string; role?: string }
  const primary = settings.app_primary_color || RED
  const navy = settings.app_navy_color || NAVY

  const firstName = user?.name?.split(' ')[0] || 'there'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const spanvaultUrl = typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3008`
    : 'http://localhost:3008'

  const healthFor = (app: string): HealthStatus =>
    (health?.find(h => h.app === app)?.status) ?? 'Unavailable'

  // Overall suite status
  let overall: 'Healthy' | 'Degraded' | 'Critical' = 'Healthy'
  if (health) {
    if (health.some(h => h.status === 'Unavailable')) overall = 'Critical'
    else if (health.some(h => h.status === 'Warning')) overall = 'Degraded'
  } else overall = 'Critical'
  const overallColor = overall === 'Healthy' ? '#16a34a' : overall === 'Degraded' ? '#d97706' : '#C8102E'
  const overallSub = overall === 'Healthy' ? 'All systems operational' : overall === 'Degraded' ? 'Some systems degraded' : 'Action required'

  const lv = suiteStats?.logvault ?? null
  const dv = suiteStats?.ddivault ?? null
  const sv = suiteStats?.spanvault ?? null

  type AppCard = {
    name: string
    slug: 'netvault' | 'logvault' | 'ddivault' | 'spanvault'
    subtitle: string
    description: string
    href: string
    color: string
    logo: string
    metrics: { icon: string; value: string; label: string }[]
  }

  // LENIENT module entitlement: a suite app is treated as licensed UNLESS there
  // is an ACTIVE key that explicitly lists modules and omits this app's slug.
  // Trial / grace / expired / unreachable / empty-modules → all tiles licensed.
  // The NetVault host tile is ALWAYS licensed (never greyed).
  const isLicensed = (slug: AppCard['slug']): boolean =>
    slug === 'netvault'
      ? true
      : !(licenseInfo?.status === 'active'
          && Array.isArray(licenseInfo.modules)
          && licenseInfo.modules.length > 0
          && !licenseInfo.modules.includes(slug))

  // PER-USER app access (independent of licensing). NetVault is always accessible;
  // an empty/undefined apps list means "all apps" (legacy users / super_admin).
  const apps = (session?.user as any)?.apps as string[] | undefined
  const canAccess = (slug: AppCard['slug']): boolean =>
    slug === 'netvault' || !apps || apps.length === 0 || apps.includes(slug)

  const cards: AppCard[] = [
    {
      name: 'NetVault', slug: 'netvault', subtitle: 'Network Asset Management',
      description: 'Devices, sites, circuits and EOL/EOS tracking.',
      href: '/dashboard', color: primary, logo: '/netvault-logo.svg',
      metrics: [
        { icon: 'device', value: statsLoading ? '' : num(netStats?.devices_total), label: 'Devices' },
        { icon: 'site', value: statsLoading ? '' : num(netStats?.sites_total), label: 'Sites' },
        { icon: 'warning', value: statsLoading ? '' : num(netStats?.eol_total), label: 'EOL / EOS Assets' },
      ],
    },
    {
      name: 'LogVault', slug: 'logvault', subtitle: 'Syslog & Log Analysis',
      description: 'Real-time syslog collection, analysis and alerting.',
      href: '/api/sso/logvault', color: '#2563eb', logo: '/logvault-logo.svg',
      metrics: [
        { icon: 'log', value: statsLoading ? '' : num(lv?.logs_today), label: 'Logs Today' },
        { icon: 'source', value: statsLoading ? '' : num(lv?.log_sources), label: 'Log Sources' },
        { icon: 'bell', value: statsLoading ? '' : num(lv?.active_alerts), label: 'Active Alerts' },
      ],
    },
    {
      name: 'DDIVault', slug: 'ddivault', subtitle: 'DNS, DHCP & IPAM Solution',
      description: 'Centralised DNS, DHCP and IP address management.',
      href: '/api/sso/ddivault', color: '#d97706', logo: '/ddivault-logo.svg',
      metrics: [
        { icon: 'dns', value: statsLoading ? '' : num(dv?.dns_servers), label: 'DNS Servers' },
        { icon: 'dhcp', value: statsLoading ? '' : num(dv?.dhcp_clusters), label: 'DHCP Clusters' },
        { icon: 'ip', value: statsLoading ? '' : num(dv?.ip_utilized), label: 'IP Addresses Utilized' },
      ],
    },
    {
      name: 'SpanVault', slug: 'spanvault', subtitle: 'Network Monitoring',
      description: 'Device monitoring, availability and performance alerting.',
      href: spanvaultUrl, color: '#16a34a', logo: '/spanvault-logo.svg',
      metrics: [
        { icon: 'monitor', value: statsLoading ? '' : num(sv?.monitored_devices), label: 'Monitored Devices' },
        { icon: 'availability', value: statsLoading ? '' : (sv?.availability != null ? `${num(sv?.availability)}%` : '—'), label: 'Availability' },
        { icon: 'alert', value: statsLoading ? '' : num(sv?.active_alerts), label: 'Active Alerts' },
      ],
    },
  ]

  // Open the Asset 360 drawer for a search hit; aggregates its cross-app story.
  const openAsset = (r: SearchResult) => {
    setAssetOpen(true); setAssetLoading(true); setAsset(null); setAssetTab('overview')
    setAssetLabel(r.label); setSearchOpen(false)
    const p = new URLSearchParams()
    if (r.netvaultId) p.set('id', r.netvaultId)
    if (r.ip) p.set('ip', r.ip)
    fetch(`/api/hub/asset360?${p.toString()}`)
      .then(res => res.json())
      .then(d => setAsset(d))
      .catch(() => setAsset({ device: null, monitoring: null, logs: null, dns: null }))
      .finally(() => setAssetLoading(false))
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes nvShimmer { 0%,100% { opacity: 0.35 } 50% { opacity: 0.8 } }
        @keyframes nvDrawerIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
        .nv-drawer { animation: nvDrawerIn 0.22s ease-out }
        .nv-search-input::placeholder { color: var(--text-muted) }
        @media (max-width: 1100px) { .nv-top-grid { grid-template-columns: 1fr !important } .nv-app-grid { grid-template-columns: repeat(2, 1fr) !important } .nv-server-grid { grid-template-columns: repeat(2, 1fr) !important } .nv-kpi-grid { grid-template-columns: repeat(3, 1fr) !important } }
        @media (max-width: 640px) { .nv-app-grid { grid-template-columns: 1fr !important } .nv-server-grid { grid-template-columns: 1fr !important } .nv-kpi-grid { grid-template-columns: repeat(2, 1fr) !important } }
      `}</style>

      {/* Top bar */}
      <div style={{ background: navy, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <img src="/nocvault-logo.svg" alt="NocVault" style={{ maxHeight: '38px', width: 'auto', objectFit: 'contain' }} />
          <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '10px', letterSpacing: '1.5px', fontWeight: 600 }}>NETWORK INTELLIGENCE SUITE</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ThemeToggle />
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: 'white', fontSize: '13px', fontWeight: '500' }}>{user?.name}</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>{user?.role?.replace('_', ' ')}</div>
          </div>
          <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: primary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '14px', fontWeight: '600' }}>
            {user?.name?.charAt(0)?.toUpperCase() || 'U'}
          </div>
          <button onClick={() => signOut({ callbackUrl: '/login' })}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '7px', color: 'white', fontSize: '13px', cursor: 'pointer', fontWeight: '500' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.2)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            Sign out
          </button>
        </div>
      </div>

      {/* Standardized suite license banner — full-width bar directly below the launcher top bar */}
      <LicenseBanner />

      {/* SSO access-denied notice — shown when redirected here with ?denied=<slug> */}
      {deniedSlug && !deniedDismissed && (() => {
        const APP_NAMES: Record<string, string> = { netvault: 'NetVault', logvault: 'LogVault', ddivault: 'DDIVault', spanvault: 'SpanVault' }
        const name = APP_NAMES[deniedSlug] || deniedSlug
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 32px', background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', borderBottom: '1px solid var(--border)', fontSize: 'var(--text-base)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span style={{ flex: 1, fontWeight: 500 }}>You don’t have access to {name}. Contact an administrator if you need it.</span>
            <button onClick={() => setDeniedDismissed(true)} aria-label="Dismiss" style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '2px 4px', flexShrink: 0 }}>✕</button>
          </div>
        )
      })()}

      {/* Main content */}
      <div style={{ flex: 1, padding: '28px 32px', maxWidth: '1400px', width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>

        {/* Welcome + Suite health on one row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '24px', marginBottom: '32px' }}>

        {/* Welcome */}
        <div style={{ flex: '0 0 35%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: '15px', color: 'var(--text-muted)', lineHeight: 1.2, marginBottom: '1px' }}>{greeting},</div>
          <h1 style={{ fontSize: '34px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1, margin: '0 0 4px' }}>{firstName}</h1>
          <div style={{ fontSize: '15px', color: 'var(--text-secondary)', fontWeight: 600, lineHeight: 1.25, marginBottom: '2px' }}>Welcome to the Network Intelligence Suite.</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.25, marginBottom: '8px' }}>Centralized visibility. Smarter operations. Better decisions.</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={primary} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            {clock || '—'}
          </div>
        </div>

        {/* Suite health overview */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg-card)', borderRadius: '12px', boxShadow: CARD_SHADOW, padding: 0, overflow: 'hidden' }}>
          {/* Title row */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-light)', fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
            Suite Health Overview
          </div>

          {/* Body row */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px' }}>
            {/* Left: overall status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', paddingRight: '20px' }}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke={overallColor} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <polyline points="9 12 11 14 15 10" />
              </svg>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Overall Status</div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: overallColor, lineHeight: 1.15 }}>{overall}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{overallSub}</div>
              </div>
            </div>

            {/* Divider */}
            <div style={{ width: '1px', height: '60px', background: 'var(--border)', flexShrink: 0 }} />

            {/* Right: app pills */}
            <div style={{ display: 'flex', alignItems: 'stretch', flex: 1 }}>
              {(['NetVault', 'LogVault', 'DDIVault', 'SpanVault'] as const).map((app, i) => {
                const st = healthFor(app)
                const pillLicensed = isLicensed(app.toLowerCase() as AppCard['slug'])
                return (
                  <div key={app} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '6px', padding: '0 24px', borderLeft: i === 0 ? 'none' : '1px solid var(--border-light)', opacity: pillLicensed ? 1 : 0.5, filter: pillLicensed ? 'none' : 'grayscale(1)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <AppIcon name={app} />
                      <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>{app}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      {pillLicensed ? (
                        <>
                          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: HEALTH_COLORS[st], display: 'inline-block', flexShrink: 0 }} />
                          <span style={{ fontSize: '12px', color: HEALTH_COLORS[st] }}>{st}</span>
                        </>
                      ) : (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Not licensed</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        </div>

        {/* App cards */}
        <div className="nv-app-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '18px', marginBottom: '24px' }}>
          {cards.map(card => {
            const st = healthFor(card.name)
            const isLic = isLicensed(card.slug)
            const access = canAccess(card.slug)
            // A tile is fully enabled only when BOTH licensed AND the user has access.
            const licensed = isLic && access
            // No-access takes precedence in the disabled-state copy; else fall back to licensing copy.
            const noAccess = isLic && !access
            const netvaultEmpty = card.name === 'NetVault' && !statsLoading && netStats != null && netStats.devices_total === 0 && netStats.sites_total === 0 && netStats.eol_total === 0
            return (
              <div key={card.name} style={{ background: NAVY, borderRadius: '14px', boxShadow: CARD_SHADOW, padding: '18px', display: 'flex', flexDirection: 'column', color: 'white', position: 'relative' }}>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, opacity: licensed ? 1 : 0.5, filter: licensed ? 'none' : 'grayscale(1)', transition: 'opacity 0.2s, filter 0.2s' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <img src={card.logo} alt={card.name} style={{ height: '30px', width: 'auto', objectFit: 'contain' }} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 600, color: HEALTH_COLORS[st], background: 'rgba(255,255,255,0.08)', padding: '3px 8px', borderRadius: '10px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: HEALTH_COLORS[st] }} /> {st}
                  </span>
                </div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: card.color, marginBottom: '4px' }}>{card.subtitle}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', lineHeight: 1.45, marginBottom: '14px', minHeight: '34px' }}>{card.description}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '16px', flex: 1, filter: licensed ? 'none' : 'blur(2px)' }}>
                  {netvaultEmpty ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '6px', flex: 1, padding: '8px 0' }}>
                      <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.color }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                      </div>
                      <div style={{ fontWeight: 700, color: 'white', fontSize: '13px' }}>No devices yet</div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.4 }}>Import or add devices to get started</div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: '2px' }}><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
                    </div>
                  ) : (
                    card.metrics.map((m, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                        <span style={{ color: card.color }}><MetricIcon name={m.icon} /></span>
                        <span style={{ fontWeight: 700, color: 'white', minWidth: '20px' }}>{m.value === '' ? <Skeleton /> : m.value}</span>
                        <span style={{ color: 'rgba(255,255,255,0.55)' }}>{m.label}</span>
                      </div>
                    ))
                  )}
                </div>
                </div>
                {licensed ? (
                  <a href={card.href} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: card.color, color: 'white', fontSize: '13px', fontWeight: 600, padding: '10px', borderRadius: '8px', textDecoration: 'none' }}>
                    Open {card.name}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </a>
                ) : (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)', fontSize: '13px', fontWeight: 600, padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', cursor: 'not-allowed' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
                      {noAccess ? 'No access' : 'Not licensed'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', textAlign: 'center', marginTop: '7px', lineHeight: 1.4 }}>
                      {noAccess
                        ? 'You don’t have access to this app — ask an administrator.'
                        : <>Not licensed — contact <a href="mailto:sales@nocvault.com" style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>sales@nocvault.com</a></>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* ===== NocVault Hub — Suite Intelligence (cross-app layer) ===== */}
        <div style={{ marginTop: '34px', borderTop: '2px solid var(--border)', paddingTop: '18px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>NocVault Hub — Suite Intelligence</h2>
                <span style={{ background: primary, color: '#fff', fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', letterSpacing: '0.5px' }}>NEW</span>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>Cross-app insight no single app can see — correlated alerts and suite-wide KPIs across all four apps.</div>
            </div>

            {/* Unified suite search */}
            <div style={{ position: 'relative', width: '340px', maxWidth: '100%', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input
                className="nv-search-input"
                type="text"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                onFocus={() => { if (searchResults.length) setSearchOpen(true) }}
                placeholder="Search any asset — IP, hostname or name…"
                style={{ width: '100%', padding: '9px 12px 9px 34px', fontSize: '13px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }}
              />
              {searchOpen && (
                <>
                  <div onClick={() => setSearchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: CARD_SHADOW, zIndex: 30, overflow: 'hidden', maxHeight: '360px', overflowY: 'auto' }}>
                    {searchLoading ? (
                      <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>Searching all four apps…</div>
                    ) : searchResults.length === 0 ? (
                      <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>No matching assets.</div>
                    ) : (
                      searchResults.map((r, i) => (
                        <button key={i} onClick={() => openAsset(r)}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)', cursor: 'pointer' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-subtle)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</div>
                            {r.ip && <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.ip}</div>}
                          </div>
                          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                            {r.sources.map(s => <span key={s} title={s} style={{ width: '8px', height: '8px', borderRadius: '50%', background: SRC_COLOR[s] || '#888' }} />)}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* KPI strip */}
          <div className="nv-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '14px', marginBottom: '16px' }}>
            {[
              { lab: 'Fleet Health', val: hubKpis ? fmtKpi(hubKpis.fleetHealth.score) : '—', unit: hubKpis?.fleetHealth.score != null ? '/100' : '', sub: hubKpis?.fleetHealth.delta7d != null ? `${hubKpis.fleetHealth.delta7d >= 0 ? '▲ +' : '▼ '}${hubKpis.fleetHealth.delta7d} vs 7d` : (hubKpis?.fleetHealth.grade ? `grade ${hubKpis.fleetHealth.grade}` : ''), color: scoreColorVal(hubKpis?.fleetHealth.score) },
              { lab: 'Availability', val: hubKpis ? fmtKpi(hubKpis.availability.pct, '%') : '—', unit: '', sub: hubKpis?.availability.devices != null ? `${hubKpis.availability.devices} devices · ${hubKpis.availability.alerts ?? 0} alerts` : '', color: '#16a34a' },
              { lab: 'Log Anomalies', val: hubKpis ? fmtKpi(hubKpis.logAnomalies.total) : '—', unit: '', sub: hubKpis?.logAnomalies.newToday != null ? `${hubKpis.logAnomalies.newToday} new today` : '', color: 'var(--text-primary)' },
              { lab: 'IPAM Utilization', val: hubKpis ? fmtKpi(hubKpis.ipamUtilization.pct, '%') : '—', unit: '', sub: hubKpis?.ipamUtilization.subnetsOver85 != null ? `${hubKpis.ipamUtilization.subnetsOver85} subnets >85%` : '', color: '#d97706' },
              { lab: 'Open Alerts', val: hubKpis ? fmtKpi(hubKpis.openAlerts.total) : '—', unit: '', sub: 'across all apps', color: (hubKpis?.openAlerts.total ?? 0) > 0 ? '#dc2626' : 'var(--text-primary)' },
            ].map((t, i) => (
              <div key={i} style={{ background: 'var(--bg-card)', borderRadius: '12px', boxShadow: CARD_SHADOW, padding: '14px 16px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{t.lab}</div>
                <div style={{ fontSize: '24px', fontWeight: 800, color: t.color, marginTop: '3px', lineHeight: 1 }}>{t.val}<span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>{t.unit}</span></div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '5px', minHeight: '14px' }}>{t.sub}</div>
              </div>
            ))}
          </div>

          {/* Correlated suite alerts */}
          <div style={{ background: 'var(--bg-card)', borderRadius: '12px', boxShadow: CARD_SHADOW, padding: '16px 20px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Correlated suite alerts</div>
            {hubAlerts == null ? (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>
            ) : hubAlerts.length === 0 ? (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>No correlated alerts right now. Suite intelligence populates as cross-app signals appear.</div>
            ) : (
              hubAlerts.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: '10px', padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
                  <div style={{ width: '3px', borderRadius: '2px', background: SEV_BAR[a.severity] || 'var(--text-muted)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>{a.title}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '2px' }}>{a.detail}</div>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '5px', flexWrap: 'wrap' }}>
                      {a.sources.map(s => (
                        <span key={s} style={{ fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '5px', color: SRC_COLOR[s] || 'var(--text-muted)', background: `${SRC_COLOR[s] || '#888888'}22` }}>{s}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Server Status */}
        {(() => {
          const loading = serverLoading && !serverStats
          const s = serverStats
          const memPct = s?.memory.percent ?? 0
          const memColor = memPct > 85 ? '#dc2626' : memPct >= 70 ? '#d97706' : '#16a34a'
          const cpuPct = s?.cpu.percent ?? 0
          const cpuColor = cpuPct > 80 ? '#dc2626' : cpuPct >= 50 ? '#d97706' : '#16a34a'
          const diskPct = s?.disk.percent ?? 0
          const diskColor = diskPct > 90 ? '#dc2626' : diskPct > 70 ? '#d97706' : '#16a34a'
          const fc = s?.disk_forecast_days ?? null
          let fcText = 'Stable'
          let fcColor = '#16a34a'
          if (fc != null) {
            fcText = `~${fc.toLocaleString()} day${fc !== 1 ? 's' : ''} until full`
            fcColor = fc < 30 ? '#dc2626' : fc < 90 ? '#d97706' : 'var(--text-muted)'
          }
          return (
            <div style={{ background: 'var(--bg-card)', borderRadius: '14px', boxShadow: CARD_SHADOW, padding: '20px 24px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--text-primary)' }}>
                  <rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" /><line x1="6" y1="6.5" x2="6.01" y2="6.5" /><line x1="6" y1="17.5" x2="6.01" y2="17.5" />
                </svg>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Server Status</div>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 18px' }}>{(s?.host || (typeof window !== 'undefined' ? window.location.hostname : 'localhost'))} — shared infrastructure for all suite apps</div>

              {serverError && !s ? (
                <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Server metrics unavailable</div>
              ) : (
                <div className="nv-server-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '28px' }}>
                  {/* DISK */}
                  <div>
                    <div style={SS_LABEL}>Disk</div>
                    {loading ? <ValueSkeleton w="100%" h="8px" /> : <ProgressBar pct={diskPct} color={diskColor} />}
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px' }}>
                      {loading || !s ? <ValueSkeleton w="150px" /> : `${gb(s.disk.used)} GB used of ${gb(s.disk.total)} GB (${diskPct}%)`}
                    </div>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: fcColor, marginTop: '3px' }}>
                      {loading || !s ? <ValueSkeleton w="110px" /> : fcText}
                    </div>
                  </div>
                  {/* MEMORY */}
                  <div>
                    <div style={SS_LABEL}>Memory</div>
                    {loading ? <ValueSkeleton w="100%" h="8px" /> : <ProgressBar pct={memPct} color={memColor} />}
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px' }}>
                      {loading || !s ? <ValueSkeleton w="150px" /> : `${gb(s.memory.used)} GB used of ${gb(s.memory.total)} GB (${memPct}%)`}
                    </div>
                  </div>
                  {/* CPU */}
                  <div>
                    <div style={SS_LABEL}>CPU</div>
                    <div style={{ fontSize: '30px', fontWeight: 800, color: cpuColor, lineHeight: 1.1 }}>
                      {loading || !s ? <ValueSkeleton w="70px" h="28px" /> : `${cpuPct}%`}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>CPU Usage</div>
                  </div>
                  {/* UPTIME */}
                  <div>
                    <div style={SS_LABEL}>Uptime</div>
                    <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.15 }}>
                      {loading || !s ? <ValueSkeleton w="120px" h="20px" /> : fmtUptime(s.uptime_seconds)}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>Server Uptime</div>
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '32px', fontSize: '12px', color: 'var(--text-muted)' }}>
          NocVault Intelligence Suite&nbsp;&nbsp;•&nbsp;&nbsp;All rights reserved © 2026
        </div>
      </div>

      {/* ===== Asset 360 drawer (cross-app story for one asset) ===== */}
      {assetOpen && (
        <>
          <div onClick={() => setAssetOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100 }} />
          <div className="nv-drawer" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: '460px', maxWidth: '92vw', background: 'var(--bg-primary)', boxShadow: '-8px 0 40px rgba(0,0,0,0.3)', zIndex: 101, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ background: navy, padding: '18px 22px', color: '#fff', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '10px', letterSpacing: '1px', color: 'rgba(255,255,255,0.5)', fontWeight: 700 }}>ASSET 360</div>
                <div style={{ fontSize: '18px', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{asset?.device?.name || assetLabel}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', fontFamily: 'var(--font-mono)' }}>{asset?.device?.ip || ''}</div>
              </div>
              <button onClick={() => setAssetOpen(false)} aria-label="Close" style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '7px', color: '#fff', width: '30px', height: '30px', cursor: 'pointer', fontSize: '15px', flexShrink: 0, lineHeight: 1 }}>✕</button>
            </div>
            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' }}>
              {([['overview', 'Overview'], ['monitoring', 'Monitoring'], ['logs', 'Logs & Security'], ['dns', 'DNS & IPAM']] as const).map(([k, lab]) => (
                <button key={k} onClick={() => setAssetTab(k)}
                  style={{ flex: 1, padding: '11px 6px', fontSize: '11.5px', fontWeight: 600, border: 'none', background: 'transparent', cursor: 'pointer', color: assetTab === k ? primary : 'var(--text-muted)', borderBottom: assetTab === k ? `2px solid ${primary}` : '2px solid transparent' }}>{lab}</button>
              ))}
            </div>
            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 22px 22px' }}>
              {assetLoading ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '16px 0' }}>Aggregating cross-app story…</div>
              ) : !asset ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '16px 0' }}>Could not load asset.</div>
              ) : assetTab === 'overview' ? (
                <>
                  {asset.device ? (
                    <>
                      <DHead>Asset of record · NetVault</DHead>
                      <DRow label="Name" value={asset.device.name} />
                      <DRow label="IP address" value={asset.device.ip} mono />
                      <DRow label="Site" value={asset.device.site} />
                      <DRow label="Model" value={asset.device.model} />
                      <DRow label="Serial" value={asset.device.serial_number} mono />
                      <DRow label="Lifecycle" value={asset.device.lifecycle_status} />
                      <DRow label="Status" value={asset.device.device_status} />
                      <DRow label="OS" value={[asset.device.os_type, asset.device.os_version].filter(Boolean).join(' ') || null} />
                      <DRow label="OS end-of-life" value={fmtDate(asset.device.os_eol_date)} />
                      <DRow label="Support ends" value={fmtDate(asset.device.support_end_date)} />
                    </>
                  ) : (
                    <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '12px 0' }}>Not in the NetVault CMDB — showing correlated signals matched by IP.</div>
                  )}
                  <DHead>Suite presence</DHead>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {([['NetVault', !!asset.device], ['SpanVault', !!asset.monitoring], ['LogVault', !!asset.logs], ['DDIVault', !!asset.dns]] as const).map(([app, on]) => (
                      <span key={app} style={{ fontSize: '11px', fontWeight: 600, padding: '4px 9px', borderRadius: '6px', color: on ? (SRC_COLOR[app] || 'var(--text-primary)') : 'var(--text-muted)', background: on ? `${SRC_COLOR[app] || '#888'}22` : 'var(--surface-subtle)', opacity: on ? 1 : 0.6 }}>
                        {on ? '● ' : '○ '}{app}
                      </span>
                    ))}
                  </div>
                </>
              ) : assetTab === 'monitoring' ? (
                asset.monitoring ? (
                  <>
                    <DHead>Availability · SpanVault</DHead>
                    <DRow label="Current status" value={<span style={{ color: asset.monitoring.status === 'up' ? '#16a34a' : asset.monitoring.status === 'down' ? '#dc2626' : 'var(--text-muted)', fontWeight: 700, textTransform: 'capitalize' }}>{asset.monitoring.status || '—'}</span>} />
                    <DRow label="Health score" value={asset.monitoring.healthScore != null ? <span style={{ color: scoreColorVal(asset.monitoring.healthScore) }}>{asset.monitoring.healthScore}/100{asset.monitoring.grade ? ` (${asset.monitoring.grade})` : ''}</span> : null} />
                    <DRow label="Uptime" value={asset.monitoring.uptimePct != null ? `${r1(asset.monitoring.uptimePct)}%` : null} />
                    <DRow label="Avg latency" value={asset.monitoring.latencyAvg != null ? `${r1(asset.monitoring.latencyAvg)} ms` : null} />
                    <DRow label="Open alerts" value={asset.monitoring.openAlerts} />
                    {asset.monitoring.alerts.length > 0 && (
                      <>
                        <DHead>Open alerts</DHead>
                        {asset.monitoring.alerts.map((a, i) => (
                          <div key={i} style={{ display: 'flex', gap: '8px', padding: '7px 0', borderBottom: '1px solid var(--border-light)' }}>
                            <span style={{ width: '3px', borderRadius: '2px', background: SEV_BAR[a.severity] || 'var(--text-muted)', flexShrink: 0 }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', textTransform: 'capitalize' }}>{a.type}</div>
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{fmtDate(a.since)} · {a.severity}</div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                ) : <DEmpty app="SpanVault monitoring" />
              ) : assetTab === 'logs' ? (
                asset.logs ? (
                  <>
                    <DHead>Risk & activity · LogVault</DHead>
                    <DRow label="Risk score" value={asset.logs.riskScore != null ? <span style={{ color: scoreColorVal(asset.logs.riskScore != null ? 100 - asset.logs.riskScore : null) }}>{asset.logs.riskScore}/100</span> : null} />
                    <DRow label="Events tracked" value={asset.logs.eventCount} />
                    <DRow label="Anomalies" value={asset.logs.anomalyCount} />
                    <DRow label="Security events (24h)" value={asset.logs.securityEvents24h} />
                    <DRow label="Country" value={asset.logs.country} />
                    <DRow label="Network (ASN)" value={asset.logs.asnOrg} />
                    <DRow label="Known-bad host" value={asset.logs.isKnownBad == null ? null : asset.logs.isKnownBad ? <span style={{ color: '#dc2626', fontWeight: 700 }}>Yes</span> : 'No'} />
                    {asset.logs.recent.length > 0 && (
                      <>
                        <DHead>Recent log entries</DHead>
                        {asset.logs.recent.map((e, i) => (
                          <div key={i} style={{ padding: '7px 0', borderBottom: '1px solid var(--border-light)' }}>
                            <div style={{ fontSize: '11.5px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>{e.message}</div>
                            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>{fmtDate(e.time)} · {e.severity}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                ) : <DEmpty app="LogVault" />
              ) : (
                asset.dns ? (
                  <>
                    {asset.dns.ipam && (
                      <>
                        <DHead>IPAM · DDIVault</DHead>
                        <DRow label="Status" value={asset.dns.ipam.status} />
                        <DRow label="Subnet" value={asset.dns.ipam.subnet} />
                      </>
                    )}
                    <DHead>DNS records</DHead>
                    {asset.dns.records.length > 0 ? asset.dns.records.map((rec, i) => (
                      <div key={i} style={{ display: 'flex', gap: '10px', padding: '7px 0', borderBottom: '1px solid var(--border-light)', fontSize: '12px' }}>
                        <span style={{ fontWeight: 700, color: primary, minWidth: '46px', flexShrink: 0 }}>{rec.type}</span>
                        <span style={{ flex: 1, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{rec.name}</span>
                      </div>
                    )) : <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '6px 0' }}>No DNS records resolve to this address.</div>}
                  </>
                ) : <DEmpty app="DDIVault DNS/IPAM" />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// useSearchParams (for ?denied) requires a Suspense boundary to be prerender-safe.
export default function LauncherPage() {
  return (
    <Suspense fallback={null}>
      <LauncherInner />
    </Suspense>
  )
}
