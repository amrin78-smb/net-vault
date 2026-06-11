'use client'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

type LicenseInfo = { status: string; daysRemaining: number; expiry: string | null }
type HealthStatus = 'Healthy' | 'Warning' | 'Unavailable'
type SuiteHealth = { app: string; status: HealthStatus }
type NetvaultStats = { devices_total: number; sites_total: number; eol_total: number }
type SuiteStats = {
  logvault: Record<string, unknown> | null
  ddivault: Record<string, unknown> | null
  spanvault: Record<string, unknown> | null
}

const NAVY = '#1a2744'
const RED = '#C8102E'
const BG = '#f4f6f9'
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

export default function LauncherPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [settings, setSettings] = useState({ app_primary_color: '#C8102E', app_navy_color: '#1a2744' })
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null)
  const [health, setHealth] = useState<SuiteHealth[] | null>(null)
  const [netStats, setNetStats] = useState<NetvaultStats | null>(null)
  const [suiteStats, setSuiteStats] = useState<SuiteStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [clock, setClock] = useState('')

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => { if (d && !d.error) setSettings(d) }).catch(() => {})
    fetch('/api/license').then(r => r.json()).then(d => { if (!d.error) setLicenseInfo(d) }).catch(() => {})
    fetch('/api/suite/health').then(r => r.json()).then(d => { if (Array.isArray(d)) setHealth(d) }).catch(() => setHealth([]))
    fetch('/api/netvault-stats').then(r => r.json()).then(d => { if (d && !d.error) setNetStats(d) }).catch(() => {}).finally(() => setStatsLoading(false))
    fetch('/api/suite/stats').then(r => r.json()).then(d => { if (d && !d.error) setSuiteStats(d) }).catch(() => {})
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

  const lv = suiteStats?.logvault ?? null
  const dv = suiteStats?.ddivault ?? null
  const sv = suiteStats?.spanvault ?? null

  type AppCard = {
    name: string
    subtitle: string
    description: string
    href: string
    color: string
    logo: string
    metrics: { icon: string; value: string; label: string }[]
  }

  const cards: AppCard[] = [
    {
      name: 'NetVault', subtitle: 'Network Asset Management',
      description: 'Devices, sites, circuits and EOL/EOS tracking.',
      href: '/dashboard', color: primary, logo: '/netvault-logo.svg',
      metrics: [
        { icon: 'device', value: statsLoading ? '' : num(netStats?.devices_total), label: 'Devices' },
        { icon: 'site', value: statsLoading ? '' : num(netStats?.sites_total), label: 'Sites' },
        { icon: 'warning', value: statsLoading ? '' : num(netStats?.eol_total), label: 'EOL / EOS Assets' },
      ],
    },
    {
      name: 'LogVault', subtitle: 'Syslog & Log Analysis',
      description: 'Real-time syslog collection, analysis and alerting.',
      href: '/api/sso/logvault', color: '#2563eb', logo: '/logvault-logo.svg',
      metrics: [
        { icon: 'log', value: statsLoading ? '' : num(lv?.logs_today), label: 'Logs Today' },
        { icon: 'source', value: statsLoading ? '' : num(lv?.log_sources), label: 'Log Sources' },
        { icon: 'bell', value: statsLoading ? '' : num(lv?.active_alerts), label: 'Active Alerts' },
      ],
    },
    {
      name: 'DDIVault', subtitle: 'DNS, DHCP & IPAM Solution',
      description: 'Centralised DNS, DHCP and IP address management.',
      href: '/api/sso/ddivault', color: '#d97706', logo: '/ddivault-logo.svg',
      metrics: [
        { icon: 'dns', value: statsLoading ? '' : num(dv?.dns_servers), label: 'DNS Servers' },
        { icon: 'dhcp', value: statsLoading ? '' : num(dv?.dhcp_clusters), label: 'DHCP Clusters' },
        { icon: 'ip', value: statsLoading ? '' : num(dv?.ip_utilized), label: 'IP Addresses Utilized' },
      ],
    },
    {
      name: 'SpanVault', subtitle: 'Network Monitoring',
      description: 'Device monitoring, availability and performance alerting.',
      href: spanvaultUrl, color: '#16a34a', logo: '/spanvault-logo.svg',
      metrics: [
        { icon: 'monitor', value: statsLoading ? '' : num(sv?.monitored_devices), label: 'Monitored Devices' },
        { icon: 'availability', value: statsLoading ? '' : (sv?.availability != null ? `${num(sv?.availability)}%` : '—'), label: 'Availability' },
        { icon: 'alert', value: statsLoading ? '' : num(sv?.active_alerts), label: 'Active Alerts' },
      ],
    },
  ]

  const license = licenseInfo

  return (
    <div style={{ minHeight: '100vh', background: BG, display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes nvShimmer { 0%,100% { opacity: 0.35 } 50% { opacity: 0.8 } }
        @media (max-width: 1100px) { .nv-top-grid { grid-template-columns: 1fr !important } .nv-app-grid { grid-template-columns: repeat(2, 1fr) !important } }
        @media (max-width: 640px) { .nv-app-grid { grid-template-columns: 1fr !important } }
      `}</style>

      {/* Top bar */}
      <div style={{ background: navy, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <img src="/nocvault-logo.svg" alt="NocVault" style={{ maxHeight: '38px', width: 'auto', objectFit: 'contain' }} />
          <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '10px', letterSpacing: '1.5px', fontWeight: 600 }}>NETWORK INTELLIGENCE SUITE</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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

      {/* License banners */}
      {license?.status === 'trial' && license.daysRemaining <= 5 && license.daysRemaining > 0 && (
        <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '10px 32px', fontSize: '13px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>Your trial expires in <strong>{license.daysRemaining} day{license.daysRemaining !== 1 ? 's' : ''}</strong>. Go to <a href="/settings" style={{ color: '#92400e', fontWeight: '600' }}>Settings → License</a> to activate.</span>
        </div>
      )}
      {license?.status === 'grace' && (
        <div style={{ background: '#ffedd5', borderBottom: '1px solid #fed7aa', padding: '10px 32px', fontSize: '13px', color: '#c2410c', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>Your trial has expired. Activate a license key to continue using NocVault.</span>
        </div>
      )}
      {license?.status === 'expired' && (
        <div style={{ background: '#fee2e2', borderBottom: '1px solid #fecaca', padding: '10px 32px', fontSize: '13px', color: '#991b1b', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
          <span><strong>NocVault license required.</strong> Contact <a href="mailto:support@nocvault.io" style={{ color: '#991b1b', fontWeight: '600' }}>support@nocvault.io</a></span>
        </div>
      )}
      {license?.status === 'active' && license.expiry && (() => {
        const days = Math.ceil((new Date(license.expiry).getTime() - Date.now()) / 86400000)
        if (days <= 30) return (
          <div style={{ background: '#ffedd5', borderBottom: '1px solid #fed7aa', padding: '10px 32px', fontSize: '13px', color: '#c2410c', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
            <span>Your license expires on <strong>{license.expiry}</strong>. Contact <a href="mailto:support@nocvault.io" style={{ color: '#c2410c', fontWeight: '600' }}>support@nocvault.io</a> to renew.</span>
          </div>
        )
        if (days <= 90) return (
          <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '10px 32px', fontSize: '13px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
            <span>Your license expires on <strong>{license.expiry}</strong>. Contact <a href="mailto:support@nocvault.io" style={{ color: '#92400e', fontWeight: '600' }}>support@nocvault.io</a> to renew.</span>
          </div>
        )
        return null
      })()}

      {/* Main content */}
      <div style={{ flex: 1, padding: '28px 32px', maxWidth: '1400px', width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>

        {/* Top row: welcome + suite health */}
        <div className="nv-top-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px', alignItems: 'stretch' }}>
          {/* Welcome */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: '15px', color: '#6b7280', marginBottom: '2px' }}>{greeting},</div>
            <h1 style={{ fontSize: '34px', fontWeight: 800, color: NAVY, margin: '0 0 10px' }}>{firstName}</h1>
            <div style={{ fontSize: '15px', color: '#374151', fontWeight: 600 }}>Welcome to the Network Intelligence Suite.</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '14px' }}>Centralized visibility. Smarter operations. Better decisions.</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#374151', fontWeight: 500 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={primary} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              {clock || '—'}
            </div>
          </div>

          {/* Suite health overview */}
          <div style={{ background: 'white', borderRadius: '14px', boxShadow: CARD_SHADOW, padding: '16px 18px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: NAVY, marginBottom: '12px' }}>Suite Health Overview</div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '110px' }}>
                <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke={overallColor} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <polyline points="9 12 11 14 15 10" />
                </svg>
                <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '6px' }}>Overall Status</div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: overallColor }}>{overall === 'Healthy' ? 'Healthy' : overall}</div>
                <div style={{ fontSize: '10px', color: '#9ca3af', textAlign: 'center' }}>All systems operational</div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {['NetVault', 'LogVault', 'DDIVault', 'SpanVault'].map(app => {
                  const st = healthFor(app)
                  return (
                    <div key={app} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                      <span style={{ fontWeight: 600, color: '#374151' }}>{app}</span>
                      <span style={{ color: '#d1d5db' }}>•</span>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: HEALTH_COLORS[st], display: 'inline-block' }} />
                      <span style={{ color: '#6b7280' }}>{st}</span>
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
            return (
              <div key={card.name} style={{ background: NAVY, borderRadius: '14px', boxShadow: CARD_SHADOW, padding: '18px', display: 'flex', flexDirection: 'column', color: 'white' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <img src={card.logo} alt={card.name} style={{ height: '30px', width: 'auto', objectFit: 'contain' }} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 600, color: HEALTH_COLORS[st], background: 'rgba(255,255,255,0.08)', padding: '3px 8px', borderRadius: '10px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: HEALTH_COLORS[st] }} /> {st}
                  </span>
                </div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: card.color, marginBottom: '4px' }}>{card.subtitle}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', lineHeight: 1.45, marginBottom: '14px', minHeight: '34px' }}>{card.description}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '16px', flex: 1 }}>
                  {card.metrics.map((m, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                      <span style={{ color: card.color }}><MetricIcon name={m.icon} /></span>
                      <span style={{ fontWeight: 700, color: 'white', minWidth: '20px' }}>{m.value === '' ? <Skeleton /> : m.value}</span>
                      <span style={{ color: 'rgba(255,255,255,0.55)' }}>{m.label}</span>
                    </div>
                  ))}
                </div>
                <a href={card.href} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: card.color, color: 'white', fontSize: '13px', fontWeight: 600, padding: '10px', borderRadius: '8px', textDecoration: 'none' }}>
                  Open {card.name}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                </a>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '32px', fontSize: '12px', color: '#9ca3af' }}>
          NocVault Intelligence Suite&nbsp;&nbsp;•&nbsp;&nbsp;All rights reserved © 2026
        </div>
      </div>
    </div>
  )
}
