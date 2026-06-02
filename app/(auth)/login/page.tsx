'use client'
import { useState, useEffect, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') || '/launcher'
  const reason = searchParams.get('reason')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [settings, setSettings] = useState<Settings>({
    app_name: 'NetVault',
    app_subtitle: 'NETWORK ASSET MANAGEMENT',
    app_logo_url: '',
    app_primary_color: '#C8102E',
    app_navy_color: '#1a2744',
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => {
      if (d && !d.error) setSettings(d)
      setSettingsLoaded(true)
    }).catch(() => setSettingsLoaded(true))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await signIn('credentials', { email, password, redirect: false })
    if (res?.ok) {
      router.push(callbackUrl)
    } else {
      setError('Invalid email or password')
      setLoading(false)
    }
  }

  const navy = settings.app_navy_color || '#1a2744'
  const primary = settings.app_primary_color || '#C8102E'

  return (
    <div style={{
      minHeight: '100vh',
      background: `linear-gradient(160deg, ${navy} 0%, #0d1220 100%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          {settingsLoaded && settings.app_logo_url ? (
            <img src={settings.app_logo_url} alt={settings.app_name} style={{ maxWidth: 240, maxHeight: 80, objectFit: 'contain' }} />
          ) : (
            <img src="/nocvault-logo-white.png" alt="NocVault" style={{ maxWidth: 260, maxHeight: 90, objectFit: 'contain' }} />
          )}
        </div>

        {/* Card */}
        <div style={{
          background: 'rgba(255,255,255,0.97)',
          borderRadius: 16,
          padding: '36px 40px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>Sign in</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>NetVault · Network Asset Management</div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="form-field" style={{ marginBottom: 16 }}>
              <label>Email address</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
              />
            </div>

            <div className="form-field" style={{ marginBottom: 24 }}>
              <label>Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {reason === 'timeout' && (
              <div style={{ background: '#fef3c7', color: '#92400e', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, textAlign: 'center', fontWeight: 500 }}>
                Your session expired due to inactivity.
              </div>
            )}

            {error && (
              <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '11px', fontSize: 14, fontWeight: 600 }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 12, marginTop: 24 }}>
          Contact your IT admin to get access
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
