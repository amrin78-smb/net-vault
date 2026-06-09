'use client'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

type LicenseInfo = { status: string; daysRemaining: number; expiry: string | null }

export default function LauncherPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [settings, setSettings] = useState({ app_primary_color: '#C8102E', app_navy_color: '#1a2744' })
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null)

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => { if (d && !d.error) setSettings(d) })
    fetch('/api/license').then(r => r.json()).then(d => { if (!d.error) setLicenseInfo(d) })
  }, [])

  if (status === 'loading') return null
  if (status === 'unauthenticated') { router.push('/login'); return null }

  const user = session?.user as { name?: string; email?: string; role?: string }
  const primary = settings.app_primary_color || '#C8102E'
  const navy = settings.app_navy_color || '#1a2744'

  const spanvaultUrl = typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3008`
    : 'http://localhost:3008'

  const apps = [
    {
      name: 'NetVault',
      subtitle: 'Network Asset Management',
      description: 'Manage network devices, sites, circuits and track EOL/EOS across your global infrastructure.',
      href: '/dashboard',
      external: false,
      icon: <img src="/netvault-logo.svg" alt="NetVault" style={{ width: '85%', height: 'auto', maxWidth: '220px' }} />,
      color: primary,
      bg: '#1a2744',
    },
    {
      name: 'LogVault',
      subtitle: 'Syslog & Log Analysis',
      description: 'Real-time syslog collection, analysis and alerting for your network infrastructure.',
      href: '/api/sso/logvault',
      external: false,
      icon: <img src="/logvault-logo.svg" alt="LogVault" style={{ width: '85%', height: 'auto', maxWidth: '220px' }} />,
      color: '#2563eb',
      bg: '#1a2744',
    },
    {
      name: 'DDIVault',
      subtitle: 'DNS, DHCP & IPAM Solution',
      description: 'Centralised DNS, DHCP and IP address management for your network infrastructure.',
      href: '/api/sso/ddivault',
      external: false,
      icon: <img src="/ddivault-logo.svg" alt="DDIVault" style={{ width: '85%', height: 'auto', maxWidth: '220px' }} />,
      color: '#d97706',
      bg: '#1a2744',
    },
    {
      name: 'SpanVault',
      subtitle: 'Network Monitoring',
      description: 'Real-time network device monitoring, availability tracking and performance alerting for your infrastructure.',
      href: spanvaultUrl,
      external: false,
      icon: <img src="/spanvault-logo.svg" alt="SpanVault" style={{ width: '85%', height: 'auto', maxWidth: '220px' }} />,
      color: '#16a34a',
      bg: '#1a2744',
    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ background: navy, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <img src="/nocvault-logo.svg" alt="NocVault" style={{ maxHeight: '52px', width: 'auto', objectFit: 'contain' }} />
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
            Sign out
          </button>
        </div>
      </div>

      {/* License banners */}
      {licenseInfo?.status === 'trial' && licenseInfo.daysRemaining <= 5 && licenseInfo.daysRemaining > 0 && (
        <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '10px 32px', fontSize: '13px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>Your trial expires in <strong>{licenseInfo.daysRemaining} day{licenseInfo.daysRemaining !== 1 ? 's' : ''}</strong>. Go to <a href="/settings" style={{ color: '#92400e', fontWeight: '600' }}>Settings → License</a> to activate.</span>
        </div>
      )}
      {licenseInfo?.status === 'grace' && (
        <div style={{ background: '#ffedd5', borderBottom: '1px solid #fed7aa', padding: '10px 32px', fontSize: '13px', color: '#c2410c', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>Your trial has expired. Activate a license key to continue using NocVault.</span>
        </div>
      )}
      {licenseInfo?.status === 'expired' && (
        <div style={{ background: '#fee2e2', borderBottom: '1px solid #fecaca', padding: '10px 32px', fontSize: '13px', color: '#991b1b', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span><strong>NocVault license required.</strong> Contact <a href="mailto:support@nocvault.io" style={{ color: '#991b1b', fontWeight: '600' }}>support@nocvault.io</a></span>
        </div>
      )}
      {licenseInfo?.status === 'active' && licenseInfo.expiry && (() => {
        const days = Math.ceil((new Date(licenseInfo.expiry).getTime() - Date.now()) / 86400000)
        if (days <= 30) return (
          <div style={{ background: '#ffedd5', borderBottom: '1px solid #fed7aa', padding: '10px 32px', fontSize: '13px', color: '#c2410c', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Your license expires on <strong>{licenseInfo.expiry}</strong>. Contact <a href="mailto:support@nocvault.io" style={{ color: '#c2410c', fontWeight: '600' }}>support@nocvault.io</a> to renew.</span>
          </div>
        )
        if (days <= 90) return (
          <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '10px 32px', fontSize: '13px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Your license expires on <strong>{licenseInfo.expiry}</strong>. Contact <a href="mailto:support@nocvault.io" style={{ color: '#92400e', fontWeight: '600' }}>support@nocvault.io</a> to renew.</span>
          </div>
        )
        return null
      })()}

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1 style={{ fontSize: '26px', fontWeight: '700', color: '#111827', margin: '0 0 6px' }}>Welcome back, {user?.name?.split(' ')[0]}</h1>
          <p style={{ fontSize: '14px', color: '#6b7280', margin: 0 }}>Select an application to get started</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 280px)', gap: '20px', alignItems: 'stretch' }}>
          {apps.map(app => (
            <a key={app.name} href={app.href} target={app.external ? '_blank' : '_self'} rel={app.external ? 'noopener noreferrer' : undefined} style={{ textDecoration: 'none', display: 'flex' }}>
              <div
                style={{ background: 'white', borderRadius: '14px', border: '1px solid #e5e7eb', padding: '20px', cursor: 'pointer', transition: 'all 0.15s', boxSizing: 'border-box' as const, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' as const }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 12px 32px rgba(0,0,0,0.12)'; (e.currentTarget as HTMLDivElement).style.borderColor = app.color }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none'; (e.currentTarget as HTMLDivElement).style.borderColor = '#e5e7eb' }}
              >
                <div style={{ width: '100%', height: '110px', borderRadius: '10px', background: app.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '14px', padding: '16px' }}>
                  {app.icon}
                </div>
                <div style={{ fontSize: '17px', fontWeight: '700', color: '#111827', marginBottom: '3px' }}>{app.name}</div>
                <div style={{ fontSize: '12px', color: app.color, fontWeight: '500', marginBottom: '8px' }}>{app.subtitle}</div>
                <div style={{ fontSize: '12px', color: '#6b7280', lineHeight: '1.5', marginBottom: '16px', flex: 1 }}>{app.description}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: app.color, fontSize: '13px', fontWeight: '500' }}>
                  Open {app.name}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </div>
              </div>
            </a>
          ))}
        </div>

        <p style={{ marginTop: '40px', fontSize: '12px', color: '#9ca3af' }}>NocVault · Network Intelligence Suite</p>
      </div>
    </div>
  )
}
