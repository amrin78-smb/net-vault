'use client'
import { useState, useSyncExternalStore } from 'react'

export const DENSITY_KEY = 'netvault-density'
export type Density = 'comfortable' | 'compact'

function subscribe(cb: () => void) {
  window.addEventListener('storage', cb)
  return () => window.removeEventListener('storage', cb)
}
function getStored(): Density {
  try { return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable' }
  catch { return 'comfortable' }
}

/**
 * Shared comfortable/compact row-density preference.
 *
 * Read through useSyncExternalStore because localStorage is an external
 * store: the server snapshot is 'comfortable', so the markup matches on
 * hydration and the stored value applies immediately afterwards without a
 * setState-inside-an-effect render cascade.
 *
 * The local override exists because a `storage` event does NOT fire in the
 * tab that performed the write, so the store alone would not re-render the
 * page that just changed the setting.
 */
export function useDensity(): [Density, (d: Density) => void] {
  const stored = useSyncExternalStore(subscribe, getStored, () => 'comfortable' as const)
  const [override, setOverride] = useState<Density | null>(null)
  const density = override ?? stored
  const set = (d: Density) => {
    try { localStorage.setItem(DENSITY_KEY, d) } catch { /* private window */ }
    setOverride(d)
  }
  return [density, set]
}
