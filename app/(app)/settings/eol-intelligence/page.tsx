'use client'
import { useToast, useConfirm } from '@/app/providers'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

// ── API contract types ──────────────────────────────────────────────
type LatestJob = {
  id: number
  status: 'running' | 'completed' | 'failed'
  started_at: string | null
  completed_at: string | null
  scanned: number
  matched: number
  written: number
  discrepancies: number
  unmatched_top: { model: string; count: number; sampleModels?: string[]; note?: string }[]
} | null

type JobStatus = {
  id: number
  status: 'running' | 'completed' | 'failed'
  scanned: number
  matched: number
  written: number
  discrepancies: number
  started_at: string | null
  completed_at: string | null
  error?: string | null
}

type SeedEntry = {
  id: number
  vendor: string
  model_raw: string
  model_normalized: string
  aliases: string[]
  eol_date: string | null
  eos_date: string | null
  source_url: string | null
  confidence: 'high' | 'medium' | 'low' | string
  added_by: string | null
  created_at: string
  updated_at: string
}

type PreviewSampleDevice = { id: number; name: string; model: string }
type Preview = { normalized: string; count: number; sample: PreviewSampleDevice[] }

type Discrepancy = {
  id: number
  device_id: number
  device_name: string
  model: string
  manual_date: string | null
  seed_date: string | null
  difference_days: number
  seed_entry_id: number
  status: string
  created_at: string
}

type SeedForm = {
  vendor: string
  model_raw: string
  aliases: string
  eol_date: string
  eos_date: string
  source_url: string
  confidence: 'high' | 'medium' | 'low'
}

const EMPTY_FORM: SeedForm = { vendor: '', model_raw: '', aliases: '', eol_date: '', eos_date: '', source_url: '', confidence: 'medium' }
const PAGE_SIZE = 25

// ── helpers ──────────────────────────────────────────────────────────
function fmtDateTime(d?: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtDate(d?: string | null): string {
  if (!d) return '—'
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// safe fetch — never throws; returns null on any failure
async function safeJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  borderRadius: '10px',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow-sm)',
  padding: '20px',
  marginBottom: '20px',
}
const sectionLabel: React.CSSProperties = {
  fontSize: 'var(--text-base)',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '16px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

function ConfidenceBadge({ value }: { value: string }) {
  const v = (value || '').toLowerCase()
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    high: { bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)', label: 'High' },
    medium: { bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)', label: 'Medium' },
    low: { bg: 'var(--tint-danger)', fg: 'var(--tint-danger-fg)', label: 'Low' },
  }
  const s = map[v] || { bg: 'var(--surface-subtle)', fg: 'var(--text-muted)', label: value || '—' }
  return (
    <span style={{ display: 'inline-block', background: s.bg, color: s.fg, padding: '2px 10px', borderRadius: '999px', fontSize: 'var(--text-xs)', fontWeight: 600, textTransform: 'capitalize' }}>
      {s.label}
    </span>
  )
}

function StatTile({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-light)', borderRadius: '8px', padding: '14px 16px', minWidth: '120px', flex: '1 1 120px' }}>
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: accent || 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  )
}

export default function EolIntelligencePage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { data: session, status: sessionStatus } = useSession()
  const router = useRouter()
  const user = session?.user as { role?: string } | undefined
  const isSuperAdmin = user?.role === 'super_admin'

  // ── access gating (mirror settings page: redirect non-admins) ───────
  // We additionally show an inline access-restricted message for any
  // authenticated non-super_admin who reaches the page directly.

  // ── enrichment status ──────────────────────────────────────────────
  const [latest, setLatest] = useState<LatestJob>(null)
  const [latestLoaded, setLatestLoaded] = useState(false)
  const [latestUnavailable, setLatestUnavailable] = useState(false)
  const [running, setRunning] = useState(false)
  const [liveStatus, setLiveStatus] = useState<JobStatus | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadLatest = useCallback(async () => {
    const data = await safeJson<{ ok: boolean; job: LatestJob }>('/api/system/enrich-eol/latest')
    if (data === null || !data.ok) {
      setLatestUnavailable(true)
    } else {
      setLatestUnavailable(false)
      setLatest(data.job ?? null)
    }
    setLatestLoaded(true)
  }, [])

  // ── seed management ─────────────────────────────────────────────────
  const [seedEntries, setSeedEntries] = useState<SeedEntry[]>([])
  const [seedTotal, setSeedTotal] = useState(0)
  const [seedPage, setSeedPage] = useState(1)
  const [seedLoaded, setSeedLoaded] = useState(false)
  const [seedUnavailable, setSeedUnavailable] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<SeedForm>(EMPTY_FORM)
  const [savingSeed, setSavingSeed] = useState(false)
  const [seedFormError, setSeedFormError] = useState('')
  const formRef = useRef<HTMLDivElement | null>(null)

  // live preview
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadSeed = useCallback(async (page: number) => {
    const data = await safeJson<{ entries: SeedEntry[]; total: number; page: number }>(`/api/admin/eol-seed?page=${page}`)
    if (data === null) {
      setSeedUnavailable(true)
    } else {
      setSeedUnavailable(false)
      setSeedEntries(Array.isArray(data.entries) ? data.entries : [])
      setSeedTotal(data.total || 0)
    }
    setSeedLoaded(true)
  }, [])

  // ── discrepancies ───────────────────────────────────────────────────
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[]>([])
  const [discLoaded, setDiscLoaded] = useState(false)
  const [discUnavailable, setDiscUnavailable] = useState(false)

  const loadDiscrepancies = useCallback(async () => {
    const data = await safeJson<{ discrepancies: Discrepancy[] }>('/api/admin/eol-discrepancies')
    if (data === null) {
      setDiscUnavailable(true)
    } else {
      setDiscUnavailable(false)
      setDiscrepancies(Array.isArray(data.discrepancies) ? data.discrepancies : [])
    }
    setDiscLoaded(true)
  }, [])

  // ── initial load ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSuperAdmin) return
    void loadLatest()
    void loadSeed(1)
    void loadDiscrepancies()
  }, [isSuperAdmin, loadLatest, loadSeed, loadDiscrepancies])

  // If a previous run is still in progress when the page loads, resume polling.
  useEffect(() => {
    if (latest && latest.status === 'running' && !running) {
      startPolling(latest.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  function startPolling(jobId: number) {
    setRunning(true)
    setJobError(null)
    if (pollRef.current) clearInterval(pollRef.current)
    const tick = async () => {
      const data = await safeJson<{ ok: boolean; job: JobStatus }>(`/api/system/enrich-eol/status?jobId=${jobId}`)
      if (!data || !data.job) return // transient; keep polling
      const job = data.job
      setLiveStatus(job)
      if (job.status === 'completed') {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = null
        setRunning(false)
        showToast('EOL enrichment complete')
        void loadLatest()
        void loadDiscrepancies()
      } else if (job.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = null
        setRunning(false)
        setJobError(job.error || 'Enrichment failed')
      }
    }
    pollRef.current = setInterval(() => { void tick() }, 2000)
    void tick()
  }

  async function runEnrichment() {
    setJobError(null)
    setLiveStatus(null)
    const res = await safeJson<{ ok: boolean; jobId: number }>('/api/system/enrich-eol', { method: 'POST' })
    if (!res || !res.ok || res.jobId == null) {
      setJobError('Could not start enrichment — service unavailable.')
      return
    }
    startPolling(res.jobId)
  }

  // ── seed form actions ───────────────────────────────────────────────
  function openAdd(prefill?: Partial<SeedForm>) {
    setEditId(null)
    setForm({ ...EMPTY_FORM, ...prefill })
    setSeedFormError('')
    setPreview(null)
    setShowForm(true)
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  function openEdit(e: SeedEntry) {
    setEditId(e.id)
    setForm({
      vendor: e.vendor || '',
      model_raw: e.model_raw || '',
      aliases: (e.aliases || []).join(', '),
      eol_date: (e.eol_date || '').slice(0, 10),
      eos_date: (e.eos_date || '').slice(0, 10),
      source_url: e.source_url || '',
      confidence: (['high', 'medium', 'low'].includes((e.confidence || '').toLowerCase()) ? (e.confidence as 'high' | 'medium' | 'low') : 'medium'),
    })
    setSeedFormError('')
    setPreview(null)
    setShowForm(true)
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  function closeForm() {
    setShowForm(false)
    setEditId(null)
    setForm(EMPTY_FORM)
    setPreview(null)
    setSeedFormError('')
  }

  function buildBody() {
    return {
      vendor: form.vendor.trim(),
      model_raw: form.model_raw.trim(),
      aliases: form.aliases.split(',').map(a => a.trim()).filter(Boolean),
      eol_date: form.eol_date || null,
      eos_date: form.eos_date || null,
      source_url: form.source_url.trim() || null,
      confidence: form.confidence,
    }
  }

  // debounced live preview on vendor/model change
  useEffect(() => {
    if (!showForm) return
    if (previewTimer.current) clearTimeout(previewTimer.current)
    const vendor = form.vendor.trim()
    const model = form.model_raw.trim()
    if (!vendor && !model) { setPreview(null); setPreviewLoading(false); return }
    setPreviewLoading(true)
    previewTimer.current = setTimeout(async () => {
      const data = await safeJson<Preview>(`/api/admin/eol-seed/preview?vendor=${encodeURIComponent(vendor)}&model=${encodeURIComponent(model)}`)
      setPreview(data)
      setPreviewLoading(false)
    }, 400)
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current) }
  }, [form.vendor, form.model_raw, showForm])

  async function saveSeed() {
    if (!form.vendor.trim() || !form.model_raw.trim()) { setSeedFormError('Vendor and model are required'); return }
    setSavingSeed(true); setSeedFormError('')
    try {
      const body = buildBody()
      if (editId != null) {
        const res = await fetch(`/api/admin/eol-seed/${editId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); setSeedFormError(d.error || 'Failed to save'); return }
        showToast('Seed entry updated')
      } else {
        const res = await fetch('/api/admin/eol-seed', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); setSeedFormError(d.error || 'Failed to save'); return }
        const d = await res.json().catch(() => null)
        const n = d?.matchPreview?.count
        showToast(typeof n === 'number' ? `Seed entry added — matches ${n} device${n === 1 ? '' : 's'}` : 'Seed entry added')
      }
      closeForm()
      void loadSeed(seedPage)
    } catch {
      setSeedFormError('Failed to save — service unavailable.')
    } finally {
      setSavingSeed(false)
    }
  }

  async function deleteSeed(e: SeedEntry) {
    const ok = await confirm({ title: 'Delete seed entry', message: `Delete EOL seed entry for "${e.vendor} ${e.model_raw}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      const res = await fetch(`/api/admin/eol-seed/${e.id}`, { method: 'DELETE' })
      if (res.ok) { showToast('Seed entry deleted'); void loadSeed(seedPage) }
      else showToast('Failed to delete entry', 'error')
    } catch {
      showToast('Failed to delete entry', 'error')
    }
  }

  // ── discrepancy actions ─────────────────────────────────────────────
  async function resolveDiscrepancy(id: number, action: 'accept_seed' | 'keep_manual' | 'ignore') {
    try {
      const res = await fetch(`/api/admin/eol-discrepancies/${id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      if (res.ok) {
        setDiscrepancies(prev => prev.filter(d => d.id !== id))
        showToast(action === 'accept_seed' ? 'Seed date accepted' : action === 'keep_manual' ? 'Manual date kept' : 'Discrepancy ignored')
      } else {
        showToast('Failed to resolve discrepancy', 'error')
      }
    } catch {
      showToast('Failed to resolve discrepancy', 'error')
    }
  }

  function addUnmatchedToSeed(model: string) {
    openAdd({ model_raw: model })
  }

  // ── render gating ───────────────────────────────────────────────────
  if (sessionStatus === 'loading') {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
  }
  if (!isSuperAdmin) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div style={{ ...cardStyle, maxWidth: '560px', textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 12 }}>🔒</div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Access restricted</div>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
            EOL Intelligence is available to super administrators only.
          </p>
          <button className="btn-secondary" onClick={() => router.push('/settings')}>Back to Settings</button>
        </div>
      </div>
    )
  }

  // effective stats: live job overrides latest while running
  const stats = liveStatus && running
    ? { scanned: liveStatus.scanned, matched: liveStatus.matched, written: liveStatus.written, discrepancies: liveStatus.discrepancies }
    : { scanned: latest?.scanned ?? 0, matched: latest?.matched ?? 0, written: latest?.written ?? 0, discrepancies: latest?.discrepancies ?? 0 }

  const totalPages = Math.max(1, Math.ceil(seedTotal / PAGE_SIZE))
  const unmatched = latest?.unmatched_top || []

  return (
    <div style={{ padding: '24px 28px' }}>
      {/* header */}
      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <div className="breadcrumb" style={{ marginBottom: 6 }}>
            <button onClick={() => router.push('/settings')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Settings</button>
            <span>/</span>
            <span style={{ color: 'var(--text-secondary)' }}>EOL Intelligence</span>
          </div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>EOL Intelligence</h1>
          <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>Enrich device lifecycle data from the curated EOL seed dataset</p>
        </div>
      </div>

      {/* ── 1. ENRICHMENT STATUS ───────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <div style={{ ...sectionLabel, marginBottom: 0 }}>Enrichment status</div>
          <button className="btn-primary" onClick={() => void runEnrichment()} disabled={running} style={{ padding: '8px 16px' }}>
            {running ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Running…</> : 'Run enrichment now'}
          </button>
        </div>

        {!latestLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : latestUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: '6px', fontSize: 'var(--text-base)' }}>
            Enrichment status is currently unavailable.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '14px' }}>
              {running
                ? <span style={{ color: 'var(--tint-warn-fg)', fontWeight: 600 }}>● Enrichment in progress…</span>
                : latest
                  ? <>Last run: <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{fmtDateTime(latest.completed_at || latest.started_at)}</span>
                      {latest.status === 'failed' && <span style={{ color: 'var(--tint-danger-fg)', marginLeft: 8 }}>(failed)</span>}</>
                  : 'Enrichment has never been run.'}
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <StatTile label="Scanned" value={stats.scanned.toLocaleString()} />
              <StatTile label="Matched" value={stats.matched.toLocaleString()} accent="var(--tint-success-fg)" />
              <StatTile label="Written" value={stats.written.toLocaleString()} accent="var(--primary)" />
              <StatTile label="Discrepancies" value={stats.discrepancies.toLocaleString()} accent={stats.discrepancies > 0 ? 'var(--tint-warn-fg)' : undefined} />
            </div>

            {jobError && (
              <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 14px', borderRadius: '6px', fontSize: 'var(--text-base)', marginTop: '14px' }}>
                {jobError}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 2. SEED MANAGEMENT ─────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <div style={{ ...sectionLabel, marginBottom: 0 }}>Seed management {seedTotal > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({seedTotal})</span>}</div>
          <button className="btn-primary" onClick={() => openAdd()} style={{ padding: '8px 16px' }}>+ Add entry</button>
        </div>

        {/* add / edit form */}
        {showForm && (
          <div ref={formRef} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '18px', marginBottom: '18px', background: 'var(--surface-subtle)' }}>
            <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 600, margin: '0 0 16px', color: 'var(--text-primary)' }}>{editId != null ? 'Edit seed entry' : 'Add seed entry'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Vendor <span style={{ color: 'var(--primary)' }}>*</span></label>
                <input className="input" placeholder="e.g. Cisco" value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Model (raw) <span style={{ color: 'var(--primary)' }}>*</span></label>
                <input className="input" placeholder="e.g. Catalyst 2960-X" value={form.model_raw} onChange={e => setForm(f => ({ ...f, model_raw: e.target.value }))} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Aliases <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(comma-separated)</span></label>
                <input className="input" placeholder="e.g. WS-C2960X, 2960X" value={form.aliases} onChange={e => setForm(f => ({ ...f, aliases: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>EOL date</label>
                <input className="input" type="date" value={form.eol_date} onChange={e => setForm(f => ({ ...f, eol_date: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>EOS date</label>
                <input className="input" type="date" value={form.eos_date} onChange={e => setForm(f => ({ ...f, eos_date: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Confidence</label>
                <select className="input select" value={form.confidence} onChange={e => setForm(f => ({ ...f, confidence: e.target.value as SeedForm['confidence'] }))}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Source URL</label>
                <input className="input" placeholder="https://…" value={form.source_url} onChange={e => setForm(f => ({ ...f, source_url: e.target.value }))} />
              </div>
            </div>

            {/* live coverage preview */}
            <div style={{ border: '1px dashed var(--border)', borderRadius: '8px', padding: '12px 14px', marginBottom: '14px', background: 'var(--bg-card)' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px' }}>Coverage preview</div>
              {(!form.vendor.trim() && !form.model_raw.trim()) ? (
                <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>Type a vendor and model to preview which devices this entry would match.</div>
              ) : previewLoading ? (
                <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>Checking coverage…</div>
              ) : preview ? (
                <div>
                  <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-primary)', fontWeight: 600 }}>
                    Matches {preview.count.toLocaleString()} device{preview.count === 1 ? '' : 's'}
                    {preview.normalized && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>→ {preview.normalized}</span>}
                  </div>
                  {preview.sample && preview.sample.length > 0 && (
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: '6px' }}>
                      {preview.sample.slice(0, 5).map(s => s.name).join(', ')}{preview.count > preview.sample.length ? '…' : ''}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>Coverage preview unavailable.</div>
              )}
            </div>

            {seedFormError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: '6px', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{seedFormError}</div>}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-primary" onClick={() => void saveSeed()} disabled={savingSeed}>{savingSeed ? 'Saving…' : editId != null ? 'Save changes' : 'Add entry'}</button>
              <button className="btn-secondary" onClick={closeForm}>Cancel</button>
            </div>
          </div>
        )}

        {/* seed table */}
        {!seedLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : seedUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: '6px', fontSize: 'var(--text-base)' }}>
            Seed dataset is currently unavailable.
          </div>
        ) : seedEntries.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No seed entries yet. Add one to start enriching device lifecycle data.</div>
        ) : (
          <>
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>Vendor</th><th>Model</th><th>Normalized</th><th>Aliases</th><th>EOL</th><th>EOS</th><th>Confidence</th><th>Source</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {seedEntries.map(e => (
                    <tr key={e.id}>
                      <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{e.vendor}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{e.model_raw}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{e.model_normalized || '—'}</td>
                      <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', maxWidth: '160px' }}>{(e.aliases && e.aliases.length) ? e.aliases.join(', ') : '—'}</td>
                      <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDate(e.eol_date)}</td>
                      <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDate(e.eos_date)}</td>
                      <td><ConfidenceBadge value={e.confidence} /></td>
                      <td>
                        {e.source_url
                          ? <a href={e.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 'var(--text-sm)' }}>Source ↗</a>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => openEdit(e)}>Edit</button>
                          <button className="btn-danger" style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }} onClick={() => void deleteSeed(e)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Page {seedPage} of {totalPages}</span>
                <button className="btn-secondary" style={{ padding: '6px 12px' }} disabled={seedPage <= 1} onClick={() => { const p = seedPage - 1; setSeedPage(p); void loadSeed(p) }}>Prev</button>
                <button className="btn-secondary" style={{ padding: '6px 12px' }} disabled={seedPage >= totalPages} onClick={() => { const p = seedPage + 1; setSeedPage(p); void loadSeed(p) }}>Next</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 3. COVERAGE WORKLIST ───────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ ...sectionLabel }}>Coverage worklist {unmatched.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({unmatched.length})</span>}</div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '-8px 0 14px' }}>Top device models with no EOL coverage. Add them to the seed dataset to expand enrichment.</p>
        {!latestLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : latestUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: '6px', fontSize: 'var(--text-base)' }}>Worklist is currently unavailable.</div>
        ) : unmatched.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No unmatched models — coverage is complete, or enrichment has not run yet.</div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th>Model</th><th>Devices</th><th>Note</th><th>Actions</th></tr></thead>
              <tbody>
                {unmatched.map((u, i) => (
                  <tr key={`${u.model}-${i}`}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {u.model}
                      {u.sampleModels && u.sampleModels.length > 0 && (
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>{u.sampleModels.slice(0, 3).join(', ')}</div>
                      )}
                    </td>
                    <td><span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{u.count.toLocaleString()}</span></td>
                    <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{u.note || '—'}</td>
                    <td>
                      <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-card)', color: 'var(--primary)', cursor: 'pointer', fontWeight: 500 }} onClick={() => addUnmatchedToSeed(u.model)}>+ Add to seed</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 4. DISCREPANCY REVIEW ──────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ ...sectionLabel }}>Discrepancy review {discrepancies.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({discrepancies.length})</span>}</div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '-8px 0 14px' }}>Devices where the manually entered EOL date differs from the seed dataset. Resolve each by choosing the authoritative date.</p>
        {!discLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : discUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: '6px', fontSize: 'var(--text-base)' }}>Discrepancy review is currently unavailable.</div>
        ) : discrepancies.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No pending discrepancies. 🎉</div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th>Device</th><th>Model</th><th>Manual date</th><th>Seed date</th><th>Difference</th><th>Actions</th></tr></thead>
              <tbody>
                {discrepancies.map(d => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{d.device_name}</td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{d.model || '—'}</td>
                    <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDate(d.manual_date)}</td>
                    <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDate(d.seed_date)}</td>
                    <td>
                      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--tint-warn-fg)', background: 'var(--tint-warn)', padding: '2px 8px', borderRadius: '999px' }}>
                        {Math.abs(d.difference_days)} day{Math.abs(d.difference_days) === 1 ? '' : 's'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--tint-success)', color: 'var(--tint-success-fg)', cursor: 'pointer', fontWeight: 500 }} onClick={() => void resolveDiscrepancy(d.id, 'accept_seed')}>Accept seed date</button>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => void resolveDiscrepancy(d.id, 'keep_manual')}>Keep manual</button>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => void resolveDiscrepancy(d.id, 'ignore')}>Ignore</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
