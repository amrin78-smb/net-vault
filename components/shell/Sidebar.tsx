'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { Icon } from '@/components/system/icons'
import { visibleGroups, isCurrent, type Role } from './nav'

const FOCUSABLE = 'a[href],button:not([disabled])'

export default function Sidebar({
  role, collapsed, mobileOpen, onCloseMobile, triggerRef,
}: {
  role: Role
  collapsed: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
  triggerRef?: React.RefObject<HTMLButtonElement | null>
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tab = searchParams.get('tab')
  const groups = visibleGroups(role)
  const navRef = useRef<HTMLElement>(null)

  /**
   * As a mobile drawer this is a modal surface, so it takes the same
   * treatment as a dialog: focus moves in, Tab is trapped, Escape closes,
   * and focus returns to the hamburger that opened it. On desktop it is
   * ordinary page furniture and none of this applies.
   */
  useEffect(() => {
    if (!mobileOpen) return
    const nav = navRef.current
    const raf = requestAnimationFrame(() => nav?.querySelector<HTMLElement>(FOCUSABLE)?.focus())

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCloseMobile(); triggerRef?.current?.focus(); return }
      if (e.key !== 'Tab' || !nav) return
      const items = Array.from(nav.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
    }
  }, [mobileOpen, onCloseMobile, triggerRef])

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} aria-hidden />}
      <nav
        ref={navRef}
        className="app-sidebar"
        data-collapsed={collapsed ? 'true' : 'false'}
        data-open={mobileOpen ? 'true' : 'false'}
        aria-label={mobileOpen ? 'Navigation menu' : 'Main'}
        {...(mobileOpen ? { role: 'dialog', 'aria-modal': true } : {})}
      >
        <div className="sidebar-mobile-close">
          <button type="button" className="icon-btn" onClick={onCloseMobile}
            aria-label="Close navigation" style={{ color: 'rgba(255,255,255,0.7)' }}>
            <Icon.close size={18} />
          </button>
        </div>

        <div style={{ flex: 1, padding: '0 8px 12px' }}>
          {groups.map(group => (
            <div key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              <ul style={{ listStyle: 'none' }}>
                {group.items.map(item => {
                  const current = isCurrent(item, pathname, tab)
                  const I = Icon[item.icon]
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="nav-link"
                        aria-current={current ? 'page' : undefined}
                        title={collapsed ? item.label : undefined}
                        onClick={onCloseMobile}
                      >
                        {/* Suite-standard nav chip: 28x28, radius 8, per-route
                            tint, and ONLY the active row is coloured - the same
                            treatment the other three NocVault apps use. */}
                        <span aria-hidden className="nav-chip" style={{
                          background: current ? item.tint[1] : 'transparent',
                          color: current ? item.tint[0] : 'rgba(255,255,255,0.55)',
                        }}>
                          <I size={16} />
                        </span>
                        <span className="nav-label" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.label}
                        </span>
                        {item.suite && !collapsed && (
                          <span aria-hidden style={{ opacity: 0.45, display: 'flex' }}><Icon.external size={12} /></span>
                        )}
                        {/* The collapsed rail shows icons only, so the label has to
                            survive somewhere for assistive tech and for a keyboard
                            user who cannot hover to see the title tooltip. */}
                        {collapsed && <span className="sr-only">{item.label}</span>}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <style>{`
        .sidebar-mobile-close { display: none; justify-content: flex-end; padding: 10px 10px 0; }
        @media (max-width: 860px) { .sidebar-mobile-close { display: flex; } }
      `}</style>
    </>
  )
}
