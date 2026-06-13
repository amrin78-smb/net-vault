'use client'
import { useState, useEffect, useRef, Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'

const RED = '#C8102E'
const NAVY_BG = '#0a0f1e'

// ── Subtle world map overlay ─────────────────────────────────────────
// A compact ASCII land-mask (non-space = land). We project it into faint
// white dots rendered behind the network canvas at ~3% opacity. Keeping it
// as a mask avoids inlining hundreds of hand-written <circle> tags.
const MAP_ROWS = [
  '                                                                  ',
  '        ######        #####                    ########           ',
  '      ##########     ######          ####     ###########   ##     ',
  '     ############   ######        #######    #############   ###   ',
  '      ###########  #####        ##########  ###############   ##   ',
  '        #########            ## ######### ################    #    ',
  '         #######              ##  ######  ##############           ',
  '          #####                #   ####    ###########            ',
  '           ###                      ###     #########       ##     ',
  '            ##                       ##       ######        ###    ',
  '             #            ######     ###       ####          #     ',
  '            ###          ########    ####       ##     ###         ',
  '           #####         ########    ###               #####       ',
  '           #####          ######     ##          ###    ###        ',
  '            ####           #####     #           ####             ',
  '             ###            ####     #            ##              ',
  '             ###             ###                                  ',
  '              ##             ##                                   ',
  '              ##             #                     ##             ',
  '               #                                                  ',
  '                                                                  ',
]
const MAP_COLS = Math.max(...MAP_ROWS.map(r => r.length))
const MAP_DOTS: [number, number][] = []
MAP_ROWS.forEach((row, r) => {
  for (let c = 0; c < row.length; c++) {
    if (row[c] !== ' ') MAP_DOTS.push([c, r])
  }
})

// ── Animated network background (canvas + RAF) ───────────────────────
function LoginBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const NODE_COUNT = 80
    let w = 0
    let h = 0
    let nodes: { x: number; y: number; vx: number; vy: number; red: boolean }[] = []

    const init = () => {
      w = canvas.width = window.innerWidth
      h = canvas.height = window.innerHeight
      nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        red: i % 9 === 0, // a few brand-red accent nodes
      }))
    }
    init()

    let raf = 0
    const draw = () => {
      ctx.clearRect(0, 0, w, h)

      // connecting lines (fade with distance)
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        n.x += n.vx
        n.y += n.vy
        if (n.x < 0 || n.x > w) n.vx *= -1
        if (n.y < 0 || n.y > h) n.vy *= -1
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j]
          const dx = n.x - m.x
          const dy = n.y - m.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 150) {
            ctx.strokeStyle = `rgba(99,179,237,${0.15 * (1 - dist / 150)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(n.x, n.y)
            ctx.lineTo(m.x, m.y)
            ctx.stroke()
          }
        }
      }

      // nodes
      for (const n of nodes) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.red ? 2.5 : 1.8, 0, Math.PI * 2)
        ctx.fillStyle = n.red ? 'rgba(200,16,46,0.8)' : 'rgba(99,179,237,0.6)'
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }
    draw()

    const onResize = () => init()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <>
      <svg
        aria-hidden
        viewBox={`0 0 ${MAP_COLS} ${MAP_ROWS.length}`}
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', opacity: 0.03, zIndex: 0, pointerEvents: 'none' }}
      >
        {MAP_DOTS.map(([c, r], i) => (
          <circle key={i} cx={c + 0.5} cy={r + 0.5} r={0.38} fill="#fff" />
        ))}
      </svg>
      <canvas
        ref={canvasRef}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none' }}
      />
    </>
  )
}

// ── Inline NocVault wordmark (Noc white, Vault red) ──────────────────
function NocVaultLogo({ height = 40 }: { height?: number }) {
  return (
    <svg viewBox="0 0 205 48" height={height} width={(205 / 48) * height} aria-label="NocVault">
      <line x1="6" y1="6" x2="6" y2="42" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="6" y1="6" x2="24" y2="42" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="24" y1="6" x2="24" y2="42" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="6" cy="6" r="3" fill={RED} />
      <circle cx="6" cy="42" r="3" fill={RED} />
      <circle cx="24" cy="6" r="3" fill={RED} />
      <circle cx="24" cy="42" r="3" fill={RED} />
      <text x="38" y="35" fontSize="32" fontWeight="700" letterSpacing="-0.5" fontFamily="'Rubik','Helvetica Neue',Helvetica,Arial,sans-serif">
        <tspan fill="#ffffff">Noc</tspan>
        <tspan fill={RED}>Vault</tspan>
      </text>
    </svg>
  )
}

// ── Suite app icons (matching the launcher marks) ────────────────────
function AppMark({ name }: { name: string }) {
  switch (name) {
    case 'NetVault':
      return (
        <svg viewBox="0 0 38 42" width="26" height="28" style={{ flexShrink: 0 }}>
          <line x1="19" y1="4" x2="4" y2="36" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
          <line x1="19" y1="4" x2="34" y2="36" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
          <line x1="4" y1="36" x2="34" y2="36" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="19" cy="4" r="3" fill={RED} />
          <circle cx="4" cy="36" r="3" fill={RED} />
          <circle cx="34" cy="36" r="3" fill={RED} />
        </svg>
      )
    case 'LogVault':
      return (
        <svg viewBox="0 0 32 46" width="20" height="28" style={{ flexShrink: 0 }}>
          <rect x="2" y="6" width="3" height="34" rx="1.5" fill="#2563eb" />
          <rect x="9" y="7" width="20" height="3" rx="1.5" fill="#2563eb" />
          <rect x="9" y="15" width="14" height="3" rx="1.5" fill="#2563eb" opacity="0.7" />
          <rect x="9" y="23" width="18" height="3" rx="1.5" fill="#2563eb" opacity="0.85" />
          <rect x="9" y="31" width="10" height="3" rx="1.5" fill="#2563eb" opacity="0.6" />
        </svg>
      )
    case 'DDIVault':
      return (
        <svg viewBox="0 0 38 44" width="26" height="28" style={{ flexShrink: 0 }}>
          <circle cx="19" cy="22" r="15" fill="none" stroke="#d97706" strokeWidth="2" />
          <ellipse cx="19" cy="22" rx="7" ry="15" fill="none" stroke="#d97706" strokeWidth="1.5" />
          <line x1="4" y1="22" x2="34" y2="22" stroke="#d97706" strokeWidth="1.5" />
        </svg>
      )
    case 'SpanVault':
      return (
        <svg viewBox="0 0 40 46" width="28" height="28" style={{ flexShrink: 0 }}>
          <path d="M1,23 L7,23 L11,8 L16,38 L21,8 L26,38 L30,23 L38,23" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    default:
      return null
  }
}

const APPS = [
  { name: 'NetVault', prefix: 'Net', accent: RED, subtitle: 'Asset Management' },
  { name: 'LogVault', prefix: 'Log', accent: '#2563eb', subtitle: 'Syslog & Log Analytics' },
  { name: 'DDIVault', prefix: 'DDI', accent: '#d97706', subtitle: 'DNS, DHCP & IPAM' },
  { name: 'SpanVault', prefix: 'Span', accent: '#16a34a', subtitle: 'Network Monitoring' },
]

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 10,
  padding: '12px 14px',
  color: '#fff',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.75)',
  marginBottom: 8,
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Only honour internal, non-looping targets. A bare /sso is not a real page,
  // and /login would loop — fall back to the launcher in those cases.
  const rawCallback = searchParams.get('callbackUrl') || ''
  const callbackUrl =
    rawCallback.startsWith('/') &&
    !rawCallback.startsWith('//') &&
    !rawCallback.startsWith('/sso') &&
    !rawCallback.startsWith('/login')
      ? rawCallback
      : '/launcher'
  const reason = searchParams.get('reason')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Form submission logic unchanged — keep the existing NextAuth signIn() call.
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

  return (
    <div style={{ position: 'relative', minHeight: '100vh', background: NAVY_BG, overflow: 'hidden', color: '#fff' }}>
      <style>{`
        .nv-login-input::placeholder { color: rgba(255,255,255,0.35); }
        .nv-login-input:focus { border-color: ${RED}; background: rgba(255,255,255,0.12); }
        .nv-login-center { min-height: 100vh; display: flex; align-items: center; justify-content: center; gap: 56px; margin-top: -60px; margin-left: -60px; padding: 24px; position: relative; z-index: 1; }
        .nv-login-left { width: 500px; flex-shrink: 0; }
        .nv-app-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .nv-app-card { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); transition: background 0.15s; }
        .nv-app-card:hover { background: rgba(255,255,255,0.12); }
        @media (max-width: 980px) {
          .nv-login-center { gap: 0; margin-top: 0; }
          .nv-login-left { display: none; }
          .nv-status-badge { display: none; }
        }
      `}</style>

      <LoginBackground />

      {/* Platform status — top-right of the page */}
      <div className="nv-status-badge" style={{ position: 'fixed', top: 24, right: 32, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px #22c55e' }} />
        <span style={{ color: 'rgba(255,255,255,0.45)' }}>Platform Status</span>
        <span style={{ color: '#22c55e', fontWeight: 600 }}>Operational</span>
      </div>

      {/* Version — fixed bottom-left of the page */}
      <div style={{ position: 'fixed', bottom: 20, left: 32, zIndex: 2, fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>
        NocVault v1.2.0  •  Build 2026.06.11
      </div>

      {/* Logo + suite name — fixed top-left */}
      <div style={{ position: 'fixed', top: 24, left: 32, zIndex: 2 }}>
        <NocVaultLogo height={40} />
        <div style={{ fontSize: 11, letterSpacing: '2px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>
          NETWORK INTELLIGENCE SUITE
        </div>
      </div>

      {/* Centered pair: left showcase + login card */}
      <div className="nv-login-center">

        {/* ── LEFT: headline + showcase ── */}
        <div className="nv-login-left">
          <h1 style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.15, margin: 0, marginBottom: 12, color: '#fff', letterSpacing: '-1px' }}>
            Unified Visibility.<br />
            Smarter Operations.<br />
            Better Decisions.
          </h1>
          <div style={{ width: 56, height: 3, background: RED, borderRadius: 2, marginBottom: 16 }} />
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.6)', margin: 0, marginBottom: 28 }}>
            NocVault delivers real-time intelligence across your network infrastructure, assets, logs and IP services.
          </p>

          {/* App showcase cards */}
          <div className="nv-app-grid">
            {APPS.map(app => (
              <div key={app.name} className="nv-app-card" style={{ borderLeft: `2px solid ${app.accent}`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <AppMark name={app.name} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>
                    {app.prefix}<span style={{ color: app.accent }}>Vault</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{app.subtitle}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT: login card ── */}
        <div style={{
            width: 400,
            flexShrink: 0,
            background: 'rgba(255,255,255,0.05)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderTop: `2px solid ${RED}`,
            borderRadius: 16,
            padding: 40,
            boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
          }}>
            {/* Lock icon */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={RED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>

            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#fff', letterSpacing: '-0.5px' }}>Welcome Back</div>
              <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', marginTop: 6 }}>Sign in to access NocVault</div>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>Email address</label>
                <input
                  type="email"
                  className="nv-login-input"
                  style={inputStyle}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  autoFocus
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <label style={labelStyle}>Password</label>
                  <a href="#" style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontWeight: 600, textDecoration: 'none' }}>Forgot password?</a>
                </div>
                <input
                  type="password"
                  className="nv-login-input"
                  style={inputStyle}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'rgba(255,255,255,0.65)', marginBottom: 22, cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={e => setRemember(e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: RED, cursor: 'pointer' }}
                />
                Remember me
              </label>

              {reason === 'timeout' && (
                <div style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', color: '#fbbf24', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
                  Your session expired due to inactivity.
                </div>
              )}

              {error && (
                <div style={{ background: 'rgba(200,16,46,0.12)', border: '1px solid rgba(200,16,46,0.35)', color: '#f87171', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%',
                  height: 48,
                  background: RED,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: loading ? 'default' : 'pointer',
                  opacity: loading ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  transition: 'background 0.15s, opacity 0.15s',
                }}
                onMouseEnter={e => { if (!loading) e.currentTarget.style.background = '#a00d24' }}
                onMouseLeave={e => { e.currentTarget.style.background = RED }}
              >
                {loading ? 'Signing in…' : <>Sign In <span style={{ fontSize: 17 }}>→</span></>}
              </button>
            </form>

          <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
            Need help? Contact your IT administrator
          </div>
        </div>
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
