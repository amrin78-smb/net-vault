'use client'
import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge, LifecycleBadge } from '@/components/Badges'
import { useToast, useConfirm } from '@/app/providers'

type Device = {
  id: string; name: string; brand: string; model: string; device_type: string
  ip_address: string; site: string; country: string; region: string
  lifecycle_status: string; device_status: string; serial_number: string
}

type Duplicate = { field: string; value: string; count: number; classification: string; color: string; devices: { id: string; name: string; site: string; device_type: string; serial: string }[] }

export default function DevicesPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'site_admin'
  const isSiteAdmin = user?.role === 'site_admin'
  const sessionUser = session?.user as { role?: string; siteIds?: number[] } | undefined

  const [devices, setDevices] = useState<Device[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(50)
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
  const [importSkipped, setImportSkipped] = useState<{row:number;name:string;reason:string}[]>([])
  const [showSkipped, setShowSkipped] = useState(false)
  const [dryRun, setDryRun] = useState(true)
  const [dryRunResult, setDryRunResult] = useState<{inserted: number; updated: number; skipped: number; skippedRows: any[]} | null>(null)
  const [duplicates, setDuplicates] = useState<Duplicate[]>([])
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [dupLoading, setDupLoading] = useState(false)
  const [showFilterPanel, setShowFilterPanel] = useState(false)

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
    // Read directly from URL to avoid state sync timing issues
    const s = searchParams.get('search') || ''
    const r = searchParams.get('region') || ''
    const si = searchParams.get('site') || ''
    const t = searchParams.get('type') || ''
    const st = searchParams.get('status') || ''
    const lc = searchParams.get('lifecycle') || ''
    const params = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (s)  params.set('search', s)
    if (r)  params.set('region', r)
    if (si) params.set('site', si)
    if (t)  params.set('type', t)
    if (st) params.set('status', st)
    if (lc) params.set('lifecycle', lc)
    const res = await fetch(`/api/devices?${params}`)
    const data = await res.json()
    setDevices(data.devices || [])
    setTotal(data.total || 0)
    setLoading(false)
  }, [page, limit, searchParams])

  useEffect(() => { fetchDevices() }, [fetchDevices])

  function pushFilters(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams()
    const current = { search, region, site, type, status, lifecycle, ...overrides }
    if (current.search)    params.set('search', current.search)
    if (current.region)    params.set('region', current.region)
    if (current.site)      params.set('site', current.site)
    if (current.type)      params.set('type', current.type)
    if (current.status)    params.set('status', current.status)
    if (current.lifecycle) params.set('lifecycle', current.lifecycle)
    router.push(`/devices${params.toString() ? '?' + params.toString() : ''}`)
  }

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
    const res = await fetch('/api/devices/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selected), field: bulkField, value: bulkValue })
    })
    if (res.ok) {
      showToast(`${selected.size} device${selected.size > 1 ? 's' : ''} updated successfully`)
    } else {
      showToast('Failed to update devices', 'error')
    }
    setBulkLoading(false)
    setSelected(new Set())
    setBulkValue('')
    fetchDevices()
  }

  async function deleteDevice(id: string, name: string) {
    const ok = await confirm({
      title: 'Delete device',
      message: `Are you sure you want to delete "${name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' })
    if (res.ok) {
      showToast(`"${name}" deleted`)
      fetchDevices()
    } else {
      showToast('Failed to delete device', 'error')
    }
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

  async function runImport(dry: boolean) {
    if (!importFile) return
    setImportLoading(true)
    const formData = new FormData()
    formData.append('file', importFile)
    formData.append('dryRun', String(dry))
    const res = await fetch('/api/import', { method: 'POST', body: formData })
    const data = await res.json()
    if (dry) {
      setDryRunResult(data)
      setImportSkipped(data.skippedRows || [])
      setShowSkipped(data.skipped > 0)
    } else {
      setImportResult(`Inserted: ${data.inserted}, Updated: ${data.updated || 0}, Skipped: ${data.skipped}`)
      setImportSkipped(data.skippedRows || [])
      setShowSkipped(data.skipped > 0)
      setDryRunResult(null)
      setImportLoading(false); setImportFile(null); setImportPreview([])
      showToast(`Import complete: ${data.inserted} inserted, ${data.updated || 0} updated, ${data.skipped} skipped`, data.skipped > 0 ? 'info' : 'success')
      fetchDevices()
      return
    }
    setImportLoading(false)
  }
  async function confirmImport() { await runImport(false) }

  const totalPages = Math.ceil(total / limit)
  const hasFilters = !!(search || region || site || type || status || lifecycle)

  // For site admins, filter lookups to only show their assigned sites
  const availableSites = isSiteAdmin && sessionUser?.siteIds?.length
    ? lookups.sites.filter((s: any) => sessionUser.siteIds!.includes(s.id))
    : lookups.sites
  const filteredSites = region
    ? availableSites.filter((s: any) => s.region === region)
    : availableSites
  const availableRegions = isSiteAdmin && sessionUser?.siteIds?.length
    ? [...new Set(availableSites.map((s: any) => s.region).filter(Boolean))]
    : lookups.regions

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Devices</h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>IT asset inventory</p>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {/* Export */}
          <button onClick={exportCSV} title={hasFilters ? 'Export filtered CSV' : 'Export CSV'}
            style={{ padding: '7px 10px', background: 'white', border: '1px solid #e5e7eb', borderRadius: '7px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
            onMouseLeave={e => (e.currentTarget.style.background = 'white')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Export
          </button>
          {isAdmin && <>
            {/* Import */}
            <button onClick={() => { setShowImport(!showImport); setImportResult('') }} title="Import devices"
              style={{ padding: '7px 10px', background: showImport ? '#eff6ff' : 'white', border: showImport ? '1px solid #bfdbfe' : '1px solid #e5e7eb', borderRadius: '7px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: showImport ? '#1d4ed8' : '#374151' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
              onMouseLeave={e => (e.currentTarget.style.background = showImport ? '#eff6ff' : 'white')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
              Import
            </button>
            {/* Check duplicates */}
            <button onClick={checkDuplicates} disabled={dupLoading} title="Check for duplicate devices"
              style={{ padding: '7px 10px', background: 'white', border: '1px solid #e5e7eb', borderRadius: '7px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
              onMouseLeave={e => (e.currentTarget.style.background = 'white')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
              {dupLoading ? 'Checking...' : 'Duplicates'}
            </button>
            {/* Add device */}
            <Link href="/devices/new">
              <button style={{ padding: '7px 14px', background: '#C8102E', color: 'white', border: 'none', borderRadius: '7px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: '500' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
                Add device
              </button>
            </Link>
          </>}
        </div>
      </div>

      {/* Duplicates panel */}
      {showDuplicates && (
        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #fbbf24', padding: '20px 24px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#92400e', margin: 0 }}>
              Duplicate detection {duplicates.length === 0 ? '— No duplicates found' : `— ${duplicates.length} groups found`}
            </h3>
            <button onClick={() => setShowDuplicates(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: '#9ca3af' }}>×</button>
          </div>
          {duplicates.length === 0 ? (
            <p style={{ fontSize: '13px', color: '#166534', margin: 0 }}>All devices have unique IP addresses and serial numbers.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Summary */}
              {(() => {
                const red = duplicates.filter(d => d.classification?.startsWith('🔴')).length
                const yellow = duplicates.filter(d => d.classification?.startsWith('🟡')).length
                const green = duplicates.filter(d => d.classification?.startsWith('🟢')).length
                return (
                  <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' as const }}>
                    {red > 0 && <span style={{ background: '#fee2e2', color: '#991b1b', padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>🔴 {red} likely duplicates</span>}
                    {yellow > 0 && <span style={{ background: '#fef9c3', color: '#92400e', padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>🟡 {yellow} needs review</span>}
                    {green > 0 && <span style={{ background: '#dcfce7', color: '#166534', padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>🟢 {green} likely valid</span>}
                  </div>
                )
              })()}
              {duplicates.map((d, i) => (
                <div key={i} style={{ background: d.color || '#fef3c7', borderRadius: '6px', padding: '10px 14px', fontSize: '13px', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const, marginBottom: '4px' }}>
                    <span style={{ fontWeight: '600', color: '#374151' }}>{d.field}: </span>
                    <span style={{ fontFamily: 'monospace', color: '#111827' }}>{d.value}</span>
                    <span style={{ color: '#6b7280' }}>— {d.count} devices</span>
                    <span style={{ fontSize: '12px', color: '#374151' }}>{d.classification}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' as const }}>
                    {(d.devices || []).map(dev => (
                      <div key={dev.id} style={{ fontSize: '11px', color: '#374151' }}>
                        <Link href={`/devices/${dev.id}`} style={{ color: '#C8102E', textDecoration: 'underline', fontWeight: '500' }}>{dev.name || 'Unnamed'}</Link>
                        <Link href={`/devices/${dev.id}/edit`} style={{ color: '#6b7280', fontSize: '10px', marginLeft: '4px', textDecoration: 'underline' }}>edit</Link>
                        <span style={{ color: '#6b7280' }}> · {dev.site} · {dev.device_type}</span>
                        {dev.serial && dev.serial !== 'nan' && <span style={{ color: '#9ca3af' }}> · S/N: {dev.serial}</span>}
                      </div>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
            <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>File must have columns: Name, Brand, Model, S/N, Type, IP Address, Site, Country, Lifecycle Status, Device Status</p>
            <button className="btn-secondary" onClick={() => {
              const headers = ['Name','Brand','Model','S/N','Type','IP Address','Site','Country','Lifecycle Status','Device Status']
              const example = ['SW-CORE-01','Cisco','C9300-48P','FHH1234X001','Switch','192.168.1.1','Bangkok HQ','Thailand','Active, Supported','Active']
              const csv = [headers.join(','), example.join(',')].join('\n')
              const blob = new Blob([csv], { type: 'text/csv' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url; a.download = 'NetVault_Import_Template.csv'; a.click()
              URL.revokeObjectURL(url)
            }} style={{ fontSize: '12px', whiteSpace: 'nowrap', marginLeft: '16px', flexShrink: 0 }}>
              ⬇ Download template
            </button>
          </div>
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
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' as const }}>
                <button className="btn-secondary" onClick={() => runImport(true)} disabled={importLoading}>
                  {importLoading && dryRunResult === null ? 'Validating...' : '🔍 Validate (dry run)'}
                </button>
                {dryRunResult && (
                  <span style={{ fontSize: '13px', color: dryRunResult.skipped > 0 ? '#92400e' : '#166534', fontWeight: '500' }}>
                    ✓ {dryRunResult.inserted} will be inserted, {dryRunResult.updated || 0} will be updated, {dryRunResult.skipped} will be skipped
                  </span>
                )}
                <button className="btn-primary" onClick={confirmImport} disabled={importLoading}>
                  {importLoading && dryRunResult !== null ? 'Importing...' : 'Confirm import'}
                </button>
              </div>
            </div>
          )}
          {importResult && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ background: '#dcfce7', color: '#166534', padding: '10px 14px', borderRadius: '6px', fontSize: '13px', marginBottom: '8px' }}>
                {importResult}
              </div>
              {showSkipped && importSkipped.length > 0 && (
                <div style={{ background: 'white', border: '1px solid #fbbf24', borderRadius: '8px', overflow: 'hidden' }}>
                  <div style={{ background: '#fef3c7', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: '600', color: '#92400e' }}>{importSkipped.length} rows skipped — see reasons below</span>
                    <button onClick={() => setShowSkipped(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '16px' }}>×</button>
                  </div>
                  <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                    <table style={{ fontSize: '12px', width: '100%' }}>
                      <thead>
                        <tr style={{ background: '#f9fafb' }}>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: '600', width: '60px' }}>Row</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: '600', width: '180px' }}>Device name</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: '600' }}>Reason skipped</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importSkipped.map((s, i) => (
                          <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '7px 12px', color: '#9ca3af', fontFamily: 'monospace' }}>{s.row}</td>
                            <td style={{ padding: '7px 12px', color: '#111827', fontWeight: '500' }}>{s.name}</td>
                            <td style={{ padding: '7px 12px', color: '#991b1b' }}>{s.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
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
          { label: 'Total devices', value: stats.total.toLocaleString(), color: '#1a2744', bg: '#f0f4f8', border: '#c7d8e8' },
          { label: 'Active', value: stats.active.toLocaleString(), color: '#166534', bg: '#dcfce7', border: '#86efac' },
          { label: 'EOL / EOS', value: stats.eol.toLocaleString(), color: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
          { label: 'Decommed', value: stats.decommed.toLocaleString(), color: '#92400e', bg: '#fef3c7', border: '#fcd34d' },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, borderRadius: '8px', border: `1px solid ${s.border}`, padding: '14px 16px' }}>
            <div style={{ fontSize: '12px', color: s.color, marginBottom: '4px', fontWeight: '500', opacity: 0.8 }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: '700', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Site admin scope banner */}
      {isSiteAdmin && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', fontSize: '13px', color: '#1d4ed8' }}>
          Showing devices for your assigned sites only.
        </div>
      )}

      {/* Search + Filter bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        <input className="input" style={{ flex: '1', maxWidth: '400px' }} placeholder="Search name, IP, model, serial..." value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          onBlur={e => pushFilters({ search: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter') pushFilters({ search: (e.target as HTMLInputElement).value }) }} />
        <button
          onClick={() => setShowFilterPanel(f => !f)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', background: showFilterPanel || hasFilters ? '#1a2744' : 'white', color: showFilterPanel || hasFilters ? 'white' : '#374151', border: '1px solid ' + (showFilterPanel || hasFilters ? '#1a2744' : '#e5e7eb'), borderRadius: '7px', cursor: 'pointer', fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap' as const }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          Filters {hasFilters && `(${[region,site,type,status,lifecycle].filter(Boolean).length})`}
        </button>
        {hasFilters && (
          <button onClick={() => router.push('/devices')} style={{ fontSize: '12px', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' as const }}>
            Clear all
          </button>
        )}
      </div>

      {/* Filter panel */}
      {showFilterPanel && (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginBottom: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Region</div>
            <select className="select" style={{ width: '100%' }} value={region} onChange={e => { setSite(''); pushFilters({ region: e.target.value, site: '' }) }}>
              <option value="">All regions</option>
              {(isSiteAdmin ? availableRegions : lookups.regions).map((r: string) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Site</div>
            <select className="select" style={{ width: '100%' }} value={site} onChange={e => pushFilters({ site: e.target.value })}>
              <option value="">All sites</option>
              {filteredSites.map((s: any) => <option key={s.site} value={s.site}>{s.site}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Type</div>
            <select className="select" style={{ width: '100%' }} value={type} onChange={e => pushFilters({ type: e.target.value })}>
              <option value="">All types</option>
              {lookups.deviceTypes.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Status</div>
            <select className="select" style={{ width: '100%' }} value={status} onChange={e => pushFilters({ status: e.target.value })}>
              <option value="">All statuses</option>
              {['Active','Decommed','Faulty, Replaced','Spare'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Lifecycle</div>
            <select className="select" style={{ width: '100%' }} value={lifecycle} onChange={e => pushFilters({ lifecycle: e.target.value })}>
              <option value="">All lifecycle</option>
              <option value="EOL / EOS">EOL / EOS</option>
              <option value="Active, Supported">Active, Supported</option>
              <option value="Unknown">Unknown</option>
            </select>
          </div>
        </div>
      )}

      {/* Active filter pills */}
      {hasFilters && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' as const, marginBottom: '12px' }}>
          {region && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500' }}>Region: {region}<button onClick={() => pushFilters({ region: '', site: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: '14px', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {site && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500' }}>Site: {site}<button onClick={() => pushFilters({ site: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: '14px', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {type && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500' }}>Type: {type}<button onClick={() => pushFilters({ type: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: '14px', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {status && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500' }}>Status: {status}<button onClick={() => pushFilters({ status: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: '14px', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {lifecycle && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500' }}>Lifecycle: {lifecycle}<button onClick={() => pushFilters({ lifecycle: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: '14px', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {search && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#e0f2fe', color: '#075985', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '500' }}>Search: {search}<button onClick={() => pushFilters({ search: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#075985', fontSize: '14px', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '13px', color: '#6b7280' }}>
            {loading ? 'Loading...' : `Showing ${total === 0 ? 0 : ((page-1)*limit)+1}–${Math.min(page*limit, total)} of ${total.toLocaleString()} devices`}
          </span>
          <select value={limit} onChange={e => { setLimit(parseInt(e.target.value)); setPage(1) }}
            style={{ padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '12px', color: '#374151', background: 'white', cursor: 'pointer' }}>
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
            <option value={200}>200 / page</option>
          </select>
        </div>
        {!loading && totalPages > 1 && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button style={{ padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', background: 'white', fontSize: '12px', cursor: page === 1 ? 'default' : 'pointer', color: page === 1 ? '#d1d5db' : '#374151' }} onClick={() => setPage(1)} disabled={page === 1}>First</button>
            <button style={{ padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', background: 'white', fontSize: '12px', cursor: page === 1 ? 'default' : 'pointer', color: page === 1 ? '#d1d5db' : '#374151' }} onClick={() => setPage(p => Math.max(1,p-1))} disabled={page === 1}>← Prev</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const start = Math.max(1, Math.min(page - 2, totalPages - 4))
              const p = start + i
              return p <= totalPages ? (
                <button key={p} onClick={() => setPage(p)}
                  style={{ padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', background: p === page ? '#C8102E' : 'white', color: p === page ? 'white' : '#374151', fontWeight: p === page ? '600' : '400' }}>
                  {p}
                </button>
              ) : null
            })}
            <button style={{ padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', background: 'white', fontSize: '12px', cursor: page === totalPages ? 'default' : 'pointer', color: page === totalPages ? '#d1d5db' : '#374151' }} onClick={() => setPage(p => Math.min(totalPages,p+1))} disabled={page === totalPages}>Next →</button>
            <button style={{ padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', background: 'white', fontSize: '12px', cursor: page === totalPages ? 'default' : 'pointer', color: page === totalPages ? '#d1d5db' : '#374151' }} onClick={() => setPage(totalPages)} disabled={page === totalPages}>Last</button>
          </div>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '16px' }}>
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{ display: 'flex', gap: '12px', padding: '12px 8px', borderBottom: '1px solid #f3f4f6', alignItems: 'center' }}>
                <div className="skeleton" style={{ width: '16px', height: '16px', borderRadius: '3px', flexShrink: 0 }} />
                <div className="skeleton" style={{ width: '180px', height: '14px' }} />
                <div className="skeleton" style={{ width: '100px', height: '14px' }} />
                <div className="skeleton" style={{ width: '140px', height: '14px' }} />
                <div className="skeleton" style={{ width: '110px', height: '14px' }} />
                <div className="skeleton" style={{ width: '90px', height: '14px' }} />
                <div className="skeleton" style={{ width: '60px', height: '14px' }} />
                <div className="skeleton" style={{ width: '70px', height: '20px', borderRadius: '10px' }} />
                <div className="skeleton" style={{ width: '60px', height: '20px', borderRadius: '10px' }} />
              </div>
            ))}
          </div>
        ) : devices.length === 0 ? (
          <div style={{ padding: '60px 40px', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔍</div>
            <div style={{ fontSize: '15px', fontWeight: '600', color: '#374151', marginBottom: '6px' }}>No devices found</div>
            <div style={{ fontSize: '13px', color: '#9ca3af' }}>
              {hasFilters ? 'Try adjusting or clearing your filters.' : 'No devices have been added yet.'}
            </div>
          </div>
        ) : (
          <div className="table-container">
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
