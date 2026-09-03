'use client'
import { useToast, useConfirm } from '@/app/providers'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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

// SEED MANAGEMENT — vendor accordion grouping (GET /api/admin/eol-seed?groupBy=vendor)
type SeedGroup = {
  vendor: string
  count: number
  dated: number
  dateless: number
  earliest_eol: string | null
  latest_eos: string | null
}
// A loaded page of seed rows (vendor accordion expansion OR flat search result)
type SeedPage = {
  entries: SeedEntry[]
  total: number
  page: number
  loading: boolean
  unavailable?: boolean
}
// EOL COVERAGE panel (GET /api/admin/eol-coverage)
type Coverage = {
  inventory: { total: number; dated: number; dateless: number }
  datelessByBrand: { brand: string; count: number }[]
  seedByVendor: { vendor: string; count: number; dateless: number }[]
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

type Rec = {
  id: number
  device_id: string
  device_name: string | null
  model: string | null
  current_status: string | null
  recommended_status: string
  reason: string
  effective_date: string | null
  days: number | null
  confidence: string
  source_url: string | null
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
const PAGE_SIZE = 50

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
  borderRadius: 'var(--radius)',
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

// Two-segment coverage ring, drawn directly.
//
// This replaced a recharts <PieChart>. recharts was imported into this route for
// exactly this one 120x120 graphic and nothing else, and cost ~386 KB of
// JavaScript across two chunks — roughly eight times the page's own 49 KB. That
// download was the main reason the page felt slow to open; the API calls behind
// it all return in 10-25 ms.
//
// Geometry matches the chart it replaces: r=48 with a 16px stroke reproduces the
// old innerRadius 40 / outerRadius 56, and rotate(-90) reproduces startAngle 90
// (i.e. begins at twelve o'clock and fills clockwise).
function CoverageDonut({ dated, total }: { dated: number; total: number }) {
  const R = 48
  const CIRC = 2 * Math.PI * R
  const frac = total > 0 ? Math.min(1, Math.max(0, dated / total)) : 0
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--border-light)" strokeWidth={16} />
      {frac > 0 && (
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--primary)" strokeWidth={16}
          strokeDasharray={`${CIRC * frac} ${CIRC}`} transform="rotate(-90 60 60)" />
      )}
    </svg>
  )
}

// Quick lookup: "what is the EOL date for this model?" — the question this page
// gets opened for. The seed catalog already had a search box, but it sat at the
// bottom inside the catalog accordion, so it was effectively undiscoverable.
// This is deliberately self-contained (its own state, its own fetch) so it does
// not fight the accordion's search, which drives a different view.
function QuickEolLookup() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<{ entries: SeedEntry[]; total: number; loading: boolean } | null>(null)

  useEffect(() => {
    const term = q.trim()
    // 2 chars minimum: a single character matches most of a 7,900-row catalog
    // and the result is noise, not an answer.
    if (term.length < 2) { setRes(null); return }
    let cancelled = false
    setRes(prev => ({ entries: prev?.entries ?? [], total: prev?.total ?? 0, loading: true }))
    const t = setTimeout(async () => {
      const d = await safeJson<{ entries: SeedEntry[]; total: number }>(
        `/api/admin/eol-seed?search=${encodeURIComponent(term)}&mode=model&page=1&pageSize=8`
      )
      if (cancelled) return
      setRes({ entries: d?.entries ?? [], total: d?.total ?? 0, loading: false })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  const th: React.CSSProperties = { textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '6px 10px', borderBottom: '1px solid var(--border)' }
  const td: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', padding: '7px 10px', borderBottom: '1px solid var(--border-light)' }

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Quick EOL lookup</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '-8px', marginBottom: '12px' }}>
        Find the end-of-life and end-of-support dates for a specific model. Matches on vendor and model name; every word must match, so &ldquo;Cisco 2900&rdquo; narrows to Cisco.
      </div>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Model or vendor — e.g. C9300-48P, FortiGate 100F, Aruba 2930F"
        style={{ width: '100%', padding: '10px 14px', fontSize: 'var(--text-md)', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
      />
      {res && (
        <div style={{ marginTop: '12px' }}>
          {res.loading && res.entries.length === 0 ? (
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', padding: '8px 0' }}>Searching…</div>
          ) : res.entries.length === 0 ? (
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', padding: '8px 0' }}>
              No catalog entry matches &ldquo;{q.trim()}&rdquo;. It may not be in the seed catalog yet — try the vendor name alone, or add an entry below.
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Vendor</th><th style={th}>Model</th><th style={th}>EOL</th><th style={th}>End of support</th><th style={th}>Confidence</th></tr></thead>
                  <tbody>
                    {res.entries.map(e => (
                      <tr key={e.id}>
                        <td style={td}>{e.vendor}</td>
                        <td style={{ ...td, color: 'var(--text-primary)', fontWeight: 600 }}>{e.model_raw}</td>
                        <td style={td}>{fmtDate(e.eol_date)}</td>
                        <td style={td}>{fmtDate(e.eos_date)}</td>
                        <td style={td}><ConfidenceBadge value={e.confidence} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '8px' }}>
                {res.total > res.entries.length
                  ? `Showing ${res.entries.length} of ${res.total.toLocaleString()} matches — refine the search or use the seed catalog below.`
                  : `${res.total.toLocaleString()} match${res.total === 1 ? '' : 'es'}.`}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
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
    <span style={{ display: 'inline-block', background: s.bg, color: s.fg, padding: '2px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-xs)', fontWeight: 600, textTransform: 'capitalize' }}>
      {s.label}
    </span>
  )
}

function StatTile({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', padding: '14px 16px', minWidth: '120px', flex: '1 1 120px' }}>
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

  // ── EOL add-on entitlement (licensed 'eol' module) ──────────────────
  // null = checking; false = not licensed → locked upsell; true = enabled.
  const [entitled, setEntitled] = useState<boolean | null>(null)
  const [licServerId, setLicServerId] = useState<string>('')
  useEffect(() => {
    if (!isSuperAdmin) { setEntitled(false); return }
    fetch('/api/license')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setLicServerId(d?.serverId ?? '')
        setEntitled(d?.status === 'active' && Array.isArray(d?.modules) && d.modules.includes('eol'))
      })
      .catch(() => setEntitled(false))
  }, [isSuperAdmin])

  // ── access gating (mirror settings page: redirect non-admins) ───────
  // We additionally show an inline access-restricted message for any
  // authenticated non-super_admin who reaches the page directly.

  // ── enrichment status ──────────────────────────────────────────────
  const [latest, setLatest] = useState<LatestJob>(null)
  const [latestLoaded, setLatestLoaded] = useState(false)
  const [latestUnavailable, setLatestUnavailable] = useState(false)
  const [running, setRunning] = useState(false)
  const [syncing, setSyncing] = useState(false)
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

  // ── seed management (vendor accordion + search) ─────────────────────
  const [seedGroups, setSeedGroups] = useState<SeedGroup[]>([])
  const [seedTotal, setSeedTotal] = useState(0)
  const [seedLoaded, setSeedLoaded] = useState(false)
  const [seedUnavailable, setSeedUnavailable] = useState(false)
  const [expandedVendor, setExpandedVendor] = useState<string | null>(null)
  const [vendorPages, setVendorPages] = useState<Record<string, SeedPage>>({})
  // search (debounced) → flat result table instead of the accordion
  const [seedSearch, setSeedSearch] = useState('')
  const [searchResult, setSearchResult] = useState<SeedPage | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<SeedForm>(EMPTY_FORM)
  const [savingSeed, setSavingSeed] = useState(false)
  const [seedFormError, setSeedFormError] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const formRef = useRef<HTMLDivElement | null>(null)

  // live preview
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Default view: collapsed vendor accordion from the grouped endpoint.
  const loadGroups = useCallback(async () => {
    const data = await safeJson<{ groups: SeedGroup[]; total: number }>('/api/admin/eol-seed?groupBy=vendor')
    if (data === null) {
      setSeedUnavailable(true)
    } else {
      setSeedUnavailable(false)
      setSeedGroups(Array.isArray(data.groups) ? data.groups : [])
      setSeedTotal(data.total || 0)
    }
    setSeedLoaded(true)
  }, [])

  // Lazy per-vendor page (cached in vendorPages; supports Prev/Next within a group).
  const loadVendorPage = useCallback(async (vendor: string, page: number) => {
    setVendorPages(prev => ({
      ...prev,
      [vendor]: { entries: prev[vendor]?.entries ?? [], total: prev[vendor]?.total ?? 0, page, loading: true },
    }))
    const data = await safeJson<{ entries: SeedEntry[]; total: number; page: number; pageSize: number }>(
      `/api/admin/eol-seed?vendor=${encodeURIComponent(vendor)}&page=${page}&pageSize=${PAGE_SIZE}`
    )
    setVendorPages(prev => ({
      ...prev,
      [vendor]: {
        entries: data && Array.isArray(data.entries) ? data.entries : [],
        total: data?.total ?? 0,
        page,
        loading: false,
        unavailable: data === null,
      },
    }))
  }, [])

  // Flat search result (debounced query).
  const loadSearch = useCallback(async (q: string, page: number) => {
    setSearchResult(prev => ({ entries: prev?.entries ?? [], total: prev?.total ?? 0, page, loading: true }))
    const data = await safeJson<{ entries: SeedEntry[]; total: number; page: number; pageSize: number }>(
      `/api/admin/eol-seed?search=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}`
    )
    setSearchResult({
      entries: data && Array.isArray(data.entries) ? data.entries : [],
      total: data?.total ?? 0,
      page,
      loading: false,
      unavailable: data === null,
    })
  }, [])

  function toggleVendor(vendor: string) {
    if (expandedVendor === vendor) { setExpandedVendor(null); return }
    setExpandedVendor(vendor)
    if (!vendorPages[vendor]) void loadVendorPage(vendor, 1)
  }

  // Refresh whichever seed views are currently visible after add/edit/delete/sync.
  const refreshSeedViews = useCallback(() => {
    void loadGroups()
    void loadCoverage()
    if (expandedVendor) void loadVendorPage(expandedVendor, vendorPages[expandedVendor]?.page ?? 1)
    const q = seedSearch.trim()
    if (q) void loadSearch(q, searchResult?.page ?? 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedVendor, vendorPages, seedSearch, searchResult, loadGroups, loadVendorPage, loadSearch])

  // ── EOL coverage panel ──────────────────────────────────────────────
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [coverageLoaded, setCoverageLoaded] = useState(false)
  const [coverageUnavailable, setCoverageUnavailable] = useState(false)
  const [showAllDateless, setShowAllDateless] = useState(false)

  const loadCoverage = useCallback(async () => {
    const data = await safeJson<Coverage>('/api/admin/eol-coverage')
    if (data === null) {
      setCoverageUnavailable(true)
    } else {
      setCoverageUnavailable(false)
      setCoverage(data)
    }
    setCoverageLoaded(true)
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

  // ── status recommendations ──────────────────────────────────────────
  const [shouldBeEol, setShouldBeEol] = useState<Rec[]>([])
  const [possiblyIncorrect, setPossiblyIncorrect] = useState<Rec[]>([])
  const [totalPending, setTotalPending] = useState(0)
  const [recsLoaded, setRecsLoaded] = useState(false)
  const [recsUnavailable, setRecsUnavailable] = useState(false)
  const recsRef = useRef<HTMLDivElement | null>(null)

  const loadRecommendations = useCallback(async () => {
    const data = await safeJson<{ ok: boolean; should_be_eol: Rec[]; possibly_incorrect: Rec[]; total_pending: number }>('/api/admin/eol-recommendations')
    if (data === null || !data.ok) {
      setRecsUnavailable(true)
    } else {
      setRecsUnavailable(false)
      setShouldBeEol(Array.isArray(data.should_be_eol) ? data.should_be_eol : [])
      setPossiblyIncorrect(Array.isArray(data.possibly_incorrect) ? data.possibly_incorrect : [])
      setTotalPending(typeof data.total_pending === 'number' ? data.total_pending : 0)
    }
    setRecsLoaded(true)
  }, [])

  // ── initial load ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSuperAdmin) return
    void loadLatest()
    void loadGroups()
    void loadCoverage()
    void loadDiscrepancies()
    void loadRecommendations()
    void safeJson<{ brands?: string[] }>('/api/lookup').then(d => setBrands(Array.isArray(d?.brands) ? d.brands : []))
  }, [isSuperAdmin, loadLatest, loadGroups, loadCoverage, loadDiscrepancies, loadRecommendations])

  // Debounced seed search → flat result table; clearing returns to the accordion.
  useEffect(() => {
    const q = seedSearch.trim()
    if (!q) { setSearchResult(null); return }
    const t = setTimeout(() => { void loadSearch(q, 1) }, 300)
    return () => clearTimeout(t)
  }, [seedSearch, loadSearch])

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

  // Pull the central signed EOL feed into the local seed catalog (verifies the
  // Ed25519 signature server-side; writes only eol_seed, never devices).
  async function syncFeed() {
    setSyncing(true)
    try {
      const res = await fetch('/api/admin/eol-seed/sync', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) { showToast(data.error || 'Feed sync failed', 'error'); return }
      // Sync updates the seed catalog only — device EOL dates don't change until
      // enrichment runs. Hint the user to run it (we intentionally don't auto-run,
      // matching the decoupled scheduled tasks).
      showToast(`Synced feed ${data.feed_version}: ${data.inserted} new, ${data.updated} updated (${data.row_count} models, signature verified). Run enrichment to apply it to devices.`)
      refreshSeedViews()
      void loadLatest()
    } catch {
      showToast('Feed sync failed — service unavailable.', 'error')
    } finally {
      setSyncing(false)
    }
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
      refreshSeedViews()
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
      if (res.ok) { showToast('Seed entry deleted'); refreshSeedViews() }
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

  async function purgeDateless() {
    const ok = await confirm({
      title: 'Remove dateless placeholder entries',
      message: `Remove the ${datelessSeedCount.toLocaleString()} seed entr${datelessSeedCount === 1 ? 'y' : 'ies'} that have no EOL and no EOS date? These carry no data, so they can't enrich any device — but they DO create false "matches" (a device matches the placeholder and counts as matched while no date is written), which hides the real coverage gap. Feed-sourced entries are never touched. Re-run enrichment afterwards so the numbers reflect reality.`,
      confirmLabel: 'Remove entries',
      danger: true,
    })
    if (!ok) return
    const res = await safeJson<{ ok: boolean; deleted: number }>('/api/admin/eol-seed/purge-dateless', { method: 'POST' })
    if (!res || !res.ok) { showToast('Purge failed — service unavailable.', 'error'); return }
    showToast(`Removed ${res.deleted.toLocaleString()} dateless placeholder entr${res.deleted === 1 ? 'y' : 'ies'}. Re-run enrichment to refresh matching.`)
    refreshSeedViews()
  }

  // ── status recommendation actions ───────────────────────────────────
  async function resolveRecommendation(rec: Rec, action: 'accept' | 'ignore', type: 'should_be_eol' | 'possibly_incorrect') {
    try {
      const res = await fetch(`/api/admin/eol-recommendations/${rec.id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      if (res.ok) {
        if (type === 'should_be_eol') setShouldBeEol(prev => prev.filter(r => r.id !== rec.id))
        else setPossiblyIncorrect(prev => prev.filter(r => r.id !== rec.id))
        setTotalPending(prev => Math.max(0, prev - 1))
        showToast(action === 'ignore'
          ? 'Recommendation ignored'
          : type === 'should_be_eol' ? 'Device marked as EOL' : 'Device reverted to Active')
      } else {
        showToast('Failed to update recommendation', 'error')
      }
    } catch {
      showToast('Failed to update recommendation', 'error')
    }
  }

  async function bulkRecommendation(action: 'accept_all' | 'ignore_all', type: 'should_be_eol' | 'possibly_incorrect') {
    const isEol = type === 'should_be_eol'
    const ok = await confirm({
      title: action === 'accept_all' ? (isEol ? 'Mark all as EOL' : 'Revert all to Active') : 'Ignore all',
      message: action === 'accept_all'
        ? (isEol
          ? 'Mark all listed devices as EOL? This updates their status to match vendor data.'
          : 'Revert all listed devices to Active? This updates their status to match vendor data.')
        : 'Ignore all listed recommendations?',
      confirmLabel: action === 'accept_all' ? (isEol ? 'Mark all as EOL' : 'Revert all') : 'Ignore all',
      danger: isEol && action === 'accept_all',
    })
    if (!ok) return
    try {
      const res = await fetch('/api/admin/eol-recommendations/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, type }),
      })
      if (res.ok) {
        const d = await res.json().catch(() => null)
        const n = d?.count
        showToast(typeof n === 'number' ? `Updated ${n} device${n === 1 ? '' : 's'}` : 'Recommendations updated')
        void loadRecommendations()
      } else {
        showToast('Failed to apply bulk action', 'error')
      }
    } catch {
      showToast('Failed to apply bulk action', 'error')
    }
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

  // EOL Intelligence is a paid add-on, gated on the 'eol' license module.
  if (entitled === null) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
  }
  if (!entitled) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div style={{ ...cardStyle, maxWidth: '560px', textAlign: 'center', padding: '40px 24px' }}>
          <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 12 }}>🔒</div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>EOL Intelligence is a licensed add-on</div>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
            This feature isn&apos;t enabled on this install. Contact your NocVault representative to license the
            EOL Intelligence module, then activate the new key under Settings &rarr; License.
          </p>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '0 0 20px' }}>
            Server ID: <code style={{ fontFamily: 'var(--font-mono)' }}>{licServerId || '—'}</code>
          </p>
          <button className="btn-secondary" onClick={() => router.push('/settings/license')}>Go to License</button>
        </div>
      </div>
    )
  }

  // effective stats: live job overrides latest while running
  const stats = liveStatus && running
    ? { scanned: liveStatus.scanned, matched: liveStatus.matched, written: liveStatus.written, discrepancies: liveStatus.discrepancies }
    : { scanned: latest?.scanned ?? 0, matched: latest?.matched ?? 0, written: latest?.written ?? 0, discrepancies: latest?.discrepancies ?? 0 }

  const unmatched = latest?.unmatched_top || []
  const datelessSeedCount = seedGroups.reduce((sum, g) => sum + (g.dateless || 0), 0)

  // Shared seed-row table — used by both an expanded vendor group and the flat
  // search result. Columns + Edit/Delete match the original markup.
  const renderSeedTable = (entries: SeedEntry[]) => (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Vendor</th><th>Model</th><th>Normalized</th><th>Aliases</th><th>EOL</th><th>EOS</th><th>Confidence</th><th>Source</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
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
                  <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => openEdit(e)}>Edit</button>
                  <button className="btn-danger" style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }} onClick={() => void deleteSeed(e)}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  // Prev/Next pager shared by vendor groups + search (pageSize = PAGE_SIZE = 50).
  const renderPager = (page: number, total: number, onPage: (p: number) => void) => {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (pages <= 1) return null
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Page {page} of {pages}</span>
        <button className="btn-secondary" style={{ padding: '6px 12px' }} disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
        <button className="btn-secondary" style={{ padding: '6px 12px' }} disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      {/* header */}
      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          {/* Breadcrumb trail dropped with the move out of Settings — this is a
              top-level page now, so "Settings / EOL Intelligence" would point at
              a parent it no longer has. The sibling link to the risk report is
              kept: the two pages are the curation engine and its output, and
              moving between them is the common path. */}
          <div className="breadcrumb" style={{ marginBottom: 6 }}>
            <span style={{ color: 'var(--text-secondary)' }}>Lifecycle data</span>
            <span className="crumb-sep">/</span>
            <button onClick={() => router.push('/eol')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>View EOL / Risk report →</button>
          </div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>EOL Intelligence</h1>
          <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>Enrich device lifecycle data from the curated EOL seed dataset</p>
        </div>
      </div>

      {/* ── 1. ENRICHMENT STATUS ───────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <div style={{ ...sectionLabel, marginBottom: 0 }}>Enrichment status</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => void syncFeed()}
              disabled={syncing || running}
              title="Pull the latest signed central EOL feed into the local seed catalog (signature-verified; updates the catalog only, not devices)"
              style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: syncing ? 'wait' : 'pointer', fontWeight: 600, fontSize: 'var(--text-base)' }}
            >
              {syncing ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Syncing…</> : 'Sync from EOL feed'}
            </button>
            <button className="btn-primary" onClick={() => void runEnrichment()} disabled={running} style={{ padding: '8px 16px' }}>
              {running ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Running…</> : 'Run enrichment now'}
            </button>
          </div>
        </div>

        {!latestLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : latestUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>
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
              <button
                type="button"
                onClick={() => recsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                disabled={totalPending === 0}
                title={totalPending > 0 ? 'View status recommendations' : undefined}
                style={{
                  textAlign: 'left',
                  font: 'inherit',
                  background: 'var(--surface-subtle)',
                  border: '1px solid var(--border-light)',
                  borderRadius: 'var(--radius)',
                  padding: '14px 16px',
                  minWidth: '120px',
                  flex: '1 1 120px',
                  cursor: totalPending > 0 ? 'pointer' : 'default',
                }}
              >
                <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: totalPending > 0 ? 'var(--tint-warn-fg)' : 'var(--text-muted)', lineHeight: 1.1 }}>{totalPending.toLocaleString()}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Recommendations</div>
              </button>
            </div>

            {jobError && (
              <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginTop: '14px' }}>
                {jobError}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 1.2 QUICK EOL LOOKUP ───────────────────────────────────── */}
      {/* Placed high on purpose: "what is the EOL date for this model" is the
          question this page is opened for, and the seed catalog search that
          answered it sat ~400 lines further down, inside an accordion. */}
      <QuickEolLookup />

      {/* ── 1.5 EOL COVERAGE ───────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ ...sectionLabel, marginBottom: '4px' }}>EOL coverage</div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '0 0 16px' }}>How much of the live inventory carries an EOL date, where the gaps are, and how the seed catalog lines up against them.</p>
        {!coverageLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : (coverageUnavailable || !coverage) ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>EOL coverage is currently unavailable.</div>
        ) : (() => {
          const inv = coverage.inventory
          const pct = inv.total > 0 ? Math.round((inv.dated / inv.total) * 100) : 0
          const maxDateless = Math.max(1, ...coverage.datelessByBrand.map(d => d.count))
          const maxSeed = Math.max(1, ...coverage.seedByVendor.map(s => s.count))
          const seedMap = new Map<string, number>()
          coverage.seedByVendor.forEach(s => seedMap.set((s.vendor || '').toLowerCase().trim(), s.count))
          const datelessRows = showAllDateless ? coverage.datelessByBrand : coverage.datelessByBrand.slice(0, 10)
          const subCard: React.CSSProperties = { background: 'var(--surface-subtle)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', padding: '16px', flex: '1 1 280px', minWidth: '260px' }
          const subTitle: React.CSSProperties = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '12px' }
          const isNoBrand = (b: string) => !b || b === '(no brand)'
          return (
            <>
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                {/* a. Inventory coverage — donut */}
                <div style={subCard}>
                  <div style={subTitle}>Inventory coverage</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ position: 'relative', width: '120px', height: '120px', flex: '0 0 auto' }}>
                      <CoverageDonut dated={inv.dated} total={inv.total} />
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                        <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>{pct}%</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>covered</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      <div><span style={{ display: 'inline-block', width: '9px', height: '9px', /* intentional: 2px on a 9x9 legend swatch is small RELATIVE TO THE ELEMENT — --radius-sm (6px) would round it into a circle */ borderRadius: '2px', background: 'var(--primary)', marginRight: '6px' }} />{inv.dated.toLocaleString()} dated</div>
                      <div><span style={{ display: 'inline-block', width: '9px', height: '9px', /* intentional: 2px on a 9x9 legend swatch is small RELATIVE TO THE ELEMENT — --radius-sm (6px) would round it into a circle */ borderRadius: '2px', background: 'var(--border-light)', marginRight: '6px' }} />{inv.dateless.toLocaleString()} dateless</div>
                      <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>{inv.total.toLocaleString()} devices total</div>
                    </div>
                  </div>
                </div>

                {/* b. Dateless inventory by brand — ranked links + gap badges */}
                <div style={subCard}>
                  <div style={subTitle}>Dateless inventory by brand</div>
                  {coverage.datelessByBrand.length === 0 ? (
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No dateless devices. 🎉</div>
                  ) : (
                    <>
                      {datelessRows.map(d => {
                        const seedCount = seedMap.get((d.brand || '').toLowerCase().trim()) || 0
                        const gap = seedCount === 0
                          ? { label: 'coverage gap', bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }
                          : seedCount < d.count
                            ? { label: 'coverage gap', bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }
                            : { label: 'matching gap', bg: 'var(--tint-info)', fg: 'var(--tint-info-fg)' }
                        const noBrand = isNoBrand(d.brand)
                        const rowInner = (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                              <span style={{ flex: '1 1 auto', fontSize: 'var(--text-sm)', fontWeight: 500, color: noBrand ? 'var(--text-muted)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.brand || '(no brand)'}</span>
                              {!noBrand && <span style={{ display: 'inline-block', background: gap.bg, color: gap.fg, padding: '1px 8px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-xs)', fontWeight: 600, flex: '0 0 auto' }}>{gap.label}</span>}
                              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>{d.count.toLocaleString()}</span>
                            </div>
                            <div style={{ height: '6px', borderRadius: 'var(--radius-pill)', background: 'var(--border-light)', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${Math.max(3, (d.count / maxDateless) * 100)}%`, background: 'var(--primary)', borderRadius: 'var(--radius-pill)' }} />
                            </div>
                          </>
                        )
                        return noBrand ? (
                          <div key={d.brand || '__none'} style={{ marginBottom: '10px' }}>{rowInner}</div>
                        ) : (
                          <Link key={d.brand} href={`/devices?brand=${encodeURIComponent(d.brand)}&eol=none`} style={{ display: 'block', marginBottom: '10px', textDecoration: 'none' }}>{rowInner}</Link>
                        )
                      })}
                      {coverage.datelessByBrand.length > 10 && (
                        <button
                          type="button"
                          onClick={() => setShowAllDateless(v => !v)}
                          style={{ background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', color: 'var(--primary)', fontSize: 'var(--text-sm)', fontWeight: 600 }}
                        >
                          {showAllDateless ? 'Show top 10' : `Show all ${coverage.datelessByBrand.length}`}
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* c. Seed catalog by vendor — ranked */}
                <div style={subCard}>
                  <div style={subTitle}>Seed catalog by vendor</div>
                  {coverage.seedByVendor.length === 0 ? (
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>The seed catalog is empty.</div>
                  ) : (
                    coverage.seedByVendor.slice(0, 10).map(s => (
                      <div key={s.vendor} style={{ marginBottom: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                          <span style={{ flex: '1 1 auto', fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.vendor}</span>
                          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>{s.count.toLocaleString()}</span>
                        </div>
                        <div style={{ height: '6px', borderRadius: 'var(--radius-pill)', background: 'var(--border-light)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.max(3, (s.count / maxSeed) * 100)}%`, background: 'var(--primary)', borderRadius: 'var(--radius-pill)' }} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* gap legend */}
              <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', marginTop: '14px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                <span><span style={{ display: 'inline-block', width: '9px', height: '9px', /* intentional: 2px on a 9x9 legend swatch is small RELATIVE TO THE ELEMENT — --radius-sm (6px) would round it into a circle */ borderRadius: '2px', background: 'var(--tint-warn-fg)', marginRight: '6px' }} /><strong style={{ color: 'var(--text-secondary)' }}>Coverage gap</strong> — research &amp; add seed for this brand.</span>
                <span><span style={{ display: 'inline-block', width: '9px', height: '9px', /* intentional: 2px on a 9x9 legend swatch is small RELATIVE TO THE ELEMENT — --radius-sm (6px) would round it into a circle */ borderRadius: '2px', background: 'var(--tint-info-fg)', marginRight: '6px' }} /><strong style={{ color: 'var(--text-secondary)' }}>Matching gap</strong> — seed exists, but the normalizer isn&apos;t matching it.</span>
              </div>
            </>
          )
        })()}
      </div>

      {/* ── 2. SEED MANAGEMENT ─────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <div style={{ ...sectionLabel, marginBottom: 0 }}>Seed management {seedTotal > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({seedTotal})</span>}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {datelessSeedCount > 0 && (
              <button onClick={purgeDateless} title="Remove seed entries that have no EOL/EOS date — they can't enrich devices and create false matches" style={{ padding: '8px 14px', fontSize: 'var(--text-sm)', fontWeight: 600, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Remove {datelessSeedCount.toLocaleString()} dateless</button>
            )}
            <button className="btn-primary" onClick={() => openAdd()} style={{ padding: '8px 16px' }}>+ Add entry</button>
          </div>
        </div>

        {/* add / edit form */}
        {showForm && (
          <div ref={formRef} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '18px', marginBottom: '18px', background: 'var(--surface-subtle)' }}>
            <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 600, margin: '0 0 16px', color: 'var(--text-primary)' }}>{editId != null ? 'Edit seed entry' : 'Add seed entry'}</h3>
            <div className="form-grid-compact" style={{ marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Vendor <span style={{ color: 'var(--primary)' }}>*</span></label>
                <select className="input select" value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))}>
                  <option value="">Select vendor…</option>
                  {brands.map(b => <option key={b} value={b}>{b}</option>)}
                  {form.vendor && !brands.includes(form.vendor) && <option value={form.vendor}>{form.vendor}</option>}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Model (raw) <span style={{ color: 'var(--primary)' }}>*</span></label>
                <input className="input" placeholder="e.g. Catalyst 2960-X" value={form.model_raw} onChange={e => setForm(f => ({ ...f, model_raw: e.target.value }))} />
              </div>
              <div style={{ flexBasis: '100%' }}>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Aliases <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(comma-separated)</span></label>
                <input className="input" placeholder="e.g. WS-C2960X, 2960X" value={form.aliases} onChange={e => setForm(f => ({ ...f, aliases: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>EOL date</label>
                <input className="input input-sm" type="date" value={form.eol_date} onChange={e => setForm(f => ({ ...f, eol_date: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>EOS date</label>
                <input className="input input-sm" type="date" value={form.eos_date} onChange={e => setForm(f => ({ ...f, eos_date: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}>Confidence</label>
                <select className="input select input-sm" value={form.confidence} onChange={e => setForm(f => ({ ...f, confidence: e.target.value as SeedForm['confidence'] }))}>
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
            <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: '14px', background: 'var(--bg-card)' }}>
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

            {seedFormError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{seedFormError}</div>}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-primary" onClick={() => void saveSeed()} disabled={savingSeed}>{savingSeed ? 'Saving…' : editId != null ? 'Save changes' : 'Add entry'}</button>
              <button className="btn-secondary" onClick={closeForm}>Cancel</button>
            </div>
          </div>
        )}

        {/* search box — non-empty query switches to a flat result table */}
        <div style={{ marginBottom: '14px' }}>
          <input
            className="input input-md"
            placeholder="Search all seed entries by vendor, model, or alias…"
            value={seedSearch}
            onChange={e => setSeedSearch(e.target.value)}
          />
        </div>

        {!seedLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : seedUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>
            Seed dataset is currently unavailable.
          </div>
        ) : seedSearch.trim() ? (
          /* ── FLAT SEARCH RESULTS ── */
          (!searchResult || searchResult.loading) ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Searching…</div>
          ) : searchResult.unavailable ? (
            <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>Search is currently unavailable.</div>
          ) : searchResult.entries.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No seed entries match &ldquo;{seedSearch.trim()}&rdquo;.</div>
          ) : (
            <>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '10px' }}>
                {searchResult.total.toLocaleString()} result{searchResult.total === 1 ? '' : 's'} for &ldquo;{seedSearch.trim()}&rdquo;
              </div>
              {renderSeedTable(searchResult.entries)}
              {renderPager(searchResult.page, searchResult.total, p => void loadSearch(seedSearch.trim(), p))}
            </>
          )
        ) : seedGroups.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No seed entries yet. Add one to start enriching device lifecycle data.</div>
        ) : (
          /* ── VENDOR ACCORDION ── */
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            {seedGroups.map((g, i) => {
              const open = expandedVendor === g.vendor
              const vp = vendorPages[g.vendor]
              return (
                <div key={g.vendor} style={{ borderBottom: i < seedGroups.length - 1 ? '1px solid var(--border-light)' : 'none' }}>
                  <button
                    type="button"
                    onClick={() => toggleVendor(g.vendor)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left',
                      padding: '12px 14px', border: 'none', cursor: 'pointer', font: 'inherit',
                      background: open ? 'var(--surface-subtle)' : 'transparent',
                    }}
                  >
                    <span style={{ display: 'inline-block', width: '10px', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 'var(--text-md)', flex: '0 0 auto' }}>{g.vendor}</span>
                    <span style={{ display: 'inline-block', background: 'var(--surface-subtle)', border: '1px solid var(--border-light)', color: 'var(--text-secondary)', padding: '1px 9px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-xs)', fontWeight: 600 }}>{g.count.toLocaleString()}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{g.dated.toLocaleString()} dated · {g.dateless.toLocaleString()} dateless</span>
                  </button>
                  {open && (
                    <div style={{ padding: '0 14px 14px' }}>
                      {(!vp || vp.loading) ? (
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>Loading…</div>
                      ) : vp.unavailable ? (
                        <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>Entries are currently unavailable.</div>
                      ) : vp.entries.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No entries for this vendor.</div>
                      ) : (
                        <>
                          {renderSeedTable(vp.entries)}
                          {renderPager(vp.page, vp.total, p => void loadVendorPage(g.vendor, p))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 3. COVERAGE WORKLIST ───────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ ...sectionLabel, marginBottom: 0 }}>Coverage worklist {unmatched.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({unmatched.length})</span>}</div>
        </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '6px 0 14px' }}>Device models with no EOL coverage. Research their real EOL/EOS dates and add each as a dated seed entry (dateless placeholders no longer help — they only create false matches).</p>
        {!latestLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : latestUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>Worklist is currently unavailable.</div>
        ) : unmatched.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No unmatched models — coverage is complete, or enrichment has not run yet.</div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
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
                      <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--primary)', cursor: 'pointer', fontWeight: 500 }} onClick={() => addUnmatchedToSeed(u.model)}>+ Add to seed</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 3.5 STATUS RECOMMENDATIONS ─────────────────────────────── */}
      {recsLoaded && !recsUnavailable && totalPending > 0 && (
        <div ref={recsRef} style={cardStyle}>
          <div style={{ ...sectionLabel }}>Status recommendations <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({totalPending})</span></div>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '-8px 0 14px' }}>Device status updates suggested by vendor EOL data. Verify against the source before accepting.</p>

          {/* SUBSECTION A — Should be EOL */}
          {shouldBeEol.length > 0 && (
            <div style={{ marginBottom: possiblyIncorrect.length > 0 ? '24px' : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>⚠️ Devices Past EOL — Status Update Recommended</div>
                <button className="btn-danger" style={{ padding: '6px 12px', fontSize: 'var(--text-sm)' }} onClick={() => void bulkRecommendation('accept_all', 'should_be_eol')}>Mark all as EOL</button>
              </div>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '0 0 12px' }}>These devices are marked Active but vendor confirms EOL date has passed. Review and update status.</p>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th>Device Name</th><th>Model</th><th>Current Status</th><th>EOL Date</th><th>Days Overdue</th><th>Confidence</th><th>Source</th><th>Action</th></tr></thead>
                  <tbody>
                    {shouldBeEol.map(r => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{r.device_name || '—'}</td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{r.model || '—'}</td>
                        <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{r.current_status || '—'}</td>
                        <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDate(r.effective_date)}</td>
                        <td>
                          {r.days != null ? (
                            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: r.days > 365 ? 'var(--tint-danger-fg)' : 'var(--tint-warn-fg)' }}>
                              {r.days.toLocaleString()} day{r.days === 1 ? '' : 's'}
                            </span>
                          ) : (
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>no date</span>
                          )}
                        </td>
                        <td><ConfidenceBadge value={r.confidence} /></td>
                        <td>
                          {r.source_url
                            ? <a href={r.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 'var(--text-sm)' }}>Verify ↗</a>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <button className="btn-danger" style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }} onClick={() => void resolveRecommendation(r, 'accept', 'should_be_eol')}>Mark as EOL</button>
                            <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => void resolveRecommendation(r, 'ignore', 'should_be_eol')}>Ignore</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SUBSECTION B — Possibly Incorrect EOL */}
          {possiblyIncorrect.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>ℹ️ Devices Marked EOL — Vendor Confirms Support</div>
                <button className="btn-primary" style={{ padding: '6px 12px', fontSize: 'var(--text-sm)' }} onClick={() => void bulkRecommendation('accept_all', 'possibly_incorrect')}>Revert all to Active</button>
              </div>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '0 0 12px' }}>These devices are marked EOL/EOS but vendor data shows they are still within support period.</p>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th>Device Name</th><th>Model</th><th>Vendor Support Until</th><th>Days Remaining</th><th>Confidence</th><th>Source</th><th>Action</th></tr></thead>
                  <tbody>
                    {possiblyIncorrect.map(r => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{r.device_name || '—'}</td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{r.model || '—'}</td>
                        <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDate(r.effective_date)}</td>
                        <td>
                          {r.days != null ? (
                            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: r.days > 365 ? 'var(--tint-success-fg)' : 'var(--tint-warn-fg)' }}>
                              {r.days.toLocaleString()} day{r.days === 1 ? '' : 's'}
                            </span>
                          ) : (
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>no date</span>
                          )}
                        </td>
                        <td><ConfidenceBadge value={r.confidence} /></td>
                        <td>
                          {r.source_url
                            ? <a href={r.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 'var(--text-sm)' }}>Verify ↗</a>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--tint-success)', color: 'var(--tint-success-fg)', cursor: 'pointer', fontWeight: 500 }} onClick={() => void resolveRecommendation(r, 'accept', 'possibly_incorrect')}>Revert to Active</button>
                            <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => void resolveRecommendation(r, 'ignore', 'possibly_incorrect')}>Ignore</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 4. DISCREPANCY REVIEW ──────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ ...sectionLabel }}>Discrepancy review {discrepancies.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({discrepancies.length})</span>}</div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '-8px 0 14px' }}>Devices where the manually entered EOL date differs from the seed dataset. Resolve each by choosing the authoritative date.</p>
        {!discLoaded ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
        ) : discUnavailable ? (
          <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>Discrepancy review is currently unavailable.</div>
        ) : discrepancies.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px 0' }}>No pending discrepancies. 🎉</div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
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
                      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--tint-warn-fg)', background: 'var(--tint-warn)', padding: '2px 8px', borderRadius: 'var(--radius-pill)' }}>
                        {Math.abs(d.difference_days)} day{Math.abs(d.difference_days) === 1 ? '' : 's'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--tint-success)', color: 'var(--tint-success-fg)', cursor: 'pointer', fontWeight: 500 }} onClick={() => void resolveDiscrepancy(d.id, 'accept_seed')}>Accept seed date</button>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => void resolveDiscrepancy(d.id, 'keep_manual')}>Keep manual</button>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => void resolveDiscrepancy(d.id, 'ignore')}>Ignore</button>
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
