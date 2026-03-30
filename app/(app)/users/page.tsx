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
  useEffect(() => { if (user && user.role !== 'admin') router.push('/devices') }, [user, router])
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
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Users</h1>
          <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Manage who can access this system</p>
        </div>
        <button className="btn-primary" onClick={openAdd}>+ Add user</button>
      </div>
      {showForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h2 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '16px' }}>{editUser ? 'Edit user' : 'Add new user'}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
            {[{ label: 'Full name', field: 'name', type: 'text', placeholder: 'e.g. John Smith' }, { label: 'Email address', field: 'email', type: 'email', placeholder: 'john@company.com' }, { label: editUser ? 'New password (leave blank to keep)' : 'Password', field: 'password', type: 'password', placeholder: '••••••••' }].map(f => (
              <div key={f.field}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>{f.label}</label>
                <input className="input" type={f.type} placeholder={f.placeholder} value={form[f.field as keyof typeof form]} onChange={e => setForm(p => ({ ...p, [f.field]: e.target.value }))} />
              </div>
            ))}
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Role</label>
              <select className="input select" value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                <option value="viewer">Viewer — read only</option>
                <option value="admin">Admin — full access</option>
              </select>
            </div>
          </div>
          {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editUser ? 'Save changes' : 'Create user'}</button>
            <button className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td style={{ fontWeight: '500', color: '#111827' }}>{u.name}</td>
                  <td style={{ color: '#6b7280' }}>{u.email}</td>
                  <td><RoleBadge role={u.role} /></td>
                  <td style={{ color: '#9ca3af', fontSize: '12px' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }} onClick={() => openEdit(u)}>Edit</button>
                      <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteUser(u.id, u.name)}>Delete</button>
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
