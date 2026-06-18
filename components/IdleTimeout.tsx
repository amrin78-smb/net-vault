'use client'
import { useEffect, useRef, useState } from 'react'
import { signOut } from 'next-auth/react'

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click'] as const

// Sign out and send the user back to where they were once they log in again.
// The current path is passed through as callbackUrl so login can restore it.
function timeoutSignOut() {
  const here = window.location.pathname + window.location.search
  const dest = here && !here.startsWith('/login') ? here : '/launcher'
  signOut({ callbackUrl: `/login?reason=timeout&callbackUrl=${encodeURIComponent(dest)}` })
}

export default function IdleTimeout() {
  const [showWarning, setShowWarning] = useState(false)
  const timeoutMs = useRef(0)
  const mainTimerId = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warnTimerId = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRef = useRef<() => void>(() => {})

  useEffect(() => {
    function clearTimers() {
      if (mainTimerId.current !== null) clearTimeout(mainTimerId.current)
      if (warnTimerId.current !== null) clearTimeout(warnTimerId.current)
    }

    function schedule() {
      clearTimers()
      setShowWarning(false)
      const ms = timeoutMs.current
      if (!ms) return
      const warnDelay = ms - 60_000
      if (warnDelay > 0) {
        warnTimerId.current = setTimeout(() => setShowWarning(true), warnDelay)
      }
      mainTimerId.current = setTimeout(() => {
        timeoutSignOut()
      }, ms)
    }

    scheduleRef.current = schedule

    function onActivity() {
      if (timeoutMs.current) schedule()
    }

    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, onActivity, { passive: true }))

    fetch('/api/settings')
      .then(r => r.json())
      .then((d: Record<string, string>) => {
        const mins = parseInt(d?.idle_timeout_minutes, 10)
        timeoutMs.current = isNaN(mins) || mins === 0 ? 0 : mins * 60_000
        if (timeoutMs.current > 0) schedule()
      })
      .catch(() => {
        timeoutMs.current = 30 * 60_000
        schedule()
      })

    return () => {
      clearTimers()
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, onActivity))
    }
  }, [])

  function stayLoggedIn() {
    scheduleRef.current()
  }

  if (!showWarning) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      animation: 'fadeIn 0.15s ease',
    }}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: '32px',
        width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        textAlign: 'center',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
          <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
        </div>
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px' }}>
          Session expiring soon
        </h2>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', margin: '0 0 24px' }}>
          You will be logged out in 60 seconds due to inactivity.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={stayLoggedIn} style={{ padding: '10px 24px' }}>
            Stay logged in
          </button>
          <button className="btn" onClick={timeoutSignOut} style={{ padding: '10px 24px' }}>
            Sign out now
          </button>
        </div>
      </div>
    </div>
  )
}
