'use client'
import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

type Device = {
  id: string; name: string; brand: string; model: string; device_type: string
  ip_address: string; site: string; country: string; region: string
  lifecycle_status: string; device_status: string; serial_number: string
}

type Duplicate = { field: string; value: string; count: number; device_ids: string[] }

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { 'Active': 'badge-active', 'Decommed': 'badge-decommed', 'Faulty, Replaced': 'badge-faulty', 'Spare': 'badge-spare' }
  return <span className={`badge ${map[status] || 'badge-unknown'}`}>{status}</span>
}

function LifecycleBadge({ status }: { status: string }) {
  if (status === 'EOL / EOS') return <span className="badge badge-eol">EOL</span>
  if (status === 'Active, Supported') return <span className="badge badge-active">Supported</span>
  return <span className="badge badge-unknown">Unknown</span>
}

export default function DevicesPage() {
  const { data: session } = useSession()
  const searchParams = useSearchParams()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'site_admin'

  const [devices, setDevices] = useState<Device[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [region, setRegion] = useState('')
  const [site, setSite] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [lifecycle, setLifecycle] = useState('')
  const [lookups, setLookups] = useState<{ regions: string[]; sites: {site:string;id:number;region:string}[]; deviceTypes: string[] }>({ regions: [], sites: [], deviceTypes: [] })
  const [stats, setStats] = useState({ total: 0, active: 0, eol: 0, decommed: 0 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkField, setBulkField] = useState('device_status')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPreview, setImportPreview] = useState<any[]>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState('')
  const [duplicates, setDuplicates] = useState<Duplicate[]>([])
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [dupLoading, setDupLoading] = useState(false)

  // Read URL params on mount and when they change
  useEffect(() => {
    setSearch(searchParams.get('search') || '')
    setRegion(searchParams.get('region') || '')
    setSite(searchParams.get('site') || '')
    setType(searchParams.get('type') || '')
    setStatus(searchParams.get('status') || '')
    setLifecycle(searchParams.get('lifecycle') || '')
    setPage(1)
  }, [searchParams])

  useEffect(() => {
    fetch('/api/lookup').then(r => r.json()).then(setLookups)
    Promise.all([
      fetch('/api/devices?limit=1').then(r => r.json()),
      fetch('/api/devices?status=Active&limit=1').then(r => r.json()),
      fetch('/api/devices?lifecycle=EOL+%2F+EOS&limit=1').then(r => r.json()),
      fetch('/api/devices?status=Decommed&limit=1').then(r => r.json()),
    ]).then(([all, active, eol, decommed]) => {
      setStats({ total: all.total, active: active.total, eol: eol.total, decommed: decommed.total })
    })
  }, [])

  const fetchDevices = useCallback(async () => {
    setLoading(true)
    setSelected(new Set())
    const params = new URLSearchParams({
      page: String(page), limit: '50',
      ...(search && { search }),
      ...(region && { region }),
      ...(site && { site }),
      ...(type && { type }),
      ...(status && { status }),
      ...(lifecycle && { lifecycle }),
    })
    const res = await fetch(`/api/devices?${params}`)
    const data = await res.json()
    setDevices(data.devices || [])
    setTotal(data.total || 0)
    setLoading(false)
  }, [page, search, region, site, type, status, lifecycle])

  useEffect(() => { fetchDevices() }, [fetchDevices])

  async function checkDuplicates() {
    setDupLoading(true)
    const res = await fetch('/api/devices/duplicates')
    const data = await res.json()
    setDuplicates(data.duplicates || [])
    setShowDuplicates(true)
    setDupLoading(false)
  }

  function exportCSV() {
    const params = new URLSearchParams()
    if (search)    params.set('search', search)
    if (region)    params.set('region', region)
    if (site)      params.set('site', site)
    if (type)      params.set('type', type)
    if (status)    params.set('status', status)
    if (lifecycle) params.set('lifecycle', lifecycle)
    window.location.href = `/api/export?${params.toString()}`
  }

  function toggleSelect(id: string) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function toggleAll() {
    if (selected.size === devices.length) setSelected(new Set())
    else setSelected(new Set(devices.map(d => d.id)))
  }

  async function bulkUpdate() {
    if (!selected.size || !bulkValue) return
    setBulkLoading(true)
    await fetch('/api/devices/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selected), field: bulkField, value: bulkValue })
    })
    setBulkLoading(false)
    setSelected(new Set())
    setBulkValue('')
    fetchDevices()
  }

  async function deleteDevice(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    await fetch(`/api/devices/${id}`, { method: 'DELETE' })
    fetchDevices()
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportFile(file); setImportResult('')
    const formData = new FormData(); formData.append('file', file)
    setImportLoading(true)
    const res = await fetch('/api/import/preview', { method: 'POST', body: formData })
    const data = await res.json()
    setImportPreview(data.preview || [])
    setImportLoading(false)
  }

  async function confirmImport() {
    if (!importFile) return
    setImportLoading(true)
    const formData = new FormData(); formData.append('file', importFile)
    const res = await fetch('/api/import', { method: 'POST', body: formData })
    const data = await res.json()
    setImportResult(`Done! Imported: ${data.inserted}, Skipped: ${data.skipped}`)
    setImportLoading(false); setImportFile(null); setImportPreview([])
    fetchDevices()
  }

  const totalPages = Math.ceil(total / 50)
  const filteredSites = region ? lookups.sites.filter((s: any) => s.region === region) : lookups.sites
  const hasFilters = !!(search || region || site || type || status || lifecycle)

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Devices</h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>IT asset inventory</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-secondary" onClick={exportCSV} style={{ fontSize: '13px' }}>
            {hasFilters ? 'Export filtered CSV' : 'Export CSV'}
          </button>
          {isAdmin && <>
            <button className="btn-secondary" onClick={checkDuplicates} disabled={dupLoading} style={{ fontSize: '13px' }}>
              {dupLoading ? 'Checking...' : 'Check duplicates'}
            </button>
            <button className="btn-secondary" onClick={() => { setShowImport(!showImport); setImportResult('') }} style={{ fontSize: '13px' }}>Import</button>
            <Link href="/devices/new"><button className="btn-primary">+ Add device</button></Link>
          </>}
        </div>
      </div>

      {/* Duplicates panel */}
      {showDuplicates && (
        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #fbbf24', padding: '20px 24px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#92400e', margin: 0 }}>
              Duplicate detection {duplicates.length === 0 ? '— No duplicates found' : `— ${duplicates.length} issue(s) found`}
            </h3>
            <button onClick={() => setShowDuplicates(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: '#9ca3af' }}>×</button>
          </div>
          {duplicates.length === 0 ? (
            <p style={{ fontSize: '13px', color: '#166534', margin: 0 }}>All devices have unique IP addresses and serial numbers.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {duplicates.map((d, i) => (
                <div key={i} style={{ background: '#fef3c7', borderRadius: '6px', padding: '10px 14px', fontSize: '13px' }}>
                  <span style={{ fontWeight: '600', color: '#92400e' }}>{d.field}: </span>
                  <span style={{ fontFamily: 'monospace', color: '#111827' }}>{d.value}</span>
                  <span style={{ color: '#6b7280' }}> — appears {d.count} times</span>
                  <div style={{ marginTop: '4px', display: 'flex', gap: '6px', flexWrap: 'wrap' as const }}>
                    {d.device_ids.map(id => (
                      <Link key={id} href={`/devices/${id}`} style={{ fontSize: '11px', color: '#C8102E', textDecoration: 'underline' }}>View device</Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Import panel */}
      {showImport && isAdmin && (
        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Import devices from Excel / CSV</h3>
          <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>File must have columns: Name, Brand, Model, S/N, Type, IP Address, Site, Country, Lifecycle Status, Device Status</p>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' }}>
            <input type="file" accept=".xlsx,.csv" onChange={handleImportFile} style={{ fontSize: '13px' }} />
            {importLoading && <span style={{ fontSize: '13px', color: '#9ca3af' }}>Processing...</span>}
          </div>
          {importPreview.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', color: '#374151', marginBottom: '8px', fontWeight: '500' }}>Preview — first {importPreview.length} rows:</div>
              <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: '6px' }}>
                <table style={{ fontSize: '12px', minWidth: '600px' }}>
                  <thead><tr>{Object.keys(importPreview[0] || {}).slice(0, 7).map(k => <th key={k}>{k}</th>)}</tr></thead>
                  <tbody>
                    {importPreview.map((row, i) => (
                      <tr key={i}>{Object.values(row).slice(0, 7).map((v: any, j) => <td key={j}>{String(v || '—')}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn-primary" onClick={confirmImport} disabled={importLoading} style={{ marginTop: '10px' }}>
                {importLoading ? 'Importing...' : 'Confirm import'}
              </button>
            </div>
          )}
          {importResult && <div style={{ background: '#dcfce7', color: '#166534', padding: '10px 14px', borderRadius: '6px', fontSize: '13px' }}>{importResult}</div>}
        </div>
      )}

      {/* Bulk action bar */}
      {isAdmin && selected.size > 0 && (
        <div style={{ background: '#1a2744', borderRadius: '8px', padding: '10px 16px', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', color: 'white', fontWeight: '500' }}>{selected.size} device{selected.size > 1 ? 's' : ''} selected</span>
          <select value={bulkField} onChange={e => { setBulkField(e.target.value); setBulkValue('') }} style={{ padding: '5px 10px', borderRadius: '5px', fontSize: '12px', border: 'none', color: '#111827', background: 'rgba(255,255,255,0.9)' }}>
            <option value="device_status">Device status</option>
            <option value="lifecycle_status">Lifecycle status</option>
            <option value="site_id">Move to site</option>
          </select>
          <select value={bulkValue} onChange={e => setBulkValue(e.target.value)} style={{ padding: '5px 10px', borderRadius: '5px', fontSize: '12px', border: 'none', color: '#111827', background: 'rgba(255,255,255,0.9)' }}>
            <option value="">Set value...</option>
            {bulkField === 'device_status' && ['Active','Decommed','Faulty, Replaced','Spare'].map(s => <option key={s}>{s}</option>)}
            {bulkField === 'lifecycle_status' && ['Active, Supported','EOL / EOS','Unknown'].map(s => <option key={s}>{s}</option>)}
            {bulkField === 'site_id' && lookups.sites.map((s: any) => <option key={s.id} value={s.id}>{s.site}</option>)}
          </select>
          <button onClick={bulkUpdate} disabled={!bulkValue || bulkLoading} style={{ padding: '5px 14px', background: '#C8102E', color: 'white', border: 'none', borderRadius: '5px', fontSize: '12px', cursor: 'pointer', fontWeight: '500' }}>
            {bulkLoading ? 'Updating...' : 'Apply'}
          </button>
          <button onClick={() => setSelected(new Set())} style={{ padding: '5px 10px', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)', border: 'none', borderRadius: '5px', fontSize: '12px', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total devices', value: stats.total.toLocaleString(), color: '#1a2744' },
          { label: 'Active', value: stats.active.toLocaleString(), color: '#166534' },
          { label: 'EOL / EOS', value: stats.eol.toLocaleString(), color: '#991b1b' },
          { label: 'Decommed', value: stats.decommed.toLocaleString(), color: '#92400e' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: '700', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Active filters banner */}
      {hasFilters && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '13px', color: '#1d4ed8' }}>
            Showing filtered results:
            {status && <span style={{ marginLeft: '8px', background: '#dbeafe', padding: '1px 8px', borderRadius: '10px' }}>Status: {status}</span>}
            {lifecycle && <span style={{ marginLeft: '8px', background: '#dbeafe', padding: '1px 8px', borderRadius: '10px' }}>Lifecycle: {lifecycle}</span>}
            {region && <span style={{ marginLeft: '8px', background: '#dbeafe', padding: '1px 8px', borderRadius: '10px' }}>Region: {region}</span>}
            {site && <span style={{ marginLeft: '8px', background: '#dbeafe', padding: '1px 8px', borderRadius: '10px' }}>Site: {site}</span>}
            {type && <span style={{ marginLeft: '8px', background: '#dbeafe', padding: '1px 8px', borderRadius: '10px' }}>Type: {type}</span>}
            {search && <span style={{ marginLeft: '8px', background: '#dbeafe', padding: '1px 8px', borderRadius: '10px' }}>Search: {search}</span>}
          </div>
          <button onClick={() => { setSearch(''); setRegion(''); setSite(''); setType(''); setStatus(''); setLifecycle(''); setPage(1) }} style={{ fontSize: '12px', color: '#1d4ed8', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
            Clear all
          </button>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' as const, alignItems: 'center' }}>
        <input className="input" style={{ flex: '1', minWidth: '200px', maxWidth: '320px' }} placeholder="Search name, IP, model, serial..." value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
        <select className="select" style={{ width: 'auto', minWidth: '130px' }} value={region} onChange={e => { setRegion(e.target.value); setSite(''); setPage(1) }}>
          <option value="">All regions</option>
          {lookups.regions.map(r => <option key={r}>{r}</option>)}
        </select>
        <select className="select" style={{ width: 'auto', minWidth: '150px' }} value={site} onChange={e => { setSite(e.target.value); setPage(1) }}>
          <option value="">All sites</option>
          {filteredSites.map((s: any) => <option key={s.site} value={s.site}>{s.site}</option>)}
        </select>
        <select className="select" style={{ width: 'auto', minWidth: '130px' }} value={type} onChange={e => { setType(e.target.value); setPage(1) }}>
          <option value="">All types</option>
          {lookups.deviceTypes.map(t => <option key={t}>{t}</option>)}
        </select>
        <select className="select" style={{ width: 'auto', minWidth: '130px' }} value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}>
          <option value="">All statuses</option>
          {['Active','Decommed','Faulty, Replaced','Spare'].map(s => <option key={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 'auto', minWidth: '140px' }} value={lifecycle} onChange={e => { setLifecycle(e.target.value); setPage(1) }}>
          <option value="">All lifecycle</option>
          <option value="EOL / EOS">EOL / EOS</option>
          <option value="Active, Supported">Active, Supported</option>
          <option value="Unknown">Unknown</option>
        </select>
        {hasFilters && (
          <button className="btn-secondary" style={{ fontSize: '13px' }} onClick={() => { setSearch(''); setRegion(''); setSite(''); setType(''); setStatus(''); setLifecycle(''); setPage(1) }}>Clear</button>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading devices...</div>
        ) : devices.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>No devices found</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  {isAdmin && <th style={{ width: '40px' }}><input type="checkbox" checked={selected.size === devices.length && devices.length > 0} onChange={toggleAll} /></th>}
                  <th>Name</th><th>Type</th><th>Brand / Model</th><th>IP address</th>
                  <th>Site</th><th>Region</th><th>Lifecycle</th><th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id} style={{ background: selected.has(d.id) ? '#fef9f9' : undefined }}>
                    {isAdmin && <td><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} /></td>}
                    <td style={{ fontWeight: '500', color: '#111827' }}>
                      <Link href={`/devices/${d.id}`} style={{ color: '#111827', textDecoration: 'none' }}>{d.name || '—'}</Link>
                    </td>
                    <td>{d.device_type}</td>
                    <td title={`${d.brand} ${d.model}`}>{d.brand} {d.model}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{d.ip_address || '—'}</td>
                    <td>{d.site}</td>
                    <td><span style={{ fontSize: '11px', color: '#6b7280' }}>{d.region}</span></td>
                    <td><LifecycleBadge status={d.lifecycle_status} /></td>
                    <td><StatusBadge status={d.device_status} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Link href={`/devices/${d.id}`}><button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>View</button></Link>
                        {isAdmin && <>
                          <Link href={`/devices/${d.id}/edit`}><button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }}>Edit</button></Link>
                          <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteDevice(d.id, d.name)}>Delete</button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && totalPages > 1 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>Showing {((page-1)*50)+1}–{Math.min(page*50, total)} of {total.toLocaleString()}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1}>← Prev</button>
              <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={() => setPage(p => Math.min(totalPages,p+1))} disabled={page===totalPages}>Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
