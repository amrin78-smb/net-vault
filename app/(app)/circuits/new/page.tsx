'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'NOK', 'PLN', 'SGD', 'VND', 'GHS']

type Lookups = {
  sites: { site: string; country: string; region: string; id: string }[]
}

export default function NewCircuitPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const prefillSite = searchParams.get('site') || ''
  const prefillSiteId = searchParams.get('site_id') || ''

  const [lookups, setLookups] = useState<Lookups>({ sites: [] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    site_id: prefillSiteId,
    site_name: prefillSite,
    isp: '', usage: 'Primary Internet', circuit_id: '', product: '',
    technology: '', circuit_type: '', interface: '',
    max_speed: '', guaranteed_speed: '', public_subnet: '',
    currency: 'THB', cost_month: '', contract_term: '',
    comment: '', pingable: '', it_owner: '', city: '', address: '',
  })

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then(data => {
      setLookups({ sites: data.map((s: any) => ({ ...s, id: s.id })) })
    })
  }, [])

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.site_id || !form.isp) { setError('Site and ISP are required'); return }
    setSaving(true); setError('')
    const res = await fetch('/api/circuits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    if (res.ok) {
      const data = await res.json()
      if (prefillSiteId) {
        router.push(`/sites/${prefillSiteId}`)
      } else {
        router.push('/circuits')
      }
    } else {
      const data = await res.json()
      setError(data.error || 'Failed to save')
      setSaving(false)
    }
  }

  const Field = ({ label, required, span, children }: { label: string; required?: boolean; span?: boolean; children: React.ReactNode }) => (
    <div style={{ gridColumn: span ? '1 / -1' : undefined }}>
      <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>
        {label}{required && <span style={{ color: '#C8102E' }}> *</span>}
      </label>
      {children}
    </div>
  )

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="card" style={{ marginBottom: '16px' }}>
      <h2 style={{ fontSize: '15px', fontWeight: '600', color: '#111827', marginBottom: '18px', paddingBottom: '10px', borderBottom: '1px solid #f3f4f6' }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>{children}</div>
    </div>
  )

  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '24px' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: '13px', cursor: 'pointer', padding: 0, marginBottom: '12px' }}>← Back</button>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Add new circuit</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Section title="Location">
          <Field label="Site" required>
            <select className="input select" value={form.site_id} onChange={e => {
              const selected = lookups.sites.find((s: any) => String(s.id) === e.target.value)
              set('site_id', e.target.value)
              if (selected) set('site_name', selected.site)
            }}>
              <option value="">Select site</option>
              {lookups.sites.map((s: any) => (
                <option key={s.id} value={s.id}>{s.site} — {s.country}</option>
              ))}
            </select>
          </Field>
          <Field label="City">
            <input className="input" value={form.city} onChange={e => set('city', e.target.value)} placeholder="e.g. Bangkok" />
          </Field>
          <Field label="IT owner">
            <input className="input" value={form.it_owner} onChange={e => set('it_owner', e.target.value)} placeholder="e.g. John Smith" />
          </Field>
          <Field label="Address" span>
            <input className="input" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Full site address" />
          </Field>
        </Section>

        <Section title="Circuit details">
          <Field label="ISP" required>
            <input className="input" value={form.isp} onChange={e => set('isp', e.target.value)} placeholder="e.g. AIS, Symphony, Interlink" />
          </Field>
          <Field label="Usage">
            <select className="input select" value={form.usage} onChange={e => set('usage', e.target.value)}>
                <option value="">Select usage</option>
                <option key='Primary Internet'>Primary Internet</option>
                <option key='Backup Internet'>Backup Internet</option>
                <option key='MPLS Primary'>MPLS Primary</option>
                <option key='MPLS Backup'>MPLS Backup</option>
                <option key='Guest Internet'>Guest Internet</option>
                <option key='Out-of-Band / Management'>Out-of-Band / Management</option>
                <option key='CCTV / Camera'>CCTV / Camera</option>
                <option key='IoT / OT'>IoT / OT</option>
                <option key='Compliance / Government'>Compliance / Government</option>
                <option key='Others'>Others</option>
                </select>
          </Field>
          <Field label="Circuit ID">
            <input className="input" value={form.circuit_id} onChange={e => set('circuit_id', e.target.value)} placeholder="e.g. DI40443" />
          </Field>
          <Field label="Product">
            <select className="input select" value={form.product} onChange={e => set('product', e.target.value)}>
              <option value="">Select product</option>
                  <option>Corporate Internet / DIA</option>
                  <option>IPVPN / MPLS</option>
                  <option>L2VPN / Private Link</option>
                  <option>SME Internet FTTx</option>
                  <option>Home Broadband FTTx</option>
                  <option>Satellite</option>
                  <option>4G/5G Mobile</option>
                  <option>Dark Fiber</option>
                  <option>Others</option>
            </select>
          </Field>
          <Field label="Technology">
            <select className="input select" value={form.technology} onChange={e => set('technology', e.target.value)}>
              <option value="">Select technology</option>
              <option>DIA</option>
              <option>MPLS</option>
              <option>SD-WAN</option>
              <option>Shared</option>
              <option>Dedicated</option>
            </select>
          </Field>
          <Field label="Circuit type">
            <input className="input" value={form.circuit_type} onChange={e => set('circuit_type', e.target.value)} placeholder="e.g. Fiber" />
          </Field>
          <Field label="Interface">
            <input className="input" value={form.interface} onChange={e => set('interface', e.target.value)} placeholder="e.g. Fiber" />
          </Field>
          <Field label="Max speed (up/down)">
            <input className="input" value={form.max_speed} onChange={e => set('max_speed', e.target.value)} placeholder="e.g. 300/300" />
          </Field>
          <Field label="Guaranteed speed">
            <input className="input" value={form.guaranteed_speed} onChange={e => set('guaranteed_speed', e.target.value)} placeholder="e.g. 100/100" />
          </Field>
          <Field label="Public subnet">
            <input className="input" value={form.public_subnet} onChange={e => set('public_subnet', e.target.value)} placeholder="e.g. 119.110.198.116" />
          </Field>
          <Field label="Pingable from IDC">
            <select className="input select" value={form.pingable} onChange={e => set('pingable', e.target.value)}>
              <option value="">Unknown</option>
              <option>Yes</option>
              <option>No</option>
            </select>
          </Field>
        </Section>

        <Section title="Commercial">
          <Field label="Currency">
            <select className="input select" value={form.currency} onChange={e => set('currency', e.target.value)}>
              {CURRENCIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Cost / month">
            <input className="input" type="number" value={form.cost_month} onChange={e => set('cost_month', e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Contract term" span>
            <input className="input" value={form.contract_term} onChange={e => set('contract_term', e.target.value)} placeholder="e.g. Annual" />
          </Field>
          <Field label="Comment" span>
            <textarea className="input" value={form.comment} onChange={e => set('comment', e.target.value)} rows={3} style={{ resize: 'vertical' }} />
          </Field>
        </Section>

        {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', marginBottom: '16px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-primary" type="submit" disabled={saving} style={{ padding: '10px 24px' }}>
            {saving ? 'Saving...' : 'Add circuit'}
          </button>
          <button className="btn-secondary" type="button" onClick={() => router.back()}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
