'use client'
import { useState, useEffect } from 'react'
type SiteRow = { region: string; country: string; site: string; eol_count: number; total_count: number }

export default function EolPage() {
  const [rows, setRows] = useState<SiteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [region, setRegion] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/devices?lifecycle=EOL+%2F+EOS&limit=3000').then(r => r.json()),
      fetch('/api/devices?limit=3000').then(r => r.json()),
    ]).then(([eolData, allData]) => {
      const sites: Record<string, SiteRow> = {}
      for (const dev of allData.devices || []) {
        const key = `${dev.region}|${dev.country}|${dev.site}`
        if (!sites[key]) sites[key] = { region: dev.region, country: dev.country, site: dev.site, eol_count: 0, total_count: 0 }
        sites[key].total_count++
      }
      for (const dev of eolData.devices || []) {
        const key = `${dev.region}|${dev.country}|${dev.site}`
        if (!sites[key]) sites[key] = { region: dev.region, country: dev.country, site: dev.site, eol_count: 0, total_count: 0 }
        sites[key].eol_count++
      }
      setRows(Object.values(sites).filter(s => s.eol_count > 0).sort((a, b) => b.eol_count - a.eol_count))
      setLoading(false)
    })
  }, [])

  const filtered = region ? rows.filter(r => r.region === region) : rows
  const regions = [...new Set(rows.map(r => r.region))]
  const totalEol = filtered.reduce((s, r) => s + r.eol_count, 0)

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>EOL / Risk report</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Devices at end-of-life by site</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '20px' }}>
        <a href="/devices?lifecycle=EOL+%2F+EOS" style={{ textDecoration: 'none' }}>
          <div style={{ background: '#fee2e2', borderRadius: '8px', border: '1px solid #fca5a5', padding: '16px', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'transform 0.1s, box-shadow 0.1s' }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>
            <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#991b1b' }}><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M12 2L2 20h20L12 2z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <div style={{ fontSize: '12px', color: '#991b1b', marginBottom: '4px', fontWeight: '600', opacity: 0.8 }}>EOL devices</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: '#991b1b' }}>{totalEol.toLocaleString()}</div>
            <div style={{ fontSize: '11px', color: '#991b1b', opacity: 0.6, marginTop: '4px' }}>View all →</div>
          </div>
        </a>
        <div style={{ background: '#fef3c7', borderRadius: '8px', border: '1px solid #fcd34d', padding: '16px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#92400e' }}><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg></div>
          <div style={{ fontSize: '12px', color: '#92400e', marginBottom: '4px', fontWeight: '600', opacity: 0.8 }}>Sites affected</div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#92400e' }}>{filtered.length}</div>
        </div>
        <div style={{ background: '#f0f4f8', borderRadius: '8px', border: '1px solid #c7d8e8', padding: '16px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#1a2744' }}><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg></div>
          <div style={{ fontSize: '12px', color: '#1a2744', marginBottom: '4px', fontWeight: '600', opacity: 0.8 }}>Regions</div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#1a2744' }}>{regions.length}</div>
        </div>
      </div>
      <div style={{ marginBottom: '16px' }}>
        <select className="select" style={{ width: "auto", minWidth: "130px" }} value={region} onChange={e => setRegion(e.target.value)}>
          <option value="">All regions</option>
          {regions.map(r => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : (
          <table>
            <thead><tr><th>Site</th><th>Country</th><th>Region</th><th>EOL devices</th><th>% of site</th><th>Risk level</th></tr></thead>
            <tbody>
              {filtered.map(row => {
                const pct = row.total_count > 0 ? Math.round((row.eol_count / row.total_count) * 100) : 0
                const risk = pct >= 50 ? { label: 'High', bg: '#fee2e2', color: '#991b1b' } : pct >= 25 ? { label: 'Medium', bg: '#fef3c7', color: '#92400e' } : { label: 'Low', bg: '#dcfce7', color: '#166534' }
                return (
                  <tr key={`${row.site}-${row.region}`}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>{row.site}</td>
                    <td>{row.country}</td>
                    <td><span style={{ fontSize: '11px', color: '#6b7280' }}>{row.region}</span></td>
                    <td style={{ fontWeight: '600', color: '#991b1b' }}>{row.eol_count}</td>
                    <td style={{ color: '#6b7280' }}>{pct}%</td>
                    <td><span className="badge" style={{ background: risk.bg, color: risk.color }}>{risk.label}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
