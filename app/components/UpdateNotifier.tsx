'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

interface UpdateInfo {
  update_available?: boolean
  latest_version?: string
  latest_commit?: string
}

const DISMISS_KEY_PREFIX = 'netvault-update-dismissed-'

export default function UpdateNotifier() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/system/update-status')
        const data: UpdateInfo = await res.json()
        if (cancelled) return
        setInfo(data)
        // Key dismissal on the latest commit so a freshly pushed patch (no
        // version bump) re-shows the banner instead of staying dismissed.
        const key = data.latest_commit || data.latest_version
        if (data.update_available && key) {
          try {
            setDismissed(!!sessionStorage.getItem(DISMISS_KEY_PREFIX + key))
          } catch {
            setDismissed(false)
          }
        }
      } catch {
        if (!cancelled) setInfo(null)
      }
    }
    check()
    const interval = setInterval(check, 6 * 60 * 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleDismiss = () => {
    const key = info?.latest_commit || info?.latest_version
    if (key) {
      try { sessionStorage.setItem(DISMISS_KEY_PREFIX + key, '1') } catch {}
    }
    setDismissed(true)
  }

  if (!info || !info.update_available || dismissed) return null

  return (
    <div style={{
      background: '#1d4ed8',
      color: '#fff',
      padding: '8px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      fontSize: 13,
      flexShrink: 0,
      zIndex: 90,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🔄</span>
        <span>{info.latest_version ? `NetVault v${info.latest_version} is available` : 'A NetVault update is available'}</span>
        <span style={{ opacity: 0.7 }}>→</span>
        <Link
          href="/settings?tab=updates"
          style={{ color: '#fff', textDecoration: 'underline', whiteSpace: 'nowrap' }}
        >
          Go to Settings
        </Link>
      </div>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        style={{
          background: 'transparent',
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
          padding: 0,
          marginLeft: 16,
        }}
      >
        ×
      </button>
    </div>
  )
}
