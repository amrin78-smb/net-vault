'use client'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import Breadcrumb from '@/components/Breadcrumb'
import { StatusBadge, LifecycleBadge } from '@/components/Badges'
import { useToast, useConfirm } from '@/app/providers'

type SiteData = {
  site: { id: string; site: string; code: string; country: string; region: string; site_status?: string }
  devices: any[]
}
type Circuit = Record<string, any>

export default function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'site_admin'
  const [data, setData] = useState<SiteData | null>(null)
  const [circuits, setCircuits] = useState<Circuit[]>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [activeTab, setActiveTab] = useState<'devices'|'circuits'>('devices')
  const [editingSite, setEditingSite] = useState(false)
  const [siteForm, setSiteForm] = useState({ name: '', code: '' })
  const [savingSite, setSavingSite] = useState(false)
  const [togglingDecomm, setTogglingDecomm] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkField, setBulkField] = useState('device_status')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const { showToast } = useToast()
  const { confirm } = useConfirm()


  const [siteId, setSiteId] = useState('')

  useEffect(() => {
    params.then(async p => {
      setSiteId(p.id)
      const [siteData, allCircuits] = await Promise.all([
        fetch(`/api/sites/${p.id}`).then(r => r.json()),
        fetch(`/api/circuits`).then(r => r.json()),
      ])
      setData(siteData)
      setSiteForm({ name: siteData.site?.site || '', code: siteData.site?.code || '' })
      const siteCircuits = Array.isArray(allCircuits)
        ? allCircuits.filter((c: Circuit) => String(c.site_id) === String(p.id))
        : []
      setCircuits(siteCircuits)
      setLoading(false)
    })
  }, [params])

  async function toggleDecomm() {
    const isDecommed = site?.site_status === 'Decommed'
    const newStatus = isDecommed ? 'Active' : 'Decommed'
    const ok = await confirm({
      title: isDecommed ? 'Reactivate site' : 'Decommission site',
      message: isDecommed
        ? `Are you sure you want to reactivate "${site?.site}"?`
        : `Are you sure you want to decommission "${site?.site}"? This will be blocked if any devices are still active.`,
      confirmLabel: isDecommed ? 'Reactivate' : 'Decommission',
      danger: !isDecommed
    })
    if (!ok) return
    setTogglingDecomm(true)
    const res = await fetch('/api/sites/manage', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: site?.id, site_status: newStatus })
    })
    const d = await res.json()
    if (res.ok) {
      showToast(isDecommed ? 'Site reactivated' : 'Site decommissioned')
      const siteData = await fetch(`/api/sites/${site?.id}`).then(r => r.json())
      setData(siteData)
    } else {
      showToast(d.error || 'Failed to update site status', 'error')
    }
    setTogglingDecomm(false)
  }

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
  if (!data) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Site not found</div>

  const { site, devices } = data
  const s = site as any
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

  function formatSpeed(speed: string) {
    if (!speed || speed === 'nan') return '—'
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

  const mainUsages = ['main', 'primary internet', 'mpls primary']
  const backupUsages = ['backup', 'backup internet', 'mpls backup']
  const mainCircuits = circuits.filter(c => mainUsages.includes(c.usage?.toLowerCase()))
  const backupCircuits = circuits.filter(c => backupUsages.includes(c.usage?.toLowerCase()))
  const otherCircuits = circuits.filter(c => !mainUsages.includes(c.usage?.toLowerCase()) && !backupUsages.includes(c.usage?.toLowerCase()))

  function toggleSelect(id: string) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function toggleAll() {
    const ids = filtered.map((d: any) => d.id)
    if (selected.size === ids.length) setSelected(new Set())
    else setSelected(new Set(ids))
  }

  async function bulkUpdate() {
    if (!selected.size || !bulkValue) return
    setBulkLoading(true)
    const res = await fetch('/api/devices/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selected), field: bulkField, value: bulkValue })
    })
    if (res.ok) {
      showToast(`${selected.size} device${selected.size > 1 ? 's' : ''} updated`)
      const siteData = await fetch(`/api/sites/${(site as any).id}`).then(r => r.json())
      setData(siteData)
    } else {
      showToast('Failed to update devices', 'error')
    }
    setSelected(new Set())
    setBulkValue('')
    setBulkLoading(false)
  }



  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <Breadcrumb crumbs={[
          { label: 'Sites', href: '/sites' },
          { label: data.site.site || 'Site detail' },
        ]} />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ flex: 1, marginRight: '16px' }}>
          {editingSite ? (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Site name</label>
                <input className="input" style={{ width: '220px' }} value={siteForm.name} onChange={e => setSiteForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Site code</label>
                <input className="input" style={{ width: '120px' }} value={siteForm.code} onChange={e => setSiteForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. CEVA" />
              </div>
              <button className="btn-primary" disabled={savingSite} onClick={async () => {
                setSavingSite(true)
                await fetch(`/api/sites/${site.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(siteForm)
                })
                setData(d => d ? { ...d, site: { ...d.site, site: siteForm.name, code: siteForm.code } } : d)
                setEditingSite(false)
                setSavingSite(false)
              }}>{savingSite ? 'Saving...' : 'Save'}</button>
              <button className="btn-secondary" onClick={() => { setEditingSite(false); setSiteForm({ name: site.site, code: site.code }) }}>Cancel</button>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>{site.site}</h1>
                {isAdmin && (
                  <button onClick={() => setEditingSite(true)} style={{ padding: '3px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer', color: '#6b7280' }}>Edit</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', color: '#6b7280' }}>{site.country}</span>
                <span style={{ color: '#d1d5db' }}>·</span>
                <span style={{ fontSize: '13px', color: '#6b7280' }}>{site.region}</span>
                {site.code && <span style={{ fontSize: '11px', background: '#f3f4f6', color: '#6b7280', padding: '2px 8px', borderRadius: '20px' }}>{site.code}</span>}
              </div>
            </div>
          )}
        </div>
        {!editingSite && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              {site?.site_status === 'Decommed' && (
                <span style={{ background: '#f3f4f6', color: '#6b7280', fontSize: '12px', fontWeight: '600', padding: '4px 12px', borderRadius: '20px', border: '1px solid #d1d5db' }}>⚠ Decommed site</span>
              )}
              {isAdmin && (
                <button onClick={toggleDecomm} disabled={togglingDecomm} style={{ fontSize: '13px', padding: '6px 14px', borderRadius: '7px', border: '1px solid', cursor: 'pointer', fontWeight: '500', color: site?.site_status === 'Decommed' ? '#166534' : '#991b1b', borderColor: site?.site_status === 'Decommed' ? '#bbf7d0' : '#fca5a5', background: site?.site_status === 'Decommed' ? '#dcfce7' : '#fee2e2' }}>
                  {togglingDecomm ? 'Updating...' : site?.site_status === 'Decommed' ? 'Reactivate site' : 'Decommission site'}
                </button>
              )}
              {isAdmin && <Link href="/devices/new"><button className="btn-primary">+ Add device</button></Link>}
              {isAdmin && <Link href={`/circuits/new?site_id=${site.id}&site=${encodeURIComponent(site.site)}`}><button className="btn-secondary">+ Add circuit</button></Link>}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total devices', value: total, color: '#1a2744', bg: '#f0f4f8', border: '#c7d8e8' },
          { label: 'Active', value: active, color: '#166534', bg: '#dcfce7', border: '#86efac' },
          { label: 'EOL / EOS', value: eol, color: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
          { label: 'Decommed', value: decommed, color: '#92400e', bg: '#fef3c7', border: '#fcd34d' },
          { label: 'Circuits', value: circuits.length, color: '#075985', bg: '#e0f2fe', border: '#7dd3fc' },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, borderRadius: '8px', border: `1px solid ${s.border}`, padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: s.color, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600', opacity: 0.8 }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: '700', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Site info panel */}
      {(s.address || s.city || s.coordinates || s.contact_name || s.site_type) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px', marginBottom: '20px' }}>
          {s.site_type && (
            <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '12px 16px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Site type</div>
              <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{s.site_type}</div>
            </div>
          )}
          {(s.city || s.address) && (
            <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '12px 16px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Location</div>
              <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{s.city}</div>
              {s.address && <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px', lineHeight: '1.4' }}>{s.address}</div>}
            </div>
          )}
          {s.coordinates && (
            <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '12px 16px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>GPS coordinates</div>
              <div style={{ fontSize: '12px', fontFamily: 'monospace', color: '#374151' }}>{s.coordinates}</div>
              <a href={`https://www.google.com/maps?q=${s.coordinates}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '11px', color: '#C8102E', textDecoration: 'none', marginTop: '4px', display: 'inline-block' }}>
                Open in Maps →
              </a>
            </div>
          )}
          {(s.contact_name || s.contact_email || s.phone) && (
            <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '12px 16px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Site contact</div>
              {s.contact_name && <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{s.contact_name}</div>}
              {s.contact_email && <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>{s.contact_email}</div>}
              {s.phone && <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>{s.phone}</div>}
            </div>
          )}
        </div>
      )}

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
            {isAdmin && selected.size > 0 && (
              <div style={{ background: '#1a2744', borderRadius: '8px', padding: '10px 16px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '13px', color: 'white', fontWeight: '500' }}>{selected.size} device{selected.size > 1 ? 's' : ''} selected</span>
                <select value={bulkField} onChange={e => { setBulkField(e.target.value); setBulkValue('') }} style={{ padding: '5px 10px', borderRadius: '5px', fontSize: '12px', border: 'none', color: '#111827', background: 'rgba(255,255,255,0.9)' }}>
                  <option value="device_status">Device status</option>
                  <option value="lifecycle_status">Lifecycle status</option>
                </select>
                <select value={bulkValue} onChange={e => setBulkValue(e.target.value)} style={{ padding: '5px 10px', borderRadius: '5px', fontSize: '12px', border: 'none', color: '#111827', background: 'rgba(255,255,255,0.9)' }}>
                  <option value="">Set value...</option>
                  {bulkField === 'device_status' && ['Active','Decommed','Faulty, Replaced','Spare'].map(s => <option key={s}>{s}</option>)}
                  {bulkField === 'lifecycle_status' && ['Active, Supported','EOL / EOS','Unknown'].map(s => <option key={s}>{s}</option>)}
                </select>
                <button onClick={bulkUpdate} disabled={!bulkValue || bulkLoading} style={{ padding: '5px 14px', background: '#C8102E', color: 'white', border: 'none', borderRadius: '5px', fontSize: '12px', cursor: 'pointer', fontWeight: '500' }}>
                  {bulkLoading ? 'Updating...' : 'Apply'}
                </button>
                <button onClick={() => setSelected(new Set())} style={{ padding: '5px 10px', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)', border: 'none', borderRadius: '5px', fontSize: '12px', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <select className="select" style={{ width: "auto", minWidth: "130px" }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                {types.map(t => <option key={t}>{t}</option>)}
              </select>
              <select className="select" style={{ width: "auto", minWidth: "130px" }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                {['Active','Decommed','Faulty, Replaced','Spare'].map(s => <option key={s}>{s}</option>)}
              </select>
              {(typeFilter || statusFilter) && <button className="btn-secondary" style={{ fontSize: '13px' }} onClick={() => { setTypeFilter(''); setStatusFilter('') }}>Clear</button>}
              <span style={{ fontSize: '13px', color: '#9ca3af', alignSelf: 'center', marginLeft: 'auto' }}>{filtered.length} devices</span>
            </div>
            <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr>{isAdmin && <th style={{ width: '40px' }}><input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} /></th>}<th>Name</th><th>Type</th><th>Brand / Model</th><th>IP</th><th>Lifecycle</th><th>Status</th>{isAdmin && <th>Actions</th>}</tr></thead>
                  <tbody>
                    {filtered.map((d: any) => (
                      <tr key={d.id} style={{ background: selected.has(d.id) ? '#fef9f9' : undefined }}>
                        {isAdmin && <td><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} /></td>}
                        <td style={{ fontWeight: '500' }}><Link href={`/devices/${d.id}?from=site&siteId=${siteId}&siteName=${encodeURIComponent(site.site)}`} style={{ color: '#111827', textDecoration: 'none' }}>{d.name || '—'}</Link></td>
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
            <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af', background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb' }}>No Circuits for this site</div>
          ) : (
            <>
              {[{ label: 'Main links', items: mainCircuits, color: '#075985' }, { label: 'Backup links', items: backupCircuits, color: '#6b7280' }, { label: 'Other', items: otherCircuits, color: '#92400e' }].filter(g => g.items.length > 0).map(group => (
                <div key={group.label} style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: group.color, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>{group.label} — {group.items.length}</div>
                  <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                    <table>
                      <thead><tr><th>ISP</th><th>Circuit ID</th><th>Product</th><th>Usage</th><th>Max speed</th><th>Public subnet</th><th>Cost/month</th><th></th></tr></thead>
                      <tbody>
                        {group.items.map((c: Circuit) => (
                          <tr key={c.id}>
                            <td style={{ fontWeight: '500' }}>{c.isp}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.circuit_id || '—'}</td>
                            <td style={{ fontSize: '12px' }}>{c.product && c.product !== 'nan' ? c.product : '—'}</td>
                            <td><span className="badge" style={{ background: '#e0f2fe', color: '#075985' }}>{c.usage || '—'}</span></td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{formatSpeed(c.max_speed)}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{c.public_subnet && c.public_subnet !== '-' && c.public_subnet !== 'nan' ? c.public_subnet : '—'}</td>
                            <td style={{ fontSize: '12px' }}>{c.cost_month ? `${c.currency || 'THB'} ${parseFloat(c.cost_month).toLocaleString()}` : '—'}</td>
                            
                            <td><Link href={`/circuits/${c.id}`}><button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>View</button></Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
