'use client'
import { useEffect, useState } from 'react'
import { getCorners, applyCorners, type Corners } from '@/lib/corners'

function RoundedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}
function SquareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

/**
 * One segment of the corner-style control. Declared at MODULE TOP LEVEL, never
 * nested inside CornersToggle — a component defined during render is a new type
 * on every render, so React unmounts/remounts it (losing focus and state).
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
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 12px', height: '100%',
        border: 'none', background: active ? 'var(--navy)' : 'transparent',
        color: active ? 'rgba(255,255,255,0.95)' : 'var(--text-secondary)',
        fontSize: 'var(--text-sm)', fontWeight: 500, fontFamily: 'inherit',
        cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-primary)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-secondary)' }}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * Suite-standard rounded/square corner switcher — a small segmented control
 * that sits beside ThemeToggle in the navy top bar. Deliberately NOT
 * admin-gated and deliberately NOT on /settings (that page redirects
 * non-admins away), so every user can reach it.
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
        display: 'inline-flex', alignItems: 'stretch',
        height: 38, flexShrink: 0,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}
    >
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
  )
}
