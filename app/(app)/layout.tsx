'use client'
import { useSession } from 'next-auth/react'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useState, useRef, Suspense, useCallback, useSyncExternalStore } from 'react'
import Link from 'next/link'
import IdleTimeout from '@/components/IdleTimeout'
import UpdateNotifier from '@/app/components/UpdateNotifier'
import UpdateFailureBanner from '@/app/components/UpdateFailureBanner'
import LicenseBanner from '@/components/LicenseBanner'
import SuiteHeader from '@/components/shell/SuiteHeader'
import Sidebar from '@/components/shell/Sidebar'
import { Dialog } from '@/components/system/Dialog'
import { Icon } from '@/components/system/icons'

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}

const SIDEBAR_COLLAPSED_KEY = 'netvault-sidebar-collapsed'

function subscribeCollapsed(cb: () => void) {
  window.addEventListener('storage', cb)
  return () => window.removeEventListener('storage', cb)
}
function getCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true' } catch { return false }
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const user = session?.user as { role?: string; name?: string; apps?: string[] } | undefined
  const userRole = user?.role

  const [settings, setSettings] = useState<Settings>({
    app_name: 'NetVault', app_subtitle: 'Network Asset Management',
    app_logo_url: '', app_primary_color: '#C8102E', app_navy_color: '#1a2744',
  })
  // Persisted collapse preference. Read through useSyncExternalStore because
  // localStorage is an external store: the server snapshot is `false`, so the
  // markup matches on hydration and the stored value applies immediately
  // afterwards, with no setState-inside-an-effect render cascade.
  const storedCollapsed = useSyncExternalStore(subscribeCollapsed, getCollapsed, () => false)
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null)
  const collapsed = collapsedOverride ?? storedCollapsed
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // Close the drawer whenever the route changes. Adjusting state during
  // render (React's documented pattern for state derived from a changing
  // input) rather than in an effect, so it happens before paint instead of
  // flashing the old drawer over the new page. Nav links also close it
  // directly; this additionally covers browser back/forward.
  const [lastPath, setLastPath] = useState(pathname)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [licenseStatus, setLicenseStatus] = useState<string | null>(null)
  const [showPwModal, setShowPwModal] = useState(false)
  const [pwForm, setPwForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)
  const [alertCount, setAlertCount] = useState<number | null>(null)
  const settingsFetched = useRef(false)
  const navTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/health').then(r => r.json())
      .then(j => { if (!cancelled) setAppVersion(j.version || null) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  // Site-scoped admins have no fleet-wide view; these two pages contradict
  // their scope, so they are bounced to their own landing page.
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
        if (!d.error) setLicenseStatus(d.status)
      }).catch(() => {})
    }
  }, [status])

  // Attention count. Real data from the dashboard overview, not a synthetic
  // notification feed: it is the EOL asset count, and the indicator links to
  // the page that lists them. Left null (and therefore hidden) when the call
  // fails, so a failed fetch never renders as a reassuring zero.
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    fetch('/api/dashboard/overview')
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d || d.error) return
        const count = typeof d.eol_assets === 'number' ? d.eol_assets
          : typeof d.sites_at_risk === 'number' ? d.sites_at_risk
          : null
        setAlertCount(count)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [status])

  // Read-only mode flag consumed by the `.license-action` rules in globals.css.
  useEffect(() => {
    if (licenseStatus === 'expired') document.body.dataset.readonly = 'true'
    else delete document.body.dataset.readonly
    return () => { delete document.body.dataset.readonly }
  }, [licenseStatus])

  const toggleCollapsed = useCallback(() => {
    const next = !(collapsedOverride ?? getCollapsed())
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
    setCollapsedOverride(next)
  }, [collapsedOverride])

  const openPwModal = useCallback(() => {
    setPwForm({ current_password: '', new_password: '', confirm_password: '' })
    setPwError(''); setPwSuccess(false); setShowPwModal(true)
  }, [])

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

  if (pathname !== lastPath) {
    setLastPath(pathname)
    if (mobileNavOpen) setMobileNavOpen(false)
  }

  if (status === 'loading') return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--canvas)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        {/* intentional: 50% — a true circle (loading spinner), never squared */}
        <div style={{ width: 28, height: 28, border: '2.5px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
      </div>
    </div>
  )
  if (!session) return null

  const isAdmin = userRole === 'admin' || userRole === 'super_admin'
  // The attention indicator points at /eol, so it is only offered to roles
  // that are allowed to open that page.
  const showAttention = alertCount !== null && alertCount > 0 && userRole !== 'site_admin'

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      <SuiteHeader
        productName={settings.app_name || 'NetVault'}
        productSubtitle={settings.app_subtitle || 'Network Asset Management'}
        userName={user?.name || 'User'}
        userRole={userRole}
        userApps={user?.apps}
        version={appVersion}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onToggleSidebar={() => setMobileNavOpen(o => !o)}
        onChangePassword={openPwModal}
        sidebarTriggerRef={navTriggerRef}
      />

      {/* useSearchParams (used to resolve the active Settings tab) must sit
          inside a Suspense boundary or the production build fails with
          "Missing Suspense boundary with useSearchParams". */}
      <Suspense fallback={<nav className="app-sidebar" aria-label="Main" data-collapsed={collapsed ? 'true' : 'false'} />}>
        <Sidebar
          role={userRole}
          collapsed={collapsed}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          triggerRef={navTriggerRef}
        />
      </Suspense>

      <div
        className="app-main"
        style={{ marginLeft: collapsed ? 'var(--shell-rail)' : 'var(--shell-sidebar)', padding: 0 }}
      >
        {/* Full-width suite banners stay above the page padding so they read
            as shell chrome rather than page content. */}
        <LicenseBanner />
        {isAdmin && <UpdateFailureBanner />}
        <UpdateNotifier />

        {showAttention && (
          <div style={{ padding: '12px var(--page-pad) 0' }}>
            <Link href="/eol" className="alert" data-tone="warn" style={{ textDecoration: 'none' }}>
              <span aria-hidden style={{ display: 'flex', flexShrink: 0, marginTop: 1 }}><Icon.alert size={18} /></span>
              <span style={{ flex: 1 }}>
                <span className="alert-title">
                  {alertCount!.toLocaleString()} asset{alertCount === 1 ? '' : 's'} past end-of-life
                </span>
                <span className="alert-body" style={{ display: 'block' }}>Review the EOL / Risk register.</span>
              </span>
              <span aria-hidden style={{ display: 'flex', alignItems: 'center' }}><Icon.chevronRight size={16} /></span>
            </Link>
          </div>
        )}

        <main id="main-content" tabIndex={-1} style={{ padding: 'var(--page-pad)' }}>
          {children}
        </main>
      </div>

      <IdleTimeout />

      <Dialog
        open={showPwModal}
        onClose={() => setShowPwModal(false)}
        title="Change password"
        description="Enter your current password and choose a new one."
        dismissible={!pwSaving}
        footer={!pwSuccess ? (
          <>
            <button className="btn btn-secondary" onClick={() => setShowPwModal(false)} disabled={pwSaving}>Cancel</button>
            <button className="btn btn-primary" onClick={changePassword} disabled={pwSaving}>
              {pwSaving ? 'Saving…' : 'Change password'}
            </button>
          </>
        ) : undefined}
      >
        {pwSuccess ? (
          <div role="status" style={{ background: 'var(--tint-success)', color: 'var(--tint-success-fg)', padding: '12px 16px', borderRadius: 'var(--radius)', fontSize: 'var(--text-md)', textAlign: 'center', marginTop: 14 }}>
            Password changed successfully.
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {[
              { label: 'Current password', field: 'current_password', ac: 'current-password' },
              { label: 'New password', field: 'new_password', ac: 'new-password' },
              { label: 'Confirm new password', field: 'confirm_password', ac: 'new-password' },
            ].map(f => (
              <div key={f.field} className="form-field" style={{ marginBottom: 14 }}>
                <label htmlFor={`pw-${f.field}`}>{f.label}</label>
                <input
                  id={`pw-${f.field}`}
                  type="password"
                  className="input"
                  autoComplete={f.ac}
                  aria-invalid={pwError ? true : undefined}
                  aria-describedby={pwError ? 'pw-error' : undefined}
                  value={pwForm[f.field as keyof typeof pwForm]}
                  onChange={e => setPwForm(p => ({ ...p, [f.field]: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && changePassword()}
                />
              </div>
            ))}
            {pwError && (
              <div id="pw-error" role="alert" style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>
                {pwError}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
