'use client'
import Link from 'next/link'
import { Icon } from './icons'

export { Icon } from './icons'
export { Dialog } from './Dialog'
export { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from './Menu'
export { useDensity, type Density } from './useDensity'
export { DensityToggle } from './DensityToggle'

/* ── Buttons ──────────────────────────────────────────────────── */

type ButtonVariant = 'default' | 'primary' | 'navy' | 'secondary' | 'destructive'
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: 'btn', primary: 'btn btn-primary', navy: 'btn btn-navy',
  secondary: 'btn btn-secondary', destructive: 'btn btn-destructive',
}

export function Button({
  variant = 'default', icon, children, className = '', ...rest
}: {
  variant?: ButtonVariant
  icon?: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`${VARIANT_CLASS[variant]} ${className}`.trim()}>
      {icon}{children}
    </button>
  )
}

/** Icon-only button. `label` is required — it becomes the accessible name,
 *  because an icon-only control is otherwise unreadable to a screen reader. */
export function IconButton({ label, icon, className = '', ...rest }: {
  label: string
  icon: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`icon-btn ${className}`.trim()} aria-label={label} title={label}>
      {icon}
    </button>
  )
}

/* ── Page header ──────────────────────────────────────────────── */

export type Crumb = { label: string; href?: string }

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (!items.length) return null
  return (
    <nav aria-label="Breadcrumb" style={{ marginBottom: 6 }}>
      <ol style={{ display: 'flex', alignItems: 'center', gap: 6, listStyle: 'none', flexWrap: 'wrap' }}>
        {items.map((c, i) => {
          const last = i === items.length - 1
          return (
            <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {c.href && !last
                ? <Link href={c.href} style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textDecoration: 'none' }}>{c.label}</Link>
                : <span style={{ fontSize: 'var(--text-sm)', color: last ? 'var(--text-secondary)' : 'var(--text-muted)' }} aria-current={last ? 'page' : undefined}>{c.label}</span>}
              {!last && <span aria-hidden style={{ color: 'var(--text-muted)', display: 'flex' }}><Icon.chevronRight size={12} /></span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Standard page header: breadcrumb, title, description, freshness, actions.
 *
 * `updatedAt` is rendered only when a value is supplied — an operations
 * console that always claims to be current is worse than one that says
 * nothing, so a page that does not know its data age must not pass one.
 */
export function PageHead({
  title, description, breadcrumbs, updatedAt, status, actions, titleId,
}: {
  title: string
  description?: string
  breadcrumbs?: Crumb[]
  updatedAt?: Date | string | null
  status?: React.ReactNode
  actions?: React.ReactNode
  titleId?: string
}) {
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 id={titleId}>{title}</h1>
          {status}
        </div>
        {description && <p className="page-desc">{description}</p>}
        {updatedAt && <div className="page-meta">Updated {formatWhen(updatedAt)}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function formatWhen(v: Date | string): string {
  const d = typeof v === 'string' ? new Date(v) : v
  if (isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
  return d.toLocaleString()
}

/* ── Section ──────────────────────────────────────────────────── */

export function Section({ title, description, actions, children, id }: {
  title?: string; description?: string; actions?: React.ReactNode
  children: React.ReactNode; id?: string
}) {
  return (
    <section className="section" id={id} aria-labelledby={title ? `${id || title}-h` : undefined}>
      {(title || actions) && (
        <div className="section-head">
          <div>
            {title && <h2 className="section-title" id={`${id || title}-h`}>{title}</h2>}
            {description && <div className="section-desc">{description}</div>}
          </div>
          {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Card({ title, actions, children, padded = true, className = '' }: {
  title?: string; actions?: React.ReactNode; children: React.ReactNode
  padded?: boolean; className?: string
}) {
  return (
    <div className={`card ${className}`.trim()}>
      {(title || actions) && (
        <div className="card-header">
          {title && <div className="card-title">{title}</div>}
          {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
        </div>
      )}
      {padded ? <div className="card-body">{children}</div> : children}
    </div>
  )
}

/* ── Status ───────────────────────────────────────────────────── */

export type Tone = 'success' | 'warn' | 'danger' | 'info' | 'neutral'
const TONE_BADGE: Record<Tone, string> = {
  success: 'badge-green', warn: 'badge-yellow', danger: 'badge-red',
  info: 'badge-blue', neutral: 'badge-gray',
}

/**
 * Status badge. Always renders text; the dot is an extra cue, never the only
 * one, so the badge stays readable in greyscale and to colour-blind users.
 */
export function StatusPill({ tone = 'neutral', children, icon }: {
  tone?: Tone; children: React.ReactNode; icon?: React.ReactNode
}) {
  return (
    <span className={`badge ${TONE_BADGE[tone]}`} style={{ gap: 5 }}>
      {icon ?? <span aria-hidden style={{
        width: 6, height: 6, borderRadius: '50%', /* intentional: status dot */
        background: 'currentColor', flexShrink: 0, opacity: 0.8,
      }} />}
      {children}
    </span>
  )
}

export function Alert({ tone = 'info', title, children, action, icon }: {
  tone?: Tone; title?: string; children?: React.ReactNode
  action?: React.ReactNode; icon?: React.ReactNode
}) {
  const role = tone === 'danger' ? 'alert' : 'status'
  const fallback = tone === 'danger' || tone === 'warn' ? <Icon.alert size={18} /> : <Icon.info size={18} />
  return (
    <div className="alert" data-tone={tone} role={role}>
      <span aria-hidden style={{ display: 'flex', flexShrink: 0, marginTop: 1 }}>{icon ?? fallback}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div className="alert-title">{title}</div>}
        {children && <div className="alert-body">{children}</div>}
      </div>
      {action && <div style={{ flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center' }}>{action}</div>}
    </div>
  )
}

/* ── Stats ────────────────────────────────────────────────────── */

/**
 * A single metric.
 *
 * `value` of `null`/`undefined` renders an em dash and the word "unavailable",
 * which is deliberately NOT the same as a real `0`. Showing 0 for data that
 * failed to load is how an operations console tells somebody their fleet is
 * fine when in fact nothing was measured.
 */
export function Stat({ label, value, sub, tone, href, loading }: {
  label: string
  value: number | string | null | undefined
  sub?: React.ReactNode
  tone?: Tone
  href?: string
  loading?: boolean
}) {
  const unavailable = !loading && (value === null || value === undefined)
  const body = (
    <>
      <div className="stat-label" style={{ marginTop: 0, order: 1 }}>{label}</div>
      <div className="stat-value" style={{
        order: 0,
        color: tone && !unavailable ? `var(--status-${tone})` : 'var(--text-primary)',
      }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: 64, height: 28, borderRadius: 6 }} />
          : unavailable ? <span style={{ color: 'var(--text-muted)' }}>—</span>
          : typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {unavailable
        ? <div className="stat-sub" style={{ order: 2 }}>Unavailable</div>
        : sub ? <div className="stat-sub" style={{ order: 2 }}>{sub}</div> : null}
    </>
  )
  const style: React.CSSProperties = { display: 'flex', flexDirection: 'column', textDecoration: 'none' }
  if (href && !unavailable && !loading) {
    return <Link href={href} className="stat-card" style={style}>{body}</Link>
  }
  return <div className="stat-card" style={style}>{body}</div>
}

/* ── Description list ─────────────────────────────────────────── */

export function DescriptionList({ items }: {
  items: { label: string; value: React.ReactNode; mono?: boolean }[]
}) {
  return (
    <dl className="dl">
      {items.map((it, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{it.label}</dt>
          <dd className={it.mono ? 'mono' : undefined}>
            {it.value === null || it.value === undefined || it.value === ''
              ? <span style={{ color: 'var(--text-muted)' }}>—</span>
              : it.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/* ── States ───────────────────────────────────────────────────── */

export function EmptyBox({ icon, title, message, action }: {
  icon?: React.ReactNode; title: string; message?: string; action?: React.ReactNode
}) {
  return (
    <div className="state-box">
      {icon && <div aria-hidden style={{ color: 'var(--text-muted)', marginBottom: 6 }}>{icon}</div>}
      <div className="state-title">{title}</div>
      {message && <div className="state-msg">{message}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function ErrorBox({ message, onRetry, title = 'Could not load this data' }: {
  message?: string; onRetry?: () => void; title?: string
}) {
  return (
    <div className="state-box" role="alert">
      <div aria-hidden style={{ color: 'var(--red)', marginBottom: 6 }}><Icon.alert size={26} /></div>
      <div className="state-title">{title}</div>
      {message && <div className="state-msg">{message}</div>}
      {onRetry && <Button style={{ marginTop: 14 }} onClick={onRetry} icon={<Icon.refresh size={14} />}>Try again</Button>}
    </div>
  )
}

export function NoAccessBox({ message = 'You do not have permission to view this.' }: { message?: string }) {
  return (
    <div className="state-box">
      <div aria-hidden style={{ color: 'var(--text-muted)', marginBottom: 6 }}><Icon.lock size={26} /></div>
      <div className="state-title">Access restricted</div>
      <div className="state-msg">{message}</div>
    </div>
  )
}

/* ── Toolbar + chips ──────────────────────────────────────────── */

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="toolbar">{children}</div>
}

export function FilterChips({ filters, onClear, onClearAll }: {
  filters: { key: string; label: string; value: string }[]
  onClear: (key: string) => void
  onClearAll?: () => void
}) {
  if (!filters.length) return null
  return (
    <div className="chip-row" style={{ marginBottom: 12 }}>
      <span className="sr-only">Active filters</span>
      {filters.map(f => (
        <span key={f.key} className="chip">
          <span style={{ color: 'var(--text-muted)' }}>{f.label}:</span>
          <strong style={{ fontWeight: 600 }}>{f.value}</strong>
          <button type="button" className="chip-x" onClick={() => onClear(f.key)}
            aria-label={`Remove ${f.label} filter`}>
            <Icon.close size={11} />
          </button>
        </span>
      ))}
      {onClearAll && filters.length > 1 && (
        <button type="button" onClick={onClearAll}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--primary)', fontWeight: 600, fontFamily: 'inherit' }}>
          Clear all
        </button>
      )}
    </div>
  )
}

/* ── Tabs ─────────────────────────────────────────────────────── */

export function Tabs({ tabs, active, onChange, label }: {
  tabs: { id: string; label: string; count?: number }[]
  active: string
  onChange: (id: string) => void
  label: string
}) {
  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.findIndex(t => t.id === active)
    if (e.key === 'ArrowRight') { e.preventDefault(); onChange(tabs[(i + 1) % tabs.length].id) }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); onChange(tabs[(i - 1 + tabs.length) % tabs.length].id) }
    if (e.key === 'Home') { e.preventDefault(); onChange(tabs[0].id) }
    if (e.key === 'End')  { e.preventDefault(); onChange(tabs[tabs.length - 1].id) }
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map(t => (
        <button key={t.id} role="tab" type="button" className="tab"
          aria-selected={t.id === active}
          tabIndex={t.id === active ? 0 : -1}
          onClick={() => onChange(t.id)}>
          {t.label}
          {typeof t.count === 'number' && (
            <span className="tnum" style={{ marginLeft: 6, color: 'var(--text-muted)' }}>{t.count.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/* ── Pagination ───────────────────────────────────────────────── */

const PAGE_SIZES = [25, 50, 100, 200]

/**
 * One pagination implementation for every list page.
 *
 * The range is computed from the ACTUAL page size. The previous per-page
 * copies multiplied by a literal 50, so picking 100 per page showed
 * "Showing 1-50 of 2,482" above a hundred rows.
 */
export function Pager({ page, limit, total, onPage, onLimit, loading }: {
  page: number; limit: number; total: number
  onPage: (p: number) => void
  onLimit?: (n: number) => void
  loading?: boolean
}) {
  const pages = Math.max(1, Math.ceil(total / limit))
  const from = total === 0 ? 0 : (page - 1) * limit + 1
  const to = Math.min(page * limit, total)
  return (
    <div className="pager">
      <div className="pager-info" aria-live="polite">
        {loading ? 'Loading…'
          : total === 0 ? 'No results'
          : <>Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</>}
      </div>
      <div className="pager-controls">
        {onLimit && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginRight: 6 }}>
            Per page
            <select className="select input-sm" value={limit} aria-label="Results per page"
              onChange={e => onLimit(Number(e.target.value))}>
              {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <Button onClick={() => onPage(page - 1)} disabled={page <= 1 || loading}
          icon={<Icon.chevronLeft size={14} />}>Previous</Button>
        <span className="tnum" style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', padding: '0 6px' }}>
          Page {page.toLocaleString()} of {pages.toLocaleString()}
        </span>
        <Button onClick={() => onPage(page + 1)} disabled={page >= pages || loading}>
          Next <Icon.chevronRight size={14} />
        </Button>
      </div>
    </div>
  )
}

/* ── Record detail ────────────────────────────────────────────────
   The shared shape for a devices/[id], sites/[id] or circuits/[id] page.
   Each of those had its own near-identical Field + Section pair whose
   markup was non-semantic divs on a hard two-column grid: long values
   (a serial, a subnet, a contract number) overflowed rather than wrapped,
   and the two columns never collapsed on a phone. */

export function RecordSection({ title, children, columns = 2, actions }: {
  title: string
  children: React.ReactNode
  columns?: 1 | 2
  actions?: React.ReactNode
}) {
  return (
    <section style={{
      background: 'var(--surface)', borderRadius: 'var(--radius)',
      border: '1px solid var(--border)', padding: '20px 24px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border-light)' }}>
        <h2 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</h2>
        {actions}
      </div>
      <dl className="record-grid" data-cols={columns}>{children}</dl>
    </section>
  )
}

/** One label/value pair inside a RecordSection. `display: contents` keeps the
 *  dt/dd on the parent grid while staying valid inside a <dl>. */
export function FieldPair({ label, value, mono, span }: {
  label: string
  value: React.ReactNode
  mono?: boolean
  span?: boolean
}) {
  const empty = value === null || value === undefined || value === ''
    || value === '-' || value === 'nan'
  return (
    <div style={{ display: 'contents' }}>
      <div className="record-field" data-span={span ? 'true' : undefined}>
        <dt>{label}</dt>
        <dd className={mono ? 'mono' : undefined}
            style={{ color: empty ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {empty ? '\u2014' : value}
        </dd>
      </div>
    </div>
  )
}
