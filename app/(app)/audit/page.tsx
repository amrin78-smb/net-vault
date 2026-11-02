'use client'
import { useState, useEffect, useCallback } from 'react'
import { PageHead, Pager } from '@/components/system'
type Log = { id: string; field_name: string; changed_at: string; changed_by_name: string; changed_by_email: string; device_name: string }
type User = { id: string; name: string }

const ACTION_LABELS: Record<string, string> = {
  created: 'Created', updated: 'Updated', deleted: 'Deleted',
  bulk_device_status: 'Bulk status', bulk_lifecycle_status: 'Bulk lifecycle', bulk_site_id: 'Bulk site'
}
const actionColor: Record<string, string> = { created: 'var(--tint-success-fg)', updated: 'var(--tint-info-fg)', deleted: 'var(--tint-danger-fg)' }
const actionBg: Record<string, string> = { created: 'var(--tint-success)', updated: 'var(--tint-info)', deleted: 'var(--tint-danger)' }

// Fixed server-side in app/api/audit/route.ts; see the Pager note below.
const AUDIT_PAGE_SIZE = 50

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
  const totalPages = Math.ceil(total / AUDIT_PAGE_SIZE)

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <PageHead
          title="Audit Log"
          description="Every recorded change, newest first. Filter by action, user or device to narrow the history."
          status={<span className="badge badge-gray tnum">{total.toLocaleString()} entries</span>}
        />
      </div>

      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '14px 16px', marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>Action</div>
          <select className="select" aria-label="Filter audit log" style={{ width: 'auto', minWidth: '140px' }} value={action} onChange={e => { setAction(e.target.value); setPage(1) }}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>User</div>
          <select className="select" style={{ width: 'auto', minWidth: '140px' }} value={userId} onChange={e => { setUserId(e.target.value); setPage(1) }}>
            <option value="">All users</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>From</div>
          <input type="date" className="input" style={{ width: 'auto' }} value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>To</div>
          <input type="date" className="input" style={{ width: 'auto' }} value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
        </div>
        {hasFilters && (
          <button className="btn-secondary" onClick={clearFilters} style={{ fontSize: 'var(--text-sm)' }}>Clear filters</button>
        )}
      </div>

      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>No audit records found</div>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Device</th><th>Changed by</th></tr></thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{new Date(log.changed_at).toLocaleString()}</td>
                  <td><span className="badge" style={{ background: actionBg[log.field_name] || 'var(--surface-subtle)', color: actionColor[log.field_name] || 'var(--text-secondary)' }}>{ACTION_LABELS[log.field_name] || log.field_name}</span></td>
                  <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{log.device_name || '—'}</td>
                  <td style={{ fontSize: 'var(--text-sm)' }}>
                    <div style={{ fontWeight: '500' }}>{log.changed_by_name}</div>
                    <div style={{ color: 'var(--text-muted)' }}>{log.changed_by_email}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Shared Pager, deliberately WITHOUT a page-size selector.
            /api/audit fixes its page size at 50 server-side and reserves
            ?limit= for a different recent-activity feed mode capped at 25 -
            so offering 100-per-page here would quietly return 25 rows.
            A JSX comment cannot be the first child of a {cond && (...)}
            expression, so it lives out here. */}
        {total > AUDIT_PAGE_SIZE && (
          <Pager page={page} limit={AUDIT_PAGE_SIZE} total={total} onPage={setPage} loading={loading} />
        )}
      </div>
    </div>
  )
}
