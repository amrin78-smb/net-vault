'use client'
import { useEffect, useState } from 'react'
import { getCorners, applyCorners, type Corners } from '@/lib/corners'

function CornersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }} aria-hidden="true">
      <path d="M4 9V6a2 2 0 012-2h3" /><path d="M15 4h3a2 2 0 012 2v3" />
      <path d="M20 15v3a2 2 0 01-2 2h-3" /><path d="M9 20H6a2 2 0 01-2-2v-3" />
    </svg>
  )
}

function RoundedIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}
function SquareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

/**
 * One segment of the corner-style control. Declared at MODULE TOP LEVEL, never
 * nested inside CornersToggle — a component defined during render is a new type
 * on every render, so React unmounts/remounts it (losing focus and state).
 *
 * Styled with CARD tokens, not the alpha-white-over-navy treatment this control
 * used when it lived in the navy top bar — it now sits on the avatar dropdown
 * panel (a --bg-card surface), where white-on-navy would be invisible.
 */
function Segment({
  label, icon, active, onSelect,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={`${label} corners`}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '5px 9px',
        border: 'none',
        background: active ? 'var(--bg-card)' : 'transparent',
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.10)' : 'none',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 500, fontFamily: 'inherit',
        cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1.2,
        transition: 'background 0.1s, color 0.1s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-primary)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-muted)' }}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * Suite-standard rounded/square corner switcher — rendered as a ROW inside the
 * user avatar dropdown menu (see app/(app)/layout.tsx), matching the padding,
 * font size and hover behaviour of the other menu items. Deliberately NOT
 * admin-gated and deliberately NOT on /settings (that page redirects non-admins
 * away), so every user can reach it.
 *
 * The current value is read in an effect, NEVER at render time: the source of
 * truth is the data-corners attribute stamped on <html> by the no-flash script
 * in app/layout.tsx, which does not exist during the server render. Reading it
 * at render would produce a hydration mismatch for anyone who picked "square".
 */
export default function CornersToggle() {
  const [corners, setCorners] = useState<Corners>('rounded')

  useEffect(() => {
    setCorners(getCorners())
    const onCorners = (e: Event) => setCorners((e as CustomEvent).detail as Corners)
    window.addEventListener('netvault:corners', onCorners)
    return () => window.removeEventListener('netvault:corners', onCorners)
  }, [])

  function select(next: Corners) {
    applyCorners(next)
    setCorners(next)
  }

  return (
    <div
      role="group"
      aria-label="Corner style"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '8px 16px', width: '100%', boxSizing: 'border-box',
      }}
    >
      <span style={{
        display: 'flex', alignItems: 'center', gap: 10,
        color: 'var(--text-secondary)', fontSize: 'var(--text-base)', fontWeight: 500,
        whiteSpace: 'nowrap',
      }}>
        <CornersIcon />
        Corners
      </span>

      <div style={{
        display: 'inline-flex', alignItems: 'stretch', flexShrink: 0,
        background: 'var(--surface-subtle)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
      }}>
        <Segment
          label="Rounded"
          icon={<RoundedIcon />}
          active={corners === 'rounded'}
          onSelect={() => select('rounded')}
        />
        <div style={{ width: 1, background: 'var(--border)' }} />
        <Segment
          label="Square"
          icon={<SquareIcon />}
          active={corners === 'square'}
          onSelect={() => select('square')}
        />
      </div>
    </div>
  )
}
