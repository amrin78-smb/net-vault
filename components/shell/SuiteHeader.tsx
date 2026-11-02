'use client'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { Icon } from '@/components/system/icons'
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from '@/components/system/Menu'
import ThemeToggle from '@/components/ThemeToggle'
import CornersToggle from '@/components/CornersToggle'
import HeaderSearch from './HeaderSearch'
import HelpMenu from './HelpMenu'

export type SuiteApp = { name: string; slug: string; subtitle: string; href: string; color: string }

/**
 * The four suite applications.
 *
 * `href` is the REAL launch path used by the launcher: an SSO handoff route
 * for the three sibling apps, and an in-app route for NetVault itself. These
 * are not new endpoints.
 */
export const SUITE_APPS: SuiteApp[] = [
  { name: 'NetVault',  slug: 'netvault',  subtitle: 'Network Asset Management', href: '/dashboard',          color: '#C8102E' },
  { name: 'LogVault',  slug: 'logvault',  subtitle: 'Syslog & Log Analysis',    href: '/api/sso/logvault',   color: '#2563eb' },
  { name: 'DDIVault',  slug: 'ddivault',  subtitle: 'DNS, DHCP & IPAM',         href: '/api/sso/ddivault',   color: '#d97706' },
  { name: 'SpanVault', slug: 'spanvault', subtitle: 'Network Monitoring',       href: '/api/sso/spanvault',  color: '#16a34a' },
]

/**
 * Per-user application access, mirroring the launcher exactly: NetVault is
 * always reachable, and an absent or empty `apps` list means "all apps"
 * (legacy accounts and super_admins). This is entitlement only — it is NOT a
 * licence or availability check, so the switcher must not imply either.
 */
export function canAccessApp(slug: string, apps: string[] | undefined): boolean {
  return slug === 'netvault' || !apps || apps.length === 0 || apps.includes(slug)
}

export default function SuiteHeader({
  productName, productSubtitle, userName, userRole, userApps, version,
  onToggleSidebar, onChangePassword, sidebarTriggerRef, collapsed, onToggleCollapsed,
}: {
  productName: string
  productSubtitle: string
  userName: string
  userRole?: string
  userApps?: string[]
  version?: string | null
  onToggleSidebar: () => void
  onChangePassword: () => void
  sidebarTriggerRef?: React.RefObject<HTMLButtonElement | null>
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const initial = userName?.charAt(0)?.toUpperCase() || 'U'
  const roleLabel = (userRole || '').replace(/_/g, ' ')

  return (
    <header className="suite-header">
      {/* Mobile nav trigger */}
      <button
        ref={sidebarTriggerRef}
        type="button"
        className="icon-btn mobile-only"
        onClick={onToggleSidebar}
        aria-label="Open navigation menu"
      >
        <Icon.menu size={20} />
      </button>

      {/* Desktop collapse toggle */}
      <button
        type="button"
        className="icon-btn desktop-only"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={collapsed}
      >
        <Icon.menu size={20} />
      </button>

      {/* Suite brand + current product */}
      <Link href="/launcher" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flexShrink: 0 }}>
        <img src="/nocvault-logo.svg" alt="NocVault" height={30} style={{ display: 'block' }} />
      </Link>

      <span aria-hidden className="product-divider" style={{
        width: 1, height: 26, background: 'rgba(255,255,255,0.18)', flexShrink: 0, margin: '0 2px',
      }} />

      <div className="product-identity" style={{ minWidth: 0, flexShrink: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: '#fff', letterSpacing: '0.01em', lineHeight: 1.2 }}>
          {productName}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.5)', letterSpacing: '0.07em', textTransform: 'uppercase', lineHeight: 1.3 }}>
          {productSubtitle}
        </div>
      </div>

      {/* App switcher */}
      <DropdownMenu
        label="Switch application"
        align="left"
        trigger={({ toggle, open, ref }) => (
          <button ref={ref} type="button" className="icon-btn" onClick={toggle}
            aria-label="Switch application" aria-haspopup="menu" aria-expanded={open}>
            <Icon.grid size={18} />
          </button>
        )}
      >
        <MenuLabel>NocVault suite</MenuLabel>
        {SUITE_APPS.map(app => {
          const allowed = canAccessApp(app.slug, userApps)
          const isCurrentApp = app.slug === 'netvault'
          return (
            <MenuItem
              key={app.slug}
              href={allowed ? app.href : undefined}
              disabled={!allowed}
              icon={<span aria-hidden style={{
                width: 9, height: 9, borderRadius: 2, background: app.color,
                flexShrink: 0, opacity: allowed ? 1 : 0.4,
              }} />}
            >
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: isCurrentApp ? 700 : 500 }}>{app.name}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {allowed ? app.subtitle : 'No access'}
                </span>
              </span>
              {isCurrentApp && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Current</span>}
            </MenuItem>
          )
        })}
        <MenuSeparator />
        <MenuItem href="/launcher" icon={<Icon.home size={15} />}>Suite Home</MenuItem>
      </DropdownMenu>

      <HeaderSearch />

      <div style={{ flex: 1 }} />

      <ThemeToggle />
      <HelpMenu version={version} />

      {/* Account menu */}
      <DropdownMenu
        label="Account"
        trigger={({ toggle, open, ref }) => (
          <button ref={ref} type="button" onClick={toggle}
            aria-haspopup="menu" aria-expanded={open}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: open ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 'var(--radius-sm)', padding: '5px 10px 5px 5px',
              cursor: 'pointer', color: '#fff', fontFamily: 'inherit',
            }}>
            {/* intentional: 50% — a true circular avatar, never squared */}
            <span aria-hidden style={{
              width: 34, height: 34, borderRadius: '50%', background: 'var(--primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--text-base)', fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>{initial}</span>
            <span className="account-name" style={{ textAlign: 'left', lineHeight: 1.25 }}>
              <span style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 600 }}>{userName}</span>
              {roleLabel && <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.55)', textTransform: 'capitalize' }}>{roleLabel}</span>}
            </span>
            <span aria-hidden style={{ display: 'flex', opacity: 0.6 }}><Icon.chevronDown size={14} /></span>
          </button>
        )}
      >
        <MenuLabel>Signed in as {userName}</MenuLabel>
        <MenuItem href="/settings?tab=security" icon={<Icon.shield size={15} />}>
          Security &amp; two-factor
        </MenuItem>
        <MenuItem onSelect={onChangePassword} icon={<Icon.key size={15} />}>
          Change password
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Preferences</MenuLabel>
        <div style={{ padding: '2px 10px 8px' }}><CornersToggle /></div>
        <MenuSeparator />
        <MenuItem destructive onSelect={() => signOut({ callbackUrl: '/login' })} icon={<Icon.logout size={15} />}>
          Sign out
        </MenuItem>
      </DropdownMenu>

      <style>{`
        .mobile-only  { display: none; }
        @media (max-width: 860px) {
          .mobile-only  { display: inline-flex; }
          .desktop-only { display: none; }
          .product-identity, .product-divider { display: none; }
        }
        @media (max-width: 620px) { .account-name { display: none; } }
      `}</style>
    </header>
  )
}
