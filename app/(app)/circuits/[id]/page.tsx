'use client'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import Breadcrumb from '@/components/Breadcrumb'

type Circuit = Record<string, any>

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'NOK', 'PLN', 'SGD', 'VND', 'GHS']

function CircuitField({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '3px' }}>{label}</div>
      <div style={{ fontSize: '14px', color: value && String(value) !== 'nan' && value !== '-' ? '#111827' : '#d1d5db', fontFamily: ['Circuit ID','Public subnet','Max speed','Guaranteed speed'].includes(label) ? 'monospace' : undefined }}>
        {value && String(value) !== 'nan' && value !== '-' ? value : '—'}
      </div>
    </div>
  )
}

function CircuitEditField({ label, field, form, setForm, type = 'text' }: { label: string; field: string; form: any; setForm: any; type?: string }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>{label}</label>
      <input className="input" type={type} value={form[field] && form[field] !== 'nan' ? form[field] : ''} onChange={e => setForm((f: any) => ({ ...f, [field]: e.target.value }))} />
    </div>
  )
}

function CircuitSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '18px 22px', marginBottom: '16px' }}>
      <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '16px', paddingBottom: '10px', borderBottom: '1px solid #f3f4f6' }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>{children}</div>
    </div>
  )
}

export default function CircuitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'site_admin'
  const [circuit, setCircuit] = useState<Circuit | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Circuit>({})
  const [saving, setSaving] = useState(false)
  const [id, setId] = useState('')

  useEffect(() => {
    params.then(p => {
      setId(p.id)
      fetch(`/api/circuits/${p.id}`).then(r => r.json()).then(d => {
        setCircuit(d); setForm(d); setLoading(false)
      })
    })
  }, [params])

  async function save() {
    setSaving(true)
    await fetch(`/api/circuits/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    setCircuit(form)
    setEditing(false)
    setSaving(false)
  }

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
  if (!circuit) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Circuit not found</div>

  const formatSpeed = (speed: any) => {
    if (!speed || speed === 'nan') return '—'
    const parts = String(speed).split('/')
    if (parts.length === 2) {
      const clean = (s: string) => s.replace(/\s*(guaranteed|not guaranteed|guranteed|shared)\s*/gi, '').trim()
      const up = clean(parts[0])
      const down = clean(parts[1])
      if (up === down) return up
      return `${up} / ${down}`
    }
    return speed
  }

  const formatCost = (cost: any, currency: string) => {
    if (!cost) return '—'
    return `${currency || 'THB'} ${parseFloat(cost).toLocaleString()}`
  }



  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '16px' }}>
        <Breadcrumb crumbs={[
          { label: 'Circuits', href: '/circuits' },
          { label: circuit.circuit_id && circuit.circuit_id !== 'nan' ? circuit.circuit_id : circuit.isp || 'Circuit detail' },
        ]} />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: '0 0 6px' }}>
            {circuit.circuit_id && circuit.circuit_id !== 'nan' ? circuit.circuit_id : circuit.isp ? `${circuit.isp} — ${circuit.site || circuit.site_name_raw}` : 'Unnamed circuit'}
          </h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: '500', color: '#374151' }}>{circuit.isp}</span>
            <span style={{ color: '#d1d5db' }}>·</span>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>{circuit.site || circuit.site_name_raw}</span>
            <span style={{ color: '#d1d5db' }}>·</span>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>{circuit.country}</span>
            {circuit.usage && (
              <span className="badge" style={{ background: circuit.usage?.toLowerCase() === 'main' ? '#e0f2fe' : '#f3f4f6', color: circuit.usage?.toLowerCase() === 'main' ? '#075985' : '#6b7280' }}>{circuit.usage}</span>
            )}
            {circuit.technology && circuit.technology !== 'nan' && (
              <span className="badge" style={{ background: '#ede9fe', color: '#5b21b6' }}>{circuit.technology}</span>
            )}
          </div>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {editing ? (
              <>
                <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                <button className="btn-secondary" onClick={() => { setEditing(false); setForm(circuit) }}>Cancel</button>
              </>
            ) : (
              <button className="btn-primary" onClick={() => setEditing(true)}>Edit circuit</button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <CircuitSection title="Circuit details">
              <CircuitEditField form={form} setForm={setForm} label="Circuit ID" field="circuit_id" />
              <CircuitEditField form={form} setForm={setForm} label="ISP" field="isp" />
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>USAGE</label>
                <select className="input select" value={form.usage || ''} onChange={e => setForm((f: Circuit) => ({ ...f, usage: e.target.value }))}>
                  <option value="">Select usage</option>
                  <option key="Primary Internet">Primary Internet</option>
                  <option key="Backup Internet">Backup Internet</option>
                  <option key="MPLS Primary">MPLS Primary</option>
                  <option key="MPLS Backup">MPLS Backup</option>
                  <option key="Guest Internet">Guest Internet</option>
                  <option key="Out-of-Band / Management">Out-of-Band / Management</option>
                  <option key="CCTV / Camera">CCTV / Camera</option>
                  <option key="IoT / OT">IoT / OT</option>
                  <option key="Compliance / Government">Compliance / Government</option>
                  <option key="Others">Others</option>
                </select>
              </div>
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>PRODUCT</label>
                <select className="input select" value={form.product || ''} onChange={e => setForm((f: Circuit) => ({ ...f, product: e.target.value }))}>
                  <option value="">Select product</option>
                  <option key="Corporate Internet / DIA">Corporate Internet / DIA</option>
                  <option key="IPVPN / MPLS">IPVPN / MPLS</option>
                  <option key="L2VPN / Private Link">L2VPN / Private Link</option>
                  <option key="SME Internet FTTx">SME Internet FTTx</option>
                  <option key="Home Broadband FTTx">Home Broadband FTTx</option>
                  <option key="Satellite">Satellite</option>
                  <option key="4G/5G Mobile">4G/5G Mobile</option>
                  <option key="Dark Fiber">Dark Fiber</option>
                  <option key="Others">Others</option>
                </select>
              </div>
                            <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Technology</label>
                <select className="input select" value={form.technology || ''} onChange={e => setForm((f: Circuit) => ({ ...f, technology: e.target.value }))}>
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
                            <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Circuit type</label>
                <select className="input select" value={form.circuit_type || ''} onChange={e => setForm((f: Circuit) => ({ ...f, circuit_type: e.target.value }))}>
                  <option value="">Select circuit type</option>
                <option key='Dedicated'>Dedicated</option>
                <option key='Shared'>Shared</option>
                <option key='Burstable'>Burstable</option>
                <option key='Always-on'>Always-on</option>
                <option key='On-demand'>On-demand</option>
                <option key='Others'>Others</option>
                </select>
              </div>
                            <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Interface</label>
                <select className="input select" value={form.interface || ''} onChange={e => setForm((f: Circuit) => ({ ...f, interface: e.target.value }))}>
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
              <CircuitEditField form={form} setForm={setForm} label="Max speed" field="max_speed" />
              <CircuitEditField form={form} setForm={setForm} label="Guaranteed speed" field="guaranteed_speed" />
            </CircuitSection>
          </div>
          <div>
            <CircuitSection title="Commercial">
              <CircuitEditField form={form} setForm={setForm} label="Public subnet" field="public_subnet" />
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Currency</label>
                <select className="input select" value={form.currency || 'THB'} onChange={e => setForm((f: Circuit) => ({ ...f, currency: e.target.value }))}>
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <CircuitEditField form={form} setForm={setForm} label="Cost/month" field="cost_month" type="number" />
              <CircuitEditField form={form} setForm={setForm} label="Contract term" field="contract_term" />
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Comment</label>
                <textarea className="input" rows={3} value={form.comment && form.comment !== 'nan' ? form.comment : ''} onChange={e => setForm((f: Circuit) => ({ ...f, comment: e.target.value }))} style={{ resize: 'vertical' }} />
              </div>
            </CircuitSection>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <CircuitSection title="Circuit details">
              <CircuitField label="Circuit ID" value={circuit.circuit_id} />
              <CircuitField label="Product" value={circuit.product} />
              <CircuitField label="Usage" value={circuit.usage} />
              <CircuitField label="Technology" value={circuit.technology} />
              <CircuitField label="Circuit type" value={circuit.circuit_type} />
              <CircuitField label="Interface" value={circuit.interface} />
              <CircuitField label="Max speed" value={formatSpeed(circuit.max_speed)} />
              <CircuitField label="Guaranteed speed" value={formatSpeed(circuit.guaranteed_speed)} />
            </CircuitSection>
            <CircuitSection title="Location">
              <CircuitField label="Site" value={circuit.site || circuit.site_name_raw} />
              <CircuitField label="City" value={circuit.city} />
              <CircuitField label="Country" value={circuit.country} />
              <CircuitField label="Region" value={circuit.region} />
              <div style={{ gridColumn: '1 / -1' }}><CircuitField label="Address" value={circuit.address} /></div>
              <div style={{ gridColumn: '1 / -1' }}><CircuitField label="IT owner" value={circuit.it_owner} /></div>
            </CircuitSection>
          </div>
          <div>
            <CircuitSection title="Commercial">
              <CircuitField label="Public subnet" value={circuit.public_subnet} />
              <CircuitField label="Currency" value={circuit.currency || 'THB'} />
              <CircuitField label="Cost / month" value={formatCost(circuit.cost_month, circuit.currency)} />
              <CircuitField label="Contract term" value={circuit.contract_term} />
              <div style={{ gridColumn: '1 / -1' }}><CircuitField label="Comment" value={circuit.comment} /></div>
            </CircuitSection>
          </div>
        </div>
      )}
    </div>
  )
}
