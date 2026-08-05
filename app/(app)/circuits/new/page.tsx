'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'NOK', 'PLN', 'SGD', 'VND', 'GHS']

type Lookups = {
  sites: { site: string; country: string; region: string; id: string }[]
}

function Field({ label, required, span, children }: { label: string; required?: boolean; span?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : undefined }}>
      <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '6px' }}>
        {label}{required && <span style={{ color: 'var(--primary)' }}> *</span>}
      </label>
      {children}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: '16px' }}>
      <h2 style={{ fontSize: 'var(--text-md)', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '18px', paddingBottom: '10px', borderBottom: '1px solid var(--border-light)' }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>{children}</div>
    </div>
  )
}

export default function NewCircuitPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  useEffect(() => {
    if (user && user.role !== 'admin' && user.role !== 'super_admin') router.push('/circuits')
  }, [user, router])
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
    comment: '',  it_owner: '', city: '', address: '',
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



  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '24px' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-base)', cursor: 'pointer', padding: 0, marginBottom: '12px' }}>← Back</button>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Add new circuit</h1>
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
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Technology</label>
              <select className="input select" value={form.technology} onChange={e => set('technology', e.target.value)}>
                <option value="">Select technology</option>
              <option key='Fiber'>Fiber</option>
              <option key='Copper / xDSL'>Copper / xDSL</option>
              <option key='Coax / Cable'>Coax / Cable</option>
              <option key='Wireless / Radio'>Wireless / Radio</option>
              <option key='Satellite'>Satellite</option>
              <option key='4G/5G Mobile'>4G/5G Mobile</option>
              <option key='SD-WAN Overlay'>SD-WAN Overlay</option>
              <option key='Others'>Others</option>
              </select>
            </div>
          </Field>
          <Field label="Circuit type">
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Circuit type</label>
              <select className="input select" value={form.circuit_type} onChange={e => set('circuit_type', e.target.value)}>
                <option value="">Select circuit type</option>
              <option key='Dedicated'>Dedicated</option>
              <option key='Shared'>Shared</option>
              <option key='Burstable'>Burstable</option>
              <option key='Always-on'>Always-on</option>
              <option key='On-demand'>On-demand</option>
              <option key='Others'>Others</option>
              </select>
            </div>
          </Field>
          <Field label="Interface">
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Interface</label>
              <select className="input select" value={form.interface} onChange={e => set('interface', e.target.value)}>
                <option value="">Select interface</option>
              <option key='Ethernet (RJ45)'>Ethernet (RJ45)</option>
              <option key='SFP / Fiber'>SFP / Fiber</option>
              <option key='SFP+ (10G)'>SFP+ (10G)</option>
              <option key='QSFP (40G/100G)'>QSFP (40G/100G)</option>
              <option key='Coax'>Coax</option>
              <option key='Wireless'>Wireless</option>
              <option key='Serial'>Serial</option>
              <option key='Others'>Others</option>
              </select>
            </div>
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

        {error && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '12px 16px', borderRadius: 'var(--radius)', fontSize: 'var(--text-md)', marginBottom: '16px' }}>{error}</div>}
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
