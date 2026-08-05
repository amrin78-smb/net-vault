'use client'
import { useToast, useConfirm } from '@/app/providers'
import { RoleBadge } from '@/components/Badges'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
type User = { id: number; name: string; email: string; role: string; created_at: string; apps?: string[] }

const APP_OPTIONS: { slug: string; label: string }[] = [
  { slug: 'netvault', label: 'NetVault' },
  { slug: 'logvault', label: 'LogVault' },
  { slug: 'ddivault', label: 'DDIVault' },
  { slug: 'spanvault', label: 'SpanVault' },
]
const ALL_SLUGS = APP_OPTIONS.map(a => a.slug)
const APP_LABEL: Record<string, string> = Object.fromEntries(APP_OPTIONS.map(a => [a.slug, a.label]))

export default function UsersPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { data: session } = useSession()
  const router = useRouter()
  const user = session?.user as { role?: string } | undefined
  useEffect(() => { if (user) router.push('/settings') }, [user, router])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'viewer' })
  // App access — checked slugs. netvault is always included; super_admin implies all.
  const [appSlugs, setAppSlugs] = useState<string[]>([...ALL_SLUGS])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function fetchUsers() { fetch('/api/users').then(r => r.json()).then(d => { setUsers(d); setLoading(false) }) }
  useEffect(() => { fetchUsers() }, [])

  function openAdd() { setForm({ name: '', email: '', password: '', role: 'viewer' }); setAppSlugs([...ALL_SLUGS]); setEditUser(null); setShowForm(true); setError('') }
  function openEdit(u: User) {
    setForm({ name: u.name, email: u.email, password: '', role: u.role })
    // Empty/absent apps means "all apps" (default) → show all four checked.
    const initial = (u.apps && u.apps.length > 0) ? u.apps : [...ALL_SLUGS]
    setAppSlugs(Array.from(new Set(['netvault', ...initial.filter(s => ALL_SLUGS.includes(s))])))
    setEditUser(u); setShowForm(true); setError('')
  }

  // super_admin can access everything; force all + lock the checkboxes.
  const appsLocked = form.role === 'super_admin'
  const effectiveApps = appsLocked ? [...ALL_SLUGS] : appSlugs
  function toggleApp(slug: string) {
    if (slug === 'netvault' || appsLocked) return
    setAppSlugs(p => p.includes(slug) ? p.filter(s => s !== slug) : [...p, slug])
  }

  async function save() {
    if (!form.name || !form.email) { setError('Name and email are required'); return }
    if (!editUser && !form.password) { setError('Password is required for new users'); return }
    setSaving(true); setError('')
    const res = await fetch(editUser ? `/api/users/${editUser.id}` : '/api/users', {
      method: editUser ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, app_slugs: Array.from(new Set(['netvault', ...effectiveApps])) })
    })
    if (res.ok) { setShowForm(false); fetchUsers() }
    else { const d = await res.json(); setError(d.error || 'Failed to save') }
    setSaving(false)
  }

  async function deleteUser(id: number, name: string) {
    const ok = await confirm({ title: 'Delete user', message: `Are you sure you want to delete "${name}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    await fetch(`/api/users/${id}`, { method: 'DELETE' })
    fetchUsers()
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Users</h1>
          <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>Manage who can access this system</p>
        </div>
        <button className="btn-primary" onClick={openAdd}>+ Add user</button>
      </div>
      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h2 style={{ fontSize: 'var(--text-md)', fontWeight: '600', marginBottom: '16px' }}>{editUser ? 'Edit user' : 'Add new user'}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
            {[{ label: 'Full name', field: 'name', type: 'text', placeholder: 'e.g. John Smith' }, { label: 'Email address', field: 'email', type: 'email', placeholder: 'john@company.com' }, { label: editUser ? 'New password (leave blank to keep)' : 'Password', field: 'password', type: 'password', placeholder: '••••••••' }].map(f => (
              <div key={f.field}>
                <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>{f.label}</label>
                <input className="input" type={f.type} placeholder={f.placeholder} value={form[f.field as keyof typeof form]} onChange={e => setForm(p => ({ ...p, [f.field]: e.target.value }))} />
              </div>
            ))}
            <div>
              <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Role</label>
              <select className="input select" value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                <option value="viewer">Viewer — read only</option>
                <option value="admin">Admin — full access</option>
              </select>
            </div>
          </div>
          {/* App access — which suite apps this user may open. NetVault is always accessible. */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>App access</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {APP_OPTIONS.map(app => {
                const forced = app.slug === 'netvault' || appsLocked
                const checked = effectiveApps.includes(app.slug)
                return (
                  <label key={app.slug} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', fontSize: 'var(--text-base)', color: 'var(--text-primary)', cursor: forced ? 'not-allowed' : 'pointer', opacity: forced && !checked ? 0.6 : 1 }}>
                    <input type="checkbox" checked={checked} disabled={forced} onChange={() => toggleApp(app.slug)} style={{ cursor: forced ? 'not-allowed' : 'pointer' }} />
                    {app.label}
                  </label>
                )
              })}
            </div>
            {appsLocked && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '6px' }}>Super admins can access all apps.</div>}
          </div>
          {error && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editUser ? 'Save changes' : 'Create user'}</button>
            <button className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>App access</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{u.name}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td><RoleBadge role={u.role} /></td>
                  <td>
                    {(() => {
                      // Empty/absent apps, all four, or super_admin → "All apps".
                      const list = (u.apps || []).filter(s => ALL_SLUGS.includes(s))
                      if (u.role === 'super_admin' || list.length === 0 || list.length >= ALL_SLUGS.length) {
                        return <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>All apps</span>
                      }
                      const shown = Array.from(new Set(['netvault', ...list]))
                      return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {shown.map(s => (
                            <span key={s} style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-secondary)', background: 'var(--surface-subtle)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 7px' }}>{APP_LABEL[s] || s}</span>
                          ))}
                        </div>
                      )
                    })()}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => openEdit(u)}>Edit</button>
                      <button className="btn-danger" style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }} onClick={() => deleteUser(u.id, u.name)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
