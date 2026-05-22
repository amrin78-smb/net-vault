'use client'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function LauncherPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [settings, setSettings] = useState({ app_primary_color: '#C8102E', app_navy_color: '#1a2744' })

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => { if (d && !d.error) setSettings(d) })
  }, [])

  if (status === 'loading') return null
  if (status === 'unauthenticated') { router.push('/login'); return null }

  const user = session?.user as { name?: string; email?: string; role?: string }
  const primary = settings.app_primary_color || '#C8102E'
  const navy = settings.app_navy_color || '#1a2744'

  const apps = [
    {
      name: 'NetVault',
      subtitle: 'Network Asset Management',
      description: 'Manage network devices, sites, circuits and track EOL/EOS across your global infrastructure.',
      href: '/dashboard',
      external: false,
      icon: <img src="/netvault-logo-white.png" alt="NetVault" style={{ width: '240px', objectFit: 'contain' }} />,
      color: primary,
      bg: '#1a2744',
    },
    {
      name: 'LogVault',
      subtitle: 'Syslog & Log Analysis',
      description: 'Real-time syslog collection, analysis and alerting for your network infrastructure.',
      href: '/api/sso/logvault',
      external: false,
      icon: <img src="/logvault-logo-white.png" alt="LogVault" style={{ width: '240px', objectFit: 'contain' }} />,
      color: '#0369a1',
      bg: '#1a2744',
    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ background: navy, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <img src="/nexvault-logo-white.png" alt="NexVault" style={{ maxHeight: '52px', maxWidth: '220px', objectFit: 'contain' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: 'white', fontSize: '13px', fontWeight: '500' }}>{user?.name}</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>{user?.role?.replace('_', ' ')}</div>
          </div>
          <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: primary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '14px', fontWeight: '600' }}>
            {user?.name?.charAt(0)?.toUpperCase() || 'U'}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <h1 style={{ fontSize: '32px', fontWeight: '700', color: '#111827', margin: '0 0 8px' }}>Welcome back, {user?.name?.split(' ')[0]}</h1>
          <p style={{ fontSize: '16px', color: '#6b7280', margin: 0 }}>Select an application to get started</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 340px)', gap: '24px' }}>
          {apps.map(app => (
            <a key={app.name} href={app.href} target={app.external ? '_blank' : '_self'} rel={app.external ? 'noopener noreferrer' : undefined} style={{ textDecoration: 'none' }}>
              <div
                style={{ background: 'white', borderRadius: '16px', border: '1px solid #e5e7eb', padding: '32px', cursor: 'pointer', transition: 'all 0.15s', boxSizing: 'border-box' as const }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 12px 32px rgba(0,0,0,0.12)'; (e.currentTarget as HTMLDivElement).style.borderColor = app.color }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none'; (e.currentTarget as HTMLDivElement).style.borderColor = '#e5e7eb' }}
              >
                <div style={{ width: '100%', height: '120px', borderRadius: '10px', background: app.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px', padding: '16px' }}>
                  {app.icon}
                </div>
                <div style={{ fontSize: '20px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>{app.name}</div>
                <div style={{ fontSize: '13px', color: app.color, fontWeight: '500', marginBottom: '12px' }}>{app.subtitle}</div>
                <div style={{ fontSize: '14px', color: '#6b7280', lineHeight: '1.5', marginBottom: '24px' }}>{app.description}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: app.color, fontSize: '14px', fontWeight: '500' }}>
                  Open {app.name}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </div>
              </div>
            </a>
          ))}
        </div>

        <p style={{ marginTop: '40px', fontSize: '12px', color: '#9ca3af' }}>NexVault · Network Intelligence Suite</p>
      </div>
    </div>
  )
}
