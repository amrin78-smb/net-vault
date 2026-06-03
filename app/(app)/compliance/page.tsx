'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

type Check = {
  key: string; label: string; href: string
  total: number; available: boolean
  fail: number | null; pass: number | null; pct: number | null
}

export default function CompliancePage() {
  const [data, setData] = useState<{ score: number; total: number; checks: Check[]; availableCount: number } | null>(null)
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
  const scoreColor  = score >= 80 ? '#166534' : score >= 60 ? '#92400e' : '#991b1b'
  const scoreBg     = score >= 80 ? '#dcfce7' : score >= 60 ? '#fef3c7' : '#fee2e2'
  const scoreBorder = score >= 80 ? '#86efac' : score >= 60 ? '#fcd34d' : '#fca5a5'
  const barColor    = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Compliance Dashboard</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>
          Data quality and lifecycle compliance across {total.toLocaleString()} active devices
        </p>
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
            {score >= 80 ? 'Good — most active devices have complete data and valid support contracts.'
              : score >= 60 ? 'Fair — some data gaps need attention.'
              : 'Poor — significant data quality issues require immediate action.'}
          </div>
          <div style={{ fontSize: '12px', color: scoreColor, opacity: 0.6, marginTop: '6px' }}>
            Average pass rate across {data.availableCount} of {checks.length} compliance checks · active devices only
            {data.availableCount < checks.length && ' · some checks unavailable (schema update pending)'}
          </div>
        </div>
      </div>

      {/* Check cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '14px' }}>
        {checks.map(check => {
          if (!check.available) {
            return (
              <div key={check.key} style={{ background: '#f9fafb', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '18px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '600', color: '#6b7280', flex: 1, paddingRight: '12px', lineHeight: 1.4 }}>{check.label}</div>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    Unavailable
                  </div>
                </div>
                <div style={{ height: '6px', background: '#e5e7eb', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }} />
                <div style={{ fontSize: '12px', color: '#9ca3af' }}>Data unavailable — schema update pending on this server</div>
              </div>
            )
          }

          const c   = check.pct! >= 80 ? '#166534' : check.pct! >= 60 ? '#92400e' : '#991b1b'
          const bg  = check.pct! >= 80 ? '#dcfce7' : check.pct! >= 60 ? '#fef3c7' : '#fee2e2'
          const bar = check.pct! >= 80 ? '#22c55e' : check.pct! >= 60 ? '#f59e0b' : '#ef4444'
          const borderColor = check.pct! >= 80 ? '#86efac' : check.pct! >= 60 ? '#fde68a' : '#fecaca'
          return (
            <div key={check.key} style={{ background: 'white', borderRadius: '10px', border: `1px solid ${borderColor}`, padding: '18px 20px' }}>
              {/* Label + percentage */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: '600', color: '#111827', flex: 1, paddingRight: '12px', lineHeight: 1.4 }}>{check.label}</div>
                <div style={{ fontSize: '22px', fontWeight: '800', color: c, flexShrink: 0 }}>{check.pct}%</div>
              </div>

              {/* Progress bar */}
              <div style={{ height: '6px', background: '#f3f4f6', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
                <div style={{ width: `${check.pct}%`, height: '100%', background: bar, borderRadius: '3px', transition: 'width 0.5s ease' }} />
              </div>

              {/* Passing count + link */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '12px', color: '#374151' }}>
                  <span style={{ fontWeight: '600', color: c }}>
                    {check.pass!.toLocaleString()}
                  </span>
                  <span style={{ color: '#6b7280' }}> of {check.total.toLocaleString()} active devices passing</span>
                  {check.fail! > 0 && (
                    <span style={{ marginLeft: '8px', background: bg, color: c, padding: '1px 8px', borderRadius: '20px', fontWeight: '600', fontSize: '11px' }}>
                      {check.fail!.toLocaleString()} failing
                    </span>
                  )}
                </div>
                {check.fail! > 0 && (
                  <Link href={check.href} style={{ fontSize: '12px', color: '#C8102E', textDecoration: 'none', fontWeight: '500', flexShrink: 0, marginLeft: '8px' }}>
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
