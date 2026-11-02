'use client'

import { useEffect, useState } from 'react'

/**
 * Self-service MFA enrolment for the signed-in user (Settings → Security).
 *
 * Enrolment is deliberately three steps — show QR, prove a code works, then
 * enable. The server refuses to set mfa_enabled until a code verifies, so a
 * mis-scanned QR cannot lock someone out of their own account.
 */

type State = {
  enabled: boolean
  enrolled_at: string | null
  backup_codes_remaining: number
  required_for_your_role: boolean
}

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', padding: 20, maxWidth: 640,
}
const btn: React.CSSProperties = {
  padding: '9px 16px', fontSize: 'var(--text-base)', fontWeight: 600,
  background: 'var(--primary)', color: '#fff', border: 'none',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
}
const btnGhost: React.CSSProperties = {
  ...btn, background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
}
const input: React.CSSProperties = {
  padding: '9px 12px', fontSize: 'var(--text-md)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', width: 180, letterSpacing: 3, textAlign: 'center',
}

export default function MfaCard() {
  const [state, setState] = useState<State | null>(null)
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [token, setToken] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [justFinished, setJustFinished] = useState(false)

  async function load() {
    try {
      const r = await fetch('/api/mfa')
      if (r.ok) setState(await r.json())
    } catch { /* card just stays in its loading state */ }
  }
  useEffect(() => { load() }, [])

  async function call(body: any) {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await fetch('/api/mfa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(d?.error || 'Something went wrong'); return null }
      return d
    } catch {
      setErr('Could not reach the server'); return null
    } finally {
      setBusy(false)
    }
  }

  async function begin() {
    const d = await call({ action: 'setup' })
    if (d) { setSetup({ secret: d.secret, qr: d.qr }); setCodes(null); setToken('') }
  }

  async function enable() {
    const d = await call({ action: 'enable', token })
    if (d?.enabled) {
      setCodes(d.backup_codes || [])
      setSetup(null); setToken('')
      await load()
    }
  }

  async function disable() {
    const d = await call({ action: 'disable', password })
    if (d && d.enabled === false) {
      setPassword(''); setCodes(null); setMsg('Two-factor authentication is off.')
      await load()
    }
  }

  if (!state) return <div style={{ ...card, color: 'var(--text-muted)' }}>Loading…</div>

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Two-factor authentication</h3>
        <span style={{
          fontSize: 'var(--text-xs)', fontWeight: 700, padding: '2px 8px',
          borderRadius: 'var(--radius-pill)',
          background: state.enabled ? 'var(--tint-success)' : 'var(--surface-subtle)',
          color: state.enabled ? 'var(--tint-success-fg)' : 'var(--text-muted)',
        }}>{state.enabled ? 'ON' : 'OFF'}</span>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 0, marginBottom: 16 }}>
        Signing in to NocVault will ask for a code from your authenticator app in addition to your
        password. This covers NetVault, LogVault, DDIVault and SpanVault — they all sign in here.
      </p>

      {/* Step indicator. Derived from the state that already exists rather
          than tracked separately, so it cannot drift from where enrolment
          actually is. Hidden once two-factor is on and settled. */}
      {(!state.enabled || codes) && (
        <ol className="import-steps" aria-label="Two-factor setup progress">
          {([['Begin', 1], ['Scan', 2], ['Verify', 3], ['Save codes', 4]] as const).map(([label, n]) => {
            const current = codes ? 4 : setup ? (token.length >= 6 ? 3 : 2) : 1
            return (
              <li key={label}
                  data-state={current > n ? 'done' : current === n ? 'current' : 'todo'}
                  aria-current={current === n ? 'step' : undefined}>
                <span className="import-step-dot">{current > n ? '\u2713' : n}</span>
                <span>{label}</span>
              </li>
            )
          })}
        </ol>
      )}

      {justFinished && state.enabled && !codes && (
        <div role="status" style={{ background: 'var(--tint-success)', color: 'var(--tint-success-fg)', border: '1px solid var(--border)', padding: '11px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5"/></svg>
          Two-factor authentication is on. You will be asked for a code the next time you sign in.
        </div>
      )}

      {state.required_for_your_role && !state.enabled && (
        <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', border: '1px solid var(--border)', padding: '9px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
          Your role requires two-factor authentication. You will not be able to sign in again until you set it up.
        </div>
      )}
      {err && (
        <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '9px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>{err}</div>
      )}
      {msg && (
        <div style={{ background: 'var(--tint-info)', color: 'var(--tint-info-fg)', padding: '9px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>{msg}</div>
      )}

      {/* Backup codes — shown once, immediately after enabling. */}
      {codes && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14, marginBottom: 16, background: 'var(--surface-subtle)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Save these backup codes now</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 10 }}>
            Each one works once, in place of a code from your app. This is the only time they are shown —
            they are stored hashed and cannot be displayed again. Without them, losing your phone means
            asking an administrator to reset your two-factor setup.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)' }}>
            {codes.map(c => <div key={c}>{c}</div>)}
          </div>
          {/* Browser-native copy, download and print. These codes are shown
              exactly once, so getting them off the screen must not depend on
              the user selecting text accurately. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button style={btnGhost} onClick={() => {
              navigator.clipboard?.writeText(codes.join('\n'))
                .then(() => setMsg('Backup codes copied to the clipboard.'))
                .catch(() => setErr('Could not copy. Select the codes and copy them manually.'))
            }}>Copy</button>
            <button style={btnGhost} onClick={() => {
              const blob = new Blob([`NocVault two-factor backup codes\n\n${codes.join('\n')}\n\nEach code works once. Keep them somewhere safe.\n`], { type: 'text/plain' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url; a.download = 'nocvault-backup-codes.txt'; a.click()
              URL.revokeObjectURL(url)
            }}>Download</button>
            <button style={btnGhost} onClick={() => {
              const w = window.open('', '_blank', 'width=520,height=640')
              if (!w) { setErr('Your browser blocked the print window.'); return }
              w.document.write(`<title>NocVault backup codes</title><h3>NocVault two-factor backup codes</h3><p>Each code works once. Keep this somewhere safe.</p><pre style="font-size:15px;line-height:1.9">${codes.join('\n')}</pre>`)
              w.document.close(); w.focus(); w.print()
            }}>Print</button>
            <button style={btn} onClick={() => { setCodes(null); setJustFinished(true); setMsg('') }}>
              I have saved them
            </button>
          </div>
        </div>
      )}

      {/* Enrolment */}
      {!state.enabled && !setup && !codes && (
        <button style={btn} onClick={begin} disabled={busy}>Set up authenticator</button>
      )}

      {setup && (
        <div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 10 }}>
            Scan this with Microsoft Authenticator, Google Authenticator, 1Password or similar,
            then enter the 6-digit code it shows.
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="Authenticator QR code" width={220} height={220}
               style={{ background: '#fff', padding: 8, borderRadius: 'var(--radius-sm)' }} />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '10px 0' }}>
            Can’t scan? Enter this key manually:{' '}
            <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{setup.secret}</code>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={input} value={token} onChange={e => setToken(e.target.value)}
                   aria-label="Six-digit code from your authenticator app"
                   autoComplete="one-time-code"
                   placeholder="000000" inputMode="numeric" maxLength={6} />
            <button style={btn} onClick={enable} disabled={busy || token.length < 6}>Verify and turn on</button>
            <button style={btnGhost} onClick={() => { setSetup(null); setToken(''); setErr('') }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {/* Turning it off */}
      {state.enabled && !codes && (
        <div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 12 }}>
            In use since {state.enrolled_at ? new Date(state.enrolled_at).toLocaleDateString() : '—'} ·{' '}
            {state.backup_codes_remaining} backup code{state.backup_codes_remaining === 1 ? '' : 's'} left
          </div>
          {!state.required_for_your_role && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input style={{ ...input, width: 220, letterSpacing: 0, textAlign: 'left' }} type="password"
                     aria-label="Confirm your password to turn off two-factor"
                     autoComplete="current-password"
                     value={password} onChange={e => setPassword(e.target.value)}
                     placeholder="Confirm your password" />
              <button style={btnGhost} onClick={disable} disabled={busy || !password}>Turn off</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
