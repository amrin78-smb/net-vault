'use client'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Icon } from '@/components/system/icons'
import GlobalSearch from '@/components/GlobalSearch'

/**
 * Header search trigger.
 *
 * The header previously carried its own dumb input whose only behaviour was
 * to push `/devices?search=<q>` on Enter — so a search for a site or a
 * circuit landed on the device list filtered by a string it did not match.
 * Meanwhile `components/GlobalSearch.tsx`, which does debounced grouped
 * search across devices, sites and circuits with arrow-key navigation, was
 * fully built and imported by nothing.
 *
 * This mounts that real component and adds the command-palette affordances:
 * Ctrl+K / Cmd+K from anywhere, and `/` as the existing shortcut. Escape and
 * result navigation are GlobalSearch's own.
 */
const subscribeNever = () => () => {}
// navigator.platform is deprecated but remains the most reliable signal in
// every browser this app supports, and it only picks which label to show.
const getIsMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export default function HeaderSearch() {
  const wrapRef = useRef<HTMLDivElement>(null)
  // Read through useSyncExternalStore rather than setting state in an effect:
  // the value is client-only, so the server snapshot is `false` (Ctrl) and the
  // client corrects it during hydration without a second render pass.
  const mac = useSyncExternalStore(subscribeNever, getIsMac, () => false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        wrapRef.current?.querySelector('input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, maxWidth: 520, minWidth: 0 }}>
      <GlobalSearch />
      <span aria-hidden className="kbd-hint" style={{
        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
        padding: '2px 7px', borderRadius: 'var(--radius-sm)',
        background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)',
        fontSize: 'var(--text-xs)', fontWeight: 600, lineHeight: 1.6,
        pointerEvents: 'none', letterSpacing: '0.02em',
      }}>
        {mac ? '⌘K' : 'Ctrl K'}
      </span>
      <style>{`@media (max-width: 720px) { .kbd-hint { display: none } }`}</style>
    </div>
  )
}

export function SearchIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label="Search">
      <Icon.search size={18} />
    </button>
  )
}
