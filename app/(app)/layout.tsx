'use client'
import { useSession, signOut } from 'next-auth/react'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import IdleTimeout from '@/components/IdleTimeout'
import UpdateNotifier from '@/app/components/UpdateNotifier'
import ThemeToggle from '@/components/ThemeToggle'

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}

const navIcons: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  '/dashboard': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
    color: '#f87171', bg: 'rgba(200,16,46,0.25)',
  },
  '/sites': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>,
    color: '#34d399', bg: 'rgba(29,158,117,0.25)',
  },
  '/devices': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" fill="none"/></svg>,
    color: '#60a5fa', bg: 'rgba(55,138,221,0.25)',
  },
  '/circuits': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none"/><circle cx="8" cy="6" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="10" cy="18" r="2.5"/></svg>,
    color: '#a78bfa', bg: 'rgba(127,119,221,0.25)',
  },
  '/eol': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 20h20L12 2zm0 4l7.5 12h-15L12 6z"/><rect x="11" y="10" width="2" height="5" rx="1"/><rect x="11" y="16" width="2" height="2" rx="1"/></svg>,
    color: '#fbbf24', bg: 'rgba(186,117,23,0.25)',
  },
  '/audit': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13zm-4 4h8v1.5H9zm0 3h5v1.5H9z"/></svg>,
    color: '#f472b6', bg: 'rgba(212,83,126,0.25)',
  },
  '/compliance': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
    color: '#06b6d4', bg: 'rgba(6,182,212,0.2)',
  },
  '/settings': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.02 7.02 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4a.484.484 0 00-.48.41l-.36 2.54a7.38 7.38 0 00-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.74 8.87a.47.47 0 00.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.47.47 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.27.41.48.41h4c.24 0 .44-.17.47-.41l.36-2.54a7.38 7.38 0 001.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>,
    color: '#9ca3af', bg: 'rgba(136,135,128,0.25)',
  },
  '/users': {
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>,
    color: '#38bdf8', bg: 'rgba(56,189,248,0.2)',
  },
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', hideForSiteAdmin: true },
  { href: '/sites', label: 'Sites' },
  { href: '/devices', label: 'Devices' },
  { href: '/circuits', label: 'Circuits' },
  { href: '/eol', label: 'EOL / Risk', hideForSiteAdmin: true },
  { href: '/audit', label: 'Audit Log', adminOnly: true },
  { href: '/compliance', label: 'Compliance', adminOnly: true },
  { href: '/settings', label: 'Settings', adminOnly: true },
]

const SIDEBAR_COLLAPSED_KEY = 'netvault-sidebar-collapsed'
const SIDEBAR_EXPANDED_W = 240
const SIDEBAR_COLLAPSED_W = 64

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const user = session?.user as { role?: string; name?: string } | undefined
  const userRole = user?.role
  const [settings, setSettings] = useState<Settings>({
    app_name: 'NetVault', app_subtitle: 'Network Asset Management',
    app_logo_url: '', app_primary_color: '#C8102E', app_navy_color: '#1a2744',
  })
  const [collapsed, setCollapsed] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [licenseStatus, setLicenseStatus] = useState<string | null>(null)
  const [licenseDaysRemaining, setLicenseDaysRemaining] = useState(0)
  const [licenseExpiry, setLicenseExpiry] = useState<string | null>(null)
  const [showPwModal, setShowPwModal] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [pwForm, setPwForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)
  const [alertCount, setAlertCount] = useState(0)
  const settingsFetched = useRef(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Hydrate collapsed state from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') setCollapsed(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/health').then(r => r.json()).then(j => { if (!cancelled) setAppVersion(j.version || null) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status === 'authenticated' && userRole === 'site_admin') {
      const restricted = ['/dashboard', '/eol']
      if (restricted.some(p => pathname.startsWith(p))) router.push('/sites')
    }
  }, [pathname, status, userRole, router])

  useEffect(() => {
    if (status === 'authenticated' && !settingsFetched.current) {
      settingsFetched.current = true
      fetch('/api/settings').then(r => r.json()).then(d => {
        if (d && !d.error) setSettings(d)
      }).catch(() => {})
      fetch('/api/license').then(r => r.json()).then(d => {
        if (!d.error) {
          setLicenseStatus(d.status)
          setLicenseDaysRemaining(d.daysRemaining)
          setLicenseExpiry(d.expiry)
        }
      }).catch(() => {})
    }
  }, [status])

  // Alert count — fetched from dashboard overview, reused for nav + header bell badges
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    fetch('/api/dashboard/overview')
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d || d.error) return
        const count = typeof d.eol_assets === 'number' ? d.eol_assets
          : typeof d.sites_at_risk === 'number' ? d.sites_at_risk
          : 0
        setAlertCount(count)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [status])

  // Global "/" shortcut → focus header search; Escape → blur
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Apply / remove data-readonly on body based on license status
  useEffect(() => {
    if (licenseStatus === 'expired') {
      document.body.dataset.readonly = 'true'
    } else {
      delete document.body.dataset.readonly
    }
    return () => { delete document.body.dataset.readonly }
  }, [licenseStatus])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function toggleCollapsed() {
    setCollapsed(c => {
      const next = !c
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      return next
    })
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const q = (e.target as HTMLInputElement).value.trim()
      if (q) router.push('/devices?search=' + encodeURIComponent(q))
    } else if (e.key === 'Escape') {
      searchRef.current?.blur()
    }
  }

  function openPwModal() {
    setPwForm({ current_password: '', new_password: '', confirm_password: '' })
    setPwError(''); setPwSuccess(false); setShowPwModal(true)
    setShowUserMenu(false)
  }

  async function changePassword() {
    if (!pwForm.current_password || !pwForm.new_password || !pwForm.confirm_password) {
      setPwError('All fields are required'); return
    }
    if (pwForm.new_password !== pwForm.confirm_password) {
      setPwError('New passwords do not match'); return
    }
    if (pwForm.new_password.length < 8) {
      setPwError('New password must be at least 8 characters'); return
    }
    setPwSaving(true); setPwError('')
    const res = await fetch('/api/users/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: pwForm.current_password, new_password: pwForm.new_password })
    })
    const data = await res.json()
    setPwSaving(false)
    if (res.ok) { setPwSuccess(true); setTimeout(() => setShowPwModal(false), 1500) }
    else setPwError(data.error || 'Failed to change password')
  }

  if (status === 'loading') return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 28, height: 28, border: '2.5px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
      </div>
    </div>
  )
  if (!session) return null

  const navy = settings.app_navy_color || '#1a2744'
  const primary = settings.app_primary_color || '#C8102E'
  const userInitial = user?.name?.charAt(0)?.toUpperCase() || 'U'
  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-primary)' }}>

      {/* ── Fixed sidebar ── */}
      <div style={{
        position: 'fixed', top: 'var(--header-height)', left: 0, bottom: 0,
        width: sidebarWidth,
        background: navy,
        display: 'flex', flexDirection: 'column',
        zIndex: 100,
        overflowX: 'hidden',
        overflowY: 'auto',
        transition: 'width 0.18s ease',
        boxShadow: '1px 0 0 rgba(255,255,255,0.05)',
      }}>

        {/* Section label — only when expanded */}
        {!collapsed && (
          <div style={{ padding: '14px 20px 6px', fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' }}>
            Navigation
          </div>
        )}
        {collapsed && <div style={{ height: 14 }} />}

        {/* Navigation items */}
        <nav style={{ flex: 1, padding: '0 8px', paddingBottom: 8 }}>
          {navItems.map(item => {
            if (item.adminOnly && userRole !== 'admin' && userRole !== 'super_admin') return null
            if ((item as any).hideForSiteAdmin && userRole === 'site_admin') return null
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
            const ic = navIcons[item.href]
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                style={{ textDecoration: 'none', display: 'block' }}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  padding: collapsed ? '10px 0' : '8px 10px',
                  margin: '1px 0',
                  borderRadius: 8,
                  background: active ? `${primary}20` : 'transparent',
                  position: 'relative',
                  transition: 'background 0.15s',
                  cursor: 'pointer',
                }}
                  onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)' }}
                  onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  {/* Active left-bar indicator */}
                  {active && (
                    <div style={{
                      position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                      width: 3, height: 20, background: primary, borderRadius: '0 3px 3px 0',
                    }} />
                  )}
                  {/* Colored icon box */}
                  <div style={{
                    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                    background: active ? ic?.bg : 'rgba(255,255,255,0.07)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: active ? ic?.color : 'rgba(255,255,255,0.4)',
                    transition: 'all 0.15s',
                    position: 'relative',
                  }}>
                    {ic?.icon}
                    {/* Collapsed alert dot */}
                    {(item as any).showAlertBadge && alertCount > 0 && collapsed && (
                      <span style={{
                        position: 'absolute', top: -2, right: -2,
                        width: 9, height: 9, borderRadius: '50%',
                        background: 'var(--primary)', border: `1.5px solid ${navy}`,
                      }} />
                    )}
                  </div>
                  {/* Label — hidden when collapsed */}
                  {!collapsed && (
                    <span style={{
                      fontSize: 'var(--text-md)', fontWeight: active ? 600 : 500,
                      color: active ? 'white' : 'rgba(255,255,255,0.55)',
                      whiteSpace: 'nowrap', letterSpacing: '-0.1px',
                    }}>
                      {item.label}
                    </span>
                  )}
                  {/* Expanded alert count badge — pushed to the right */}
                  {(item as any).showAlertBadge && alertCount > 0 && !collapsed && (
                    <span style={{
                      marginLeft: 'auto',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 9,
                      background: 'var(--primary)', color: 'white',
                      fontSize: 'var(--text-xs)', fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      lineHeight: 1,
                    }}>
                      {alertCount > 99 ? '99+' : alertCount}
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </nav>

        {/* ── Collapse toggle button (exact DDIVault style) ── */}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            justifyContent: collapsed ? 'center' : 'flex-start',
            margin: '4px 10px',
            padding: collapsed ? '10px 0' : '10px 12px',
            width: 'calc(100% - 20px)',
            background: 'transparent', border: 'none', borderRadius: 8,
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.4)', fontSize: 'var(--text-sm)',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'white' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}>
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          {!collapsed && <span style={{ whiteSpace: 'nowrap' }}>Collapse</span>}
        </button>

        {/* Footer */}
        {!collapsed && (
          <div style={{ padding: '6px 20px 10px', fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.2)', whiteSpace: 'nowrap' }}>
            <div>NocVault Suite</div>
            <div style={{ marginTop: 2 }}>NetVault{appVersion ? ` v${appVersion}` : ''}</div>
          </div>
        )}
        {collapsed && <div style={{ height: 8 }} />}
      </div>

      {/* ── Top header — fixed full-width, unaffected by sidebar ── */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        height: 'var(--header-height)',
        background: navy,
        display: 'flex', alignItems: 'center',
        padding: '0 24px', gap: 20,
        zIndex: 150,
        boxShadow: '0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.2)',
      }}>
          {/* Logo + tagline — single-line wordmark, divider, inline tagline (suite pattern) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 185 46" height="44" style={{ display: 'block' }}>
              <line x1="19" y1="5" x2="4" y2="37" stroke="#C8102E" strokeWidth="2" strokeLinecap="round"/>
              <line x1="19" y1="5" x2="34" y2="37" stroke="#C8102E" strokeWidth="2" strokeLinecap="round"/>
              <line x1="4" y1="37" x2="34" y2="37" stroke="#C8102E" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="19" cy="5" r="3" fill="#C8102E"/>
              <circle cx="4" cy="37" r="3" fill="#C8102E"/>
              <circle cx="34" cy="37" r="3" fill="#C8102E"/>
              <text x="50" y="32" fontSize="26" fontWeight="700" letterSpacing="-0.3" fontFamily="'Rubik','Helvetica Neue',Helvetica,Arial,sans-serif">
                <tspan fill="#ffffff">Net</tspan>
                <tspan fill="#C8102E">Vault</tspan>
              </text>
            </svg>
            <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.15)' }} />
            <div style={{ fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.45)', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
              Network Asset Management
            </div>
          </div>

          {/* Global search */}
          <div style={{ flex: 1, maxWidth: 400, position: 'relative' }}>
            <svg style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)', pointerEvents: 'none' }}
              width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search devices, sites, circuits..."
              onKeyDown={onSearchKeyDown}
              style={{
                width: '100%', padding: '9px 44px 9px 36px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6,
                color: 'white', fontSize: 'var(--text-base)',
                outline: 'none', boxSizing: 'border-box',
                fontFamily: 'inherit',
                transition: 'border-color 0.15s, background 0.15s',
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.28)'
                e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
              }}
            />
            <span style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              padding: '2px 7px', borderRadius: 6,
              background: 'rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.55)',
              fontSize: 'var(--text-sm)', fontWeight: 600, lineHeight: 1,
              pointerEvents: 'none',
            }}>
              /
            </span>
          </div>

          <div style={{ flex: 1 }} />

          {/* Theme toggle + Help ghost icon button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 6 }}>
            <ThemeToggle />
            <a
              href="/compliance"
              title="Help"
              style={{
                width: 36, height: 36, borderRadius: 9,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.6)', textDecoration: 'none',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'white' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)' }}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </a>
          </div>

          {/* User dropdown */}
          <div ref={userMenuRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowUserMenu(m => !m)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: showUserMenu ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6, padding: '6px 12px 6px 6px',
                cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
              onMouseLeave={e => { if (!showUserMenu) e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
            >
              <div style={{
                width: 34, height: 34, borderRadius: '50%',
                background: 'var(--primary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--text-base)', fontWeight: 700, color: 'white', flexShrink: 0,
                boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
              }}>
                {userInitial}
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ color: 'white', fontSize: 'var(--text-base)', fontWeight: 600, lineHeight: 1.2 }}>
                  {user?.name?.split(' ')[0] || 'User'}
                </div>
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 'var(--text-xs)', lineHeight: 1.2 }}>
                  {user?.role?.replace(/_/g, ' ')}
                </div>
              </div>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{
                color: 'rgba(255,255,255,0.35)',
                transform: showUserMenu ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
                marginLeft: 2,
              }}>
                <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {showUserMenu && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: 'white', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                minWidth: 220, overflow: 'hidden', zIndex: 999,
                animation: 'fadeIn 0.15s ease',
              }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>{user?.name}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>{user?.role?.replace(/_/g, ' ')}</div>
                </div>
                <div style={{ padding: '6px 0' }}>
                  <a
                    href={process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || '/launcher'}
                    onClick={() => setShowUserMenu(false)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 'var(--text-base)', fontWeight: 500, textDecoration: 'none', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
                    </svg>
                    NocVault Hub
                  </a>
                  <button
                    onClick={openPwModal}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', width: '100%', color: 'var(--text-secondary)', fontSize: 'var(--text-base)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                    </svg>
                    Change Password
                  </button>
                  <div style={{ height: 1, background: 'var(--border-light)', margin: '4px 0' }} />
                  <button
                    onClick={() => { setShowUserMenu(false); signOut({ callbackUrl: '/login' }) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', width: '100%', color: '#dc2626', fontSize: 'var(--text-base)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
                    </svg>
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

      {/* ── Main column — shifts with sidebar, starts below header ── */}
      <div style={{
        marginLeft: sidebarWidth,
        flex: 1,
        display: 'flex', flexDirection: 'column',
        minHeight: '100vh',
        paddingTop: 'var(--header-height)',
        transition: 'margin-left 0.18s ease',
      }}>

        {/* License banner */}
        {licenseStatus === 'trial' && licenseDaysRemaining <= 5 && licenseDaysRemaining > 0 && (
          <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '10px 24px', fontSize: 'var(--text-base)', color: '#92400e', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Your trial expires in <strong>{licenseDaysRemaining} day{licenseDaysRemaining !== 1 ? 's' : ''}</strong>. Contact <a href="mailto:sales@nocvault.com" style={{ color: '#92400e', fontWeight: '600' }}>sales@nocvault.com</a> to purchase a license.</span>
          </div>
        )}
        {licenseStatus === 'grace' && (
          <div style={{ background: '#ffedd5', borderBottom: '1px solid #fed7aa', padding: '10px 24px', fontSize: 'var(--text-base)', color: '#c2410c', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Your trial has expired. Enter a license key in <a href="/settings" style={{ color: '#c2410c', fontWeight: '600' }}>Settings → License</a> to continue.</span>
          </div>
        )}
        {licenseStatus === 'expired' && (
          <div style={{ background: '#fee2e2', borderBottom: '1px solid #fecaca', padding: '10px 24px', fontSize: 'var(--text-base)', color: '#991b1b', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span><strong>NocVault license required.</strong> The system is in read-only mode. Enter a license key in <a href="/settings" style={{ color: '#991b1b', fontWeight: '600' }}>Settings → License</a> or contact <a href="mailto:sales@nocvault.com" style={{ color: '#991b1b', fontWeight: '600' }}>sales@nocvault.com</a>.</span>
          </div>
        )}
        {licenseStatus === 'active' && licenseExpiry && (() => {
          const days = Math.ceil((new Date(licenseExpiry).getTime() - Date.now()) / 86400000)
          if (days <= 30) return (
            <div style={{ background: '#ffedd5', borderBottom: '1px solid #fed7aa', padding: '10px 24px', fontSize: 'var(--text-base)', color: '#c2410c', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>Your license expires on <strong>{licenseExpiry}</strong>. Contact <a href="mailto:sales@nocvault.com" style={{ color: '#c2410c', fontWeight: '600' }}>sales@nocvault.com</a> to renew.</span>
            </div>
          )
          if (days <= 90) return (
            <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '10px 24px', fontSize: 'var(--text-base)', color: '#92400e', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>Your license expires on <strong>{licenseExpiry}</strong>. Contact <a href="mailto:sales@nocvault.com" style={{ color: '#92400e', fontWeight: '600' }}>sales@nocvault.com</a> to renew.</span>
            </div>
          )
          return null
        })()}

        <UpdateNotifier />

        {/* Page content */}
        <div style={{ flex: 1, overflow: 'auto' }}>{children}</div>
      </div>

      <IdleTimeout />

      {/* ── Change Password Modal ── */}
      {showPwModal && (
        <div className="modal-overlay">
          <div style={{ background: 'white', borderRadius: 'var(--radius)', padding: '28px 32px', width: '100%', maxWidth: 400, boxShadow: 'var(--shadow-lg)' }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Change password</h2>
            <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '0 0 20px' }}>Enter your current password and choose a new one.</p>
            {pwSuccess ? (
              <div style={{ background: '#dcfce7', color: '#166534', padding: '12px 16px', borderRadius: 8, fontSize: 'var(--text-md)', textAlign: 'center' }}>
                Password changed successfully!
              </div>
            ) : (
              <>
                {[
                  { label: 'Current password', field: 'current_password' },
                  { label: 'New password', field: 'new_password' },
                  { label: 'Confirm new password', field: 'confirm_password' },
                ].map(f => (
                  <div key={f.field} className="form-field" style={{ marginBottom: 14 }}>
                    <label>{f.label}</label>
                    <input type="password" className="input"
                      value={pwForm[f.field as keyof typeof pwForm]}
                      onChange={e => setPwForm(p => ({ ...p, [f.field]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && changePassword()}
                    />
                  </div>
                ))}
                {pwError && (
                  <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: 6, fontSize: 'var(--text-base)', marginBottom: 14 }}>{pwError}</div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={changePassword} disabled={pwSaving} style={{ flex: 1 }}>
                    {pwSaving ? 'Saving…' : 'Change password'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setShowPwModal(false)} style={{ flex: 1 }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
