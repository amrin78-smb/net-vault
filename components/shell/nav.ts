import type { IconName } from '@/components/system/icons'

export type Role = 'super_admin' | 'admin' | 'site_admin' | 'viewer' | string | undefined

export type NavItem = {
  href: string
  label: string
  icon: IconName
  /** Suite-standard nav chip tint: [icon colour, chip background]. */
  tint: [string, string]
  /** Matched against `?tab=` so a Settings deep-link highlights the right row. */
  tab?: string
  adminOnly?: boolean
  superAdminOnly?: boolean
  hideForSiteAdmin?: boolean
  /** Marks a link that leaves NetVault for the suite shell. */
  suite?: boolean
}

export type NavGroup = { label: string; items: NavItem[] }

/**
 * Grouped, role-aware navigation.
 *
 * The role flags are carried over VERBATIM from the previous flat list and are
 * load-bearing, not cosmetic:
 *
 *  - `hideForSiteAdmin` on Dashboard and EOL/Risk — a site_admin's view of
 *    those pages is fleet-wide and contradicts their site scope.
 *  - `superAdminOnly` on EOL Intelligence — it is a separately licensed add-on
 *    with its own entitlement gate. It stays VISIBLE to a super_admin on an
 *    unlicensed install (the page itself shows the locked upsell), because
 *    hiding it would make a paid feature invisible to the only person who
 *    could buy it.
 *  - `adminOnly` on Audit, Compliance, Users and Licensing.
 *  - Settings has NO gate. It is the only route to a user's own two-factor
 *    setup, and gating it would lock out every member of a role that has
 *    `mfa_required_roles` set but no factor enrolled yet.
 *
 * Users & Access and Subscription & Licensing point at the Settings tabs
 * rather than at new routes: `/settings?tab=users` and `?tab=license` are the
 * existing supported deep links (`/settings/license` redirects to the latter),
 * and `/users` is an orphaned route nothing links to. Giving either its own
 * nav entry as well would be the duplicate label the design brief rules out.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/launcher',  label: 'Suite Home',        icon: 'home', tint: ['#fda4af', 'rgba(200,16,46,0.25)'], suite: true },
      { href: '/dashboard', label: 'NetVault Dashboard', icon: 'dashboard', tint: ['#f87171', 'rgba(200,16,46,0.25)'], hideForSiteAdmin: true },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/sites',    label: 'Sites',    icon: 'site', tint: ['#34d399', 'rgba(29,158,117,0.25)'] },
      { href: '/devices',  label: 'Devices',  icon: 'device', tint: ['#60a5fa', 'rgba(55,138,221,0.25)'] },
      { href: '/circuits', label: 'Circuits', icon: 'circuit', tint: ['#a78bfa', 'rgba(127,119,221,0.25)'] },
    ],
  },
  {
    label: 'Lifecycle & Assurance',
    items: [
      { href: '/eol',              label: 'EOL / Risk',       icon: 'risk', tint: ['#fbbf24', 'rgba(186,117,23,0.25)'], hideForSiteAdmin: true },
      { href: '/eol-intelligence', label: 'EOL Intelligence', icon: 'intelligence', tint: ['#c084fc', 'rgba(147,86,220,0.25)'], superAdminOnly: true },
      { href: '/compliance',       label: 'Compliance',       icon: 'compliance', tint: ['#06b6d4', 'rgba(6,182,212,0.2)'], adminOnly: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/agents', label: 'Agents',    icon: 'agent', tint: ['#2dd4bf', 'rgba(13,148,136,0.25)'], superAdminOnly: true },
      { href: '/audit',  label: 'Audit Log', icon: 'audit', tint: ['#f472b6', 'rgba(212,83,126,0.25)'], adminOnly: true },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/settings?tab=users',   label: 'Users & Access',          icon: 'users', tint: ['#38bdf8', 'rgba(56,189,248,0.2)'],    tab: 'users',   adminOnly: true },
      { href: '/settings?tab=license', label: 'Subscription & Licensing', icon: 'license', tint: ['#fcd34d', 'rgba(217,119,6,0.25)'], tab: 'license', adminOnly: true },
      { href: '/settings?tab=general', label: 'System Settings',          icon: 'settings', tint: ['#9ca3af', 'rgba(136,135,128,0.25)'], tab: 'general' },
    ],
  },
]

export function canSee(item: NavItem, role: Role): boolean {
  if (item.adminOnly && role !== 'admin' && role !== 'super_admin') return false
  if (item.superAdminOnly && role !== 'super_admin') return false
  if (item.hideForSiteAdmin && role === 'site_admin') return false
  return true
}

export function visibleGroups(role: Role): NavGroup[] {
  return NAV_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => canSee(i, role)) }))
    .filter(g => g.items.length > 0)
}

/**
 * Which nav row is the current page?
 *
 * Settings rows are distinguished by `?tab=`, so a plain pathname comparison
 * would light up all three Administration rows at once. A non-admin lands on
 * the Security tab, which has no nav row of its own — `System Settings` is
 * the honest parent for it, so it is treated as the fallback for any Settings
 * tab that is not one of the named rows.
 */
export function isCurrent(item: NavItem, pathname: string, tab: string | null): boolean {
  if (item.href.startsWith('/settings')) {
    if (!pathname.startsWith('/settings')) return false
    const named = ['users', 'license', 'general']
    if (!tab) return item.tab === 'general'
    return tab === item.tab || (!named.includes(tab) && item.tab === 'general')
  }
  if (pathname.startsWith('/settings')) return false
  if (item.href === '/dashboard' || item.href === '/launcher') return pathname === item.href
  return pathname === item.href || pathname.startsWith(item.href + '/')
}
