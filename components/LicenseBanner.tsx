'use client'

import { useEffect, useState } from 'react'
import { Icon } from '@/components/system/icons'

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

  // State / impact / action, per the suite banner contract.
  //
  // The background colours stay as they are: they are the NocVault
  // suite-standard licence palette and the three satellites use the same
  // values, so tokenising them here would make NetVault the odd one out.
  // What changed is the content - an emoji and one run-on sentence became an
  // icon, a stated STATE, the concrete IMPACT, and a single next action.
  const banners: Record<string, { bg: string; state: string; impact: string }> = {
    trial: {
      bg: '#1d4ed8',
      state: `Trial licence \u2014 ${days} day${plural(days)} remaining`,
      impact: 'Everything works until the trial ends. Activate a full licence to keep using NetVault.',
    },
    grace: {
      bg: '#b45309',
      state: `Licence expired \u2014 ${Math.abs(days)} day${plural(Math.abs(days))} into the grace period`,
      impact: 'Saving, editing and deleting are already disabled. Renew to restore them.',
    },
    disabled: {
      bg: '#b91c1c',
      state: 'Licence expired and the grace period has ended',
      impact: 'NetVault is read-only: you can still view everything, but nothing can be changed until a licence is activated.',
    },
    unreachable: {
      bg: '#374151',
      state: 'Licence status unavailable',
      impact: 'The current licence state could not be read, so this install may be running under restrictions.',
    },
  }
  if (mode === 'active' && days <= 30) {
    banners.expiring = {
      bg: '#92400e',
      state: `Licence expires in ${days} day${plural(days)}`,
      impact: 'Renew before it lapses to avoid NetVault dropping into read-only.',
    }
  }

  const banner = banners[mode] || (mode === 'active' && days <= 30 ? banners.expiring : null)
  if (!banner) return null

  return (
    <div
      role={mode === 'disabled' || mode === 'grace' ? 'alert' : 'status'}
      style={{
        background: banner.bg, color: '#fff',
        padding: '10px 20px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        fontSize: 'var(--text-base)', flexShrink: 0, zIndex: 100,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
        <span aria-hidden style={{ display: 'flex', flexShrink: 0, marginTop: 1 }}>
          {mode === 'unreachable' ? <Icon.info size={17} /> : <Icon.alert size={17} />}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 600 }}>
            {banner.state}
            {license.customer && (
              <span style={{ opacity: 0.75, fontWeight: 400 }}> · Licensed to {license.customer}</span>
            )}
          </span>
          <span style={{ display: 'block', opacity: 0.9, fontSize: 'var(--text-sm)', marginTop: 1 }}>
            {banner.impact}
          </span>
        </span>
      </div>
      <a
        href="/settings/license"
        style={{
          color: '#fff', textDecoration: 'none', fontSize: 'var(--text-sm)', fontWeight: 600,
          whiteSpace: 'nowrap', flexShrink: 0,
          border: '1px solid rgba(255,255,255,0.45)', borderRadius: 'var(--radius-sm)',
          padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        {mode === 'trial' || banner === banners.expiring ? 'Activate a licence' : 'Manage licence'}
        <Icon.chevronRight size={13} />
      </a>
    </div>
  )
}
