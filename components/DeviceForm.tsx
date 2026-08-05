'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useToast } from '@/app/providers'
import { calcTechnicalDebt } from '@/lib/techDebt'

type Lookups = {
  regions: string[]; sites: { site: string; country: string; region: string }[]
  deviceTypes: string[]; brands: string[]; vendors: string[]
  lifecycleStatuses: string[]; deviceStatuses: string[]; mgmtProtocols: string[]
}

type DeviceFormProps = { initialData?: Record<string, any>; deviceId?: string }

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
    <div className="card" style={{ marginBottom: '16px', padding: '20px 24px' }}>
      <h2 style={{ fontSize: 'var(--text-md)', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '18px', paddingBottom: '10px', borderBottom: '1px solid var(--border-light)' }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>{children}</div>
    </div>
  )
}

export default function DeviceForm({ initialData, deviceId }: DeviceFormProps) {
  const router = useRouter()
  const { data: session } = useSession()
  const sessionUser = session?.user as { role?: string; siteIds?: number[] } | undefined
  const isSiteAdmin = sessionUser?.role === 'site_admin'
  const { showToast } = useToast()
  const [lookups, setLookups] = useState<Lookups | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', brand: '', model: '', serial_number: '', device_type: '', device_type_other: '', ip_address: '', mgmt_protocol: '', mgmt_url: '', site: '', location_detail: '', lifecycle_status: 'Unknown', device_status: 'Active', risk_score: '', technical_debt: '', remark: '', cost: '', purchase_date: '', purchase_vendor: '', ma_vendor: '', support_contract_number: '', support_vendor: '', support_start_date: '', support_end_date: '', support_cost: '', support_currency: 'THB', os_type: '', os_version: '', os_eol_date: '', ...initialData })

  useEffect(() => {
    fetch('/api/lookup').then(r => r.json()).then(data => {
      setLookups(data)
      // Auto-select site if site admin has only one assigned site and no site is set
      if (isSiteAdmin && data.sites?.length === 1 && !initialData?.site) {
        setForm(f => ({ ...f, site: data.sites[0].site }))
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  function set(field: string, value: string) { setForm(f => ({ ...f, [field]: value })) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name || !form.device_type || !form.site) { setError('Name, device type and site are required'); return }
    if (form.device_type === 'Others' && !(form as any).device_type_other) { setError('Please specify the device type'); return }
    if (form.ip_address && !/^\d{1,3}(\.\d{1,3}){3}$/.test(form.ip_address.trim())) { setError('Invalid IP address format (e.g. 192.168.1.1)'); return }
    if (form.device_type === 'Others') (form as any).device_type = (form as any).device_type_other
    setSaving(true); setError('')
    const res = await fetch(deviceId ? `/api/devices/${deviceId}` : '/api/devices', {
      method: deviceId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    if (res.ok) {
      const data = await res.json()
      if (!deviceId) {
        showToast(`Device "${data.name || form.name}" added successfully to ${data.site || form.site}`)
      } else {
        showToast('Device updated successfully')
      }
      router.push('/devices')
      router.refresh()
    } else {
      const data = await res.json()
      setError(data.error || 'Failed to save')
      setSaving(false)
    }
  }

  if (!lookups) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>



  const inp = { className: 'input' }

  // Technical debt is DERIVED, never stored from user input: both POST /api/devices
  // and PUT /api/devices/[id] overwrite it with calcTechnicalDebt(...) and ignore
  // body.technical_debt. It used to render as a free-text input, so anything typed
  // here was silently discarded on every save. Show the same computed value the
  // server will write, recalculated live as the three inputs change — mirroring the
  // submit-time swap of 'Others' for the typed device type.
  const effectiveDeviceType = form.device_type === 'Others'
    ? ((form as any).device_type_other || '')
    : form.device_type
  const derivedTechDebt = calcTechnicalDebt(form.lifecycle_status, form.device_status, effectiveDeviceType)

  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '24px' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-base)', cursor: 'pointer', padding: 0, marginBottom: '12px' }}>← Back</button>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>{deviceId ? 'Edit device' : 'Add new device'}</h1>
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
              <div
                className="input"
                style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-primary)', color: derivedTechDebt === null ? 'var(--text-muted)' : 'var(--text-primary)' }}
              >
                {derivedTechDebt === null ? '—' : derivedTechDebt.toLocaleString()}
              </div>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Calculated from lifecycle status, device status and device type. Set only for an
                Active device at EOL / EOS.
              </p>
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
            <input {...inp} list="vendors-list" value={form.purchase_vendor} onChange={e => set('purchase_vendor', e.target.value)} placeholder="Select or type vendor" />
          </Field>
          <Field label="MA vendor">
            <input {...inp} list="vendors-list" value={form.ma_vendor} onChange={e => set('ma_vendor', e.target.value)} placeholder="Select or type vendor" />
          </Field>
        </Section>
        <Section title="Support Contract">
          <Field label="Contract number">
            <input {...inp} type="text" value={form.support_contract_number} onChange={e => set('support_contract_number', e.target.value)} placeholder="e.g. SUP-12345" />
          </Field>
          <Field label="Support vendor">
            <input {...inp} list="vendors-list" value={form.support_vendor} onChange={e => set('support_vendor', e.target.value)} placeholder="Select or type vendor" />
          </Field>
          <Field label="Support start date">
            <input {...inp} type="date" value={form.support_start_date} onChange={e => set('support_start_date', e.target.value)} />
          </Field>
          <Field label="Support end date">
            <input {...inp} type="date" value={form.support_end_date} onChange={e => set('support_end_date', e.target.value)} />
          </Field>
          <Field label="Support cost">
            <input {...inp} type="number" value={form.support_cost} onChange={e => set('support_cost', e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Currency">
            <select {...inp} value={form.support_currency} onChange={e => set('support_currency', e.target.value)}>
              <option value="THB">THB</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="SGD">SGD</option>
              <option value="GBP">GBP</option>
            </select>
          </Field>

        </Section>

        <Section title="Software / Firmware">
          <Field label="OS Type">
            <input {...inp} list="os-type-list" value={form.os_type} onChange={e => set('os_type', e.target.value)} placeholder="e.g. PAN-OS, FortiOS" />
            <datalist id="os-type-list">
              {['PAN-OS','FortiOS','ArubaOS','IOS-XE','IOS-XR','NX-OS','EOS','JunOS','SonicOS','Other'].map(t => <option key={t} value={t} />)}
            </datalist>
          </Field>
          <Field label="OS Version">
            <input {...inp} value={form.os_version} onChange={e => set('os_version', e.target.value)} placeholder="e.g. 10.2.4" />
          </Field>
          <Field label="OS EOL Date">
            <input {...inp} type="date" value={form.os_eol_date} onChange={e => set('os_eol_date', e.target.value)} />
          </Field>
        </Section>

        {error && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '12px 16px', borderRadius: 'var(--radius)', fontSize: 'var(--text-md)', marginBottom: '16px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-primary" type="submit" disabled={saving}>{saving ? 'Saving...' : deviceId ? 'Save changes' : 'Add device'}</button>
          <button className="btn-secondary" type="button" onClick={() => router.back()}>Cancel</button>
        </div>
      <datalist id="vendors-list">
        {lookups.vendors.map(v => <option key={v} value={v} />)}
      </datalist>
      </form>
    </div>
  )
}
