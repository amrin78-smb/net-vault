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
      icon: <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
      color: primary,
      bg: '#fee2e2',
    },
    {
      name: 'LogVault',
      subtitle: 'Syslog & Log Analysis',
      description: 'Real-time syslog collection, analysis and alerting for your network infrastructure.',
      href: 'http://192.168.6.111:3004',
      external: true,
      icon: <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
      color: '#0369a1',
      bg: '#e0f2fe',
    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ background: navy, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', background: primary, borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z"/>
              <polyline points="9 12 11 14 15 10"/>
            </svg>
          </div>
          <div>
            <div style={{ color: 'white', fontSize: '16px', fontWeight: '700' }}>NexVault</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>Network Intelligence Suite</div>
          </div>
        </div>
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
                <div style={{ width: '64px', height: '64px', borderRadius: '14px', background: app.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: app.color, marginBottom: '20px' }}>
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
