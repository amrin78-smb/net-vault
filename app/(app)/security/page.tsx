'use client'

import MfaCard from '../settings/MfaCard'

/**
 * /security — the signed-in user's own account security (currently two-factor).
 *
 * Deliberately its OWN route rather than only a Settings tab: /settings
 * redirects any non-admin to /dashboard and its nav entry is adminOnly, so a
 * viewer or site_admin could never have reached the enrolment card there.
 *
 * That is not a cosmetic gap. Two-factor is not an administrative privilege —
 * and once mfa_required_roles names a role, a member of it who cannot self-enrol
 * is permanently locked out: the login refuses them for having no factor, and
 * the only page that could give them one is closed to their role. Every
 * authenticated user must be able to reach this.
 */
export default function SecurityPage() {
  return (
    <div style={{ padding: '24px 28px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 4px' }}>Security</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 20px' }}>
        Settings that protect your own account.
      </p>
      <MfaCard />
    </div>
  )
}
