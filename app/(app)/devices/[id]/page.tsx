'use client'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

type Device = Record<string, any>
type Log = { field_name: string; changed_at: string; changed_by_name: string; old_value: string; new_value: string }

function Badge({ status }: { status: string }) {
  const map: Record<string, string> = { 'Active': 'badge-active', 'Decommed': 'badge-decommed', 'Faulty, Replaced': 'badge-faulty', 'Spare': 'badge-spare' }
  return <span className={`badge ${map[status] || 'badge-unknown'}`}>{status}</span>
}

function LifecycleBadge({ status }: { status: string }) {
  if (status === 'EOL / EOS') return <span className="badge badge-eol">EOL / EOS</span>
  if (status === 'Active, Supported') return <span className="badge badge-active">Active, Supported</span>
  return <span className="badge badge-unknown">Unknown</span>
}

export default function DeviceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'site_admin'
  const [device, setDevice] = useState<Device | null>(null)
  const [logs, setLogs] = useState<Log[]>([])
  const [loading, setLoading] = useState(true)
  const [id, setId] = useState('')

  useEffect(() => {
    params.then(async p => {
      setId(p.id)
      const [dev, auditRes] = await Promise.all([
        fetch(`/api/devices/${p.id}`).then(r => r.json()),
        fetch(`/api/audit/device/${p.id}`).then(r => r.json()),
      ])
      setDevice(dev)
      setLogs(auditRes.logs || [])
      setLoading(false)
    })
  }, [params])

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
  if (!device) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Device not found</div>

  function timeAgo(d: string) {
    const diff = Date.now() - new Date(d).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const Field = ({ label, value }: { label: string; value: any }) => (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '3px' }}>{label}</div>
      <div style={{ fontSize: '14px', color: value ? '#111827' : '#d1d5db', fontFamily: label === 'IP address' || label === 'Serial number' ? 'monospace' : undefined }}>
        {value || '—'}
      </div>
    </div>
  )

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '16px' }}>
      <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '16px', paddingBottom: '10px', borderBottom: '1px solid #f3f4f6' }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>{children}</div>
    </div>
  )

  return (
    <div style={{ padding: '24px 28px', maxWidth: '960px' }}>
      <div style={{ marginBottom: '20px' }}>
        <Link href="/devices" style={{ fontSize: '13px', color: '#6b7280', textDecoration: 'none' }}>← Back to devices</Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: '0 0 6px' }}>{device.name}</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Badge status={device.device_status} />
            <LifecycleBadge status={device.lifecycle_status} />
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>{device.device_type} · {device.brand} {device.model}</span>
          </div>
        </div>
        {isAdmin && (
          <Link href={`/devices/${id}/edit`}>
            <button className="btn-primary">Edit device</button>
          </Link>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div>
          <Section title="Identity">
            <Field label="Device name" value={device.name} />
            <Field label="Device type" value={device.device_type} />
            <Field label="Brand" value={device.brand} />
            <Field label="Model" value={device.model} />
            <Field label="Serial number" value={device.serial_number} />
          </Section>
          <Section title="Network">
            <Field label="IP address" value={device.ip_address} />
            <Field label="Mgmt protocol" value={device.mgmt_protocol} />
            <div style={{ gridColumn: '1 / -1' }}><Field label="Mgmt URL" value={device.mgmt_url} /></div>
          </Section>
          <Section title="Procurement">
            <Field label="Cost" value={device.cost ? `$${parseFloat(device.cost).toLocaleString()}` : null} />
            <Field label="Purchase date" value={device.purchase_date ? new Date(device.purchase_date).toLocaleDateString() : null} />
            <Field label="Purchase vendor" value={device.purchase_vendor} />
            <Field label="MA vendor" value={device.ma_vendor} />
          </Section>
        </div>

        <div>
          <Section title="Location">
            <Field label="Site" value={device.site} />
            <Field label="Country" value={device.country} />
            <Field label="Region" value={device.region} />
            <div style={{ gridColumn: '1 / -1' }}><Field label="Location detail" value={device.location_detail} /></div>
          </Section>
          <Section title="Lifecycle">
            <Field label="Device status" value={device.device_status} />
            <Field label="Lifecycle status" value={device.lifecycle_status} />
            <Field label="Risk score" value={device.risk_score} />
            <div style={{ gridColumn: '1 / -1' }}><Field label="Technical debt" value={device.technical_debt} /></div>
            <div style={{ gridColumn: '1 / -1' }}><Field label="Remark" value={device.remark} /></div>
          </Section>

          {/* Change history */}
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px' }}>
            <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '14px', paddingBottom: '10px', borderBottom: '1px solid #f3f4f6' }}>Change history</h2>
            {logs.length === 0 ? (
              <div style={{ fontSize: '13px', color: '#9ca3af' }}>No changes recorded yet</div>
            ) : logs.map((log, i) => (
              <div key={i} style={{ display: 'flex', gap: '10px', paddingBottom: '10px', marginBottom: '10px', borderBottom: i < logs.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, marginTop: '5px', background: log.field_name === 'created' ? '#166534' : log.field_name === 'deleted' ? '#991b1b' : '#075985' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', color: '#374151' }}>
                    <span style={{ fontWeight: '500' }}>{log.changed_by_name || 'System'}</span>
                    {' '}{log.field_name} this device
                  </div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{timeAgo(log.changed_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
