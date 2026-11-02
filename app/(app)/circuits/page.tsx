'use client'
import { useToast, useConfirm } from '@/app/providers'
import { DensityToggle, ErrorBox, FilterChips, PageHead, Pager, useDensity } from '@/components/system'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'

type Circuit = {
  id: string; site_name_raw: string; site: string; site_code: string
  country: string; region: string; isp: string; usage: string
  circuit_id: string; product: string; technology: string; circuit_type: string
  interface: string; max_speed: string; guaranteed_speed: string
  public_subnet: string; cost_month: string; currency: string
  pingable: string; comment: string; it_owner: string; city: string
}

function UsageBadge({ usage }: { usage: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    'Primary Internet': { bg: '#e0f2fe', color: '#075985' },
    'Backup Internet':  { bg: '#f3f4f6', color: '#6b7280' },
    'MPLS Primary':     { bg: '#ede9fe', color: '#5b21b6' },
    'MPLS Backup':      { bg: '#f5f3ff', color: '#7c3aed' },
    'Main':             { bg: '#e0f2fe', color: '#075985' },
    'Backup':           { bg: '#f3f4f6', color: '#6b7280' },
  }
  const c = colors[usage] || { bg: '#f3f4f6', color: '#6b7280' }
  return <span className="badge" style={{ background: c.bg, color: c.color, }}>{usage || '—'}</span>
}

export default function CircuitsPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { data: session } = useSession()
  const user = session?.user as { role?: string } | undefined
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'site_admin'
  const [circuits, setCircuits] = useState<Circuit[]>([])
  const [loading, setLoading] = useState(true)
  const [density, setDensity] = useDensity()
  const [loadError, setLoadError] = useState(false)
  // Paged in the browser: /api/circuits returns the whole set in one call
  // and this page already filters client-side, so slicing here keeps the
  // filtering identical while stopping 100+ rows rendering at once.
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(50)
  const [search, setSearch] = useState('')
  const [isp, setIsp] = useState('')
  const [usage, setUsage] = useState('')
  const [technology, setTechnology] = useState('')
  const [country, setCountry] = useState('')
  const [site, setSite] = useState('')

  const clearAllCircuitFilters = () => {
    setSearch(''); setIsp(''); setUsage(''); setTechnology(''); setCountry(''); setSite('')
  }
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)

  // Close the export menu on any outside click. Registered only while the menu
  // is open so there is no listener sitting on the document the rest of the time.
  useEffect(() => {
    if (!exportMenu) return
    const close = () => setExportMenu(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [exportMenu])

  useEffect(() => { fetchCircuits(); setPage(1) }, [search, isp, usage, technology, country, site])

  async function fetchCircuits() {
    setLoading(true)
    const params = new URLSearchParams({
      ...(search && { search }),
      ...(isp && { isp }),
      ...(usage && { usage }),
      ...(technology && { technology }),
      ...(country && { country }),
      ...(site && { site }),
    })
    try {
      const res = await fetch(`/api/circuits?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error('unexpected payload')
      setCircuits(data)
      setLoadError(false)
    } catch {
      setCircuits([]); setLoadError(true)
    }
    setLoading(false)
  }

  async function deleteCircuit(id: string, circuitId: string) {
    const ok = await confirm({ title: 'Delete circuit', message: `Are you sure you want to delete circuit "${circuitId}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    const res = await fetch(`/api/circuits/${id}`, { method: 'DELETE' })
    if (res.ok) showToast(`Circuit "${circuitId}" deleted`)
    else showToast('Failed to delete circuit', 'error')
    fetchCircuits()
  }

  // Export whatever is currently on screen. The server re-applies these same
  // filters (and the site scoping) rather than trusting a client-side row list,
  // so the file always matches the query, not the paginated view.
  function doExport(format: 'csv' | 'xlsx') {
    const params = new URLSearchParams()
    if (search)     params.set('search', search)
    if (isp)        params.set('isp', isp)
    if (usage)      params.set('usage', usage)
    if (technology) params.set('technology', technology)
    if (country)    params.set('country', country)
    if (site)       params.set('site', site)
    if (format === 'xlsx') params.set('format', 'xlsx')
    setExportMenu(false)
    window.location.href = `/api/circuits/export?${params.toString()}`
  }

  const isps = [...new Set(circuits.map(c => c.isp).filter(Boolean))].sort()
  const technologies = [...new Set(circuits.map(c => c.technology).filter(t => t && t !== 'nan'))].sort()
  const countries = [...new Set(circuits.map(c => c.country).filter(Boolean))].sort()
  const sites = [...new Set(circuits.map(c => c.site).filter(Boolean))].sort()
  const mainCount = circuits.filter(c => ['main','primary internet','mpls primary'].includes(c.usage?.toLowerCase())).length
  const backupCount = circuits.filter(c => ['backup','backup internet','mpls backup'].includes(c.usage?.toLowerCase())).length

  function formatSpeed(speed: string) {
    if (!speed || speed === 'nan') return '—'
    // Convert "200Mb Guaranteed/200Mb Guaranteed" to "200/200 Mb"
    const parts = speed.split('/')
    if (parts.length === 2) {
      const clean = (s: string) => s.replace(/\s*(guaranteed|not guaranteed|guranteed|shared)\s*/gi, '').trim()
      const up = clean(parts[0])
      const down = clean(parts[1])
      if (up === down) return up
      return `${up} / ${down}`
    }
    return speed
  }

  function formatCost(cost: string, currency: string) {
    if (!cost) return '—'
    return `${currency || 'THB'} ${parseFloat(cost).toLocaleString()}`
  }

  const selectStyle = { padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-md)', background: 'var(--bg-card)', outline: 'none', cursor: 'pointer' }

  return (
    <div style={{ padding: '24px 28px' }}>
      <PageHead
        title="WAN Circuits"
        description="Provider links across every site, with the circuit reference, type and monthly cost."
      />

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total circuits', value: circuits.length, color: 'var(--text-secondary)', bg: 'var(--surface-subtle)', border: 'var(--border)', href: '/circuits', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg> },
          { label: 'Primary / Main', value: mainCount, color: 'var(--tint-success-fg)', bg: 'var(--tint-success)', border: 'var(--border)', href: '/circuits?usage=Main', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> },
          { label: 'Backup', value: backupCount, color: 'var(--tint-info-fg)', bg: 'var(--tint-info)', border: 'var(--border)', href: '/circuits?usage=Backup', icon: <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg> },
        ].map(s => (
          <a key={s.label} href={s.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: s.bg, borderRadius: 'var(--radius)', border: `1px solid ${s.border}`, padding: '16px', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'transform 0.1s, box-shadow 0.1s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>
              <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: s.color }}>{s.icon}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: s.color, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600', opacity: 0.8 }}>{s.label}</div>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: s.color, opacity: 0.6, marginTop: '4px' }}>View all →</div>
            </div>
          </a>
        ))}
      </div>

      {/* Search + Filter bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        <input className="input" style={{ flex: '1', maxWidth: '400px' }} placeholder="Search circuit ID, ISP, subnet..." aria-label="Search circuits"
          value={search} onChange={e => setSearch(e.target.value)} />
        <button onClick={() => setShowFilterPanel(f => !f)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', background: showFilterPanel || !!(isp||usage||technology||country||site) ? '#1a2744' : 'var(--bg-card)', color: showFilterPanel || !!(isp||usage||technology||country||site) ? 'white' : 'var(--text-secondary)', border: '1px solid ' + (showFilterPanel || !!(isp||usage||technology||country||site) ? '#1a2744' : 'var(--border)'), borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-base)', fontWeight: '500', whiteSpace: 'nowrap' as const }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          Filters {!!(isp||usage||technology||country||site) && `(${[isp,usage,technology,country,site].filter(Boolean).length})`}
        </button>
        {/* stopPropagation so clicking the button does not immediately hit the
            document-level close handler that the menu registers. */}
        <div style={{ position: 'relative' as const }} onClick={e => e.stopPropagation()}>
          <button onClick={() => setExportMenu(m => !m)}
            title={!!(search||isp||usage||technology||country||site) ? 'Export the filtered circuits' : 'Export all circuits'}
            style={{ padding: '7px 10px', background: exportMenu ? 'var(--surface-subtle)' : 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-base)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' as const }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-subtle)')}
            onMouseLeave={e => (e.currentTarget.style.background = exportMenu ? 'var(--surface-subtle)' : 'var(--bg-card)')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Export
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {exportMenu && (
            <div style={{ position: 'absolute' as const, top: 'calc(100% + 4px)', right: 0, zIndex: 20, minWidth: '190px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)', overflow: 'hidden' }}>
              <button onClick={() => doExport('xlsx')}
                style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '9px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-subtle)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                Excel (.xlsx)
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Cost is a real number</div>
              </button>
              <button onClick={() => doExport('csv')}
                style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '9px 12px', background: 'none', border: 'none', borderTop: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-subtle)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                CSV
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>For Power BI / scripts</div>
              </button>
            </div>
          )}
        </div>
        {!!(search||isp||usage||technology||country||site) && (
          <button onClick={clearAllCircuitFilters}
            style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' as const }}>
            Clear all
          </button>
        )}
      </div>

      <FilterChips
        filters={([
          ['search',     'Search',     search],
          ['isp',        'Provider',   isp],
          ['usage',      'Usage',      usage],
          ['technology', 'Technology', technology],
          ['country',    'Country',    country],
          ['site',       'Site',       site],
        ] as const).filter(([, , v]) => !!v).map(([key, label, value]) => ({ key, label, value: String(value) }))}
        onClear={k => {
          if (k === 'search') setSearch('')
          else if (k === 'isp') setIsp('')
          else if (k === 'usage') setUsage('')
          else if (k === 'technology') setTechnology('')
          else if (k === 'country') setCountry('')
          else if (k === 'site') setSite('')
        }}
        onClearAll={clearAllCircuitFilters}
      />

      {/* Filter panel */}
      {showFilterPanel && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '16px', marginBottom: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Country</div>
            <select className="select" style={{ width: '100%' }} value={country} onChange={e => { setCountry(e.target.value); setSite('') }}>
              <option value="">All countries</option>
              {countries.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Site</div>
            <select className="select" style={{ width: '100%' }} value={site} onChange={e => setSite(e.target.value)}>
              <option value="">All sites</option>
              {sites.filter(s => !country || circuits.find(c => c.site === s)?.country === country).map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>ISP</div>
            <select className="select" style={{ width: '100%' }} value={isp} onChange={e => setIsp(e.target.value)}>
              <option value="">All ISPs</option>
              {isps.map(i => <option key={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Usage</div>
            <select className="select" style={{ width: '100%' }} value={usage} onChange={e => setUsage(e.target.value)}>
              <option value="">All usage</option>
              <option>Primary Internet</option>
              <option>Backup Internet</option>
              <option>MPLS Primary</option>
              <option>MPLS Backup</option>
              <option>Main</option>
              <option>Backup</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px' }}>Technology</div>
            <select className="select" style={{ width: '100%' }} value={technology} onChange={e => setTechnology(e.target.value)}>
              <option value="">All technology</option>
              {technologies.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Active filter pills */}
      {!!(isp||usage||technology||country||site) && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' as const, marginBottom: '12px' }}>
          {country && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--tint-info)', color: 'var(--tint-info-fg)', padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Country: {country}<button onClick={() => { setCountry(''); setSite('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tint-info-fg)', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {site && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--tint-info)', color: 'var(--tint-info-fg)', padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Site: {site}<button onClick={() => setSite('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tint-info-fg)', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {isp && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--tint-info)', color: 'var(--tint-info-fg)', padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)', fontWeight: '500' }}>ISP: {isp}<button onClick={() => setIsp('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tint-info-fg)', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {usage && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--tint-info)', color: 'var(--tint-info-fg)', padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Usage: {usage}<button onClick={() => setUsage('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tint-info-fg)', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
          {technology && <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--tint-info)', color: 'var(--tint-info-fg)', padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)', fontWeight: '500' }}>Technology: {technology}<button onClick={() => setTechnology('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tint-info-fg)', fontSize: 'var(--text-md)', lineHeight: '1', padding: '0 0 0 2px' }}>×</button></span>}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="tnum" style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }} aria-live="polite">
            {loading ? 'Loading…' : `${circuits.length.toLocaleString()} circuit${circuits.length === 1 ? '' : 's'}`}
          </span>
          <DensityToggle density={density} onChange={setDensity} />
        </div>
        {isAdmin && (
          <Link href="/circuits/new">
            <button style={{ padding: '7px 14px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-base)', fontWeight: '500' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
              Add circuit
            </button>
          </Link>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        {loadError ? (
          <ErrorBox message="The circuit list could not be loaded." onRetry={() => { setLoading(true); fetchCircuits() }} />
        ) : loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading circuits...</div>
        ) : circuits.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>No circuits found</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {/* tableLayout auto, not fixed: under `fixed` a column can never be
                widened by its content, so the circuit ID could only ever be
                clipped or spill over its neighbours. With auto layout plus a
                minWidth the identifier takes the room it needs and the
                container's existing overflowX scrolls. */}
            <table className={`data-table sticky${density === 'compact' ? ' compact' : ''}`}
              style={{ fontSize: 'var(--text-base)', borderCollapse: 'collapse', width: '100%', tableLayout: 'auto', minWidth: 1180 }}>
              <thead>
              <tr>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '13%' }}>Site</th>
                {/* The circuit ID was not displayed at all. It is the value
                    an operator quotes to the provider when a link is down -
                    the single most useful identifier on this page - and it
                    does not get clamped (see the .ident rule in globals.css:
                    a half-shown circuit ID is worse than no column). */}
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }} className="ident">Circuit ID</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '7%' }}>Country</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '13%' }}>ISP</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '10%' }}>Usage</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '12%' }}>Product</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '13%' }}>Max speed</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '15%' }}>Public subnet</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '11%' }}>Cost/month</th>
                <th style={{ padding: '10px 14px', background: 'var(--bg-card)', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '12%' }}>Actions</th>
              </tr>
            </thead>
              <tbody>
                {circuits.slice((page - 1) * limit, page * limit).map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ padding: '10px 14px', fontWeight: '500', color: 'var(--text-primary)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Link href={`/circuits/${c.id}`} style={{ color: 'var(--text-primary)', textDecoration: 'none' }} title={c.site || c.site_name_raw}>
                        {c.site || c.site_name_raw}
                      </Link>
                    </td>
                    <td className="ident" style={{ padding: '10px 14px', color: 'var(--text-primary)' }}>
                      {c.circuit_id && c.circuit_id !== 'nan' ? c.circuit_id : <span style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c.country}</td>
                    <td style={{ padding: '10px 14px', fontWeight: '500', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.isp}>{c.isp}</td>
                    <td style={{ padding: '10px 14px', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><UsageBadge usage={c.usage} /></td>
                    <td style={{ padding: '10px 14px', fontSize: 'var(--text-sm)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.product && c.product !== 'nan' ? c.product : '—'}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.max_speed}>{formatSpeed(c.max_speed)}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.public_subnet && c.public_subnet !== '-' && c.public_subnet !== 'nan' ? c.public_subnet : '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{formatCost(c.cost_month, c.currency)}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Link href={`/circuits/${c.id}`}>
                          <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer' }}>View</button>
                        </Link>
                        {isAdmin && (
                          <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', border: '1px solid var(--tint-danger-fg)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                            onClick={() => deleteCircuit(c.id, c.circuit_id)}>Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !loadError && (
          <Pager
            page={page}
            limit={limit}
            total={circuits.length}
            onPage={setPage}
            onLimit={n => { setLimit(n); setPage(1) }}
          />
        )}
      </div>
    </div>
  )
}
