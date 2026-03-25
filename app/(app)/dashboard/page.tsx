'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

type Summary = { total: string; active: string; decommed: string; spare: string; eol: string; supported: string; unknown_lifecycle: string }
type RegionRow = { region: string; total: string; eol_count: string }
type TypeRow = { device_type: string; total: string }
type EolRow = { site: string; country: string; region: string; eol_count: string }
type ActivityRow = { field_name: string; changed_at: string; changed_by_name: string; device_name: string }
type CircuitStats = { total_circuits: string; main_circuits: string; backup_circuits: string; sites_with_circuits: string; total_cost_thb: string; total_cost_usd: string; total_cost_eur: string; total_isps: string; pingable_count: string }

export default function DashboardPage() {
  const [data, setData] = useState<{ summary: Summary; byRegion: RegionRow[]; byType: TypeRow[]; topEol: EolRow[]; recentActivity: ActivityRow[]; circuitStats: CircuitStats } | null>(null)
  const [loading, setLoading] = useState(true)
  const [chartsReady, setChartsReady] = useState(false)

  useEffect(() => {
    fetch('/api/dashboard').then(r => r.json()).then(d => { setData(d); setLoading(false) })
  }, [])

  useEffect(() => {
    if (!data || chartsReady) return
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js'
    script.onload = () => setChartsReady(true)
    document.head.appendChild(script)
  }, [data])

  useEffect(() => {
    if (!data || !chartsReady || !(window as any).Chart) return
    const Chart = (window as any).Chart
    Chart.defaults.font.family = 'system-ui, sans-serif'

    // Destroy existing charts
    const chartIds = ['statusChart','regionChart','typeChart']
    chartIds.forEach((id: string) => {
      const existing = Chart.getChart(id)
      if (existing) existing.destroy()
    })

    const total = parseInt(data.summary.total)
    const active = parseInt(data.summary.active)
    const eol = parseInt(data.summary.eol)
    const decommed = parseInt(data.summary.decommed)
    const spare = parseInt(data.summary.spare)
    const other = total - active - eol - decommed - spare

    // Status donut
    const statusCtx = document.getElementById('statusChart') as HTMLCanvasElement
    if (statusCtx) new Chart(statusCtx, {
      type: 'doughnut',
      data: {
        labels: ['Active', 'EOL / EOS', 'Decommed', 'Spare', 'Other'],
        datasets: [{ data: [active, eol, decommed, spare, other], backgroundColor: ['#166534','#991b1b','#6b7280','#92400e','#d1d5db'], borderWidth: 0, hoverOffset: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '70%',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: any) => ` ${c.label}: ${c.raw.toLocaleString()} (${Math.round(c.raw/total*100)}%)` } } }
      }
    })

    // Region bar
    const regionCtx = document.getElementById('regionChart') as HTMLCanvasElement
    if (regionCtx) new Chart(regionCtx, {
      type: 'bar',
      data: {
        labels: data.byRegion.map(r => r.region),
        datasets: [
          { label: 'Active', data: data.byRegion.map(r => parseInt(r.total) - parseInt(r.eol_count)), backgroundColor: '#1a2744', borderRadius: 4 },
          { label: 'EOL', data: data.byRegion.map(r => parseInt(r.eol_count)), backgroundColor: '#C8102E', borderRadius: 4 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 12 } } },
          y: { stacked: true, grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } }
        }
      }
    })

    // Type horizontal bar
    const typeCtx = document.getElementById('typeChart') as HTMLCanvasElement
    if (typeCtx) new Chart(typeCtx, {
      type: 'bar',
      data: {
        labels: data.byType.map(t => t.device_type),
        datasets: [{ data: data.byType.map(t => parseInt(t.total)), backgroundColor: '#1a2744', borderRadius: 4, barThickness: 16 }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
          y: { grid: { display: false }, ticks: { font: { size: 12 } } }
        }
      }
    })
  }, [data, chartsReady])

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading dashboard...</div>
  if (!data) return null

  const { summary, byRegion, topEol, recentActivity, circuitStats } = data
  const total = parseInt(summary.total)
  const eol = parseInt(summary.eol)
  const eolPct = total > 0 ? Math.round((eol / total) * 100) : 0
  const maxEol = topEol.length > 0 ? parseInt(topEol[0].eol_count) : 1

  const actColor: Record<string,string> = { created:'#166534', updated:'#075985', deleted:'#991b1b' }
  const actBg: Record<string,string> = { created:'#dcfce7', updated:'#e0f2fe', deleted:'#fee2e2' }

  function timeAgo(d: string) {
    const diff = Date.now() - new Date(d).getTime()
    const mins = Math.floor(diff/60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins/60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs/24)}d ago`
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Dashboard</h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Network infrastructure overview</p>
        </div>
        <Link href="/devices">
          <button style={{ padding: '7px 14px', background: '#1a2744', color: 'white', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}>View all devices →</button>
        </Link>
      </div>

      {/* Summary stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total devices', value: parseInt(summary.total).toLocaleString(), sub: `${byRegion.length} regions`, color: '#1a2744' },
          { label: 'Active', value: parseInt(summary.active).toLocaleString(), sub: `${Math.round(parseInt(summary.active)/total*100)}% of fleet`, color: '#166534' },
          { label: 'EOL / EOS', value: eol.toLocaleString(), sub: `${eolPct}%${eolPct >= 25 ? ' — action needed' : ''}`, color: '#991b1b' },
          { label: 'Decommed', value: parseInt(summary.decommed).toLocaleString(), sub: 'pending removal', color: '#92400e' },
          { label: 'Spare', value: parseInt(summary.spare).toLocaleString(), sub: 'in storage', color: '#075985' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
            <div style={{ fontSize: '26px', fontWeight: '700', color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: s.label === 'EOL / EOS' && eolPct >= 25 ? '#991b1b' : '#9ca3af', marginTop: '2px' }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Circuit stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'WAN circuits', value: parseInt(circuitStats.total_circuits).toLocaleString(), sub: `${circuitStats.sites_with_circuits} sites covered`, color: '#075985' },
          { label: 'Main links', value: parseInt(circuitStats.main_circuits).toLocaleString(), sub: `${parseInt(circuitStats.backup_circuits)} backup links`, color: '#166534' },
          { label: 'Sites with WAN', value: parseInt(circuitStats.sites_with_circuits).toLocaleString(), sub: `out of 51 total sites`, color: '#92400e' },
          { label: 'ISP providers', value: parseInt(circuitStats.total_isps).toLocaleString(), sub: `${circuitStats.pingable_count} circuits pingable`, color: '#5b21b6' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
            <div style={{ fontSize: '22px', fontWeight: '700', color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Charts row 1 — status donut + region stacked bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '16px', marginBottom: '16px' }}>
        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Fleet status</div>
          <div style={{ position: 'relative', height: '180px' }}>
            <canvas id="statusChart"></canvas>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
            {[
              { label: 'Active', color: '#166534', bg: '#dcfce7' },
              { label: 'EOL', color: '#991b1b', bg: '#fee2e2' },
              { label: 'Decommed', color: '#4b5563', bg: '#f3f4f6' },
              { label: 'Spare', color: '#92400e', bg: '#fef3c7' },
            ].map(l => (
              <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: l.color, background: l.bg, padding: '2px 8px', borderRadius: '20px', fontWeight: '500' }}>
                {l.label}
              </span>
            ))}
          </div>
        </div>

        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Devices by region</div>
            <div style={{ display: 'flex', gap: '10px', fontSize: '11px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#6b7280' }}><span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#1a2744', display: 'inline-block' }}></span>Active</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#6b7280' }}><span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#C8102E', display: 'inline-block' }}></span>EOL</span>
            </div>
          </div>
          <div style={{ position: 'relative', height: '200px' }}>
            <canvas id="regionChart"></canvas>
          </div>
        </div>
      </div>

      {/* Charts row 2 — device type + top EOL + activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Devices by type</div>
          <div style={{ position: 'relative', height: '240px' }}>
            <canvas id="typeChart"></canvas>
          </div>
        </div>

        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Top EOL sites</div>
            <Link href="/eol" style={{ fontSize: '12px', color: '#C8102E', textDecoration: 'none' }}>View all →</Link>
          </div>
          {topEol.map(row => {
            const pct = Math.round(parseInt(row.eol_count) / maxEol * 100)
            const barColor = pct >= 70 ? '#C8102E' : pct >= 40 ? '#f59e0b' : '#6b7280'
            return (
              <div key={`${row.site}-${row.region}`} style={{ marginBottom: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span style={{ fontSize: '12px', color: '#111827', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }}>{row.site}</span>
                  <span style={{ fontSize: '12px', fontWeight: '600', color: '#991b1b' }}>{row.eol_count}</span>
                </div>
                <div style={{ height: '6px', background: '#f3f4f6', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: barColor }} />
                </div>
                <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px' }}>{row.country} · {row.region}</div>
              </div>
            )
          })}
        </div>

        <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Recent activity</div>
            <Link href="/audit" style={{ fontSize: '12px', color: '#C8102E', textDecoration: 'none' }}>View all →</Link>
          </div>
          {recentActivity.length === 0 ? (
            <div style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center', padding: '20px 0' }}>No activity yet</div>
          ) : recentActivity.map((log, i) => (
            <div key={i} style={{ display: 'flex', gap: '10px', paddingBottom: '10px', marginBottom: '10px', borderBottom: i < recentActivity.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: actColor[log.field_name] || '#9ca3af', flexShrink: 0, marginTop: '4px' }} />
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '12px', color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ background: actBg[log.field_name] || '#f3f4f6', color: actColor[log.field_name] || '#374151', padding: '1px 6px', borderRadius: '10px', fontSize: '10px', fontWeight: '500', marginRight: '5px' }}>{log.field_name}</span>
                  {log.device_name || 'Unknown'}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{log.changed_by_name || 'System'} · {timeAgo(log.changed_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
