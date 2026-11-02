'use client'
import type { Density } from './useDensity'

/** Comfortable / compact switch for a list page. Pairs with useDensity(). */
export function DensityToggle({ density, onChange }: {
  density: Density
  onChange: (d: Density) => void
}) {
  return (
    <div className="segmented" role="group" aria-label="Row density">
      {(['comfortable', 'compact'] as const).map(d => (
        <button key={d} type="button" onClick={() => onChange(d)} aria-pressed={density === d}>
          {d === 'comfortable' ? 'Comfortable' : 'Compact'}
        </button>
      ))}
    </div>
  )
}
