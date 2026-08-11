'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * /security — kept only as a redirect to Settings → Security / 2FA.
 *
 * This was briefly a page of its own in the sidebar. Two-factor setup belongs
 * with the other settings rather than as a top-level nav item, so the card moved
 * into Settings; this route stays so a bookmark or a link from that window still
 * lands somewhere sensible instead of 404ing.
 *
 * Settings is no longer admin-only precisely because of this move — every role
 * has to be able to reach its own two-factor setup, or requiring MFA for a role
 * locks its members out with no page able to give them a factor.
 */
export default function SecurityRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/settings?tab=security')
  }, [router])
  return (
    <div style={{ padding: '24px 28px', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
      Taking you to Settings → Security / 2FA…
    </div>
  )
}
