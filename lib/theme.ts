'use client'

/**
 * Dark-mode theme handling for the NocVault suite (NetVault hub).
 * The theme is stored in localStorage and applied as a `data-theme`
 * attribute on <html>; dark tokens live in app/globals.css under
 * [data-theme="dark"]. A no-flash inline script in the root layout
 * (app/layout.tsx) applies the saved theme before paint, so this module
 * only needs to read/toggle at runtime. Default is light.
 */
export type Theme = 'light' | 'dark'

export const THEME_KEY = 'netvault-theme'

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
  else document.documentElement.removeAttribute('data-theme')
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* ignore */ }
  // Let any other mounted toggle (launcher + app header) re-sync its icon.
  window.dispatchEvent(new CustomEvent('netvault:theme', { detail: theme }))
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}

/** Inline <script> body that sets data-theme before first paint (no flash). */
export const THEME_INIT_SCRIPT =
  `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();`
