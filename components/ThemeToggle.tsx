'use client'
import { useEffect, useState } from 'react'
import { getTheme, toggleTheme, type Theme } from '@/lib/theme'

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="0.5" x2="8" y2="2.2" /><line x1="8" y1="13.8" x2="8" y2="15.5" />
        <line x1="0.5" y1="8" x2="2.2" y2="8" /><line x1="13.8" y1="8" x2="15.5" y2="8" />
        <line x1="2.7" y1="2.7" x2="3.9" y2="3.9" /><line x1="12.1" y1="12.1" x2="13.3" y2="13.3" />
        <line x1="2.7" y1="13.3" x2="3.9" y2="12.1" /><line x1="12.1" y1="3.9" x2="13.3" y2="2.7" />
      </g>
    </svg>
  )
}
function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 8.7A5.8 5.8 0 1 1 7.3 2.5a4.6 4.6 0 0 0 6.2 6.2z" fill="currentColor" />
    </svg>
  )
}

/**
 * Suite-standard sun/moon theme switcher. Lives in the navy top bar of the
 * launcher and the app header, so it uses the navy-bar ghost-button style
 * (38×38, radius 8) and white-on-navy icon coloring rather than the page
 * token colors. Theme persistence + data-theme live in @/lib/theme.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    setTheme(getTheme())
    const onTheme = (e: Event) => setTheme((e as CustomEvent).detail as Theme)
    window.addEventListener('netvault:theme', onTheme)
    return () => window.removeEventListener('netvault:theme', onTheme)
  }, [])

  return (
    <button
      onClick={() => setTheme(toggleTheme())}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 38, height: 38, borderRadius: 8,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: 'rgba(255,255,255,0.85)', cursor: 'pointer', flexShrink: 0,
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.14)'; (e.currentTarget as HTMLElement).style.color = '#fff' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.85)' }}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
