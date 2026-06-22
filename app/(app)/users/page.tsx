'use client'
import { useToast, useConfirm } from '@/app/providers'
import { RoleBadge } from '@/components/Badges'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
type User = { id: number; name: string; email: string; role: string; created_at: string }

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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function fetchUsers() { fetch('/api/users').then(r => r.json()).then(d => { setUsers(d); setLoading(false) }) }
  useEffect(() => { fetchUsers() }, [])

  function openAdd() { setForm({ name: '', email: '', password: '', role: 'viewer' }); setEditUser(null); setShowForm(true); setError('') }
  function openEdit(u: User) { setForm({ name: u.name, email: u.email, password: '', role: u.role }); setEditUser(u); setShowForm(true); setError('') }

  async function save() {
    if (!form.name || !form.email) { setError('Name and email are required'); return }
    if (!editUser && !form.password) { setError('Password is required for new users'); return }
    setSaving(true); setError('')
    const res = await fetch(editUser ? `/api/users/${editUser.id}` : '/api/users', {
      method: editUser ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
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
          {error && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: '6px', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editUser ? 'Save changes' : 'Create user'}</button>
            <button className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div style={{ background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{u.name}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td><RoleBadge role={u.role} /></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => openEdit(u)}>Edit</button>
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
