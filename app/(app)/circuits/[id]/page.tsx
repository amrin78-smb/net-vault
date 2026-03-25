'use client'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

type Circuit = Record<string, any>

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'NOK', 'PLN', 'SGD', 'VND', 'GHS']

export default function CircuitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin'
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

  const formatCost = (cost: any, currency: string) => {
    if (!cost) return '—'
    return `${currency || 'THB'} ${parseFloat(cost).toLocaleString()}`
  }

  const Field = ({ label, value }: { label: string; value: any }) => (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '3px' }}>{label}</div>
      <div style={{ fontSize: '14px', color: value && value !== 'nan' && value !== '-' ? '#111827' : '#d1d5db', fontFamily: ['Circuit ID','Public subnet','Max speed','Guaranteed speed'].includes(label) ? 'monospace' : undefined }}>
        {value && value !== 'nan' && value !== '-' ? value : '—'}
      </div>
    </div>
  )

  const EditField = ({ label, field, type = 'text' }: { label: string; field: string; type?: string }) => (
    <div style={{ marginBottom: '14px' }}>
      <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>{label}</label>
      <input className="input" type={type} value={form[field] || ''} onChange={e => setForm((f: Circuit) => ({ ...f, [field]: e.target.value }))} />
    </div>
  )

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '18px 22px', marginBottom: '16px' }}>
      <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '16px', paddingBottom: '10px', borderBottom: '1px solid #f3f4f6' }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>{children}</div>
    </div>
  )

  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '16px' }}>
        <Link href="/circuits" style={{ fontSize: '13px', color: '#6b7280', textDecoration: 'none' }}>← Back to circuits</Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: '0 0 6px' }}>
            {circuit.circuit_id || 'Unnamed circuit'}
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
            <Section title="Circuit details">
              <EditField label="Circuit ID" field="circuit_id" />
              <EditField label="ISP" field="isp" />
              <EditField label="Usage" field="usage" />
              <EditField label="Technology" field="technology" />
              <EditField label="Circuit type" field="circuit_type" />
              <EditField label="Interface" field="interface" />
              <EditField label="Max speed" field="max_speed" />
              <EditField label="Guaranteed speed" field="guaranteed_speed" />
            </Section>
          </div>
          <div>
            <Section title="Commercial">
              <EditField label="Public subnet" field="public_subnet" />
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Currency</label>
                <select className="input select" value={form.currency || 'THB'} onChange={e => setForm((f: Circuit) => ({ ...f, currency: e.target.value }))}>
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <EditField label="Cost/month" field="cost_month" type="number" />
              <EditField label="Contract term" field="contract_term" />
              <EditField label="Pingable" field="pingable" />
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>Comment</label>
                <textarea className="input" rows={3} value={form.comment || ''} onChange={e => setForm((f: Circuit) => ({ ...f, comment: e.target.value }))} style={{ resize: 'vertical' }} />
              </div>
            </Section>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <Section title="Circuit details">
              <Field label="Circuit ID" value={circuit.circuit_id} />
              <Field label="Product" value={circuit.product} />
              <Field label="Usage" value={circuit.usage} />
              <Field label="Technology" value={circuit.technology} />
              <Field label="Circuit type" value={circuit.circuit_type} />
              <Field label="Interface" value={circuit.interface} />
              <Field label="Max speed" value={circuit.max_speed} />
              <Field label="Guaranteed speed" value={circuit.guaranteed_speed} />
            </Section>
            <Section title="Location">
              <Field label="Site" value={circuit.site || circuit.site_name_raw} />
              <Field label="City" value={circuit.city} />
              <Field label="Country" value={circuit.country} />
              <Field label="Region" value={circuit.region} />
              <div style={{ gridColumn: '1 / -1' }}><Field label="Address" value={circuit.address} /></div>
              <div style={{ gridColumn: '1 / -1' }}><Field label="IT owner" value={circuit.it_owner} /></div>
            </Section>
          </div>
          <div>
            <Section title="Commercial">
              <Field label="Public subnet" value={circuit.public_subnet} />
              <Field label="Currency" value={circuit.currency || 'THB'} />
              <Field label="Cost / month" value={formatCost(circuit.cost_month, circuit.currency)} />
              <Field label="Contract term" value={circuit.contract_term} />
              <Field label="Pingable from IDC" value={circuit.pingable} />
              <div style={{ gridColumn: '1 / -1' }}><Field label="Comment" value={circuit.comment} /></div>
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}
