'use client'
import { useSession, signOut } from 'next-auth/react'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import GlobalSearch from '@/components/GlobalSearch'

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '▤', hideForSiteAdmin: true },
  { href: '/devices', label: 'My devices', icon: '☰' },
  { href: '/sites', label: 'Sites', icon: '◈' },
  { href: '/circuits', label: 'Circuits', icon: '⇌' },
  { href: '/eol', label: 'EOL / Risk', icon: '⚠', hideForSiteAdmin: true },
  { href: '/audit', label: 'Audit log', icon: '≡', adminOnly: true },
  { href: '/settings', label: 'Settings', icon: '⚙', adminOnly: true },
]

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const user = session?.user as { role?: string; name?: string } | undefined
  const [settings, setSettings] = useState<Settings>({
    app_name: 'TU CMDB', app_subtitle: 'Thai Union Group',
    app_logo_url: '', app_primary_color: '#C8102E', app_navy_color: '#1a2744',
  })
  const [showPwModal, setShowPwModal] = useState(false)
  const [pwForm, setPwForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
    if (status === 'authenticated' && user?.role === 'site_admin') {
      const restricted = ['/dashboard', '/eol']
      if (restricted.some(p => pathname.startsWith(p))) router.push('/sites')
    }
  }, [status, router, user, pathname])

  useEffect(() => {
    if (status === 'authenticated') {
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
            <img src={settings.app_logo_url} alt="logo" style={{ width: '100%', maxHeight: '48px', objectFit: 'contain', objectPosition: 'left' }} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '32px', height: '32px', background: primary, borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
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
            if (item.adminOnly && user?.role !== 'admin') return null
            if ((item as any).hideForSiteAdmin && user?.role === 'site_admin') return null
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
            return (
              <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '9px 12px', borderRadius: '7px', marginBottom: '2px',
                  background: active ? `${primary}33` : 'transparent',
                  borderLeft: active ? `3px solid ${primary}` : '3px solid transparent'
                }}>
                  <span style={{ fontSize: '14px', color: active ? '#f87171' : 'rgba(255,255,255,0.45)', width: '16px' }}>{item.icon}</span>
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
                {user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '12px', fontWeight: '500', color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>{user?.role}</div>
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
