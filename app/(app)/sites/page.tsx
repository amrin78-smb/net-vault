'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

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

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then(d => { setSites(d); setLoading(false) })
  }, [])

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
    if (siteStatus === 'Decommed') return { bg: '#e5e7eb', color: '#4b5563', label: 'Site decommed' }
    if (total === 0) return { bg: '#f3f4f6', color: '#6b7280', label: 'Empty' }
    const pct = eol / total
    if (pct >= 0.4) return { bg: '#fee2e2', color: '#991b1b', label: 'High' }
    if (pct >= 0.2) return { bg: '#fef3c7', color: '#92400e', label: 'Medium' }
    return { bg: '#dcfce7', color: '#166534', label: 'Low' }
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
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Sites</h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>{filtered.length} sites · {totalDevices.toLocaleString()} devices · {totalEol.toLocaleString()} EOL</p>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total sites', value: filtered.length, color: '#1a2744', bg: '#f0f4f8', border: '#c7d8e8', href: '/sites', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg> },
          { label: 'Total devices', value: totalDevices.toLocaleString(), color: '#166534', bg: '#dcfce7', border: '#86efac', href: '/devices', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> },
          { label: 'EOL devices', value: totalEol.toLocaleString(), color: '#991b1b', bg: '#fee2e2', border: '#fca5a5', href: '/devices?lifecycle=EOL+%2F+EOS', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M12 2L2 20h20L12 2z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> },
        ].map(s => (
          <a key={s.label} href={s.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: s.bg, borderRadius: '8px', border: `1px solid ${s.border}`, padding: '16px', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'transform 0.1s, box-shadow 0.1s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>
              <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: s.color }}>{s.icon}</div>
              <div style={{ fontSize: '11px', color: s.color, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600', opacity: 0.8 }}>{s.label}</div>
              <div style={{ fontSize: '26px', fontWeight: '700', color: s.color }}>{s.value}</div>
              <div style={{ fontSize: '11px', color: s.color, opacity: 0.6, marginTop: '4px' }}>View all →</div>
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
          <button className="btn-secondary" style={{ fontSize: '13px' }} onClick={() => { setSearch(''); setRegion('') }}>Clear</button>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading sites...</div>
      ) : (
        Object.values(grouped).map(group => (
          <div key={`${group.region}-${group.country}`} style={{ marginBottom: '24px' }}>
            {/* Country header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <div style={{ fontSize: '15px', fontWeight: '600', color: '#111827' }}>{group.country}</div>
              <div style={{ fontSize: '11px', color: '#9ca3af', background: '#f3f4f6', padding: '2px 8px', borderRadius: '20px' }}>{group.region}</div>
              <div style={{ fontSize: '12px', color: '#9ca3af' }}>{group.sites.length} site{group.sites.length > 1 ? 's' : ''}</div>
            </div>

            {/* Site cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
              {group.sites.map(site => {
                const risk = riskColor(parseInt(site.eol), parseInt(site.total), site.site_status)
                const isDecommed = site.site_status === 'Decommed'
                const eolPct = parseInt(site.total) > 0 ? Math.round(parseInt(site.eol) / parseInt(site.total) * 100) : 0
                return (
                  <Link key={site.id} href={`/sites/${site.id}`} style={{ textDecoration: 'none' }}>
                    <div style={{ background: isDecommed ? '#f9fafb' : 'white', borderRadius: '10px', border: isDecommed ? '1px solid #d1d5db' : '1px solid #e5e7eb', padding: '16px 18px', cursor: 'pointer', transition: 'border-color 0.15s', opacity: isDecommed ? 0.7 : 1 }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = isDecommed ? '#d1d5db' : '#C8102E')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = isDecommed ? '#d1d5db' : '#e5e7eb')}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: '600', color: '#111827' }}>{site.site}</div>

                        </div>
                        <span style={{ fontSize: '10px', fontWeight: '500', padding: '3px 8px', borderRadius: '20px', background: risk.bg, color: risk.color }}>{isDecommed ? risk.label : `${risk.label} risk`}</span>
                      </div>

                      {/* Device count row */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '6px', marginBottom: '12px' }}>
                        {[
                          { label: 'Total', value: site.total, color: '#1a2744' },
                          { label: 'Active', value: site.active, color: '#166534' },
                          { label: 'EOL', value: site.eol, color: '#991b1b' },
                          { label: 'Decommed', value: site.decommed, color: '#92400e' },
                        ].map(stat => (
                          <div key={stat.label} style={{ textAlign: 'center', background: '#f9fafb', borderRadius: '6px', padding: '6px 4px' }}>
                            <div style={{ fontSize: '14px', fontWeight: '700', color: stat.color }}>{stat.value}</div>
                            <div style={{ fontSize: '9px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{stat.label}</div>
                          </div>
                        ))}
                      </div>

                      {/* EOL progress bar */}
                      {parseInt(site.total) > 0 && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                            <span style={{ fontSize: '10px', color: '#9ca3af' }}>EOL exposure</span>
                            <span style={{ fontSize: '10px', color: risk.color, fontWeight: '500' }}>{eolPct}%</span>
                          </div>
                          <div style={{ height: '4px', background: '#f3f4f6', borderRadius: '2px', overflow: 'hidden' }}>
                            <div style={{ width: `${eolPct}%`, height: '100%', borderRadius: '2px', background: risk.color }} />
                          </div>
                        </div>
                      )}

                      <div style={{ fontSize: '10px', color: '#d1d5db', marginTop: '10px' }}>Updated {timeAgo(site.last_updated)}</div>
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
