'use client'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}
type User = { id: number; name: string; email: string; role: string; created_at: string }
type Site = { id: number; name: string; code: string; country: string; country_id: number; region: string; total: string }
type Country = { id: number; name: string; iso_code: string; region: string }

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'NOK', 'PLN', 'SGD', 'VND', 'GHS']

export default function SettingsPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const user = session?.user as { role?: string } | undefined
  useEffect(() => { if (user && user.role !== 'admin') router.push('/dashboard') }, [user, router])

  const [activeTab, setActiveTab] = useState<'branding'|'users'|'sites'>('branding')
  const [settings, setSettings] = useState<Settings>({ app_name: '', app_subtitle: '', app_logo_url: '', app_primary_color: '#C8102E', app_navy_color: '#1a2744' })
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  const [users, setUsers] = useState<User[]>([])
  const [showUserForm, setShowUserForm] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [userForm, setUserForm] = useState({ name: '', email: '', password: '', role: 'viewer' })
  const [savingUser, setSavingUser] = useState(false)
  const [userError, setUserError] = useState('')

  const [sites, setSites] = useState<Site[]>([])
  const [countries, setCountries] = useState<Country[]>([])
  const [showSiteForm, setShowSiteForm] = useState(false)
  const [siteForm, setSiteForm] = useState({ name: '', code: '', country_id: '' })
  const [savingSite, setSavingSite] = useState(false)
  const [siteError, setSiteError] = useState('')
  const [siteSearch, setSiteSearch] = useState('')

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => { setSettings(d); setLoadingSettings(false) })
    fetch('/api/users').then(r => r.json()).then(setUsers)
    fetch('/api/sites').then(r => r.json()).then(setSites)
    fetch('/api/countries').then(r => r.json()).then(d => { if (Array.isArray(d)) setCountries(d) })
  }, [])

  async function saveSettings() {
    setSavingSettings(true)
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
    setSavingSettings(false); setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 3000)
  }

  function fetchUsers() { fetch('/api/users').then(r => r.json()).then(setUsers) }
  function fetchSites() { fetch('/api/sites').then(r => r.json()).then(setSites) }

  function openAddUser() { setUserForm({ name: '', email: '', password: '', role: 'viewer' }); setEditUser(null); setShowUserForm(true); setUserError('') }
  function openEditUser(u: User) { setUserForm({ name: u.name, email: u.email, password: '', role: u.role }); setEditUser(u); setShowUserForm(true); setUserError('') }

  async function saveUser() {
    if (!userForm.name || !userForm.email) { setUserError('Name and email required'); return }
    if (!editUser && !userForm.password) { setUserError('Password required for new users'); return }
    setSavingUser(true); setUserError('')
    const res = await fetch(editUser ? `/api/users/${editUser.id}` : '/api/users', {
      method: editUser ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userForm)
    })
    if (res.ok) { setShowUserForm(false); fetchUsers() }
    else { const d = await res.json(); setUserError(d.error || 'Failed to save') }
    setSavingUser(false)
  }

  async function deleteUser(id: number, name: string) {
    if (!confirm(`Delete user "${name}"?`)) return
    await fetch(`/api/users/${id}`, { method: 'DELETE' })
    fetchUsers()
  }

  async function addSite() {
    if (!siteForm.name || !siteForm.country_id) { setSiteError('Site name and country are required'); return }
    setSavingSite(true); setSiteError('')
    const res = await fetch('/api/sites/manage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(siteForm)
    })
    if (res.ok) { setShowSiteForm(false); setSiteForm({ name: '', code: '', country_id: '' }); fetchSites() }
    else { const d = await res.json(); setSiteError(d.error || 'Failed to add site') }
    setSavingSite(false)
  }

  async function deleteSite(id: number, name: string) {
    if (!confirm(`Delete site "${name}"?`)) return
    const res = await fetch('/api/sites/manage', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    if (res.ok) { fetchSites() }
    else { const d = await res.json(); alert(d.error || 'Failed to delete') }
  }

  if (loadingSettings) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>

  const filteredSites = sites.filter(s =>
    !siteSearch || s.name?.toLowerCase().includes(siteSearch.toLowerCase()) || s.country?.toLowerCase().includes(siteSearch.toLowerCase())
  )

  return (
    <div style={{ padding: '24px 28px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Settings</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Manage app branding, users and sites</p>
      </div>

      <div style={{ display: 'flex', borderBottom: '2px solid #f3f4f6', marginBottom: '24px' }}>
        {(['branding', 'users', 'sites'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: activeTab === tab ? '600' : '400', color: activeTab === tab ? '#C8102E' : '#6b7280', background: 'none', border: 'none', borderBottom: activeTab === tab ? '2px solid #C8102E' : '2px solid transparent', cursor: 'pointer', marginBottom: '-2px', textTransform: 'capitalize' }}>
            {tab === 'branding' ? 'Branding' : tab === 'users' ? `Users (${users.length})` : `Sites (${sites.length})`}
          </button>
        ))}
      </div>

      {/* BRANDING TAB */}
      {activeTab === 'branding' && (
        <div>
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Preview</div>
            <div style={{ background: settings.app_navy_color || '#1a2744', borderRadius: '8px', padding: '14px 16px', width: '220px' }}>
              {settings.app_logo_url ? (
                <div style={{ marginBottom: '6px' }}>
                  <img src={settings.app_logo_url} alt="logo" style={{ maxWidth: '160px', maxHeight: '40px', objectFit: 'contain', objectPosition: 'left' }} />
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <div style={{ width: '28px', height: '28px', background: settings.app_primary_color || '#C8102E', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                    </svg>
                  </div>
                  <div style={{ color: 'white', fontSize: '13px', fontWeight: '700' }}>{settings.app_name || 'App name'}</div>
                </div>
              )}
              {settings.app_logo_url && <div style={{ color: 'white', fontSize: '12px', fontWeight: '600' }}>{settings.app_name}</div>}
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '10px' }}>{settings.app_subtitle || 'Subtitle'}</div>
            </div>
          </div>

          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>App identity</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>App name</label>
                <input className="input" value={settings.app_name} onChange={e => setSettings(s => ({ ...s, app_name: e.target.value }))} placeholder="e.g. NetVault" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>Subtitle</label>
                <input className="input" value={settings.app_subtitle} onChange={e => setSettings(s => ({ ...s, app_subtitle: e.target.value }))} placeholder="e.g. Network Intelligence Platform" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>Logo</label>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <div>
                    {settings.app_logo_url ? (
                      <div style={{ position: 'relative', display: 'inline-block' }}>
                        <img src={settings.app_logo_url} alt="logo" style={{ width: '56px', height: '56px', borderRadius: '8px', objectFit: 'cover', border: '1px solid #e5e7eb' }} />
                        <button onClick={() => setSettings(s => ({ ...s, app_logo_url: '' }))} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '18px', height: '18px', borderRadius: '50%', background: '#ef4444', color: 'white', border: 'none', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                      </div>
                    ) : (
                      <div style={{ width: '56px', height: '56px', borderRadius: '8px', border: '2px dashed #d1d5db', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: '11px' }}>No logo</div>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'inline-block', padding: '8px 14px', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', color: '#374151', cursor: 'pointer', marginBottom: '8px' }}>
                      Upload image
                      <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp" style={{ display: 'none' }} onChange={async e => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const formData = new FormData()
                        formData.append('file', file)
                        const res = await fetch('/api/settings/logo', { method: 'POST', body: formData })
                        const data = await res.json()
                        if (data.url) setSettings(s => ({ ...s, app_logo_url: data.url }))
                        else alert(data.error || 'Upload failed')
                      }} />
                    </label>
                    <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '6px' }}>PNG, JPG, SVG or WebP — max 500KB</div>
                    <div style={{ fontSize: '12px', color: '#9ca3af' }}>Or paste a URL:</div>
                    <input className="input" style={{ marginTop: '4px' }} value={settings.app_logo_url} onChange={e => setSettings(s => ({ ...s, app_logo_url: e.target.value }))} placeholder="https://your-company.com/logo.png" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Colors</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>Primary color <span style={{ fontWeight: '400', color: '#9ca3af' }}>(buttons, accents)</span></label>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <input type="color" value={settings.app_primary_color} onChange={e => setSettings(s => ({ ...s, app_primary_color: e.target.value }))} style={{ width: '48px', height: '36px', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', padding: '2px' }} />
                  <input className="input" value={settings.app_primary_color} onChange={e => setSettings(s => ({ ...s, app_primary_color: e.target.value }))} style={{ fontFamily: 'monospace', flex: 1 }} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>Sidebar color</label>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <input type="color" value={settings.app_navy_color} onChange={e => setSettings(s => ({ ...s, app_navy_color: e.target.value }))} style={{ width: '48px', height: '36px', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', padding: '2px' }} />
                  <input className="input" value={settings.app_navy_color} onChange={e => setSettings(s => ({ ...s, app_navy_color: e.target.value }))} style={{ fontFamily: 'monospace', flex: 1 }} />
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button className="btn-primary" onClick={saveSettings} disabled={savingSettings} style={{ padding: '10px 24px' }}>
              {savingSettings ? 'Saving...' : 'Save settings'}
            </button>
            {settingsSaved && <span style={{ fontSize: '13px', color: '#166534', background: '#dcfce7', padding: '6px 12px', borderRadius: '6px' }}>Saved! Reload to see changes.</span>}
          </div>
        </div>
      )}

      {/* USERS TAB */}
      {activeTab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>Manage who can access this system</p>
            <button className="btn-primary" onClick={openAddUser}>+ Add user</button>
          </div>
          {showUserForm && (
            <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '16px' }}>{editUser ? 'Edit user' : 'Add new user'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                {[
                  { label: 'Full name', field: 'name', type: 'text', placeholder: 'e.g. John Smith' },
                  { label: 'Email address', field: 'email', type: 'email', placeholder: 'john@company.com' },
                  { label: editUser ? 'New password (leave blank to keep)' : 'Password', field: 'password', type: 'password', placeholder: '••••••••' },
                ].map(f => (
                  <div key={f.field}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>{f.label}</label>
                    <input className="input" type={f.type} placeholder={f.placeholder} value={userForm[f.field as keyof typeof userForm]} onChange={e => setUserForm(p => ({ ...p, [f.field]: e.target.value }))} />
                  </div>
                ))}
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Role</label>
                  <select className="input select" value={userForm.role} onChange={e => setUserForm(p => ({ ...p, role: e.target.value }))}>
                    <option value="viewer">Viewer — read only</option>
                    <option value="admin">Admin — full access</option>
                  </select>
                </div>
              </div>
              {userError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>{userError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={saveUser} disabled={savingUser}>{savingUser ? 'Saving...' : editUser ? 'Save changes' : 'Create user'}</button>
                <button className="btn-secondary" onClick={() => setShowUserForm(false)}>Cancel</button>
              </div>
            </div>
          )}
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>{u.name}</td>
                    <td style={{ color: '#6b7280' }}>{u.email}</td>
                    <td><span className={`badge ${u.role === 'admin' ? 'badge-admin' : 'badge-viewer'}`}>{u.role}</span></td>
                    <td style={{ color: '#9ca3af', fontSize: '12px' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }} onClick={() => openEditUser(u)}>Edit</button>
                        <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteUser(u.id, u.name)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SITES TAB */}
      {activeTab === 'sites' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <input className="input" style={{ width: '240px' }} placeholder="Search sites or countries..." value={siteSearch} onChange={e => setSiteSearch(e.target.value)} />
            <button className="btn-primary" onClick={() => { setShowSiteForm(true); setSiteError('') }}>+ Add site</button>
          </div>

          {showSiteForm && (
            <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '16px' }}>Add new site</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Site name <span style={{ color: '#C8102E' }}>*</span></label>
                  <input className="input" placeholder="e.g. Bangkok Office" value={siteForm.name} onChange={e => setSiteForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Site code</label>
                  <input className="input" placeholder="e.g. BKK-01" value={siteForm.code} onChange={e => setSiteForm(f => ({ ...f, code: e.target.value }))} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Country <span style={{ color: '#C8102E' }}>*</span></label>
                  <select className="input select" value={siteForm.country_id} onChange={e => setSiteForm(f => ({ ...f, country_id: e.target.value }))}>
                    <option value="">Select country</option>
                    {countries.map(c => <option key={c.id} value={c.id}>{c.name} — {c.region}</option>)}
                  </select>
                </div>
              </div>
              {siteError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>{siteError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={addSite} disabled={savingSite}>{savingSite ? 'Saving...' : 'Add site'}</button>
                <button className="btn-secondary" onClick={() => setShowSiteForm(false)}>Cancel</button>
              </div>
            </div>
          )}

          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <table>
              <thead><tr><th>Site name</th><th>Code</th><th>Country</th><th>Region</th><th>Devices</th><th>Actions</th></tr></thead>
              <tbody>
                {filteredSites.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>{s.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px', color: '#6b7280' }}>{s.code || '—'}</td>
                    <td>{s.country}</td>
                    <td><span style={{ fontSize: '11px', color: '#6b7280' }}>{s.region}</span></td>
                    <td><span style={{ fontSize: '12px', fontWeight: '500', color: parseInt(s.total) > 0 ? '#111827' : '#9ca3af' }}>{s.total}</span></td>
                    <td>
                      <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteSite(s.id, s.name)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
