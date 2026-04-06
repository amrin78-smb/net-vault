'use client'
import { useState, useEffect, useCallback } from 'react'
type Log = { id: string; field_name: string; changed_at: string; changed_by_name: string; changed_by_email: string; device_name: string }
type User = { id: string; name: string }

const ACTION_LABELS: Record<string, string> = {
  created: 'Created', updated: 'Updated', deleted: 'Deleted',
  bulk_device_status: 'Bulk status', bulk_lifecycle_status: 'Bulk lifecycle', bulk_site_id: 'Bulk site'
}
const actionColor: Record<string, string> = { created: '#166534', updated: '#075985', deleted: '#991b1b' }
const actionBg: Record<string, string> = { created: '#dcfce7', updated: '#e0f2fe', deleted: '#fee2e2' }

export default function AuditPage() {
  const [logs, setLogs] = useState<Log[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<User[]>([])
  const [action, setAction] = useState('')
  const [userId, setUserId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page) })
    if (action)   params.set('action', action)
    if (userId)   params.set('user', userId)
    if (dateFrom) params.set('from', dateFrom)
    if (dateTo)   params.set('to', dateTo)
    const res = await fetch(`/api/audit?${params}`)
    const d = await res.json()
    setLogs(d.logs || [])
    setTotal(d.total || 0)
    if (d.users) setUsers(d.users)
    setLoading(false)
  }, [page, action, userId, dateFrom, dateTo])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  function clearFilters() {
    setAction(''); setUserId(''); setDateFrom(''); setDateTo(''); setPage(1)
  }

  const hasFilters = !!(action || userId || dateFrom || dateTo)
  const totalPages = Math.ceil(total / 50)

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Audit log</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Full history of all changes - {total.toLocaleString()} entries</p>
      </div>

      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '14px 16px', marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px', fontWeight: '500' }}>Action</div>
          <select className="select" style={{ width: 'auto', minWidth: '140px' }} value={action} onChange={e => { setAction(e.target.value); setPage(1) }}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px', fontWeight: '500' }}>User</div>
          <select className="select" style={{ width: 'auto', minWidth: '140px' }} value={userId} onChange={e => { setUserId(e.target.value); setPage(1) }}>
            <option value="">All users</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px', fontWeight: '500' }}>From</div>
          <input type="date" className="input" style={{ width: 'auto' }} value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px', fontWeight: '500' }}>To</div>
          <input type="date" className="input" style={{ width: 'auto' }} value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
        </div>
        {hasFilters && (
          <button className="btn-secondary" onClick={clearFilters} style={{ fontSize: '12px' }}>Clear filters</button>
        )}
      </div>

      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>No audit records found</div>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Device</th><th>Changed by</th></tr></thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td style={{ fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap' }}>{new Date(log.changed_at).toLocaleString()}</td>
                  <td><span className="badge" style={{ background: actionBg[log.field_name] || '#f3f4f6', color: actionColor[log.field_name] || '#374151' }}>{ACTION_LABELS[log.field_name] || log.field_name}</span></td>
                  <td style={{ fontWeight: '500', color: '#111827' }}>{log.device_name || '—'}</td>
                  <td style={{ fontSize: '12px' }}>
                    <div style={{ fontWeight: '500' }}>{log.changed_by_name}</div>
                    <div style={{ color: '#9ca3af' }}>{log.changed_by_email}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {total > 50 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>Page {page} of {totalPages} - {total.toLocaleString()} entries</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={() => setPage(p => p-1)} disabled={page === 1}>Prev</button>
              <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={() => setPage(p => p+1)} disabled={page >= totalPages}>Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
