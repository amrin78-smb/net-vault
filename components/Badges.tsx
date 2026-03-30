export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    'Active': 'badge-active',
    'Decommed': 'badge-decommed',
    'Faulty, Replaced': 'badge-faulty',
    'Spare': 'badge-spare',
  }
  return <span className={`badge ${map[status] || 'badge-unknown'}`}>{status || '—'}</span>
}

export function LifecycleBadge({ status }: { status: string }) {
  if (status === 'EOL / EOS') return <span className="badge badge-eol">EOL / EOS</span>
  if (status === 'Active, Supported') return <span className="badge badge-active">Supported</span>
  return <span className="badge badge-unknown">Unknown</span>
}

export function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    'admin': 'badge-admin',
    'site_admin': 'badge-viewer',
    'viewer': 'badge-unknown',
  }
  return <span className={`badge ${map[role] || 'badge-unknown'}`}>{role}</span>
}
