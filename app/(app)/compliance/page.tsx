'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

type Check = {
  key: string; label: string; href: string
  total: number; fail: number; pass: number; pct: number
}

export default function CompliancePage() {
  const [data, setData] = useState<{ score: number; total: number; checks: Check[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/compliance')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => {
        if (d.error) throw new Error(d.error)
        setData(d)
        setLoading(false)
      })
      .catch(e => {
        console.error('[compliance]', e)
        setError('Failed to load compliance data. Please try refreshing the page.')
        setLoading(false)
      })
  }, [])

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading compliance report...</div>
  if (error) return (
    <div style={{ padding: '40px', textAlign: 'center' }}>
      <div style={{ background: '#fee2e2', color: '#991b1b', padding: '16px 20px', borderRadius: '10px', display: 'inline-block', fontSize: '14px' }}>{error}</div>
    </div>
  )
  if (!data) return null

  const { score, total, checks } = data
  const scoreColor = score >= 80 ? '#166534' : score >= 60 ? '#92400e' : '#991b1b'
  const scoreBg    = score >= 80 ? '#dcfce7' : score >= 60 ? '#fef3c7' : '#fee2e2'
  const scoreBorder= score >= 80 ? '#86efac' : score >= 60 ? '#fcd34d' : '#fca5a5'
  const barColor   = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Compliance Dashboard</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Data quality and lifecycle compliance across {total.toLocaleString()} devices</p>
      </div>

      {/* Score card */}
      <div style={{ background: scoreBg, border: `1px solid ${scoreBorder}`, borderRadius: '12px', padding: '24px 28px', marginBottom: '28px', display: 'flex', alignItems: 'center', gap: '28px' }}>
        <div style={{ textAlign: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: '52px', fontWeight: '800', color: scoreColor, lineHeight: 1 }}>{score}%</div>
          <div style={{ fontSize: '13px', fontWeight: '600', color: scoreColor, marginTop: '4px' }}>Compliance Score</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ height: '12px', background: 'rgba(0,0,0,0.08)', borderRadius: '6px', overflow: 'hidden', marginBottom: '10px' }}>
            <div style={{ width: `${score}%`, height: '100%', background: barColor, borderRadius: '6px', transition: 'width 0.6s ease' }} />
          </div>
          <div style={{ fontSize: '13px', color: scoreColor, opacity: 0.8 }}>
            {score >= 80 ? 'Good — most devices have complete data and valid support contracts.'
              : score >= 60 ? 'Fair — some data gaps need attention.'
              : 'Poor — significant data quality issues require immediate action.'}
          </div>
          <div style={{ fontSize: '12px', color: scoreColor, opacity: 0.6, marginTop: '6px' }}>
            Calculated as average pass rate across {checks.length} compliance checks
          </div>
        </div>
      </div>

      {/* Check cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '14px' }}>
        {checks.map(check => {
          const c = check.pct >= 90 ? '#166534' : check.pct >= 70 ? '#92400e' : '#991b1b'
          const bg = check.pct >= 90 ? '#f0fdf4' : check.pct >= 70 ? '#fffbeb' : '#fff1f2'
          const bar = check.pct >= 90 ? '#22c55e' : check.pct >= 70 ? '#f59e0b' : '#ef4444'
          return (
            <div key={check.key} style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div style={{ fontSize: '13px', fontWeight: '600', color: '#111827', flex: 1, paddingRight: '12px' }}>{check.label}</div>
                <div style={{ fontSize: '20px', fontWeight: '700', color: c, flexShrink: 0 }}>{check.pct}%</div>
              </div>
              <div style={{ height: '6px', background: '#f3f4f6', borderRadius: '3px', overflow: 'hidden', marginBottom: '10px' }}>
                <div style={{ width: `${check.pct}%`, height: '100%', background: bar, borderRadius: '3px' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '12px', fontSize: '12px' }}>
                  <span style={{ color: '#166534' }}>✓ {check.pass.toLocaleString()} pass</span>
                  {check.fail > 0 && (
                    <span style={{ background: bg, color: c, padding: '1px 8px', borderRadius: '20px', fontWeight: '600' }}>
                      {check.fail.toLocaleString()} fail
                    </span>
                  )}
                </div>
                {check.fail > 0 && (
                  <Link href={check.href} style={{ fontSize: '12px', color: '#C8102E', textDecoration: 'none', fontWeight: '500', flexShrink: 0 }}>
                    View affected →
                  </Link>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
