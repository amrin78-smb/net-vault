'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

type Check = {
  key: string; label: string; href: string
  kind: 'risk' | 'completeness'; weight: number
  total: number; available: boolean; tracked: boolean; activeInRisk: boolean
  fail: number | null; pass: number | null; pct: number | null
  populated: number | null; populationPct: number | null
}

type ComplianceData = {
  score: number
  completenessScore: number
  total: number
  checks: Check[]
  riskActiveCount: number
  notTrackedCount: number
  minPopPct: number
  hasData?: boolean
}

export default function CompliancePage() {
  const [data, setData] = useState<ComplianceData | null>(null)
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

  const { score, completenessScore, total, checks, riskActiveCount, notTrackedCount, minPopPct } = data

  // No active devices, or no risk check cleared the population gate → there is
  // genuinely nothing to assess. Show an explicit "no data" state instead of a
  // misleading green 100%.
  const noData = data.hasData === false

  // Risk score is "share of policy passing" — higher is better.
  const scoreColor  = score >= 80 ? 'var(--tint-success-fg)' : score >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
  const scoreBg     = score >= 80 ? 'var(--tint-success)' : score >= 60 ? 'var(--tint-warn)' : 'var(--tint-danger)'
  const scoreBorder = scoreColor
  const barColor    = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)'

  const complColor = completenessScore >= 80 ? 'var(--tint-success-fg)' : completenessScore >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
  const complBar   = completenessScore >= 80 ? 'var(--green)' : completenessScore >= 60 ? 'var(--yellow)' : 'var(--red)'

  const riskChecks = checks.filter(c => c.activeInRisk)
  const completenessChecks = checks.filter(c => c.kind === 'completeness')
  const notTracked = checks.filter(c => c.kind === 'risk' && (!c.available || !c.tracked))

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Compliance Dashboard</h1>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>
          Policy risk and inventory completeness across {total.toLocaleString()} active devices
        </p>
      </div>

      {/* Two score cards: Risk/Compliance + Data Completeness */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        {/* Risk / Compliance */}
        {noData ? (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '24px 28px', display: 'flex', alignItems: 'center', gap: '24px' }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <div style={{ fontSize: '34px', fontWeight: '800', color: 'var(--text-muted)', lineHeight: 1 }}>—</div>
              <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginTop: '4px' }}>Risk / Compliance</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 'var(--text-md)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>No data to assess</div>
              <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                {total === 0
                  ? 'There are no active devices to evaluate yet. Add devices to the inventory to begin compliance scoring.'
                  : `No policy check has enough populated data to score yet (fields need coverage on at least ${minPopPct}% of the fleet). Checks reactivate automatically once the data exists.`}
              </div>
            </div>
          </div>
        ) : (
        <div style={{ background: scoreBg, border: `1px solid ${scoreBorder}`, borderRadius: '8px', padding: '24px 28px', display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div style={{ textAlign: 'center', flexShrink: 0 }}>
            <div style={{ fontSize: '52px', fontWeight: '800', color: scoreColor, lineHeight: 1 }}>{score}%</div>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: scoreColor, marginTop: '4px' }}>Risk / Compliance</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ height: '12px', background: 'var(--surface-subtle)', borderRadius: '6px', overflow: 'hidden', marginBottom: '10px' }}>
              <div style={{ width: `${score}%`, height: '100%', background: barColor, borderRadius: '6px', transition: 'width 0.6s ease' }} />
            </div>
            <div style={{ fontSize: 'var(--text-base)', color: scoreColor, opacity: 0.85 }}>
              {score >= 80 ? 'Good — active devices comply with lifecycle and assignment policy.'
                : score >= 60 ? 'Fair — some policy violations need attention.'
                : 'Poor — significant policy violations require immediate action.'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: scoreColor, opacity: 0.65, marginTop: '6px' }}>
              Weighted pass rate across {riskActiveCount} active policy {riskActiveCount === 1 ? 'check' : 'checks'} · active devices only
              {notTrackedCount > 0 && ` · ${notTrackedCount} not yet tracked`}
            </div>
          </div>
        </div>
        )}

        {/* Data Completeness */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '24px 28px', display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div style={{ textAlign: 'center', flexShrink: 0 }}>
            <div style={{ fontSize: '52px', fontWeight: '800', color: complColor, lineHeight: 1 }}>{completenessScore}%</div>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginTop: '4px' }}>Data Completeness</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ height: '12px', background: 'var(--surface-subtle)', borderRadius: '6px', overflow: 'hidden', marginBottom: '10px' }}>
              <div style={{ width: `${completenessScore}%`, height: '100%', background: complBar, borderRadius: '6px', transition: 'width 0.6s ease' }} />
            </div>
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
              How fully identifying inventory fields are populated. Empty fields lower completeness but do not count against compliance risk.
            </div>
          </div>
        </div>
      </div>

      {/* Risk checks */}
      {riskChecks.length > 0 && (
        <Section title="Policy risk checks" subtitle="Real violations counted in the Risk / Compliance score">
          {riskChecks.map(check => <CheckCard key={check.key} check={check} />)}
        </Section>
      )}

      {/* Data completeness checks */}
      {completenessChecks.length > 0 && (
        <Section title="Data completeness" subtitle="Population of identifying inventory fields">
          {completenessChecks.map(check => <CheckCard key={check.key} check={check} completeness />)}
        </Section>
      )}

      {/* Not yet tracked */}
      {notTracked.length > 0 && (
        <Section
          title="Not yet tracked"
          subtitle={`Fields populated on under ${minPopPct}% of the fleet — excluded from the risk score until an enrichment job fills them in, then they reactivate automatically`}
        >
          {notTracked.map(check => <NotTrackedCard key={check.key} check={check} />)}
        </Section>
      )}
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <div style={{ marginBottom: '12px' }}>
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>{title}</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '2px 0 0' }}>{subtitle}</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '14px' }}>
        {children}
      </div>
    </div>
  )
}

function CheckCard({ check, completeness }: { check: Check; completeness?: boolean }) {
  // For completeness cards, the headline number is population %; for risk cards
  // it's pass %. Both already live on the check.
  const value = completeness ? (check.populationPct ?? 0) : (check.pct ?? 0)
  const c   = value >= 80 ? 'var(--tint-success-fg)' : value >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'
  const bg  = value >= 80 ? 'var(--tint-success)' : value >= 60 ? 'var(--tint-warn)' : 'var(--tint-danger)'
  const bar = value >= 80 ? 'var(--green)' : value >= 60 ? 'var(--yellow)' : 'var(--red)'
  const borderColor = value >= 80 ? 'var(--tint-success-fg)' : value >= 60 ? 'var(--tint-warn-fg)' : 'var(--tint-danger-fg)'

  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: '8px', border: `1px solid ${borderColor}`, padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-primary)', flex: 1, paddingRight: '12px', lineHeight: 1.4 }}>{check.label}</div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: '800', color: c, flexShrink: 0 }}>{value}%</div>
      </div>

      <div style={{ height: '6px', background: 'var(--surface-subtle)', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
        <div style={{ width: `${value}%`, height: '100%', background: bar, borderRadius: '3px', transition: 'width 0.5s ease' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          <span style={{ fontWeight: '600', color: c }}>
            {completeness ? (check.populated ?? 0).toLocaleString() : (check.pass ?? 0).toLocaleString()}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}> of {check.total.toLocaleString()} active devices {completeness ? 'populated' : 'passing'}</span>
          {(check.fail ?? 0) > 0 && (
            <span style={{ marginLeft: '8px', background: bg, color: c, padding: '1px 8px', borderRadius: '20px', fontWeight: '600', fontSize: 'var(--text-xs)' }}>
              {(check.fail ?? 0).toLocaleString()} {completeness ? 'missing' : 'failing'}
            </span>
          )}
        </div>
        {(check.fail ?? 0) > 0 && (
          <Link href={check.href} style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '500', flexShrink: 0, marginLeft: '8px' }}>
            View affected →
          </Link>
        )}
      </div>
    </div>
  )
}

function NotTrackedCard({ check }: { check: Check }) {
  const pop = check.populationPct
  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border)', padding: '18px 20px', opacity: 0.85 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', flex: 1, paddingRight: '12px', lineHeight: 1.4 }}>{check.label}</div>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: '600', color: 'var(--text-muted)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Not tracked
        </div>
      </div>
      <div style={{ height: '6px', background: 'var(--surface-subtle)', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }} />
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        {check.available
          ? `Only ${pop ?? 0}% of active devices have this field populated. Excluded from the risk score until coverage grows; it will reactivate automatically.`
          : 'Data unavailable — schema update pending on this server.'}
      </div>
    </div>
  )
}
