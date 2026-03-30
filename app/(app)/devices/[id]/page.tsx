'use client'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import Breadcrumb from '@/components/Breadcrumb'

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

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(d).toLocaleDateString()
}

function formatDateTime(d: string) {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function parseLogEntry(log: Log): { label: string; detail: string | null; dotColor: string } {
  const field = log.field_name

  if (field === 'created') return { label: 'Device created', detail: null, dotColor: '#166534' }
  if (field === 'deleted') return { label: 'Device deleted', detail: null, dotColor: '#991b1b' }

  if (field === 'updated') {
    // Try to parse old/new value as JSON for structured diff
    try {
      const oldObj = JSON.parse(log.old_value || '{}')
      const newObj = JSON.parse(log.new_value || '{}')
      const changed: string[] = []
      const fieldLabels: Record<string, string> = {
        name: 'Name', brand: 'Brand', model: 'Model', device_type: 'Type',
        ip_address: 'IP address', site: 'Site', device_status: 'Device status',
        lifecycle_status: 'Lifecycle', serial_number: 'Serial', mgmt_protocol: 'Mgmt protocol',
        mgmt_url: 'Mgmt URL', location_detail: 'Location', risk_score: 'Risk score',
        remark: 'Remark', cost: 'Cost', purchase_date: 'Purchase date',
        purchase_vendor: 'Purchase vendor', ma_vendor: 'MA vendor'
      }
      for (const key of Object.keys(newObj)) {
        const oldVal = oldObj[key]
        const newVal = newObj[key]
        if (String(oldVal || '') !== String(newVal || '') && fieldLabels[key]) {
          const label = fieldLabels[key]
          const from = oldVal ? `"${oldVal}"` : 'empty'
          const to = newVal ? `"${newVal}"` : 'empty'
          changed.push(`${label}: ${from} → ${to}`)
        }
      }
      return {
        label: 'Device updated',
        detail: changed.length > 0 ? changed.join('\n') : null,
        dotColor: '#075985'
      }
    } catch {
      return { label: 'Device updated', detail: null, dotColor: '#075985' }
    }
  }

  // Bulk field changes
  const bulkLabels: Record<string, string> = {
    bulk_device_status: 'Device status',
    bulk_lifecycle_status: 'Lifecycle status',
    bulk_site_id: 'Site',
  }
  if (bulkLabels[field]) {
    const label = bulkLabels[field]
    const to = log.new_value ? `"${log.new_value}"` : 'unknown'
    return { label: `${label} changed (bulk)`, detail: `Set to ${to}`, dotColor: '#6d28d9' }
  }

  // Fallback for any other field
  const from = log.old_value ? `"${log.old_value}"` : 'empty'
  const to = log.new_value ? `"${log.new_value}"` : 'empty'
  return {
    label: `${field} changed`,
    detail: `${from} → ${to}`,
    dotColor: '#075985'
  }
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
      <Breadcrumb crumbs={[
        { label: 'Devices', href: '/devices' },
        { label: device.name || 'Device detail' },
      ]} />

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

          {/* Change history timeline */}
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px' }}>
            <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '16px', paddingBottom: '10px', borderBottom: '1px solid #f3f4f6' }}>
              Change history {logs.length > 0 && <span style={{ fontWeight: '400', color: '#9ca3af', textTransform: 'none', letterSpacing: 0 }}>({logs.length})</span>}
            </h2>

            {logs.length === 0 ? (
              <div style={{ fontSize: '13px', color: '#9ca3af' }}>No changes recorded yet</div>
            ) : (
              <div style={{ position: 'relative' }}>
                {/* Timeline line */}
                <div style={{ position: 'absolute', left: '7px', top: '8px', bottom: '8px', width: '1px', background: '#e5e7eb' }} />

                {logs.map((log, i) => {
                  const { label, detail, dotColor } = parseLogEntry(log)
                  return (
                    <div key={i} style={{ display: 'flex', gap: '14px', paddingBottom: i < logs.length - 1 ? '14px' : 0, marginBottom: i < logs.length - 1 ? '14px' : 0, position: 'relative' }}>
                      {/* Dot */}
                      <div style={{ width: '15px', height: '15px', borderRadius: '50%', flexShrink: 0, marginTop: '2px', background: dotColor, border: '2px solid white', boxShadow: `0 0 0 1px ${dotColor}`, zIndex: 1 }} />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                          <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{label}</div>
                          <div style={{ fontSize: '11px', color: '#9ca3af', flexShrink: 0 }} title={formatDateTime(log.changed_at)}>
                            {timeAgo(log.changed_at)}
                          </div>
                        </div>
                        <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '1px' }}>
                          {log.changed_by_name || 'System'}
                        </div>
                        {detail && (
                          <div style={{ marginTop: '6px', background: '#f9fafb', borderRadius: '6px', padding: '8px 10px', border: '1px solid #f3f4f6' }}>
                            {detail.split('\n').map((line, j) => (
                              <div key={j} style={{ fontSize: '12px', color: '#374151', fontFamily: 'monospace', lineHeight: '1.6' }}>{line}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
