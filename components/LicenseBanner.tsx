'use client'

import { useEffect, useState } from 'react'

// Standardized NocVault-suite license banner for NetVault. Mirrors DDIVault's
// LicenseBanner (frontend/src/components/LicenseGuard.tsx) in colors, text,
// layout and behavior. NetVault IS the license source, so this reads NetVault's
// own GET /api/license (backed by lib/license.ts + app_settings) rather than a
// remote hub. It is display-only and does NOT gate/enforce anything — the read-
// only enforcement (data-readonly body flag, write-route guards) is unchanged.
//
// NetVault status → banner mode:
//   trial    → trial     (#1d4ed8)
//   grace    → grace      (#b45309)   trial expired, within 7-day grace
//   expired  → disabled   (#b91c1c)   past grace — read-only
//   active   → active     (only banners when ≤30 days remain → "expiring" #92400e)
//   (fetch failure) → unreachable (#374151)

type LicenseInfo = {
  status: string
  daysRemaining: number
  customer: string | null
  expiry: string | null
}

type Mode = 'trial' | 'active' | 'grace' | 'disabled' | 'unreachable' | 'unknown'

export default function LicenseBanner() {
  const [license, setLicense] = useState<LicenseInfo | null>(null)
  const [mode, setMode] = useState<Mode>('unknown')

  useEffect(() => {
    let cancelled = false
    const check = () => {
      fetch('/api/license')
        .then(r => r.json())
        .then(d => {
          if (cancelled) return
          if (!d || d.error) { setMode('unreachable'); return }
          setLicense(d as LicenseInfo)
          const s = String(d.status)
          // Map NetVault's status vocabulary onto the suite-standard banner modes.
          setMode(s === 'expired' ? 'disabled' : (s as Mode))
        })
        .catch(() => { if (!cancelled) setMode('unreachable') })
    }
    check()
    // Re-check every 5 min, matching all three satellites (their LicenseGuard.tsx
    // providers use the same interval, tied to the backend's licence cache TTL).
    // This used to fetch ONCE on mount: because the banner lives in the (app)
    // layout, a client-side route change does not remount it, so a NetVault tab
    // left open kept showing whatever day count it read at page load — the count
    // could sit stale for days, and a licence that expired or was renewed mid-
    // session would not surface until a full reload. The satellites never had
    // that problem; the hub was the odd one out.
    const interval = setInterval(check, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  if (!license || mode === 'active') {
    // still allow the "expiring soon" warning for active licenses below
    if (!license || (mode === 'active' && license.daysRemaining > 30)) return null
  }

  const days = license.daysRemaining
  const plural = (n: number) => (n !== 1 ? 's' : '')

  const banners: Record<string, { bg: string; message: string }> = {
    trial: {
      bg: '#1d4ed8',
      message: `Trial license — ${days} day${plural(days)} remaining. Activate a full license to continue using NetVault.`,
    },
    grace: {
      bg: '#b45309',
      message: `License expired — ${Math.abs(days)} day${plural(Math.abs(days))} into grace period. Write operations disabled. Renew now to restore full access.`,
    },
    disabled: {
      bg: '#b91c1c',
      message: 'NetVault license has expired and the grace period has ended. Please renew your NocVault license to restore access.',
    },
    unreachable: {
      bg: '#374151',
      message: 'License status unavailable — unable to read the current license state.',
    },
  }
  if (mode === 'active' && days <= 30) {
    banners.expiring = {
      bg: '#92400e',
      message: `License expires in ${days} day${plural(days)}. Renew now to avoid service interruption.`,
    }
  }

  const banner = banners[mode] || (mode === 'active' && days <= 30 ? banners.expiring : null)
  if (!banner) return null

  return (
    <div style={{
      background: banner.bg, color: '#fff',
      padding: '10px 20px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', fontSize: 'var(--text-base)', fontWeight: 500,
      flexShrink: 0, zIndex: 100,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>⚠️</span>
        <span>{banner.message}</span>
        {license.customer && (
          <span style={{ opacity: 0.7, marginLeft: 8 }}>· Licensed to: {license.customer}</span>
        )}
      </div>
      <a
        href="/settings/license"
        style={{ color: '#fff', textDecoration: 'underline', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap', marginLeft: 16 }}
      >
        Manage License →
      </a>
    </div>
  )
}
