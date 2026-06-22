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

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading compliance report...</div>
  if (error) return (
    <div style={{ padding: '40px', textAlign: 'center' }}>
      <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '16px 20px', borderRadius: '10px', display: 'inline-block', fontSize: 'var(--text-md)' }}>{error}</div>
    </div>
  )
  if (!data) return null

  const { score, total, checks } = data
  const scoreColor  = score >= 80 ? 'var(--tint-success-fg)' : score >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
  const scoreBg     = score >= 80 ? 'var(--tint-success)' : score >= 60 ? 'var(--tint-warn)' : 'var(--tint-danger)'
  const scoreBorder = score >= 80 ? 'var(--tint-success-fg)' : score >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
  const barColor    = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)'

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Compliance Dashboard</h1>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>
          Data quality and lifecycle compliance across {total.toLocaleString()} active devices
        </p>
      </div>

      {/* Score card */}
      <div style={{ background: scoreBg, border: `1px solid ${scoreBorder}`, borderRadius: '8px', padding: '24px 28px', marginBottom: '28px', display: 'flex', alignItems: 'center', gap: '28px' }}>
        <div style={{ textAlign: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: '52px', fontWeight: '800', color: scoreColor, lineHeight: 1 }}>{score}%</div>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: scoreColor, marginTop: '4px' }}>Compliance Score</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ height: '12px', background: 'var(--surface-subtle)', borderRadius: '6px', overflow: 'hidden', marginBottom: '10px' }}>
            <div style={{ width: `${score}%`, height: '100%', background: barColor, borderRadius: '6px', transition: 'width 0.6s ease' }} />
          </div>
          <div style={{ fontSize: 'var(--text-base)', color: scoreColor, opacity: 0.8 }}>
            {score >= 80 ? 'Good — most active devices have complete data and valid support contracts.'
              : score >= 60 ? 'Fair — some data gaps need attention.'
              : 'Poor — significant data quality issues require immediate action.'}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: scoreColor, opacity: 0.6, marginTop: '6px' }}>
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
              <div key={check.key} style={{ background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border)', padding: '18px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', flex: 1, paddingRight: '12px', lineHeight: 1.4 }}>{check.label}</div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: '600', color: 'var(--text-muted)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    Unavailable
                  </div>
                </div>
                <div style={{ height: '6px', background: 'var(--surface-subtle)', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }} />
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Data unavailable — schema update pending on this server</div>
              </div>
            )
          }

          const c   = check.pct! >= 80 ? 'var(--tint-success-fg)' : check.pct! >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
          const bg  = check.pct! >= 80 ? 'var(--tint-success)' : check.pct! >= 60 ? 'var(--tint-warn)' : 'var(--tint-danger)'
          const bar = check.pct! >= 80 ? 'var(--green)' : check.pct! >= 60 ? 'var(--yellow)' : 'var(--red)'
          const borderColor = check.pct! >= 80 ? 'var(--tint-success-fg)' : check.pct! >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
          return (
            <div key={check.key} style={{ background: 'var(--bg-card)', borderRadius: '8px', border: `1px solid ${borderColor}`, padding: '18px 20px' }}>
              {/* Label + percentage */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-primary)', flex: 1, paddingRight: '12px', lineHeight: 1.4 }}>{check.label}</div>
                <div style={{ fontSize: 'var(--text-xl)', fontWeight: '800', color: c, flexShrink: 0 }}>{check.pct}%</div>
              </div>

              {/* Progress bar */}
              <div style={{ height: '6px', background: 'var(--surface-subtle)', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
                <div style={{ width: `${check.pct}%`, height: '100%', background: bar, borderRadius: '3px', transition: 'width 0.5s ease' }} />
              </div>

              {/* Passing count + link */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                  <span style={{ fontWeight: '600', color: c }}>
                    {check.pass!.toLocaleString()}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}> of {check.total.toLocaleString()} active devices passing</span>
                  {check.fail! > 0 && (
                    <span style={{ marginLeft: '8px', background: bg, color: c, padding: '1px 8px', borderRadius: '20px', fontWeight: '600', fontSize: 'var(--text-xs)' }}>
                      {check.fail!.toLocaleString()} failing
                    </span>
                  )}
                </div>
                {check.fail! > 0 && (
                  <Link href={check.href} style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '500', flexShrink: 0, marginLeft: '8px' }}>
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
