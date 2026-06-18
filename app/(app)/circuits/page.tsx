'use client'
import { useToast, useConfirm } from '@/app/providers'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'

type Circuit = {
  id: string; site_name_raw: string; site: string; site_code: string
  country: string; region: string; isp: string; usage: string
  circuit_id: string; product: string; technology: string; circuit_type: string
  interface: string; max_speed: string; guaranteed_speed: string
  public_subnet: string; cost_month: string; currency: string
  pingable: string; comment: string; it_owner: string; city: string
}

function UsageBadge({ usage }: { usage: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    'Primary Internet': { bg: '#e0f2fe', color: '#075985' },
    'Backup Internet':  { bg: '#f3f4f6', color: '#6b7280' },
    'MPLS Primary':     { bg: '#ede9fe', color: '#5b21b6' },
    'MPLS Backup':      { bg: '#f5f3ff', color: '#7c3aed' },
    'Main':             { bg: '#e0f2fe', color: '#075985' },
    'Backup':           { bg: '#f3f4f6', color: '#6b7280' },
  }
  const c = colors[usage] || { bg: '#f3f4f6', color: '#6b7280' }
  return <span className="badge" style={{ background: c.bg, color: c.color, }}>{usage || '—'}</span>
}

export default function CircuitsPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'site_admin'
  const [circuits, setCircuits] = useState<Circuit[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [isp, setIsp] = useState('')
  const [usage, setUsage] = useState('')
  const [technology, setTechnology] = useState('')
  const [country, setCountry] = useState('')
  const [site, setSite] = useState('')
  const [showFilterPanel, setShowFilterPanel] = useState(false)

  useEffect(() => { fetchCircuits() }, [search, isp, usage, technology, country, site])

  async function fetchCircuits() {
    setLoading(true)
    const params = new URLSearchParams({
      ...(search && { search }),
      ...(isp && { isp }),
      ...(usage && { usage }),
      ...(technology && { technology }),
      ...(country && { country }),
      ...(site && { site }),
    })
    const res = await fetch(`/api/circuits?${params}`)
    const data = await res.json()
    setCircuits(Array.isArray(data) ? data : [])
    setLoading(false)
  }

  async function deleteCircuit(id: string, circuitId: string) {
    const ok = await confirm({ title: 'Delete circuit', message: `Are you sure you want to delete circuit "${circuitId}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    const res = await fetch(`/api/circuits/${id}`, { method: 'DELETE' })
    if (res.ok) showToast(`Circuit "${circuitId}" deleted`)
    else showToast('Failed to delete circuit', 'error')
    fetchCircuits()
  }

  const isps = [...new Set(circuits.map(c => c.isp).filter(Boolean))].sort()
  const technologies = [...new Set(circuits.map(c => c.technology).filter(t => t && t !== 'nan'))].sort()
  const countries = [...new Set(circuits.map(c => c.country).filter(Boolean))].sort()
  const sites = [...new Set(circuits.map(c => c.site).filter(Boolean))].sort()
  const mainCount = circuits.filter(c => ['main','primary internet','mpls primary'].includes(c.usage?.toLowerCase())).length
  const backupCount = circuits.filter(c => ['backup','backup internet','mpls backup'].includes(c.usage?.toLowerCase())).length

  function formatSpeed(speed: string) {
    if (!speed || speed === 'nan') return '—'
    // Convert "200Mb Guaranteed/200Mb Guaranteed" to "200/200 Mb"
    const parts = speed.split('/')
    if (parts.length === 2) {
      const clean = (s: string) => s.replace(/\s*(guaranteed|not guaranteed|guranteed|shared)\s*/gi, '').trim()
      const up = clean(parts[0])
      const down = clean(parts[1])
      if (up === down) return up
      return `${up} / ${down}`
    }
    return speed
  }

  function formatCost(cost: string, currency: string) {
    if (!cost) return '—'
    return `${currency || 'THB'} ${parseFloat(cost).toLocaleString()}`
  }

  const selectStyle = { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: 'var(--text-md)', background: 'white', outline: 'none', cursor: 'pointer' }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: '#111827', margin: 0 }}>WAN Circuits</h1>
        <p style={{ fontSize: 'var(--text-base)', color: '#9ca3af', margin: '2px 0 0' }}>Circuit inventory across all sites</p>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total circuits', value: circuits.length, color: '#1a2744', bg: '#f0f4f8', border: '#c7d8e8', href: '/circuits', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg> },
          { label: 'Primary / Main', value: mainCount, color: '#166534', bg: '#dcfce7', border: '#86efac', href: '/circuits?usage=Main', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> },
          { label: 'Backup', value: backupCount, color: '#075985', bg: '#e0f2fe', border: '#7dd3fc', href: '/circuits?usage=Backup', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg> },
        ].map(s => (
          <a key={s.label} href={s.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: s.bg, borderRadius: '8px', border: `1px solid ${s.border}`, padding: '16px', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'transform 0.1s, box-shadow 0.1s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>
              <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: s.color }}>{s.icon}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: s.color, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600', opacity: 0.8 }}>{s.label}</div>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: s.color, opacity: 0.6, marginTop: '4px' }}>View all →</div>
            </div>
          </a>
        ))}
      </div>

      {/* Search + Filter bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        <input className="input" style={{ flex: '1', maxWidth: '400px' }} placeholder="Search circuit ID, ISP, subnet..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <button onClick={() => setShowFilterPanel(f => !f)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', background: showFilterPanel || !!(isp||usage||technology||country||site) ? '#1a2744' : 'white', color: showFilterPanel || !!(isp||usage||technology||country||site) ? 'white' : '#374151', border: '1px solid ' + (showFilterPanel || !!(isp||usage||technology||country||site) ? '#1a2744' : '#e5e7eb'), borderRadius: '6px', cursor: 'pointer', fontSize: 'var(--text-base)', fontWeight: '500', whiteSpace: 'nowrap' as const }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          Filters {!!(isp||usage||technology||country||site) && `(${[isp,usage,technology,country,site].filter(Boolean).length})`}
        </button>
        {!!(search||isp||usage||technology||country||site) && (
          <button onClick={() => { setSearch(''); setIsp(''); setUsage(''); setTechnology(''); setCountry(''); setSite('') }}
            style={{ fontSize: 'var(--text-sm)', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' as const }}>
            Clear all
          </button>
        )}
      </div>

      {/* Filter panel */}
      {showFilterPanel && (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', marginBottom: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Country</div>
            <select className="select" style={{ width: '100%' }} value={country} onChange={e => { setCountry(e.target.value); setSite('') }}>
              <option value="">All countries</option>
              {countries.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Site</div>
            <select className="select" style={{ width: '100%' }} value={site} onChange={e => setSite(e.target.value)}>
              <option value="">All sites</option>
              {sites.filter(s => !country || circuits.find(c => c.site === s)?.country === country).map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>ISP</div>
            <select className="select" style={{ width: '100%' }} value={isp} onChange={e => setIsp(e.target.value)}>
              <option value="">All ISPs</option>
              {isps.map(i => <option key={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Usage</div>
            <select className="select" style={{ width: '100%' }} value={usage} onChange={e => setUsage(e.target.value)}>
              <option value="">All usage</option>
              <option>Primary Internet</option>
              <option>Backup Internet</option>
              <option>MPLS Primary</option>
              <option>MPLS Backup</option>
              <option>Main</option>
              <option>Backup</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Technology</div>
            <select className="select" style={{ width: '100%' }} value={technology} onChange={e => setTechnology(e.target.value)}>
              <option value="">All technology</option>
              {technologies.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Active filter pills */}
      {!!(isp||usage||technology||country||site) && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' as const, marginBottom: '12px' }}>
          {country && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Country: {country}<button onClick={() => { setCountry(''); setSite('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {site && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Site: {site}<button onClick={() => setSite('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {isp && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: 'var(--text-sm)', fontWeight: '500' }}>ISP: {isp}<button onClick={() => setIsp('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {usage && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Usage: {usage}<button onClick={() => setUsage('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {technology && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Technology: {technology}<button onClick={() => setTechnology('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: 'var(--text-base)', color: '#6b7280' }}>
          {loading ? 'Loading...' : `${circuits.length.toLocaleString()} circuits`}
        </span>
        {isAdmin && (
          <Link href="/circuits/new">
            <button style={{ padding: '7px 14px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-base)', fontWeight: '500' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
              Add circuit
            </button>
          </Link>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading circuits...</div>
        ) : circuits.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>No circuits found</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: 'var(--text-base)', borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <thead>
              <tr>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '13%' }}>Site</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '8%' }}>Country</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '13%' }}>ISP</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '10%' }}>Usage</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '12%' }}>Product</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '13%' }}>Max speed</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '15%' }}>Public subnet</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '11%' }}>Cost/month</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '12%' }}>Actions</th>
              </tr>
            </thead>
              <tbody>
                {circuits.map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px', fontWeight: '500', color: '#111827', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Link href={`/circuits/${c.id}`} style={{ color: '#111827', textDecoration: 'none' }} title={c.site || c.site_name_raw}>
                        {c.site || c.site_name_raw}
                      </Link>
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 'var(--text-sm)', color: '#6b7280', whiteSpace: 'nowrap' }}>{c.country}</td>
                    <td style={{ padding: '10px 14px', fontWeight: '500', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.isp}>{c.isp}</td>
                    <td style={{ padding: '10px 14px', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><UsageBadge usage={c.usage} /></td>
                    <td style={{ padding: '10px 14px', fontSize: 'var(--text-sm)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.product && c.product !== 'nan' ? c.product : '—'}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.max_speed}>{formatSpeed(c.max_speed)}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.public_subnet && c.public_subnet !== '-' && c.public_subnet !== 'nan' ? c.public_subnet : '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{formatCost(c.cost_month, c.currency)}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Link href={`/circuits/${c.id}`}>
                          <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid #d1d5db', borderRadius: '6px', background: 'white', cursor: 'pointer' }}>View</button>
                        </Link>
                        {isAdmin && (
                          <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: '6px', cursor: 'pointer' }}
                            onClick={() => deleteCircuit(c.id, c.circuit_id)}>Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: 'var(--text-base)', color: '#6b7280' }}>
            {circuits.length} circuit{circuits.length !== 1 ? 's' : ''} shown
          </div>
        )}
      </div>
    </div>
  )
}
