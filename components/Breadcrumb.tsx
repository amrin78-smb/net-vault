import Link from 'next/link'

type Crumb = { label: string; href?: string }

export default function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px', fontSize: 'var(--text-base)' }}>
      {crumbs.map((crumb, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {i > 0 && <span style={{ color: 'var(--text-muted)' }}>›</span>}
          {crumb.href ? (
            <Link href={crumb.href} style={{ color: 'var(--text-muted)', textDecoration: 'none', transition: 'color 0.15s' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#C8102E')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}>
              {crumb.label}
            </Link>
          ) : (
            <span style={{ color: 'var(--text-primary)', fontWeight: '500' }}>{crumb.label}</span>
          )}
        </span>
      ))}
    </div>
  )
}
