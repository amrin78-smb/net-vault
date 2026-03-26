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
  const main = usage?.toLowerCase() === 'main'
  return <span className="badge" style={{ background: main ? '#e0f2fe' : '#f3f4f6', color: main ? '#075985' : '#6b7280' }}>{usage || '—'}</span>
}

function TechBadge({ tech }: { tech: string }) {
  if (!tech || tech === 'nan') return <span style={{ color: '#d1d5db', fontSize: '12px' }}>—</span>
  const colors: Record<string, { bg: string; color: string }> = {
    'DIA': { bg: '#dcfce7', color: '#166534' },
    'MPLS': { bg: '#ede9fe', color: '#5b21b6' },
    'SD-WAN': { bg: '#fef3c7', color: '#92400e' },
  }
  const c = colors[tech] || { bg: '#f3f4f6', color: '#6b7280' }
  return <span className="badge" style={{ background: c.bg, color: c.color }}>{tech}</span>
}

function PingBadge({ pingable }: { pingable: string }) {
  if (!pingable || pingable === 'nan') return <span style={{ color: '#d1d5db', fontSize: '12px' }}>—</span>
  const yes = pingable.toLowerCase() === 'yes'
  return <span className="badge" style={{ background: yes ? '#dcfce7' : '#fee2e2', color: yes ? '#166534' : '#991b1b' }}>{pingable}</span>
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
  const totalCost = circuits.reduce((s, c) => s + (parseFloat(c.cost_month) || 0), 0)
  const mainCount = circuits.filter(c => c.usage?.toLowerCase() === 'main').length
  const backupCount = circuits.filter(c => c.usage?.toLowerCase() === 'backup').length

  function formatCost(cost: string, currency: string) {
    if (!cost) return '—'
    return `${currency || 'THB'} ${parseFloat(cost).toLocaleString()}`
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>WAN Circuits</h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>ISP circuit inventory across all sites</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total circuits', value: circuits.length, color: '#1a2744' },
          { label: 'Main links', value: mainCount, color: '#166534' },
          { label: 'Backup links', value: backupCount, color: '#075985' },
          { label: 'Monthly cost (THB)', value: totalCost > 0 ? totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—', color: '#92400e' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: '700', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: 1, minWidth: '200px', maxWidth: '280px' }}
          placeholder="Search circuit ID, ISP, subnet..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select" value={country} onChange={e => setCountry(e.target.value)}>
          <option value="">All countries</option>
          {countries.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="select" value={isp} onChange={e => setIsp(e.target.value)}>
          <option value="">All ISPs</option>
          {isps.map(i => <option key={i}>{i}</option>)}
        </select>
        <select className="select" value={usage} onChange={e => setUsage(e.target.value)}>
          <option value="">All usage</option>
          <option value="Main">Main</option>
          <option value="Backup">Backup</option>
        </select>
        <select className="select" value={technology} onChange={e => setTechnology(e.target.value)}>
          <option value="">All technology</option>
          {technologies.map(t => <option key={t}>{t}</option>)}
        </select>
        {(search || isp || usage || technology || country) && (
          <button className="btn-secondary" style={{ fontSize: '13px' }} onClick={() => { setSearch(''); setIsp(''); setUsage(''); setTechnology(''); setCountry('') }}>Clear</button>
        )}
      </div>

      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading circuits...</div>
        ) : circuits.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>No circuits found</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Site</th><th>Country</th><th>ISP</th><th>Circuit ID</th>
                  <th>Usage</th><th>Technology</th><th>Max speed</th>
                  <th>Public subnet</th><th>Cost/month</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {circuits.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>
                      <Link href={`/circuits/${c.id}`} style={{ color: '#111827', textDecoration: 'none' }}>
                        {c.site || c.site_name_raw}
                      </Link>
                    </td>
                    <td style={{ fontSize: '12px', color: '#6b7280' }}>{c.country}</td>
                    <td style={{ fontWeight: '500' }}>{c.isp}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.circuit_id || '—'}</td>
                    <td><UsageBadge usage={c.usage} /></td>
                    <td><TechBadge tech={c.technology} /></td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.max_speed || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.public_subnet && c.public_subnet !== '-' && c.public_subnet !== 'nan' ? c.public_subnet : '—'}</td>
                    <td style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>{formatCost(c.cost_month, c.currency)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Link href={`/circuits/${c.id}`}>
                          <button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>View</button>
                        </Link>
                        {isAdmin && (
                          <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteCircuit(c.id, c.circuit_id)}>Delete</button>
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
