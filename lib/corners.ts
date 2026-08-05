'use client'

/**
 * Corner-style handling for the NocVault suite (NetVault hub) — the square/
 * rounded twin of @/lib/theme. The choice is stored in localStorage and applied
 * as a `data-corners` attribute on <html>; the square token overrides live in
 * app/globals.css under :root[data-corners="square"]. A no-flash inline script
 * in the root layout (app/layout.tsx) applies the saved style before paint, so
 * this module only needs to read/toggle at runtime. Default is rounded.
 *
 * Rounded is the ABSENCE of the attribute — there is no data-corners="rounded"
 * selector to keep in sync, so `applyCorners('rounded')` REMOVES the attribute
 * rather than setting it.
 */
export type Corners = 'rounded' | 'square'

export const CORNERS_KEY = 'netvault-corners'

export function getCorners(): Corners {
  if (typeof document === 'undefined') return 'rounded'
  return document.documentElement.getAttribute('data-corners') === 'square' ? 'square' : 'rounded'
}

export function applyCorners(corners: Corners) {
  if (typeof document === 'undefined') return
  if (corners === 'square') document.documentElement.setAttribute('data-corners', 'square')
  else document.documentElement.removeAttribute('data-corners')
  try { localStorage.setItem(CORNERS_KEY, corners) } catch { /* ignore */ }
  // Let any other mounted toggle (launcher + app header) re-sync its state.
  window.dispatchEvent(new CustomEvent('netvault:corners', { detail: corners }))
}

export function toggleCorners(): Corners {
  const next: Corners = getCorners() === 'square' ? 'rounded' : 'square'
  applyCorners(next)
  return next
}

/** Inline <script> body that sets data-corners before first paint (no flash). */
export const CORNERS_INIT_SCRIPT =
  `(function(){try{var c=localStorage.getItem('${CORNERS_KEY}');if(c==='square'){document.documentElement.setAttribute('data-corners','square');}}catch(e){}})();`
