'use client'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

type SiteData = {
  site: { id: string; site: string; code: string; country: string; region: string }
  devices: any[]
}
type Circuit = Record<string, any>

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { 'Active': 'badge-active', 'Decommed': 'badge-decommed', 'Faulty, Replaced': 'badge-faulty', 'Spare': 'badge-spare' }
  return <span className={`badge ${map[status] || 'badge-unknown'}`}>{status}</span>
}
function LifecycleBadge({ status }: { status: string }) {
  if (status === 'EOL / EOS') return <span className="badge badge-eol">EOL</span>
  if (status === 'Active, Supported') return <span className="badge badge-active">Supported</span>
  return <span className="badge badge-unknown">Unknown</span>
}

export default function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin'
  const [data, setData] = useState<SiteData | null>(null)
  const [circuits, setCircuits] = useState<Circuit[]>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [activeTab, setActiveTab] = useState<'devices'|'circuits'>('devices')
  const [siteId, setSiteId] = useState('')

  useEffect(() => {
    params.then(p => {
      setSiteId(p.id)
      Promise.all([
        fetch(`/api/sites/${p.id}`).then(r => r.json()),
        fetch(`/api/circuits?site_id=${p.id}`).then(r => r.json()),
      ]).then(([siteData, circuitData]) => {
        setData(siteData)
        setCircuits(Array.isArray(circuitData) ? circuitData.filter((c: Circuit) => c.site_id === parseInt(p.id)) : [])
        setLoading(false)
      })
    })
  }, [params])

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
  if (!data) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Site not found</div>

  const { site, devices } = data
  const total = devices.length
  const active = devices.filter(d => d.device_status === 'Active').length
  const eol = devices.filter(d => d.lifecycle_status === 'EOL / EOS').length
  const decommed = devices.filter(d => d.device_status === 'Decommed').length
  const types = [...new Set(devices.map(d => d.device_type).filter(Boolean))]

  const filtered = devices.filter(d => {
    const matchType = !typeFilter || d.device_type === typeFilter
    const matchStatus = !statusFilter || d.device_status === statusFilter
    return matchType && matchStatus
  })

  const byType = types.map(t => ({
    type: t,
    count: devices.filter(d => d.device_type === t).length,
    eol: devices.filter(d => d.device_type === t && d.lifecycle_status === 'EOL / EOS').length,
  })).sort((a, b) => b.count - a.count)

  const mainCircuits = circuits.filter(c => c.usage?.toLowerCase() === 'main')
  const backupCircuits = circuits.filter(c => c.usage?.toLowerCase() === 'backup')

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <Link href="/sites" style={{ fontSize: '13px', color: '#6b7280', textDecoration: 'none' }}>← Back to sites</Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: '0 0 4px' }}>{site.site}</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>{site.country}</span>
            <span style={{ color: '#d1d5db' }}>·</span>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>{site.region}</span>
            {site.code && <span style={{ fontSize: '11px', background: '#f3f4f6', color: '#6b7280', padding: '2px 8px', borderRadius: '20px' }}>{site.code}</span>}
          </div>
        </div>
        {isAdmin && <Link href="/devices/new"><button className="btn-primary">+ Add device</button></Link>}
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total devices', value: total, color: '#1a2744' },
          { label: 'Active', value: active, color: '#166534' },
          { label: 'EOL / EOS', value: eol, color: '#991b1b' },
          { label: 'Decommed', value: decommed, color: '#92400e' },
          { label: 'WAN circuits', value: circuits.length, color: '#075985' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: '700', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '16px', borderBottom: '2px solid #f3f4f6' }}>
        {(['devices', 'circuits'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: activeTab === tab ? '600' : '400', color: activeTab === tab ? '#C8102E' : '#6b7280', background: 'none', border: 'none', borderBottom: activeTab === tab ? '2px solid #C8102E' : '2px solid transparent', cursor: 'pointer', marginBottom: '-2px', textTransform: 'capitalize' }}>
            {tab} {tab === 'devices' ? `(${total})` : `(${circuits.length})`}
          </button>
        ))}
      </div>

      {activeTab === 'devices' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '16px' }}>
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>By device type</div>
            {byType.map(t => {
              const pct = Math.round(t.count / total * 100)
              return (
                <div key={t.type} style={{ marginBottom: '12px', cursor: 'pointer' }} onClick={() => setTypeFilter(typeFilter === t.type ? '' : t.type)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', color: typeFilter === t.type ? '#C8102E' : '#374151', fontWeight: typeFilter === t.type ? '600' : '400' }}>{t.type}</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: '#111827' }}>{t.count}</span>
                      {t.eol > 0 && <span style={{ fontSize: '11px', color: '#991b1b', background: '#fee2e2', padding: '0 5px', borderRadius: '10px' }}>{t.eol} EOL</span>}
                    </div>
                  </div>
                  <div style={{ height: '6px', background: '#f3f4f6', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: typeFilter === t.type ? '#C8102E' : '#1a2744' }} />
                  </div>
                </div>
              )
            })}
          </div>
          <div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <select className="select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                {types.map(t => <option key={t}>{t}</option>)}
              </select>
              <select className="select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                {['Active','Decommed','Faulty, Replaced','Spare'].map(s => <option key={s}>{s}</option>)}
              </select>
              {(typeFilter || statusFilter) && <button className="btn-secondary" style={{ fontSize: '13px' }} onClick={() => { setTypeFilter(''); setStatusFilter('') }}>Clear</button>}
              <span style={{ fontSize: '13px', color: '#9ca3af', alignSelf: 'center', marginLeft: 'auto' }}>{filtered.length} devices</span>
            </div>
            <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Name</th><th>Type</th><th>Brand / Model</th><th>IP</th><th>Lifecycle</th><th>Status</th>{isAdmin && <th>Actions</th>}</tr></thead>
                  <tbody>
                    {filtered.map((d: any) => (
                      <tr key={d.id}>
                        <td style={{ fontWeight: '500' }}><Link href={`/devices/${d.id}`} style={{ color: '#111827', textDecoration: 'none' }}>{d.name || '—'}</Link></td>
                        <td>{d.device_type}</td>
                        <td>{d.brand} {d.model}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{d.ip_address || '—'}</td>
                        <td><LifecycleBadge status={d.lifecycle_status} /></td>
                        <td><StatusBadge status={d.device_status} /></td>
                        {isAdmin && <td><Link href={`/devices/${d.id}/edit`}><button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>Edit</button></Link></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'circuits' && (
        <div>
          {circuits.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af', background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb' }}>No circuits for this site</div>
          ) : (
            <>
              {mainCircuits.length > 0 && (
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#075985', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Main links — {mainCircuits.length}</div>
                  <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                    <table>
                      <thead><tr><th>ISP</th><th>Circuit ID</th><th>Technology</th><th>Max speed</th><th>Public subnet</th><th>Cost/month</th><th>Pingable</th><th></th></tr></thead>
                      <tbody>
                        {mainCircuits.map((c: Circuit) => (
                          <tr key={c.id}>
                            <td style={{ fontWeight: '500' }}>{c.isp}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.circuit_id || '—'}</td>
                            <td><span className="badge" style={{ background: '#ede9fe', color: '#5b21b6' }}>{c.technology || '—'}</span></td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.max_speed || '—'}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.public_subnet && c.public_subnet !== '-' ? c.public_subnet : '—'}</td>
                            <td style={{ fontSize: '12px' }}>{c.cost_month ? `THB ${parseFloat(c.cost_month).toLocaleString()}` : '—'}</td>
                            <td><span className="badge" style={{ background: c.pingable === 'Yes' ? '#dcfce7' : '#f3f4f6', color: c.pingable === 'Yes' ? '#166534' : '#6b7280' }}>{c.pingable || '—'}</span></td>
                            <td><Link href={`/circuits/${c.id}`}><button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>View</button></Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {backupCircuits.length > 0 && (
                <div>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Backup links — {backupCircuits.length}</div>
                  <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                    <table>
                      <thead><tr><th>ISP</th><th>Circuit ID</th><th>Technology</th><th>Max speed</th><th>Public subnet</th><th>Cost/month</th><th>Pingable</th><th></th></tr></thead>
                      <tbody>
                        {backupCircuits.map((c: Circuit) => (
                          <tr key={c.id}>
                            <td style={{ fontWeight: '500' }}>{c.isp}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.circuit_id || '—'}</td>
                            <td><span className="badge" style={{ background: '#ede9fe', color: '#5b21b6' }}>{c.technology || '—'}</span></td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.max_speed || '—'}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.public_subnet && c.public_subnet !== '-' ? c.public_subnet : '—'}</td>
                            <td style={{ fontSize: '12px' }}>{c.cost_month ? `THB ${parseFloat(c.cost_month).toLocaleString()}` : '—'}</td>
                            <td><span className="badge" style={{ background: c.pingable === 'Yes' ? '#dcfce7' : '#f3f4f6', color: c.pingable === 'Yes' ? '#166634' : '#6b7280' }}>{c.pingable || '—'}</span></td>
                            <td><Link href={`/circuits/${c.id}`}><button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>View</button></Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
