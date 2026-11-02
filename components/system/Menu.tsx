'use client'
import { useEffect, useRef, useState, useId } from 'react'

/**
 * Dropdown menu with roving keyboard focus.
 *
 * Closes on Escape, on outside pointer-down, and after an item is chosen,
 * and returns focus to the trigger so keyboard users are not dropped at the
 * top of the document.
 */
export function DropdownMenu({ trigger, children, align = 'right', label }: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => React.ReactNode
  children: React.ReactNode
  align?: 'left' | 'right'
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'ArrowDown'
        ? (i < 0 ? 0 : Math.min(i + 1, items.length - 1))
        : (i < 0 ? items.length - 1 : Math.max(i - 1, 0))
      items[next]?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {trigger({ open, toggle: () => setOpen(o => !o), ref: triggerRef })}
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          id={id}
          className="menu-panel"
          style={align === 'left' ? { right: 'auto', left: 0 } : undefined}
          onClick={e => {
            // Any activated item closes the menu, matching platform behaviour.
            if ((e.target as HTMLElement).closest('[role="menuitem"]')) setOpen(false)
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ children, onSelect, href, destructive, icon, disabled }: {
  children: React.ReactNode
  onSelect?: () => void
  href?: string
  destructive?: boolean
  icon?: React.ReactNode
  disabled?: boolean
}) {
  const common = {
    role: 'menuitem' as const,
    className: 'menu-item',
    'data-destructive': destructive ? 'true' : undefined,
    tabIndex: -1,
  }
  if (href && !disabled) {
    return <a {...common} href={href}>{icon}{children}</a>
  }
  return (
    <button {...common} type="button" disabled={disabled} onClick={onSelect}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      {icon}{children}
    </button>
  )
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="menu-label">{children}</div>
}
export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />
}
