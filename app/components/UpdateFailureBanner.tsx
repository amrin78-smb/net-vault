'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

interface UpdateStatus {
  exists?: boolean
  success?: boolean
  stage?: string | null
  errorCode?: number
  errorMessage?: string | null
  rolledBack?: boolean
  healthCheckPassed?: boolean
  schemaWarning?: string | null
  timestamp?: string
}

const DISMISS_KEY_PREFIX = 'netvault-update-failure-dismissed-'

const STAGE_LABELS: Record<string, string> = {
  init: 'startup',
  'pre-flight': 'pre-flight snapshot',
  'git-pull': 'pulling code from GitHub',
  'npm-install': 'installing dependencies',
  'npm-build': 'building the app',
  'static-copy': 'copying build output',
  'service-start': 'starting the service',
  'health-check': 'health check after starting',
}

export default function UpdateFailureBanner() {
  const [info, setInfo] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/system/last-update-status')
        const data: UpdateStatus = await res.json()
        if (cancelled) return
        setInfo(data)
        const key = data.timestamp
        const worthShowing = data.exists && (data.success === false || !!data.schemaWarning)
        if (worthShowing && key) {
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
    const interval = setInterval(check, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleDismiss = () => {
    if (info?.timestamp) {
      try { sessionStorage.setItem(DISMISS_KEY_PREFIX + info.timestamp, '1') } catch {}
    }
    setDismissed(true)
  }

  // Also surface a non-fatal schema-apply warning on an otherwise-successful
  // update - lower severity (amber, not red), but still needs a human to check.
  if (!info || !info.exists || dismissed) return null
  if (info.success === false) {
    const stageLabel = info.stage ? (STAGE_LABELS[info.stage] || info.stage) : 'the update'
    return (
      <div style={{
        background: '#b91c1c',
        color: '#fff',
        padding: '10px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        fontSize: 13,
        flexShrink: 0,
        zIndex: 91,
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>⚠</span>
          {info.rolledBack ? (
            <span>
              <strong>An update failed</strong> at {stageLabel} and was automatically rolled back — NetVault is
              running normally on the previous version, but this needs to be fixed
              {info.errorCode ? ` (error code ${info.errorCode})` : ''}.
            </span>
          ) : (
            <span>
              <strong>An update failed</strong> at {stageLabel} and the automatic rollback also failed — NetVault may be
              DOWN or unstable. Manual intervention required
              {info.errorCode ? ` (error code ${info.errorCode})` : ''}.
            </span>
          )}
          {info.errorMessage && (
            <span style={{ opacity: 0.85, fontFamily: 'var(--font-mono)', fontSize: 12 }}>— {info.errorMessage}</span>
          )}
          <span style={{ opacity: 0.7 }}>→</span>
          <Link href="/settings?tab=updates" style={{ color: '#fff', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
            View details
          </Link>
        </div>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          style={{ background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}
        >
          ×
        </button>
      </div>
    )
  }

  if (info.schemaWarning) {
    return (
      <div style={{
        background: '#b45309',
        color: '#fff',
        padding: '8px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        fontSize: 13,
        flexShrink: 0,
        zIndex: 91,
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>⚠</span>
          <span>The last update succeeded, but a database schema step failed and needs to be checked: {info.schemaWarning}</span>
        </div>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          style={{ background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}
        >
          ×
        </button>
      </div>
    )
  }

  return null
}
