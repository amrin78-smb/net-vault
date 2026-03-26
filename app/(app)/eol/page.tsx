'use client'
import { useState, useEffect } from 'react'
type Device = { region: string; country: string; site: string; lifecycle_status: string }
type SiteRow = { region: string; country: string; site: string; eol_count: number; total_count: number }

export default function EolPage() {
  const [rows, setRows] = useState<SiteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [region, setRegion] = useState('')

  useEffect(() => {
    fetch('/api/devices?lifecycle=EOL+%2F+EOS&limit=3000').then(r => r.json()).then(d => {
      const sites: Record<string, SiteRow> = {}
      for (const dev of d.devices || []) {
        const key = `${dev.region}|${dev.country}|${dev.site}`
        if (!sites[key]) sites[key] = { region: dev.region, country: dev.country, site: dev.site, eol_count: 0, total_count: 0 }
        sites[key].eol_count++
      }
      setRows(Object.values(sites).sort((a, b) => b.eol_count - a.eol_count))
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
        <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>EOL devices</div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#991b1b' }}>{totalEol.toLocaleString()}</div>
        </div>
        <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>Sites affected</div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#92400e' }}>{filtered.length}</div>
        </div>
        <div style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>Regions</div>
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
            <thead><tr><th>Site</th><th>Country</th><th>Region</th><th>EOL devices</th><th>Risk level</th></tr></thead>
            <tbody>
              {filtered.map(row => {
                const pct = row.eol_count > 0 ? row.eol_count : 0
                const risk = pct >= 20 ? { label: 'High', bg: '#fee2e2', color: '#991b1b' } : pct >= 10 ? { label: 'Medium', bg: '#fef3c7', color: '#92400e' } : { label: 'Low', bg: '#dcfce7', color: '#166534' }
                return (
                  <tr key={`${row.site}-${row.region}`}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>{row.site}</td>
                    <td>{row.country}</td>
                    <td><span style={{ fontSize: '11px', color: '#6b7280' }}>{row.region}</span></td>
                    <td style={{ fontWeight: '600', color: '#991b1b' }}>{row.eol_count}</td>
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
