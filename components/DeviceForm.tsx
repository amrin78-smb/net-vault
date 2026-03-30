'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

type Lookups = {
  regions: string[]; sites: { site: string; country: string; region: string }[]
  deviceTypes: string[]; brands: string[]; vendors: string[]
  lifecycleStatuses: string[]; deviceStatuses: string[]; mgmtProtocols: string[]
}

type DeviceFormProps = { initialData?: Record<string, any>; deviceId?: string }

export default function DeviceForm({ initialData, deviceId }: DeviceFormProps) {
  const router = useRouter()
  const { data: session } = useSession()
  const sessionUser = session?.user as { role?: string; siteIds?: number[] } | undefined
  const isSiteAdmin = sessionUser?.role === 'site_admin'
  const [lookups, setLookups] = useState<Lookups | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', brand: '', model: '', serial_number: '', device_type: '', device_type_other: '', ip_address: '', mgmt_protocol: '', mgmt_url: '', site: '', location_detail: '', lifecycle_status: 'Unknown', device_status: 'Active', risk_score: '', technical_debt: '', remark: '', cost: '', purchase_date: '', purchase_vendor: '', ma_vendor: '', ...initialData })

  useEffect(() => {
    fetch('/api/lookup').then(r => r.json()).then(data => {
      setLookups(data)
      // Auto-select site if site admin has only one assigned site and no site is set
      if (isSiteAdmin && data.sites?.length === 1 && !initialData?.site) {
        setForm(f => ({ ...f, site: data.sites[0].site }))
      }
    })
  }, [isSiteAdmin])
  function set(field: string, value: string) { setForm(f => ({ ...f, [field]: value })) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name || !form.device_type || !form.site) { setError('Name, device type and site are required'); return }
    if (form.device_type === 'Others' && !(form as any).device_type_other) { setError('Please specify the device type'); return }
    if (form.device_type === 'Others') (form as any).device_type = (form as any).device_type_other
    setSaving(true); setError('')
    const res = await fetch(deviceId ? `/api/devices/${deviceId}` : '/api/devices', {
      method: deviceId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    if (res.ok) { router.push('/devices'); router.refresh() }
    else { const data = await res.json(); setError(data.error || 'Failed to save'); setSaving(false) }
  }

  if (!lookups) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>

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

  const inp = { className: 'input' }

  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '24px' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: '13px', cursor: 'pointer', padding: 0, marginBottom: '12px' }}>← Back</button>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>{deviceId ? 'Edit device' : 'Add new device'}</h1>
      </div>
      <form onSubmit={handleSubmit}>

        <Section title="Device identity">
          <Field label="Device name" required>
            <input {...inp} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. SW-CORE-BKK-01" />
          </Field>
          <Field label="Device type" required>
            <select {...inp} value={form.device_type} onChange={e => set('device_type', e.target.value)}>
              <option value="">Select type</option>
              {['Access Point', 'Core Switch', 'Firewall', 'Router', 'Switch', 'Wireless Controller', 'Server', 'Virtual Machine', 'UPS', 'Others'].map((t: string) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          {form.device_type === 'Others' && (
            <Field label="Specify device type" required>
              <input {...inp} placeholder="e.g. CCTV Camera, PLC, KVM Switch..."
                value={(form as any).device_type_other || ''}
                onChange={e => set('device_type_other', e.target.value)} />
            </Field>
          )}
          <Field label="Brand">
            <select {...inp} value={form.brand} onChange={e => set('brand', e.target.value)}>
              <option value="">Select brand</option>
              {lookups.brands.map(b => <option key={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <input {...inp} value={form.model} onChange={e => set('model', e.target.value)} placeholder="e.g. Catalyst 9300" />
          </Field>
          <Field label="Serial number" span>
            <input {...inp} value={form.serial_number} onChange={e => set('serial_number', e.target.value)} placeholder="e.g. FCW2144L0BX" />
          </Field>
        </Section>

        <Section title="Network">
          <Field label="IP address">
            <input {...inp} value={form.ip_address} onChange={e => set('ip_address', e.target.value)} placeholder="e.g. 10.1.1.1" />
          </Field>
          <Field label="Management protocol">
            <select {...inp} value={form.mgmt_protocol} onChange={e => set('mgmt_protocol', e.target.value)}>
              <option value="">Select protocol</option>
              {lookups.mgmtProtocols.map(p => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Management URL" span>
            <input {...inp} value={form.mgmt_url} onChange={e => set('mgmt_url', e.target.value)} placeholder="https://..." />
          </Field>
        </Section>

        <Section title="Location">
          <Field label="Site" required>
            <select {...inp} value={form.site} onChange={e => set('site', e.target.value)}>
              <option value="">Select site</option>
              {lookups.sites
                .filter((s: any) => !isSiteAdmin || !sessionUser?.siteIds?.length || sessionUser.siteIds.includes(s.id))
                .map((s: any) => <option key={s.site} value={s.site}>{s.site} — {s.country}</option>)}
            </select>
          </Field>
          <Field label="Location detail">
            <input {...inp} value={form.location_detail} onChange={e => set('location_detail', e.target.value)} placeholder="e.g. Rack B2, Server room" />
          </Field>
        </Section>

        <Section title="Lifecycle & status">
          <Field label="Lifecycle status">
            <select {...inp} value={form.lifecycle_status} onChange={e => set('lifecycle_status', e.target.value)}>
              {lookups.lifecycleStatuses.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Device status">
            <select {...inp} value={form.device_status} onChange={e => set('device_status', e.target.value)}>
              {lookups.deviceStatuses.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
          {!isSiteAdmin && (
            <Field label="Risk score">
              <input {...inp} type="number" value={form.risk_score} onChange={e => set('risk_score', e.target.value)} placeholder="0–100" min="0" max="100" />
            </Field>
          )}
          {!isSiteAdmin && (
            <Field label="Technical debt">
              <input {...inp} value={form.technical_debt} onChange={e => set('technical_debt', e.target.value)} />
            </Field>
          )}
          <Field label="Remark" span>
            <textarea {...inp} value={form.remark} onChange={e => set('remark', e.target.value)} rows={3} style={{ resize: 'vertical' }} />
          </Field>
        </Section>

        <Section title="Procurement">
          {!isSiteAdmin && (
            <Field label="Cost (USD)">
              <input {...inp} type="number" value={form.cost} onChange={e => set('cost', e.target.value)} placeholder="0.00" />
            </Field>
          )}
          <Field label="Purchase date">
            <input {...inp} type="date" value={form.purchase_date} onChange={e => set('purchase_date', e.target.value)} />
          </Field>
          <Field label="Purchase vendor">
            <select {...inp} value={form.purchase_vendor} onChange={e => set('purchase_vendor', e.target.value)}>
              <option value="">Select vendor</option>
              {lookups.vendors.map(v => <option key={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="MA vendor">
            <select {...inp} value={form.ma_vendor} onChange={e => set('ma_vendor', e.target.value)}>
              <option value="">Select vendor</option>
              {lookups.vendors.map(v => <option key={v}>{v}</option>)}
            </select>
          </Field>
        </Section>

        {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', marginBottom: '16px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-primary" type="submit" disabled={saving}>{saving ? 'Saving...' : deviceId ? 'Save changes' : 'Add device'}</button>
          <button className="btn-secondary" type="button" onClick={() => router.back()}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
