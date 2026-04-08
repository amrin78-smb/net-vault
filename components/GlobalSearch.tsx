'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

type DeviceResult = { id: string; name: string; device_type: string; ip_address: string; site: string; device_status: string }
type SiteResult = { id: string; name: string; code: string; country: string; region: string }
type CircuitResult = { id: string; circuit_id: string; isp: string; usage: string; site: string }
type Results = { devices: DeviceResult[]; sites: SiteResult[]; circuits: CircuitResult[] }

const statusColor: Record<string, string> = { 'Active': '#166534', 'Decommed': '#4b5563', 'Spare': '#92400e', 'Faulty, Replaced': '#9a3412' }
const statusBg: Record<string, string> = { 'Active': '#dcfce7', 'Decommed': '#f3f4f6', 'Spare': '#fef3c7', 'Faulty, Replaced': '#ffedd5' }

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
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(a => Math.max(a - 1, 0)) }
    if (e.key === 'Enter' && flat[activeIdx]) navigate(flat[activeIdx])
  }

  function navigate(item: { type: string; id: string }) {
    setOpen(false); setQ(''); setResults({ devices: [], sites: [], circuits: [] })
    if (item.type === 'device') router.push('/devices/' + item.id)
    else if (item.type === 'site') router.push('/sites/' + item.id)
    else if (item.type === 'circuit') router.push('/circuits/' + item.id)
  }

  function isActive(type: 'device' | 'site' | 'circuit', id: string) {
    const i = flat.findIndex(f => f.type === type && f.id === id)
    return i === activeIdx
  }

  const hasResults = total > 0

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div style={{ position: 'relative' }}>
        <svg style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input
          ref={inputRef}
          value={q}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => q.length >= 2 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search devices, sites, circuits… (/)"
          style={{ width: '100%', padding: '7px 32px 7px 32px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '7px', color: '#111827', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
        />
        {loading && <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontSize: '11px' }}>...</div>}
      </div>

      {open && hasResults && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 999, overflow: 'hidden' }}>

          {results.devices.length > 0 && (
            <>
              <div style={{ padding: '6px 14px 4px', fontSize: '10px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>🖥 Devices</div>
              {results.devices.map(d => (
                <div key={d.id} onMouseDown={() => navigate({ type: 'device', id: d.id })}
                  style={{ padding: '9px 14px', cursor: 'pointer', background: isActive('device', d.id) ? '#f9fafb' : 'white', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                    <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '1px' }}>
                      {d.device_type} · {d.site}{d.ip_address && <span style={{ fontFamily: 'monospace' }}> · {d.ip_address}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: '10px', fontWeight: '500', padding: '2px 7px', borderRadius: '20px', background: statusBg[d.device_status] || '#f3f4f6', color: statusColor[d.device_status] || '#374151', flexShrink: 0 }}>{d.device_status}</span>
                </div>
              ))}
            </>
          )}

          {results.sites.length > 0 && (
            <>
              <div style={{ padding: '6px 14px 4px', fontSize: '10px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>🏢 Sites</div>
              {results.sites.map(s => (
                <div key={s.id} onMouseDown={() => navigate({ type: 'site', id: s.id })}
                  style={{ padding: '9px 14px', cursor: 'pointer', background: isActive('site', s.id) ? '#f9fafb' : 'white', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{s.name}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '1px' }}>{s.code} · {s.country} · {s.region}</div>
                </div>
              ))}
            </>
          )}

          {results.circuits.length > 0 && (
            <>
              <div style={{ padding: '6px 14px 4px', fontSize: '10px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>⇌ Circuits</div>
              {results.circuits.map(c => (
                <div key={c.id} onMouseDown={() => navigate({ type: 'circuit', id: c.id })}
                  style={{ padding: '9px 14px', cursor: 'pointer', background: isActive('circuit', c.id) ? '#f9fafb' : 'white', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{c.isp}{c.circuit_id ? ' · ' + c.circuit_id : ''}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '1px' }}>{c.usage} · {c.site}</div>
                </div>
              ))}
            </>
          )}

          <div style={{ padding: '7px 14px', background: '#f9fafb', fontSize: '11px', color: '#9ca3af', borderTop: '1px solid #f3f4f6' }}>
            ↑↓ navigate · Enter to open · Esc to close
          </div>
        </div>
      )}

      {open && !hasResults && q.length >= 2 && !loading && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 14px', textAlign: 'center', fontSize: '13px', color: '#9ca3af', zIndex: 999 }}>
          No results for "{q}"
        </div>
      )}
    </div>
  )
}