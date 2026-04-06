'use client'
import { useSession, signOut } from 'next-auth/react'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import GlobalSearch from '@/components/GlobalSearch'

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}

const navIcons: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  '/dashboard': { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>, color: '#f87171', bg: 'rgba(200,16,46,0.25)' },
  '/sites':     { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>, color: '#34d399', bg: 'rgba(29,158,117,0.25)' },
  '/devices':   { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" fill="none"/></svg>, color: '#60a5fa', bg: 'rgba(55,138,221,0.25)' },
  '/circuits':  { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none"/><circle cx="8" cy="6" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="10" cy="18" r="2.5"/></svg>, color: '#a78bfa', bg: 'rgba(127,119,221,0.25)' },
  '/eol':       { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 20h20L12 2zm0 4l7.5 12h-15L12 6z"/><rect x="11" y="10" width="2" height="5" rx="1"/><rect x="11" y="16" width="2" height="2" rx="1"/></svg>, color: '#fbbf24', bg: 'rgba(186,117,23,0.25)' },
  '/audit':     { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13zm-4 4h8v1.5H9zm0 3h5v1.5H9z"/></svg>, color: '#f472b6', bg: 'rgba(212,83,126,0.25)' },
  '/settings':  { icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.02 7.02 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4a.484.484 0 00-.48.41l-.36 2.54a7.38 7.38 0 00-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.74 8.87a.47.47 0 00.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.47.47 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.27.41.48.41h4c.24 0 .44-.17.47-.41l.36-2.54a7.38 7.38 0 001.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>, color: '#9ca3af', bg: 'rgba(136,135,128,0.25)' },
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', hideForSiteAdmin: true },
  { href: '/sites', label: 'Sites' },
  { href: '/devices', label: 'My devices' },
  { href: '/circuits', label: 'Circuits' },
  { href: '/eol', label: 'EOL / Risk', hideForSiteAdmin: true },
  { href: '/audit', label: 'Audit log', adminOnly: true },
  { href: '/settings', label: 'Settings', adminOnly: true },
]

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const user = session?.user as { role?: string; name?: string } | undefined
  const userRole = user?.role
  const userName = user?.name
  const [settings, setSettings] = useState<Settings>({
    app_name: 'TU CMDB', app_subtitle: 'Thai Union Group',
    app_logo_url: '', app_primary_color: '#C8102E', app_navy_color: '#1a2744',
  })
  const [showPwModal, setShowPwModal] = useState(false)
  const [pwForm, setPwForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)
  const settingsFetched = useRef(false)

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
    }
  }, [status])

  function openPwModal() {
    setPwForm({ current_password: '', new_password: '', confirm_password: '' })
    setPwError(''); setPwSuccess(false); setShowPwModal(true)
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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#9ca3af', fontSize: '14px' }}>Loading...</div>
    </div>
  )
  if (!session) return null

  const navy = settings.app_navy_color || '#1a2744'
  const primary = settings.app_primary_color || '#C8102E'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f8f8' }}>
      {/* Fixed sidebar */}
      <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: '220px', background: navy, display: 'flex', flexDirection: 'column', zIndex: 100 }}>
        {/* Logo */}
        <div style={{ padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          {settings.app_logo_url ? (
            <img src={settings.app_logo_url} alt="logo" style={{ width: '100%', maxHeight: '64px', objectFit: 'contain', objectPosition: 'left' }} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '40px', height: '40px', background: primary, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                </svg>
              </div>
              <div>
                <div style={{ color: 'white', fontSize: '15px', fontWeight: '700' }}>{settings.app_name || 'NetVault'}</div>
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '10px' }}>{settings.app_subtitle || 'Network Intelligence Platform'}</div>
              </div>
            </div>
          )}
        </div>

        {/* Global search */}
        <div style={{ padding: '8px 8px 4px', flexShrink: 0 }}>
          <GlobalSearch />
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto' }}>
          {navItems.map(item => {
            if (item.adminOnly && userRole !== 'admin' && userRole !== 'super_admin') return null
            if ((item as any).hideForSiteAdmin && userRole === 'site_admin') return null
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
            return (
              <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '9px 12px', borderRadius: '7px', marginBottom: '2px',
                  background: active ? `${primary}33` : 'transparent',
                  borderLeft: active ? `3px solid ${primary}` : '3px solid transparent'
                }}>
                  <div style={{ width: '28px', height: '28px', borderRadius: '6px', background: active ? navIcons[item.href]?.bg : 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: active ? navIcons[item.href]?.color : 'rgba(255,255,255,0.4)', transition: 'all 0.15s' }}>{navIcons[item.href]?.icon}</div>
                  <span style={{ fontSize: '13px', fontWeight: active ? '500' : '400', color: active ? 'white' : 'rgba(255,255,255,0.6)' }}>{item.label}</span>
                </div>
              </Link>
            )
          })}
        </nav>

        {/* User card - pinned to bottom */}
        <div style={{ padding: '12px 8px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <div style={{ padding: '10px 12px', borderRadius: '7px', background: 'rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: primary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', color: 'white', flexShrink: 0 }}>
                {userName?.charAt(0)?.toUpperCase() || 'U'}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '12px', fontWeight: '500', color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userName}</div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>{userRole}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={openPwModal} style={{ flex: 1, padding: '5px', background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '5px', color: 'rgba(255,255,255,0.5)', fontSize: '11px', cursor: 'pointer' }}>
                Change password
              </button>
              <button onClick={() => signOut({ callbackUrl: '/login' })} style={{ flex: 1, padding: '5px', background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '5px', color: 'rgba(255,255,255,0.5)', fontSize: '11px', cursor: 'pointer' }}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main content offset by sidebar */}
      <div style={{ marginLeft: '220px', flex: 1, overflow: 'auto' }}>{children}</div>

      {/* Change Password Modal */}
      {showPwModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '28px', width: '100%', maxWidth: '380px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '700', color: '#111827', margin: '0 0 4px' }}>Change password</h2>
            <p style={{ fontSize: '13px', color: '#9ca3af', margin: '0 0 20px' }}>Enter your current password and choose a new one.</p>
            {pwSuccess ? (
              <div style={{ background: '#dcfce7', color: '#166534', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', textAlign: 'center' }}>
                Password changed successfully!
              </div>
            ) : (
              <>
                {[
                  { label: 'Current password', field: 'current_password' },
                  { label: 'New password', field: 'new_password' },
                  { label: 'Confirm new password', field: 'confirm_password' },
                ].map(f => (
                  <div key={f.field} style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>{f.label}</label>
                    <input type="password" className="input"
                      value={pwForm[f.field as keyof typeof pwForm]}
                      onChange={e => setPwForm(p => ({ ...p, [f.field]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && changePassword()}
                      style={{ width: '100%' }} />
                  </div>
                ))}
                {pwError && (
                  <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '14px' }}>{pwError}</div>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn-primary" onClick={changePassword} disabled={pwSaving} style={{ flex: 1 }}>
                    {pwSaving ? 'Saving...' : 'Change password'}
                  </button>
                  <button className="btn-secondary" onClick={() => setShowPwModal(false)} style={{ flex: 1 }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
