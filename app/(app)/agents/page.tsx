'use client'
import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useToast, useConfirm } from '@/app/providers'
import { PageHeader, EmptyState, TableSkeleton, Spinner, useEscape } from '@/components/ui'

// ── API contract types (match the routes built by the backend agent) ──────────
// GET /api/agents → { agents: Agent[] }
type AgentModule = { app: string; enabled: boolean }
type AgentStatus = 'online' | 'offline' | 'degraded' | 'revoked'
type Agent = {
  id: string
  name: string
  hostname: string | null
  local_ip: string | null
  os: string | null
  site_id: number | null
  site_name: string | null
  status: AgentStatus
  agent_version: string | null
  last_seen_at: string | null
  modules: AgentModule[]
  buffer_depth: number | null
}
type Site = { id: number; site: string; region?: string; country?: string }
// POST /api/agents/enroll-tokens → { token, expires_at, install_command }
type EnrollToken = { token: string; expires_at: string | null; install_command: string }

// ── Module registry ───────────────────────────────────────────────────────────
// Canonical short keys (log/ddi/span) drive the chip tints AND the values sent to
// the enroll + PATCH routes. normalizeApp() folds either short ('log') or long
// ('logvault') forms from the API into a canonical key so the UI is robust to both.
type ModuleKey = 'log' | 'ddi' | 'span'
const MODULES: { key: ModuleKey; label: string; app: string; bg: string; fg: string }[] = [
  { key: 'log',  label: 'LogVault',  app: 'logvault',  bg: 'var(--tint-info)',    fg: 'var(--tint-info-fg)' },
  { key: 'ddi',  label: 'DDIVault',  app: 'ddivault',  bg: 'var(--tint-purple)',  fg: 'var(--tint-purple-fg)' },
  { key: 'span', label: 'SpanVault', app: 'spanvault', bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' },
]
function normalizeApp(app: string): ModuleKey | null {
  const a = (app || '').toLowerCase()
  if (a.includes('log')) return 'log'
  if (a.includes('ddi')) return 'ddi'
  if (a.includes('span')) return 'span'
  return null
}
function moduleMeta(key: ModuleKey) {
  return MODULES.find(m => m.key === key) || MODULES[0]
}

// ── Status registry ───────────────────────────────────────────────────────────
const STATUS_META: Record<AgentStatus, { label: string; dot: string; bg: string; fg: string }> = {
  online:   { label: 'Online',   dot: 'var(--green)',      bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' },
  degraded: { label: 'Degraded', dot: 'var(--yellow)',     bg: 'var(--tint-warn)',    fg: 'var(--tint-warn-fg)' },
  offline:  { label: 'Offline',  dot: 'var(--red)',        bg: 'var(--tint-danger)',  fg: 'var(--tint-danger-fg)' },
  revoked:  { label: 'Revoked',  dot: 'var(--text-muted)', bg: 'var(--surface-subtle)', fg: 'var(--text-muted)' },
}

// ── helpers ───────────────────────────────────────────────────────────────────
function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '—'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 0) return 'just now'
  if (s < 45) return 'just now'
  if (s < 90) return '1m ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

// Forward-looking sibling of relTime, for future timestamps (e.g. token expiry).
function relTimeFuture(iso: string | null): string {
  if (!iso) return 'soon'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '—'
  const s = Math.round((t - Date.now()) / 1000)
  if (s <= 0) return 'now'
  if (s < 90) return 'in <1 minute'
  const m = Math.round(s / 60)
  if (m < 60) return `in ~${m} minutes`
  const h = Math.round(m / 60)
  if (h < 24) return `in ~${h} hours`
  const d = Math.round(h / 24)
  return `in ~${d} days`
}

// ── module-level subcomponents (never define inside the page component) ────────

function StatusPill({ status }: { status: AgentStatus }) {
  const m = STATUS_META[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 10px', borderRadius: 20,
      background: m.bg, color: m.fg,
      fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.02em', whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: m.dot, flexShrink: 0,
        animation: status === 'online' ? 'pulse 2s ease-in-out infinite' : undefined,
      }} />
      {m.label}
    </span>
  )
}

function ModuleChip({ appKey, enabled }: { appKey: ModuleKey; enabled: boolean }) {
  const meta = moduleMeta(appKey)
  return (
    <span
      title={enabled ? `${meta.label} · enabled` : `${meta.label} · disabled`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 6,
        background: enabled ? meta.bg : 'var(--surface-subtle)',
        color: enabled ? meta.fg : 'var(--text-muted)',
        fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap',
        opacity: enabled ? 1 : 0.7,
        border: enabled ? '1px solid transparent' : '1px dashed var(--border)',
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        background: enabled ? 'currentColor' : 'var(--text-muted)',
      }} />
      {meta.key}
    </span>
  )
}

function ToggleSwitch({ on, busy, onChange }: { on: boolean; busy?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={onChange}
      style={{
        position: 'relative', width: 34, height: 19, flexShrink: 0,
        borderRadius: 20, border: 'none', padding: 0,
        cursor: busy ? 'wait' : 'pointer',
        background: on ? 'var(--primary)' : 'var(--border)',
        transition: 'background 0.15s', opacity: busy ? 0.6 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 17 : 2,
        width: 15, height: 15, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)', transition: 'left 0.15s',
      }} />
    </button>
  )
}

function CopyBox({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  // Fallback for non-secure contexts (plain HTTP on a LAN IP), where
  // navigator.clipboard is undefined/rejects. Returns true on success.
  function legacyCopy(text: string): boolean {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
  async function copy() {
    setFailed(false)
    let ok = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
        ok = true
      }
    } catch { /* fall through to legacy path */ }
    if (!ok) ok = legacyCopy(value)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } else {
      setFailed(true)
    }
  }
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <div style={{
          flex: 1, minWidth: 0,
          background: 'var(--surface-subtle)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          padding: '9px 12px',
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
          fontSize: mono ? 'var(--text-sm)' : 'var(--text-base)',
          color: 'var(--text-primary)',
          overflowX: 'auto', whiteSpace: 'nowrap', wordBreak: 'break-all',
        }}>
          {value}
        </div>
        <button
          className="btn btn-secondary"
          onClick={copy}
          style={{ flexShrink: 0, whiteSpace: 'nowrap', color: failed ? 'var(--tint-danger-fg)' : undefined }}
          title={failed ? 'Copy failed — select the text and copy manually' : undefined}
        >
          {copied ? 'Copied!' : failed ? 'Copy failed — select manually' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

// ── Fleet row (parent, expandable) + its detail panel ──────────────────────────
function AgentRow({ agent, expanded, onToggleExpand, onToggleModule, onRevoke, busy }: {
  agent: Agent
  expanded: boolean
  onToggleExpand: () => void
  onToggleModule: (appKey: ModuleKey) => void
  onRevoke: () => void
  busy: boolean
}) {
  const revoked = agent.status === 'revoked'
  const cellMuted: React.CSSProperties = revoked ? { opacity: 0.6 } : {}
  return (
    <>
      <tr
        className="clickable"
        onClick={onToggleExpand}
        style={{ cursor: 'pointer', background: expanded ? 'var(--bg-primary)' : undefined }}
      >
        {/* Agent */}
        <td style={{ maxWidth: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ color: 'var(--text-muted)', flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', ...cellMuted }}>{agent.name}</div>
              <div className="mono" style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {[agent.hostname, agent.local_ip, agent.os].filter(Boolean).join(' · ') || '—'}
              </div>
            </div>
          </div>
        </td>
        {/* Site */}
        <td style={cellMuted}>{agent.site_name || <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>}</td>
        {/* Status */}
        <td><StatusPill status={agent.status} /></td>
        {/* Modules */}
        <td>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {agent.modules.length === 0
              ? <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>none</span>
              : agent.modules.map(m => {
                  const k = normalizeApp(m.app)
                  return k ? <ModuleChip key={m.app} appKey={k} enabled={m.enabled} /> : null
                })}
          </div>
        </td>
        {/* Version */}
        <td className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', ...cellMuted }}>
          {agent.agent_version || '—'}
        </td>
        {/* Last seen */}
        <td style={{ color: 'var(--text-secondary)', ...cellMuted }}>{relTime(agent.last_seen_at)}</td>
        {/* Buffer depth */}
        <td style={{
          fontVariantNumeric: 'tabular-nums', fontWeight: (agent.buffer_depth ?? 0) > 0 ? 700 : 400,
          color: (agent.buffer_depth ?? 0) > 0 ? 'var(--tint-warn-fg)' : 'var(--text-muted)',
        }}>
          {(agent.buffer_depth ?? 0) > 0
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--yellow)' }} />
                {(agent.buffer_depth ?? 0).toLocaleString()}
              </span>
            : '0'}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--bg-primary)', padding: 0, maxWidth: 'none', whiteSpace: 'normal' }}>
            <div style={{ padding: '16px 20px 20px 34px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              {/* Facts */}
              <div style={{ minWidth: 200 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
                  Host
                </div>
                <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', fontSize: 'var(--text-base)' }}>
                  <dt style={{ color: 'var(--text-muted)' }}>Agent ID</dt>
                  <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{agent.id}</dd>
                  <dt style={{ color: 'var(--text-muted)' }}>Hostname</dt>
                  <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{agent.hostname || '—'}</dd>
                  <dt style={{ color: 'var(--text-muted)' }}>Local IP</dt>
                  <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{agent.local_ip || '—'}</dd>
                  <dt style={{ color: 'var(--text-muted)' }}>OS</dt>
                  <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{agent.os || '—'}</dd>
                  <dt style={{ color: 'var(--text-muted)' }}>Last seen</dt>
                  <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{relTime(agent.last_seen_at)}</dd>
                  <dt style={{ color: 'var(--text-muted)' }}>Buffer depth</dt>
                  <dd style={{ margin: 0, color: (agent.buffer_depth ?? 0) > 0 ? 'var(--tint-warn-fg)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {(agent.buffer_depth ?? 0).toLocaleString()}
                  </dd>
                </dl>
              </div>

              {/* Modules with toggles */}
              <div style={{ minWidth: 220 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
                  Modules
                </div>
                {agent.modules.length === 0
                  ? <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>No modules assigned.</div>
                  : agent.modules.map(m => {
                      const k = normalizeApp(m.app)
                      if (!k) return null
                      const meta = moduleMeta(k)
                      return (
                        <div key={m.app} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                          <ModuleChip appKey={k} enabled={m.enabled} />
                          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', flex: 1 }}>{meta.label}</span>
                          <ToggleSwitch on={m.enabled} busy={busy} onChange={() => onToggleModule(k)} />
                        </div>
                      )
                    })}
              </div>

              {/* Actions */}
              <div style={{ minWidth: 180, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 2 }}>
                  Actions
                </div>
                <button
                  className="btn btn-danger"
                  disabled={busy || revoked}
                  onClick={onRevoke}
                  style={{ justifyContent: 'center' }}
                >
                  {revoked ? 'Revoked' : busy ? <Spinner size={13} /> : 'Revoke agent'}
                </button>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Revoking refuses this agent&apos;s tunnels suite-wide on its next connect.
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────
export default function AgentsPage() {
  const { data: session, status: sessionStatus } = useSession()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const user = session?.user as { role?: string } | undefined
  const isSuperAdmin = user?.role === 'super_admin'

  const [agents, setAgents] = useState<Agent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Add-agent modal + enrollment
  const [showAdd, setShowAdd] = useState(false)
  const [formSite, setFormSite] = useState<string>('')
  const [formModules, setFormModules] = useState<Set<ModuleKey>>(new Set<ModuleKey>(['log', 'ddi', 'span']))
  const [formNote, setFormNote] = useState('')
  const [generating, setGenerating] = useState(false)
  const [token, setToken] = useState<EnrollToken | null>(null)
  const [formError, setFormError] = useState('')

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setAgents(Array.isArray(data?.agents) ? data.agents : [])
      setError(null)
    } catch {
      setError('Could not load the agent fleet. The control-plane API may be unavailable.')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !isSuperAdmin) return
    loadAgents()
    fetch('/api/sites')
      .then(r => (r.ok ? r.json() : []))
      .then(d => setSites(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [sessionStatus, isSuperAdmin, loadAgents])

  function resetForm() {
    setFormSite('')
    setFormModules(new Set<ModuleKey>(['log', 'ddi', 'span']))
    setFormNote('')
    setToken(null)
    setFormError('')
  }
  function openAdd() { resetForm(); setShowAdd(true) }
  function closeAdd() { setShowAdd(false) }
  useEscape(() => { if (showAdd) setShowAdd(false) })

  function toggleFormModule(k: ModuleKey) {
    setFormModules(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }

  async function generateToken() {
    if (formModules.size === 0) { setFormError('Select at least one module.'); return }
    setGenerating(true); setFormError('')
    try {
      const res = await fetch('/api/agents/enroll-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: formSite ? Number(formSite) : undefined,
          modules: MODULES.filter(m => formModules.has(m.key)).map(m => m.key),
          note: formNote.trim() || undefined,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data?.token) throw new Error('malformed')
      setToken(data as EnrollToken)
    } catch {
      setFormError('Failed to generate an enrollment token. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  async function toggleModule(agent: Agent, appKey: ModuleKey) {
    setBusyId(agent.id)
    const newModules = agent.modules.map(m =>
      normalizeApp(m.app) === appKey ? { app: m.app, enabled: !m.enabled } : { app: m.app, enabled: m.enabled }
    )
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modules: newModules }),
      })
      if (!res.ok) throw new Error()
      // Optimistic local update, then reconcile from the source of truth.
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, modules: newModules } : a))
      await loadAgents()
    } catch {
      showToast('Failed to update module', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function revokeAgent(agent: Agent) {
    const ok = await confirm({
      title: 'Revoke agent?',
      message: `Revoking "${agent.name}" refuses its tunnels across the whole suite on its next connect. This cannot be undone from here — the host must be re-enrolled.`,
      confirmLabel: 'Revoke agent',
      danger: true,
    })
    if (!ok) return
    setBusyId(agent.id)
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/revoke`, { method: 'POST' })
      if (!res.ok) throw new Error()
      showToast(`Agent "${agent.name}" revoked`)
      await loadAgents()
    } catch {
      showToast('Failed to revoke agent', 'error')
    } finally {
      setBusyId(null)
    }
  }

  // ── render gating ─────────────────────────────────────────────────────────────
  if (sessionStatus === 'loading') {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
  }
  if (!isSuperAdmin) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          maxWidth: 560, textAlign: 'center', padding: '40px 24px', boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 12 }}>🔒</div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Access restricted</div>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
            Agent fleet management is available to super administrators only.
          </p>
          <button className="btn btn-secondary" onClick={() => router.push('/dashboard')}>Back to Dashboard</button>
        </div>
      </div>
    )
  }

  const enrolled = agents.length
  const online = agents.filter(a => a.status === 'online').length
  const offline = agents.filter(a => a.status === 'offline').length
  const degraded = agents.filter(a => a.status === 'degraded').length
  const revoked = agents.filter(a => a.status === 'revoked').length

  return (
    <div style={{ padding: '24px 28px' }}>
      <PageHeader
        title="Agents"
        subtitle="Enroll, monitor, and manage the NocVault agent fleet across your remote sites."
      >
        <button className="btn btn-primary" onClick={openAdd}>
          <span style={{ fontSize: 'var(--text-md)', lineHeight: 1 }}>＋</span> Add agent
        </button>
      </PageHeader>

      {/* Summary line */}
      {loaded && !error && enrolled > 0 && (
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginBottom: 16, marginTop: -6 }}>
          <strong style={{ color: 'var(--text-secondary)' }}>{enrolled}</strong> enrolled
          {' · '}<span style={{ color: 'var(--tint-success-fg)', fontWeight: 600 }}>{online} online</span>
          {degraded > 0 && <>{' · '}<span style={{ color: 'var(--tint-warn-fg)', fontWeight: 600 }}>{degraded} degraded</span></>}
          {' · '}<span style={{ color: offline > 0 ? 'var(--tint-danger-fg)' : 'var(--text-muted)', fontWeight: 600 }}>{offline} offline</span>
          {revoked > 0 && <>{' · '}<span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{revoked} revoked</span></>}
        </div>
      )}

      {/* Fleet table / states */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {!loaded ? (
          <TableSkeleton rows={5} cols={7} />
        ) : error ? (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Fleet unavailable</div>
            <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '0 0 18px' }}>{error}</p>
            <button className="btn btn-secondary" onClick={() => { setLoaded(false); loadAgents() }}>Retry</button>
          </div>
        ) : enrolled === 0 ? (
          <EmptyState
            icon={
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" />
                <line x1="7" y1="7" x2="7.01" y2="7" /><line x1="7" y1="17" x2="7.01" y2="17" />
              </svg>
            }
            title="No agents enrolled yet"
            message="Enroll your first NocVault agent to start collecting from a remote site. Click Add agent to mint a one-time enrollment token."
            actionLabel="Add agent"
            onAction={openAdd}
          />
        ) : (
          <div className="table-container" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Modules</th>
                  <th>Version</th>
                  <th>Last seen</th>
                  <th>Buffer</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(a => (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    expanded={expandedId === a.id}
                    onToggleExpand={() => setExpandedId(id => id === a.id ? null : a.id)}
                    onToggleModule={(k) => toggleModule(a, k)}
                    onRevoke={() => revokeAgent(a)}
                    busy={busyId === a.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add-agent modal ── */}
      {showAdd && (
        <div className="modal-overlay" onClick={closeAdd}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--bg-card)', borderRadius: 'var(--radius)', width: '100%', maxWidth: 520,
              boxShadow: 'var(--shadow-lg)', maxHeight: '90vh', overflowY: 'auto',
            }}
          >
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Add agent</h2>
                <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  Generate a one-time enrollment token, then run the install command on the remote host.
                </p>
              </div>
              <button className="btn btn-secondary" onClick={closeAdd} style={{ padding: '6px 10px' }} aria-label="Close">✕</button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              {!token ? (
                <>
                  <div className="form-field" style={{ marginBottom: 16 }}>
                    <label>Site</label>
                    <select className="input" value={formSite} onChange={e => setFormSite(e.target.value)}>
                      <option value="">Unassigned</option>
                      {sites.map(s => (
                        <option key={s.id} value={s.id}>{s.site}{s.region ? ` — ${s.region}` : ''}</option>
                      ))}
                    </select>
                    <span className="hint">Scopes the agent&apos;s RBAC and data. Can be changed later.</span>
                  </div>

                  <div className="form-field" style={{ marginBottom: 16 }}>
                    <label>Modules</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
                      {MODULES.map(m => {
                        const on = formModules.has(m.key)
                        return (
                          <label key={m.key} style={{
                            display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                            padding: '9px 12px', borderRadius: 'var(--radius-sm)',
                            border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                            background: on ? 'var(--primary-light)' : 'var(--bg-card)',
                            transition: 'border-color 0.12s, background 0.12s',
                          }}>
                            <input type="checkbox" checked={on} onChange={() => toggleFormModule(m.key)} style={{ accentColor: 'var(--primary)', width: 16, height: 16 }} />
                            <ModuleChip appKey={m.key} enabled />
                            <span style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-primary)' }}>{m.label}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>

                  <div className="form-field" style={{ marginBottom: 16 }}>
                    <label>Note <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label>
                    <input className="input" value={formNote} onChange={e => setFormNote(e.target.value)} placeholder="e.g. Tucson branch collector" />
                  </div>

                  {formError && (
                    <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: 14 }}>
                      {formError}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" onClick={generateToken} disabled={generating} style={{ flex: 1, justifyContent: 'center' }}>
                      {generating ? <><Spinner size={13} color="#fff" /> Generating…</> : 'Generate token'}
                    </button>
                    <button className="btn btn-secondary" onClick={closeAdd} style={{ flex: '0 0 auto' }}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)',
                    padding: '12px 14px', borderRadius: 'var(--radius-sm)', marginBottom: 18,
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <div style={{ fontSize: 'var(--text-base)', lineHeight: 1.45 }}>
                      This token is shown <strong>once</strong>. Copy it now — it can&apos;t be retrieved again.
                      {token.expires_at
                        ? <> It expires <strong>{relTimeFuture(token.expires_at)}</strong> ({new Date(token.expires_at).toLocaleString()}).</>
                        : <> It expires in <strong>~60 minutes</strong>.</>}
                    </div>
                  </div>

                  <CopyBox label="One-time enrollment token" value={token.token} mono />
                  <CopyBox label="Install command (run on the remote host)" value={token.install_command} mono />

                  <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                    <button className="btn btn-secondary" onClick={resetForm} style={{ flex: 1, justifyContent: 'center' }}>Generate another</button>
                    <button className="btn btn-primary" onClick={() => { closeAdd(); loadAgents() }} style={{ flex: 1, justifyContent: 'center' }}>Done</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
