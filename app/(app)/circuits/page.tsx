'use client'
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
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'site_admin'
  const [circuits, setCircuits] = useState<Circuit[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [isp, setIsp] = useState('')
  const [usage, setUsage] = useState('')
  const [technology, setTechnology] = useState('')
  const [country, setCountry] = useState('')

  useEffect(() => { fetchCircuits() }, [search, isp, usage, technology, country])

  async function fetchCircuits() {
    setLoading(true)
    const params = new URLSearchParams({
      ...(search && { search }),
      ...(isp && { isp }),
      ...(usage && { usage }),
      ...(technology && { technology }),
      ...(country && { country }),
    })
    const res = await fetch(`/api/circuits?${params}`)
    const data = await res.json()
    setCircuits(Array.isArray(data) ? data : [])
    setLoading(false)
  }

  async function deleteCircuit(id: string, circuitId: string) {
    if (!confirm(`Delete circuit "${circuitId}"?`)) return
    await fetch(`/api/circuits/${id}`, { method: 'DELETE' })
    fetchCircuits()
  }

  const isps = [...new Set(circuits.map(c => c.isp).filter(Boolean))].sort()
  const technologies = [...new Set(circuits.map(c => c.technology).filter(t => t && t !== 'nan'))].sort()
  const countries = [...new Set(circuits.map(c => c.country).filter(Boolean))].sort()
  const mainCount = circuits.filter(c => ['main','primary internet','mpls primary'].includes(c.usage?.toLowerCase())).length
  const backupCount = circuits.filter(c => ['backup','backup internet','mpls backup'].includes(c.usage?.toLowerCase())).length

  function formatCost(cost: string, currency: string) {
    if (!cost) return '—'
    return `${currency || 'THB'} ${parseFloat(cost).toLocaleString()}`
  }

  const selectStyle = { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '7px', fontSize: '14px', background: 'white', outline: 'none', cursor: 'pointer' }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>WAN Circuits</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Circuit inventory across all sites</p>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total circuits', value: circuits.length, color: '#1a2744' },
          { label: 'Primary / Main', value: mainCount, color: '#166534' },
          { label: 'Backup', value: backupCount, color: '#075985' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: '700', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '7px', fontSize: '14px', background: 'white', outline: 'none', minWidth: '200px', flex: 1, maxWidth: '280px' }}
          placeholder="Search circuit ID, ISP, subnet..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <select style={selectStyle} value={country} onChange={e => setCountry(e.target.value)}>
          <option value="">All countries</option>
          {countries.map(c => <option key={c}>{c}</option>)}
        </select>
        <select style={selectStyle} value={isp} onChange={e => setIsp(e.target.value)}>
          <option value="">All ISPs</option>
          {isps.map(i => <option key={i}>{i}</option>)}
        </select>
        <select style={selectStyle} value={usage} onChange={e => setUsage(e.target.value)}>
          <option value="">All usage</option>
          <option>Primary Internet</option>
          <option>Backup Internet</option>
          <option>MPLS Primary</option>
          <option>MPLS Backup</option>
          <option>Main</option>
          <option>Backup</option>
        </select>
        <select style={selectStyle} value={technology} onChange={e => setTechnology(e.target.value)}>
          <option value="">All technology</option>
          {technologies.map(t => <option key={t}>{t}</option>)}
        </select>
        {(search || isp || usage || technology || country) && (
          <button style={{ padding: '8px 14px', background: 'white', border: '1px solid #d1d5db', borderRadius: '7px', fontSize: '13px', cursor: 'pointer' }}
            onClick={() => { setSearch(''); setIsp(''); setUsage(''); setTechnology(''); setCountry('') }}>Clear</button>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading circuits...</div>
        ) : circuits.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>No circuits found</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: '13px', borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <thead>
              <tr>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '13%' }}>Site</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '8%' }}>Country</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '13%' }}>ISP</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '10%' }}>Usage</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '18%' }}>Max speed</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '15%' }}>Public subnet</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '11%' }}>Cost/month</th>
                <th style={{ padding: '10px 14px', background: '#f9fafb', textAlign: 'left', fontSize: '11px', fontWeight: '600', color: '#6b7280', borderBottom: '1px solid #e5e7eb', width: '12%' }}>Actions</th>
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
                    <td style={{ padding: '10px 14px', fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap' }}>{c.country}</td>
                    <td style={{ padding: '10px 14px', fontWeight: '500', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.isp}>{c.isp}</td>
                    <td style={{ padding: '10px 14px', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><UsageBadge usage={c.usage} /></td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: '12px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.max_speed}>{c.max_speed || '—'}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: '12px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.public_subnet && c.public_subnet !== '-' && c.public_subnet !== 'nan' ? c.public_subnet : '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: '12px', whiteSpace: 'nowrap' }}>{formatCost(c.cost_month, c.currency)}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Link href={`/circuits/${c.id}`}>
                          <button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>View</button>
                        </Link>
                        {isAdmin && (
                          <button style={{ padding: '4px 10px', fontSize: '12px', background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: '5px', cursor: 'pointer' }}
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
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: '13px', color: '#6b7280' }}>
            {circuits.length} circuit{circuits.length !== 1 ? 's' : ''} shown
          </div>
        )}
      </div>
    </div>
  )
}
