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
    <svg viewBox="0 0 218 46" height={height} width={(218 / 46) * height} aria-label="NocVault">
      <defs>
      <radialGradient id="noc-login-nocSphere" cx="35%" cy="28%" r="78%">
      <stop offset="0%"   stopColor="#FF6B7F"/>
      <stop offset="42%"  stopColor="#E02744"/>
      <stop offset="100%" stopColor="#8E0A20"/>
      </radialGradient>
      <linearGradient id="noc-login-nocSheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stopColor="#ffffff" stopOpacity="0.38"/>
      <stop offset="60%"  stopColor="#ffffff" stopOpacity="0"/>
      </linearGradient>
      </defs>
      <circle cx="22" cy="23" r="17" fill="url(#noc-login-nocSphere)"/>
      <ellipse cx="22" cy="15.5" rx="13.5" ry="7.5" fill="url(#noc-login-nocSheen)"/>
      <g fill="none" stroke="#FFD2D9" strokeOpacity="0.75" strokeWidth="1.25">
      <ellipse cx="22" cy="23" rx="17" ry="7"/>
      <ellipse cx="22" cy="23" rx="7" ry="17"/>
      <path d="M6.5 16.5 Q22 25 37.5 16.5"/>
      </g>
      <g>
      <circle cx="22" cy="6"  r="3.3" fill="#ffffff"/><circle cx="22" cy="6"  r="1.5" fill="#E02744"/>
      <circle cx="37" cy="27" r="3.0" fill="#ffffff"/><circle cx="37" cy="27" r="1.3" fill="#E02744"/>
      <circle cx="9"  cy="30" r="2.7" fill="#ffffff"/><circle cx="9"  cy="30" r="1.2" fill="#E02744"/>
      </g>
      <text x="48" y="33" fontSize="30" fontWeight="700" letterSpacing="-0.5" fontFamily="'Rubik','Helvetica Neue',Helvetica,Arial,sans-serif">
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
        <svg viewBox="0 0 46 46" width="28" height="28" style={{ flexShrink: 0 }}>
          <defs>
          <linearGradient id="tile-net-nvFace" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FF7187"/><stop offset="55%" stopColor="#D4162F"/><stop offset="100%" stopColor="#8E0A20"/>
          </linearGradient>
          <linearGradient id="tile-net-nvEdge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.34"/><stop offset="45%" stopColor="#ffffff" stopOpacity="0"/>
          </linearGradient>
          <mask id="tile-net-nvLens">
          <rect x="0" y="0" width="206" height="46" fill="#fff"/>
          <circle cx="30" cy="31" r="11.6" fill="#000"/>
          </mask>
          </defs>
          {/* three rack units: flat faces with bay LEDs, not isometric slabs, so this cannot be mistaken for LogVault's data stack */}
          <g mask="url(#tile-net-nvLens)">
          <g>
          <rect x="3" y="5"  width="31" height="9.4" rx="2.4" fill="url(#tile-net-nvFace)"/>
          <rect x="3" y="5"  width="31" height="9.4" rx="2.4" fill="url(#tile-net-nvEdge)"/>
          <rect x="3" y="17.3" width="31" height="9.4" rx="2.4" fill="url(#tile-net-nvFace)" opacity="0.88"/>
          <rect x="3" y="17.3" width="31" height="9.4" rx="2.4" fill="url(#tile-net-nvEdge)"/>
          <rect x="3" y="29.6" width="31" height="9.4" rx="2.4" fill="url(#tile-net-nvFace)" opacity="0.74"/>
          <rect x="3" y="29.6" width="31" height="9.4" rx="2.4" fill="url(#tile-net-nvEdge)"/>
          </g>
          <g fill="#FFD2D9">
          <circle cx="8.4" cy="9.7"  r="1.5"/><rect x="12.5" y="8.8" width="9" height="1.8" rx="0.9" opacity="0.5"/>
          <circle cx="8.4" cy="22"   r="1.5" opacity="0.9"/><rect x="12.5" y="21.1" width="9" height="1.8" rx="0.9" opacity="0.42"/>
          <circle cx="8.4" cy="34.3" r="1.5" opacity="0.8"/><rect x="12.5" y="33.4" width="9" height="1.8" rx="0.9" opacity="0.34"/>
          </g>
          </g>
          <circle cx="30" cy="31" r="8.6" fill="#8E0A20" fillOpacity="0.22"/>
          <circle cx="30" cy="31" r="8.6" fill="none" stroke="#FF7187" strokeWidth="3.1"/>
          <line x1="36.2" y1="37.2" x2="41.4" y2="42.4" stroke="#FF7187" strokeWidth="3.4" strokeLinecap="round"/>
        </svg>
      )
    case 'LogVault':
      return (
        <svg viewBox="0 0 52 46" width="32" height="28" style={{ flexShrink: 0 }}>
          <defs>
          <linearGradient id="tile-log-lvTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7FB2FF"/><stop offset="100%" stopColor="#2563eb"/>
          </linearGradient>
          <linearGradient id="tile-log-lvSide" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2E6BEE"/><stop offset="100%" stopColor="#143F91"/>
          </linearGradient>
          </defs>
          <g>
          <path d="M20 29 L35 36.2 L20 43.4 L5 36.2 Z" fill="url(#tile-log-lvTop)" opacity="0.62"/>
          <path d="M5 36.2 L20 43.4 L20 40.2 L5 33 Z" fill="url(#tile-log-lvSide)" opacity="0.62"/>
          <path d="M35 36.2 L20 43.4 L20 40.2 L35 33 Z" fill="url(#tile-log-lvSide)" opacity="0.45"/>
          <path d="M20 17 L35 24.2 L20 31.4 L5 24.2 Z" fill="url(#tile-log-lvTop)" opacity="0.82"/>
          <path d="M5 24.2 L20 31.4 L20 28.2 L5 21 Z" fill="url(#tile-log-lvSide)" opacity="0.82"/>
          <path d="M35 24.2 L20 31.4 L20 28.2 L35 21 Z" fill="url(#tile-log-lvSide)" opacity="0.6"/>
          <path d="M20 5 L35 12.2 L20 19.4 L5 12.2 Z" fill="url(#tile-log-lvTop)"/>
          <path d="M5 12.2 L20 19.4 L20 16.2 L5 9 Z" fill="url(#tile-log-lvSide)"/>
          <path d="M35 12.2 L20 19.4 L20 16.2 L35 9 Z" fill="url(#tile-log-lvSide)" opacity="0.75"/>
          <path d="M20 5 L35 12.2 L20 19.4 L5 12.2 Z" fill="none" stroke="#BBD5FF" strokeOpacity="0.55" strokeWidth="0.8"/>
          </g>
          <g fill="#5A9BFF">
          <rect x="38.5" y="7"  width="4.6" height="4.6" rx="1.1"/>
          <rect x="45.5" y="12" width="3.4" height="3.4" rx="0.9" opacity="0.8"/>
          <rect x="38.5" y="17" width="4"   height="4"   rx="1"   opacity="0.9"/>
          <rect x="46.5" y="22" width="3"   height="3"   rx="0.8" opacity="0.62"/>
          <rect x="39"   y="26" width="3.4" height="3.4" rx="0.9" opacity="0.72"/>
          <rect x="45"   y="31" width="2.6" height="2.6" rx="0.7" opacity="0.5"/>
          </g>
        </svg>
      )
    case 'DDIVault':
      return (
        <svg viewBox="0 0 44 46" width="27" height="28" style={{ flexShrink: 0 }}>
          <defs>
          <radialGradient id="tile-ddi-ddiSphere" cx="36%" cy="28%" r="80%">
          <stop offset="0%"   stopColor="#FFC266"/>
          <stop offset="45%"  stopColor="#EE8B0B"/>
          <stop offset="100%" stopColor="#9A4E02"/>
          </radialGradient>
          <linearGradient id="tile-ddi-ddiSheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#ffffff" stopOpacity="0.40"/>
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0"/>
          </linearGradient>
          </defs>
          <circle cx="22" cy="23" r="15" fill="url(#tile-ddi-ddiSphere)"/>
          <ellipse cx="22" cy="16" rx="11.5" ry="6.5" fill="url(#tile-ddi-ddiSheen)"/>
          <g fill="none" stroke="#FFD9A3" strokeWidth="1.7" strokeOpacity="0.95">
          <ellipse cx="22" cy="23" rx="19" ry="8" transform="rotate(-24 22 23)"/>
          <ellipse cx="22" cy="23" rx="19" ry="8" transform="rotate(36 22 23)"/>
          </g>
          <g>
          <circle cx="38.4" cy="15.9" r="3.2" fill="#ffffff"/><circle cx="38.4" cy="15.9" r="1.4" fill="#EE8B0B"/>
          <circle cx="5.6"  cy="30.1" r="3.2" fill="#ffffff"/><circle cx="5.6"  cy="30.1" r="1.4" fill="#EE8B0B"/>
          <circle cx="6.6"  cy="13.6" r="2.8" fill="#ffffff"/><circle cx="6.6"  cy="13.6" r="1.2" fill="#EE8B0B"/>
          <circle cx="37.4" cy="32.4" r="2.8" fill="#ffffff"/><circle cx="37.4" cy="32.4" r="1.2" fill="#EE8B0B"/>
          </g>
        </svg>
      )
    case 'SpanVault':
      return (
        <svg viewBox="0 0 44 46" width="27" height="28" style={{ flexShrink: 0 }}>
          <defs>
          <linearGradient id="tile-spa-svBand" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6EE7B7"/><stop offset="48%" stopColor="#16a34a"/><stop offset="100%" stopColor="#065F2E"/>
          </linearGradient>
          <linearGradient id="tile-spa-svGhost" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6EE7B7" stopOpacity="0.42"/><stop offset="100%" stopColor="#16a34a" stopOpacity="0.12"/>
          </linearGradient>
          </defs>
          {/* ghost pass, offset up: gives the band its sculpted depth */}
          <path d="M2 19 C8 3, 15.5 3, 21 17 C26.5 31, 34 31, 40 13 L40 19.5
          C34 37.5, 26.5 37.5, 21 23.5 C15.5 9.5, 8 9.5, 2 25.5 Z" fill="url(#tile-spa-svGhost)"/>
          {/* main band: thick, clear peaks */}
          <path d="M2 26 C8 8, 15.5 8, 21 24 C26.5 40, 34 40, 40 20 L40 29
          C34 49, 26.5 49, 21 33 C15.5 17, 8 17, 2 35 Z" fill="url(#tile-spa-svBand)"/>
          <g>
          <circle cx="2"  cy="30.5" r="3.6" fill="#6EE7B7"/>
          <circle cx="21" cy="28.5" r="3.2" fill="#A7F3D0"/>
          <circle cx="40" cy="24.5" r="3.6" fill="#34D399"/>
          </g>
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
  borderRadius: 'var(--radius)',
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
  const [mfaStage, setMfaStage] = useState(false)
  const [totp, setTotp] = useState('')
  const totpRef = useRef<HTMLInputElement>(null)

  // Two-step sign-in when the account has a second factor.
  //
  // Step 1 asks /api/auth/mfa/precheck whether a code is needed, purely so the
  // form knows whether to show the field — a user without MFA never sees one,
  // and a user with it isn't told "invalid password" when the real problem is a
  // missing code. That endpoint issues nothing; authorize() re-checks the
  // password AND the code regardless of what the browser did here, so skipping
  // or faking step 1 gains nothing.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    if (!mfaStage) {
      try {
        const r = await fetch('/api/auth/mfa/precheck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        if (r.status === 429) {
          setError('Too many attempts. Wait a few minutes and try again.')
          setLoading(false)
          return
        }
        const d = await r.json().catch(() => ({}))
        if (d?.enrolmentRequired) {
          setError('Your role requires an authenticator app. Ask an administrator to set it up for you.')
          setLoading(false)
          return
        }
        if (d?.mfaRequired) {
          setMfaStage(true)
          setLoading(false)
          setTimeout(() => totpRef.current?.focus(), 50)
          return
        }
        // Not required (or the password was wrong — precheck answers the same
        // either way). Fall through and let signIn() give the real verdict.
      } catch {
        // Precheck is only an affordance; if it fails, attempt the sign-in
        // anyway rather than blocking login on a non-essential request.
      }
    }

    const res = await signIn('credentials', {
      email,
      password,
      totp: mfaStage ? totp : undefined,
      redirect: false,
    })
    if (res?.ok) {
      router.push(callbackUrl)
    } else {
      // NextAuth collapses every authorize() rejection into one error, so this
      // cannot distinguish a bad code from a bad password. Word it for the step
      // the user is actually on.
      setError(mfaStage ? 'That code was not accepted. Check your authenticator and try again.' : 'Invalid email or password')
      setTotp('')
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
        <span style={{ width: 8, height: 8, borderRadius: '50%' /* intentional: platform-status dot — squaring it would look broken */, background: '#22c55e', boxShadow: '0 0 8px #22c55e' }} />
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
          <div style={{ width: 56, height: 3, background: RED, borderRadius: 2 /* intentional: decorative 3px-tall accent sliver — a token radius would swallow the shape */, marginBottom: 16 }} />
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.6)', margin: 0, marginBottom: 28 }}>
            NocVault delivers real-time intelligence across your network infrastructure, assets, logs and IP services.
          </p>

          {/* App showcase cards */}
          <div className="nv-app-grid">
            {APPS.map(app => (
              <div key={app.name} className="nv-app-card" style={{ borderLeft: `2px solid ${app.accent}`, borderRadius: 'var(--radius)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
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
            borderRadius: 'var(--radius)',
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

              {mfaStage && (
                <div style={{ marginBottom: 18 }}>
                  <label style={labelStyle}>Authentication code</label>
                  <input
                    ref={totpRef}
                    // Not type="number": it strips leading zeros, and a TOTP
                    // beginning with 0 is perfectly normal. inputMode gets the
                    // numeric keypad on a phone without that side effect.
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="nv-login-input"
                    style={{ ...inputStyle, letterSpacing: 4, fontSize: 18, textAlign: 'center' }}
                    value={totp}
                    onChange={e => setTotp(e.target.value)}
                    placeholder="000000"
                    maxLength={14}
                    required
                    autoFocus
                  />
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 7, textAlign: 'center' }}>
                    From your authenticator app — or enter one of your backup codes.
                  </div>
                </div>
              )}

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
                <div style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', color: '#fbbf24', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
                  Your session expired due to inactivity.
                </div>
              )}

              {error && (
                <div style={{ background: 'rgba(200,16,46,0.12)', border: '1px solid rgba(200,16,46,0.35)', color: '#f87171', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
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
                  borderRadius: 'var(--radius)',
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
