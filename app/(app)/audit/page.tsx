'use client'
import { useState, useEffect, useCallback } from 'react'
import { Dialog, FilterChips, PageHead, Pager } from '@/components/system'
type Log = { id: string; field_name: string; changed_at: string; changed_by_name: string; changed_by_email: string; device_name: string; old_value?: string | null; new_value?: string | null }
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
  const [detail, setDetail] = useState<Log | null>(null)
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

      <FilterChips
        filters={([
          ['action', 'Action', action ? (ACTION_LABELS[action as keyof typeof ACTION_LABELS] ?? action) : ''],
          ['user',   'User',   userId ? (users.find(u => String(u.id) === String(userId))?.name ?? userId) : ''],
          ['from',   'From',   dateFrom],
          ['to',     'To',     dateTo],
        ] as const).filter(([, , v]) => !!v).map(([key, label, value]) => ({ key, label, value: String(value) }))}
        onClear={k => {
          setPage(1)
          if (k === 'action') setAction('')
          else if (k === 'user') setUserId('')
          else if (k === 'from') setDateFrom('')
          else setDateTo('')
        }}
        onClearAll={clearFilters}
      />

      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>No audit records found</div>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Device</th><th>Changed by</th><th>Details</th></tr></thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="clickable" style={{ cursor: 'pointer' }}
                    onClick={() => setDetail(log)}>
                  <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{new Date(log.changed_at).toLocaleString()}</td>
                  <td><span className="badge" style={{ background: actionBg[log.field_name] || 'var(--surface-subtle)', color: actionColor[log.field_name] || 'var(--text-secondary)' }}>{ACTION_LABELS[log.field_name] || log.field_name}</span></td>
                  <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{log.device_name || '—'}</td>
                  <td style={{ fontSize: 'var(--text-sm)' }}>
                    <div style={{ fontWeight: '500' }}>{log.changed_by_name}</div>
                    <div style={{ color: 'var(--text-muted)' }}>{log.changed_by_email}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/* A real button: the row click is a convenience for the
                        mouse, but a <tr onClick> is unreachable by keyboard. */}
                    <button type="button" className="btn btn-secondary"
                      style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }}
                      onClick={e => { e.stopPropagation(); setDetail(log) }}
                      aria-label={`View details of the ${ACTION_LABELS[log.field_name] || log.field_name} change${log.device_name ? ` to ${log.device_name}` : ''}`}>
                      Details
                    </button>
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

      {/* Detail drawer.

          The API has always returned old_value and new_value; nothing
          rendered them, so the log could tell you THAT a device changed but
          never WHAT changed. For an audit trail that is most of the point. */}
      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        variant="drawer"
        title={detail ? (ACTION_LABELS[detail.field_name] || detail.field_name) : ''}
        description={detail ? new Date(detail.changed_at).toLocaleString() : ''}
        footer={<button className="btn" onClick={() => setDetail(null)}>Close</button>}
      >
        {detail && (
          <div style={{ marginTop: 12 }}>
            <dl className="dl">
              <div style={{ display: 'contents' }}><dt>Device</dt><dd>{detail.device_name || '\u2014'}</dd></div>
              <div style={{ display: 'contents' }}><dt>Changed by</dt><dd>{detail.changed_by_name}{detail.changed_by_email ? ` (${detail.changed_by_email})` : ''}</dd></div>
              <div style={{ display: 'contents' }}><dt>When</dt><dd>{new Date(detail.changed_at).toLocaleString()}</dd></div>
            </dl>

            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Change
              </div>
              {(detail.old_value ?? detail.new_value) == null ? (
                <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: 0 }}>
                  This entry does not record before and after values.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 3 }}>Before</div>
                    <div className="mono" style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '8px 11px', borderRadius: 'var(--radius-sm)', overflowWrap: 'anywhere' }}>
                      {detail.old_value || '(empty)'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 3 }}>After</div>
                    <div className="mono" style={{ background: 'var(--tint-success)', color: 'var(--tint-success-fg)', padding: '8px 11px', borderRadius: 'var(--radius-sm)', overflowWrap: 'anywhere' }}>
                      {detail.new_value || '(empty)'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
