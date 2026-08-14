'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /settings/eol-intelligence — kept only as a redirect to /eol-intelligence.
 *
 * EOL Intelligence used to live under Settings. It is a separately licensed
 * add-on (the 'eol' module) with its own entitlement check, not a preference,
 * so it now has its own top-level nav item and this route only survives so an
 * existing bookmark or an old link lands somewhere sensible instead of 404ing.
 *
 * Same shape as /security, which redirects the other way after two-factor setup
 * moved INTO Settings.
 */
export default function EolIntelligenceRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/eol-intelligence')
  }, [router])
  return (
    <div style={{ padding: '24px 28px', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
      Taking you to EOL Intelligence…
    </div>
  )
}
