'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import SitesImportModal from './SitesImportModal'

type Site = {
  id: string; site: string; code: string; country: string
  iso_code: string; region: string; total: string; active: string
  decommed: string; eol: string; spare: string; last_updated: string; site_status: string
}

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [region, setRegion] = useState('')
  const [search, setSearch] = useState('')
  const [showImport, setShowImport] = useState(false)

  const fetchSites = useCallback(() => {
    setLoading(true)
    return fetch('/api/sites').then(r => r.json()).then(d => { setSites(d); setLoading(false) })
  }, [])

  useEffect(() => { fetchSites() }, [fetchSites])

  const regions = [...new Set(sites.map(s => s.region))]
  const filtered = sites.filter(s => {
    const matchRegion = !region || s.region === region
    const matchSearch = !search || s.site.toLowerCase().includes(search.toLowerCase()) || s.country.toLowerCase().includes(search.toLowerCase())
    return matchRegion && matchSearch
  })

  const grouped = filtered.reduce((acc, s) => {
    const key = `${s.region}|${s.country}`
    if (!acc[key]) acc[key] = { region: s.region, country: s.country, sites: [] }
    acc[key].sites.push(s)
    return acc
  }, {} as Record<string, { region: string; country: string; sites: Site[] }>)

  const totalDevices = filtered.reduce((s, r) => s + parseInt(r.total), 0)
  const totalEol = filtered.reduce((s, r) => s + parseInt(r.eol), 0)

  function riskColor(eol: number, total: number, siteStatus?: string) {
    if (siteStatus === 'Decommed') return { bg: 'var(--surface-subtle)', color: 'var(--text-secondary)', label: 'Site decommed' }
    if (total === 0) return { bg: 'var(--surface-subtle)', color: 'var(--text-muted)', label: 'Empty' }
    const pct = eol / total
    if (pct >= 0.4) return { bg: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', label: 'High' }
    if (pct >= 0.2) return { bg: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', label: 'Medium' }
    return { bg: 'var(--tint-success)', color: 'var(--tint-success-fg)', label: 'Low' }
  }

  function timeAgo(d: string) {
    if (!d) return '—'
    const diff = Date.now() - new Date(d).getTime()
    const days = Math.floor(diff / 86400000)
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    return `${days}d ago`
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Sites</h1>
          <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>{filtered.length} sites · {totalDevices.toLocaleString()} devices · {totalEol.toLocaleString()} EOL</p>
        </div>
        <button onClick={() => setShowImport(true)} title="Import sites from Excel / CSV"
          style={{ padding: '7px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-subtle)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-card)')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
          Import Sites
        </button>
      </div>

      {showImport && (
        <SitesImportModal onClose={() => setShowImport(false)} onImported={fetchSites} />
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total sites', value: filtered.length, color: 'var(--text-secondary)', bg: 'var(--surface-subtle)', border: 'var(--border)', href: '/sites', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg> },
          { label: 'Total devices', value: totalDevices.toLocaleString(), color: 'var(--tint-success-fg)', bg: 'var(--tint-success)', border: 'var(--tint-success-fg)', href: '/devices', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> },
          { label: 'EOL devices', value: totalEol.toLocaleString(), color: 'var(--tint-danger-fg)', bg: 'var(--tint-danger)', border: 'var(--tint-danger-fg)', href: '/devices?lifecycle=EOL+%2F+EOS', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M12 2L2 20h20L12 2z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> },
        ].map(s => (
          <a key={s.label} href={s.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: s.bg, borderRadius: 'var(--radius)', border: `1px solid ${s.border}`, padding: '16px', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'transform 0.1s, box-shadow 0.1s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>
              <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: s.color }}>{s.icon}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: s.color, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600', opacity: 0.8 }}>{s.label}</div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: '700', color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: s.color, opacity: 0.6, marginTop: '4px' }}>View all →</div>
            </div>
          </a>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        <input className="input" style={{ flex: 1, maxWidth: '280px', width: '280px' }} placeholder="Search site or country..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select" style={{ width: 'auto', minWidth: '140px' }} value={region} onChange={e => setRegion(e.target.value)}>
          <option value="">All regions</option>
          {regions.map(r => <option key={r}>{r}</option>)}
        </select>
        {(search || region) && (
          <button className="btn-secondary" style={{ fontSize: 'var(--text-base)' }} onClick={() => { setSearch(''); setRegion('') }}>Clear</button>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading sites...</div>
      ) : (
        Object.values(grouped).map(group => (
          <div key={`${group.region}-${group.country}`} style={{ marginBottom: '24px' }}>
            {/* Country header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <div style={{ fontSize: 'var(--text-md)', fontWeight: '600', color: 'var(--text-primary)' }}>{group.country}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--surface-subtle)', padding: '2px 8px', borderRadius: 'var(--radius-pill)' }}>{group.region}</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{group.sites.length} site{group.sites.length > 1 ? 's' : ''}</div>
            </div>

            {/* Site cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
              {group.sites.map(site => {
                const risk = riskColor(parseInt(site.eol), parseInt(site.total), site.site_status)
                const isDecommed = site.site_status === 'Decommed'
                const eolPct = parseInt(site.total) > 0 ? Math.round(parseInt(site.eol) / parseInt(site.total) * 100) : 0
                return (
                  <Link key={site.id} href={`/sites/${site.id}`} style={{ textDecoration: 'none' }}>
                    <div style={{ background: isDecommed ? 'var(--surface-subtle)' : 'var(--bg-card)', borderRadius: 'var(--radius)', border: isDecommed ? '1px solid var(--border)' : '1px solid var(--border)', padding: '16px 18px', cursor: 'pointer', transition: 'border-color 0.15s', opacity: isDecommed ? 0.7 : 1 }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = isDecommed ? 'var(--border)' : 'var(--primary)')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                        <div>
                          <div style={{ fontSize: 'var(--text-md)', fontWeight: '600', color: 'var(--text-primary)' }}>{site.site}</div>

                        </div>
                        <span style={{ fontSize: 'var(--text-xs)', fontWeight: '500', padding: '3px 8px', borderRadius: 'var(--radius-pill)', background: risk.bg, color: risk.color }}>{isDecommed ? risk.label : `${risk.label} risk`}</span>
                      </div>

                      {/* Device count row */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '6px', marginBottom: '12px' }}>
                        {[
                          { label: 'Total', value: site.total, color: 'var(--text-primary)' },
                          { label: 'Active', value: site.active, color: 'var(--tint-success-fg)' },
                          { label: 'EOL', value: site.eol, color: 'var(--tint-danger-fg)' },
                          { label: 'Decommed', value: site.decommed, color: 'var(--tint-warn-fg)' },
                        ].map(stat => (
                          <div key={stat.label} style={{ textAlign: 'center', background: 'var(--surface-subtle)', borderRadius: 'var(--radius-sm)', padding: '6px 4px' }}>
                            <div style={{ fontSize: 'var(--text-md)', fontWeight: '700', color: stat.color }}>{stat.value}</div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{stat.label}</div>
                          </div>
                        ))}
                      </div>

                      {/* EOL progress bar */}
                      {parseInt(site.total) > 0 && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>EOL exposure</span>
                            <span style={{ fontSize: 'var(--text-xs)', color: risk.color, fontWeight: '500' }}>{eolPct}%</span>
                          </div>
                          <div style={{ height: '4px', background: 'var(--surface-subtle)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                            <div style={{ width: `${eolPct}%`, height: '100%', borderRadius: 'var(--radius-pill)', background: risk.color }} />
                          </div>
                        </div>
                      )}

                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '10px' }}>Updated {timeAgo(site.last_updated)}</div>
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
