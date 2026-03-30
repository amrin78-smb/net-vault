import Link from 'next/link'

type Crumb = { label: string; href?: string }

export default function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px', fontSize: '13px' }}>
      {crumbs.map((crumb, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {i > 0 && <span style={{ color: '#d1d5db' }}>›</span>}
          {crumb.href ? (
            <Link href={crumb.href} style={{ color: '#6b7280', textDecoration: 'none', transition: 'color 0.15s' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#C8102E')}
              onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}>
              {crumb.label}
            </Link>
          ) : (
            <span style={{ color: '#111827', fontWeight: '500' }}>{crumb.label}</span>
          )}
        </span>
      ))}
    </div>
  )
}
