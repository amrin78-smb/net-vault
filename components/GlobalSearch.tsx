'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

type DeviceResult   = { id: string; name: string; device_type: string; ip_address: string; site: string; device_status: string }
type SiteResult     = { id: string; name: string; code: string; country: string; region: string }
type CircuitResult  = { id: string; circuit_id: string; isp: string; usage: string; site: string }
type Results        = { devices: DeviceResult[]; sites: SiteResult[]; circuits: CircuitResult[] }

const statusColor: Record<string, string> = {
  'Active': '#15803d', 'Decommed': '#475569', 'Spare': '#b45309', 'Faulty, Replaced': '#c2410c',
}
const statusBg: Record<string, string> = {
  'Active': '#dcfce7', 'Decommed': '#f1f5f9', 'Spare': '#fef3c7', 'Faulty, Replaced': '#ffedd5',
}

export default function GlobalSearch() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Results>({ devices: [], sites: [], circuits: [] })
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  const flat: { type: 'device' | 'site' | 'circuit'; id: string }[] = [
    ...results.devices.map(d => ({ type: 'device' as const, id: d.id })),
    ...results.sites.map(s => ({ type: 'site' as const, id: s.id })),
    ...results.circuits.map(c => ({ type: 'circuit' as const, id: c.id })),
  ]
  const total = flat.length

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault(); inputRef.current?.focus()
      }
      if (e.key === 'Escape') { setOpen(false); setQ(''); inputRef.current?.blur() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const search = useCallback(async (val: string) => {
    if (val.length < 2) { setResults({ devices: [], sites: [], circuits: [] }); setOpen(false); return }
    setLoading(true)
    const res = await fetch('/api/search?q=' + encodeURIComponent(val))
    const data = await res.json()
    setResults({ devices: data.devices || [], sites: data.sites || [], circuits: data.circuits || [] })
    setOpen(true)
    setActiveIdx(0)
    setLoading(false)
  }, [])

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setQ(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(v), 200)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || total === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(a => Math.min(a + 1, total - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(a => Math.max(a - 1, 0)) }
    if (e.key === 'Enter' && flat[activeIdx]) navigate(flat[activeIdx])
  }

  function navigate(item: { type: string; id: string }) {
    setOpen(false); setQ(''); setResults({ devices: [], sites: [], circuits: [] })
    if (item.type === 'device')  router.push('/devices/'  + item.id)
    else if (item.type === 'site')    router.push('/sites/'    + item.id)
    else if (item.type === 'circuit') router.push('/circuits/' + item.id)
  }

  function isActive(type: 'device' | 'site' | 'circuit', id: string) {
    return flat.findIndex(f => f.type === type && f.id === id) === activeIdx
  }

  const hasResults = total > 0

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div style={{ position: 'relative' }}>
        <svg style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)', pointerEvents: 'none' }}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => q.length >= 2 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search devices, sites, circuits… (/)"
          style={{
            width: '100%', padding: '8px 32px 8px 34px',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            color: 'rgba(255,255,255,0.9)',
            fontSize: 'var(--text-base)',
            outline: 'none',
            boxSizing: 'border-box',
            transition: 'border-color 0.15s, background 0.15s',
            fontFamily: 'inherit',
          }}
          onFocusCapture={e => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'
            e.currentTarget.style.background = 'rgba(255,255,255,0.12)'
          }}
          onBlurCapture={e => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
            e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
          }}
        />
        {loading && <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)', fontSize: 'var(--text-xs)' }}>…</div>}
      </div>

      {open && hasResults && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0,
          background: 'var(--bg-card)', borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 999, overflow: 'hidden',
          animation: 'fadeIn 0.15s ease',
        }}>
          {results.devices.length > 0 && (
            <>
              <div style={{ padding: '7px 14px 5px', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-light)' }}>
                Devices
              </div>
              {results.devices.map(d => (
                <div key={d.id} onMouseDown={() => navigate({ type: 'device', id: d.id })}
                  style={{ padding: '9px 14px', cursor: 'pointer', background: isActive('device', d.id) ? 'var(--surface-subtle)' : 'var(--bg-card)', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 1 }}>
                      {d.device_type} · {d.site}{d.ip_address && <span className="mono"> · {d.ip_address}</span>}
                    </div>
                  </div>
                  <span className="badge" style={{ background: statusBg[d.device_status] || '#f1f5f9', color: statusColor[d.device_status] || 'var(--text-secondary)', flexShrink: 0, fontSize: 'var(--text-xs)' }}>
                    {d.device_status}
                  </span>
                </div>
              ))}
            </>
          )}

          {results.sites.length > 0 && (
            <>
              <div style={{ padding: '7px 14px 5px', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-light)' }}>
                Sites
              </div>
              {results.sites.map(s => (
                <div key={s.id} onMouseDown={() => navigate({ type: 'site', id: s.id })}
                  style={{ padding: '9px 14px', cursor: 'pointer', background: isActive('site', s.id) ? 'var(--surface-subtle)' : 'var(--bg-card)', borderBottom: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-primary)' }}>{s.name}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 1 }}>{s.code} · {s.country} · {s.region}</div>
                </div>
              ))}
            </>
          )}

          {results.circuits.length > 0 && (
            <>
              <div style={{ padding: '7px 14px 5px', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-light)' }}>
                Circuits
              </div>
              {results.circuits.map(c => (
                <div key={c.id} onMouseDown={() => navigate({ type: 'circuit', id: c.id })}
                  style={{ padding: '9px 14px', cursor: 'pointer', background: isActive('circuit', c.id) ? 'var(--surface-subtle)' : 'var(--bg-card)', borderBottom: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-primary)' }}>{c.isp}{c.circuit_id ? ' · ' + c.circuit_id : ''}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 1 }}>{c.usage} · {c.site}</div>
                </div>
              ))}
            </>
          )}

          <div style={{ padding: '7px 14px', background: 'var(--surface-subtle)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', borderTop: '1px solid var(--border-light)' }}>
            ↑↓ navigate · Enter to open · Esc to close
          </div>
        </div>
      )}

      {open && !hasResults && q.length >= 2 && !loading && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0,
          background: 'var(--bg-card)', borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          padding: '20px 14px', textAlign: 'center',
          fontSize: 'var(--text-base)', color: 'var(--text-muted)', zIndex: 999,
          boxShadow: 'var(--shadow-lg)',
        }}>
          No results for "{q}"
        </div>
      )}
    </div>
  )
}
