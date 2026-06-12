'use client'
import { useToast, useConfirm } from '@/app/providers'
import { RoleBadge } from '@/components/Badges'
import { useState, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type UpdateStatus = {
  current_version?: string; latest_version?: string
  current_commit?: string; latest_commit?: string
  up_to_date?: boolean; update_available?: boolean
  release_notes?: string[]; release_date?: string; error?: string
}

function fmtReleaseDate(d?: string): string {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function UpdateConfirmModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: '12px', padding: '28px 32px', maxWidth: '400px', width: '90%' }}>
        <div style={{ fontSize: '16px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Apply update?</div>
        <div style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
          Services will restart and you will lose connection for 30–60 seconds. The page will reload automatically when the update is complete.
        </div>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: '6px', background: 'white', cursor: 'pointer', fontSize: '13px', color: '#374151' }}>Cancel</button>
          <button onClick={onConfirm} style={{ padding: '8px 16px', background: '#C8102E', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}>Update now</button>
        </div>
      </div>
    </div>
  )
}

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes — covers slow npm install + Next.js build before the service is back
// After the API is confirmed stably back up, wait this long before reloading so
// the Next.js frontend (which starts AFTER the API) has time to finish booting —
// otherwise the reload lands on "page cannot be reached" for 20-30 seconds.
const RELOAD_COUNTDOWN_SECONDS = 15

function UpdatingOverlay({ preVersion }: { preVersion: string }) {
  const [phase, setPhase] = useState<'starting' | 'down' | 'back_up' | 'verify_failed' | 'timeout'>('starting')
  const [countdown, setCountdown] = useState(RELOAD_COUNTDOWN_SECONDS)
  const wentDown = useRef(false)
  const consecutiveUp = useRef(0)
  // Capture the version that was running before the update so we can confirm
  // the code actually changed once services come back up.
  const preVersionRef = useRef(preVersion)
  useEffect(() => { preVersionRef.current = preVersion }, [preVersion])

  // After services recover, confirm the running version actually changed.
  // If it matches the pre-update version, the pull/build silently failed —
  // show an error instead of redirecting with a false success banner. Driven by
  // the countdown effect (and the "Reload Now" button) once the API is back up.
  const verifyAndRedirect = async () => {
    try {
      const ctrl = new AbortController()
      const abortId = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch('/api/system/update-status', { cache: 'no-store', signal: ctrl.signal })
      clearTimeout(abortId)
      const data = await res.json()
      // Compare commit hashes, not the semver version: a patch pushed without
      // a version bump still changes the commit, so the version string alone
      // would falsely report "verify_failed".
      const newVersion: string = data?.current_commit || ''
      if (preVersionRef.current && newVersion && newVersion === preVersionRef.current) {
        setPhase('verify_failed')
        return
      }
    } catch {
      // Verification itself failed (e.g. transient) — the service is back up,
      // so fall through and let the user land on the dashboard.
    }
    window.location.href = '/dashboard?updated=true'
  }

  useEffect(() => {
    let active = true
    const startedAt = Date.now()
    let pollId: ReturnType<typeof setInterval> | null = null

    const tick = async () => {
      if (!active) return
      if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
        if (pollId !== null) clearInterval(pollId)
        setPhase('timeout')
        return
      }
      const ctrl = new AbortController()
      const abortId = setTimeout(() => ctrl.abort(), 1800)
      let ok = false
      try {
        const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal })
        ok = res.ok
      } catch {
        ok = false
      } finally {
        clearTimeout(abortId)
      }
      if (!active) return
      if (!ok) {
        // Fetch failed or non-200 → API is down (restarting). Reset the
        // consecutive-success counter: during startup the API can answer one
        // probe then drop again, so any failure restarts the stability window.
        consecutiveUp.current = 0
        wentDown.current = true
        setPhase('down')
        return
      }
      if (wentDown.current) {
        // Require 3 consecutive healthy probes (≈6s at the 2s cadence) before
        // declaring the API stably back up. A single success after going down
        // isn't enough — services may respond once then briefly drop again
        // mid-startup, which would trigger a premature reload.
        consecutiveUp.current += 1
        if (consecutiveUp.current >= 3) {
          setPhase('back_up')
          if (pollId !== null) clearInterval(pollId)
          // The reload is driven by the countdown effect below — the API is up,
          // but Next.js needs a little longer before it can serve pages.
        }
      }
    }

    pollId = setInterval(tick, 2000)
    tick()

    return () => {
      active = false
      if (pollId !== null) clearInterval(pollId)
    }
  }, [])

  // Once the API is confirmed stably back up, count down (15…14…13…) before
  // reloading so the Next.js frontend has time to finish starting after the API.
  useEffect(() => {
    if (phase !== 'back_up') return
    if (countdown <= 0) { void verifyAndRedirect(); return }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(id)
  }, [phase, countdown])

  let statusLine = 'Starting update…'
  if (phase === 'down') statusLine = 'Services restarting… ⟳'
  else if (phase === 'back_up') statusLine = `✓ Services are back online. Reloading in ${countdown} second${countdown === 1 ? '' : 's'}…`
  else if (phase === 'verify_failed') statusLine = 'Services restarted, but the version did not change. The update may not have applied — try again or check the server logs.'
  else if (phase === 'timeout') statusLine = 'Update is taking longer than expected. Try refreshing the page manually.'

  const isError = phase === 'timeout' || phase === 'verify_failed'

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15,23,42,0.78)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.35)', padding: 28, maxWidth: 440, width: '100%', textAlign: 'center' }}>
        {phase !== 'back_up' && !isError && (
          <div style={{ fontSize: 44, lineHeight: 1, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</div>
        )}
        {phase === 'back_up' && <div style={{ fontSize: 44, lineHeight: 1 }}>✓</div>}
        {isError && <div style={{ fontSize: 44, lineHeight: 1 }}>⚠</div>}
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 14 }}>Updating NetVault…</div>
        <p style={{ color: '#64748b', marginTop: 6 }}>Pulling latest code and restarting services. Do not close this window.</p>
        <p style={{ fontWeight: 600, margin: '14px 0' }}>{statusLine}</p>
        {phase === 'back_up' && (
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, margin: '4px 0 10px', color: 'var(--primary, #C8102E)' }}>
            {countdown}
          </div>
        )}
        {phase !== 'back_up' && (
          <p style={{ color: '#64748b', fontSize: 12 }}>(This usually takes 1-3 minutes)</p>
        )}
        <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={phase === 'back_up' ? () => { void verifyAndRedirect() } : () => window.location.reload()}>Reload Now</button>
      </div>
    </div>
  )
}

type Settings = {
  app_name: string; app_subtitle: string; app_logo_url: string
  app_primary_color: string; app_navy_color: string
}
type User = { id: number; name: string; email: string; role: string; created_at: string; sites?: { id: number; name: string; code: string }[] }
type Site = { id: number; site: string; name: string; code: string; country: string; country_id: number; region: string; total: string }
type Country = { id: number; name: string; iso_code: string; region: string }

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'NOK', 'PLN', 'SGD', 'VND', 'GHS']

export default function SettingsPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { data: session } = useSession()
  const router = useRouter()
  const user = session?.user as { role?: string } | undefined
  const isSuperAdmin = user?.role === 'super_admin'
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  useEffect(() => { if (user && user.role !== 'admin' && user.role !== 'super_admin') router.push('/dashboard') }, [user, router])

  const [activeTab, setActiveTab] = useState<'branding'|'users'|'sites'|'security'|'license'|'updates'>('users')

  // Deep-link support: the suite apps' "Manage License" link points at
  // /settings/license (which redirects here as ?tab=license). Honour ?tab=<name>
  // on load so the correct tab opens instead of the default.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t && ['branding', 'users', 'sites', 'security', 'license', 'updates'].includes(t)) {
      setActiveTab(t as 'branding' | 'users' | 'sites' | 'security' | 'license' | 'updates')
    }
  }, [])
  const [settings, setSettings] = useState<Settings>({ app_name: '', app_subtitle: '', app_logo_url: '', app_primary_color: '#C8102E', app_navy_color: '#1a2744' })
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  const [idleTimeout, setIdleTimeout] = useState('30')
  const [savingSecuritySettings, setSavingSecuritySettings] = useState(false)
  const [securitySettingsSaved, setSecuritySettingsSaved] = useState(false)

  type LicenseInfo = {
    status: string; daysRemaining: number; serverId: string; customer: string | null
    expiry: string | null; modules: string[]; maxDevices: number | null; trialDaysTotal: number; installDate: string | null
  }
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null)
  const [licenseKeyInput, setLicenseKeyInput] = useState('')
  const [activatingLicense, setActivatingLicense] = useState(false)
  const [licenseActivateMsg, setLicenseActivateMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [copiedServerId, setCopiedServerId] = useState(false)

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [checkUpdateErr, setCheckUpdateErr] = useState<string | null>(null)
  const [confirmingUpdate, setConfirmingUpdate] = useState(false)
  const [updatingApp, setUpdatingApp] = useState(false)
  const [applyUpdateErr, setApplyUpdateErr] = useState<string | null>(null)

  const [users, setUsers] = useState<User[]>([])
  const [showUserForm, setShowUserForm] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [userForm, setUserForm] = useState({ name: '', email: '', password: '', role: 'viewer', site_ids: [] as number[] })
  const [savingUser, setSavingUser] = useState(false)
  const [userError, setUserError] = useState('')

  const [sites, setSites] = useState<Site[]>([])
  const [countries, setCountries] = useState<Country[]>([])
  const [showSiteForm, setShowSiteForm] = useState(false)
  const [editSite, setEditSite] = useState<Site | null>(null)
  const [editSiteForm, setEditSiteForm] = useState({ name: '', code: '', city: '', address: '', postal_code: '', coordinates: '', site_type: '', phone: '', contact_name: '', contact_email: '' })
  const [savingEditSite, setSavingEditSite] = useState(false)
  const [editSiteError, setEditSiteError] = useState('')
  const [siteForm, setSiteForm] = useState({ name: '', code: '', country_id: '', address: '', city: '', postal_code: '', coordinates: '', site_type: '', phone: '', contact_name: '', contact_email: '' })
  const [savingSite, setSavingSite] = useState(false)
  const [siteError, setSiteError] = useState('')
  const [siteSearch, setSiteSearch] = useState('')

  useEffect(() => {
    if (user?.role === 'super_admin') {
      fetch('/api/settings').then(r => r.json()).then(d => { setSettings(d); setLoadingSettings(false) })
    } else {
      setLoadingSettings(false)
    }
    fetch('/api/users').then(r => r.json()).then(setUsers)
    fetch('/api/sites').then(r => r.json()).then(setSites)
    fetch('/api/countries').then(r => r.json()).then(d => { if (Array.isArray(d)) setCountries(d) })
    fetch('/api/license').then(r => r.json()).then(d => { if (!d.error) setLicenseInfo(d) })
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/settings').then(r => r.json()).then(d => {
      if (d && !d.error && d.idle_timeout_minutes != null) setIdleTimeout(d.idle_timeout_minutes)
    }).catch(() => {})
  }, [isAdmin])

  async function saveSettings() {
    setSavingSettings(true)
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
    setSavingSettings(false); setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 3000)
  }

  async function saveSecuritySettings() {
    setSavingSecuritySettings(true)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idle_timeout_minutes: idleTimeout }),
    })
    setSavingSecuritySettings(false)
    setSecuritySettingsSaved(true)
    setTimeout(() => setSecuritySettingsSaved(false), 3000)
  }

  async function checkForUpdates() {
    setCheckingUpdate(true)
    setCheckUpdateErr(null)
    try {
      const res = await fetch('/api/system/update-status')
      const data = await res.json()
      setUpdateStatus(data)
    } catch (e: any) {
      setCheckUpdateErr(e?.message || 'Could not check for updates')
    } finally {
      setCheckingUpdate(false)
    }
  }

  async function startUpdate() {
    setConfirmingUpdate(false)
    setApplyUpdateErr(null)
    try {
      const res = await fetch('/api/system/update', { method: 'POST' })
      if (res.status === 403) {
        // License blocked the update — do NOT show the updating overlay.
        const data = await res.json().catch(() => ({}))
        setApplyUpdateErr(data.error || 'Updates are not available for your license.')
        return
      }
      setUpdatingApp(true)
    } catch (_e) {
      // connection may drop during restart
      setUpdatingApp(true)
    }
  }

  useEffect(() => {
    if (activeTab === 'updates' && !updateStatus && !checkingUpdate) {
      void checkForUpdates()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  function fetchUsers() { fetch('/api/users').then(r => r.json()).then(setUsers) }
  function fetchSites() { fetch('/api/sites').then(r => r.json()).then(setSites) }

  function openAddUser() { setUserForm({ name: '', email: '', password: '', role: 'viewer', site_ids: [] }); setEditUser(null); setShowUserForm(true); setUserError('') }
  function openEditUser(u: User) { setUserForm({ name: u.name, email: u.email, password: '', role: u.role, site_ids: (u as any).sites?.map((s: any) => s.id) || [] }); setEditUser(u); setShowUserForm(true); setUserError('') }

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
    const ok = await confirm({ title: 'Delete user', message: `Are you sure you want to delete user "${name}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' })
    if (res.ok) showToast(`User "${name}" deleted`)
    else showToast('Failed to delete user', 'error')
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
    if (res.ok) { setShowSiteForm(false); setSiteForm({ name: '', code: '', country_id: '', address: '', city: '', postal_code: '', coordinates: '', site_type: '', phone: '', contact_name: '', contact_email: '' }); fetchSites() }
    else { const d = await res.json(); setSiteError(d.error || 'Failed to add site') }
    setSavingSite(false)
  }

  async function openEditSite(s: Site) {
    setEditSite(s)
    setEditSiteError('')
    // Fetch full site details
    const res = await fetch(`/api/sites/${s.id}`)
    const data = await res.json()
    const full = data.site || {}
    setEditSiteForm({
      name: full.site || s.name || '',
      code: full.code || s.code || '',
      city: full.city || '',
      address: full.address || '',
      postal_code: full.postal_code || '',
      coordinates: full.coordinates || '',
      site_type: full.site_type || '',
      phone: full.phone || '',
      contact_name: full.contact_name || '',
      contact_email: full.contact_email || '',
    })
  }

  async function saveEditSite() {
    if (!editSite || !editSiteForm.name) { setEditSiteError('Site name is required'); return }
    setSavingEditSite(true); setEditSiteError('')
    const res = await fetch(`/api/sites/${editSite.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editSiteForm)
    })
    if (res.ok) { setEditSite(null); fetchSites() }
    else { const d = await res.json(); setEditSiteError(d.error || 'Failed to save') }
    setSavingEditSite(false)
  }

  async function deleteSite(id: number, name: string) {
    const ok2 = await confirm({ title: 'Delete site', message: `Are you sure you want to delete site "${name}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok2) return
    const res = await fetch('/api/sites/manage', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    if (res.ok) { fetchSites() }
    else { const d = await res.json(); showToast(d.error || 'Failed to delete site', 'error') }
  }

  async function activateLicense() {
    if (!licenseKeyInput.trim()) { setLicenseActivateMsg({ ok: false, text: 'Paste a license key first' }); return }
    setActivatingLicense(true); setLicenseActivateMsg(null)
    const res = await fetch('/api/license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: licenseKeyInput.trim() }),
    })
    const data = await res.json()
    if (res.ok) {
      setLicenseActivateMsg({ ok: true, text: `License activated for ${data.customer} — expires ${data.expiry}` })
      setLicenseKeyInput('')
      fetch('/api/license').then(r => r.json()).then(d => { if (!d.error) setLicenseInfo(d) })
    } else {
      setLicenseActivateMsg({ ok: false, text: data.error || 'Activation failed' })
    }
    setActivatingLicense(false)
  }

  function copyServerId() {
    if (!licenseInfo?.serverId) return
    navigator.clipboard.writeText(licenseInfo.serverId).then(() => {
      setCopiedServerId(true)
      setTimeout(() => setCopiedServerId(false), 2000)
    })
  }

  if (loadingSettings) return <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>Loading...</div>

  const filteredSites = sites.filter(s =>
    !siteSearch || s.name?.toLowerCase().includes(siteSearch.toLowerCase()) || s.country?.toLowerCase().includes(siteSearch.toLowerCase())
  )

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', margin: 0 }}>Settings</h1>
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: '2px 0 0' }}>Manage app branding, users and sites</p>
      </div>

      <div style={{ display: 'flex', borderBottom: '2px solid #f3f4f6', marginBottom: '24px', flexWrap: 'wrap' }}>
        {(['branding', 'users', 'sites', 'security', 'license', 'updates'] as const)
          .filter(tab => tab !== 'branding' || isSuperAdmin)
          .filter(tab => tab !== 'security' || isAdmin)
          .filter(tab => tab !== 'license' || isSuperAdmin)
          .filter(tab => tab !== 'updates' || isAdmin)
          .map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: activeTab === tab ? '600' : '400', color: activeTab === tab ? '#C8102E' : '#6b7280', background: 'none', border: 'none', borderBottom: activeTab === tab ? '2px solid #C8102E' : '2px solid transparent', cursor: 'pointer', marginBottom: '-2px', textTransform: 'capitalize' }}>
            {tab === 'branding' ? 'Branding' : tab === 'users' ? `Users (${users.length})` : tab === 'sites' ? `Sites (${sites.length})` : tab === 'security' ? 'Security' : tab === 'updates' ? 'Updates' : 'License'}
            {tab === 'updates' && updateStatus?.update_available && (
              <span title="Update available" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#dc2626', marginLeft: 6, verticalAlign: 'middle' }} />
            )}
          </button>
        ))}
      </div>

      {/* BRANDING TAB */}
      {activeTab === 'branding' && (
        <div>
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Preview</div>
            <div style={{ background: settings.app_navy_color || '#1a2744', borderRadius: '8px', padding: '14px 16px', width: '220px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <div style={{ width: '28px', height: '28px', background: settings.app_primary_color || '#C8102E', borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                  </svg>
                </div>
                <div style={{ color: 'white', fontSize: '13px', fontWeight: '700' }}>NetVault</div>
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

          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginTop: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>About</div>
            <div style={{ fontSize: '15px', fontWeight: '700', color: '#111827' }}>NetVault</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '4px' }}>Version: v{updateStatus?.current_version || '1.0.0'}</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '2px' }}>Part of the NocVault Intelligence Suite</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '8px' }}>© 2026 NocVault</div>
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
                    <input className="input" type={f.type} placeholder={f.placeholder} value={String(userForm[f.field as keyof typeof userForm] ?? '')} onChange={e => setUserForm(p => ({ ...p, [f.field]: e.target.value }))} />
                  </div>
                ))}
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Role</label>
                  <select className="input select" value={userForm.role} onChange={e => setUserForm(p => ({ ...p, role: e.target.value, site_ids: [] }))}>
                    <option value="viewer">Viewer — read only, all sites</option>
                    <option value="site_admin">Site Admin — full edit, assigned sites only</option>
                    {isSuperAdmin && <option value="super_admin">Super Admin — full access including branding and deletes</option>}
                    <option value="admin">Admin — full access, all sites</option>
                  </select>
                </div>
                {userForm.role === 'site_admin' && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '8px' }}>
                      Assigned sites <span style={{ color: '#C8102E' }}>*</span>
                      <span style={{ fontWeight: '400', color: '#9ca3af', marginLeft: '6px' }}>({userForm.site_ids.length} selected)</span>
                    </label>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', maxHeight: '200px', overflowY: 'auto', padding: '8px' }}>
                      {sites.length === 0 ? (
                        <div style={{ color: '#9ca3af', fontSize: '13px', padding: '8px' }}>Loading sites...</div>
                      ) : (
                        Object.entries(
                          sites.reduce((acc: any, s: any) => {
                            const key = s.country || 'Other'
                            if (!acc[key]) acc[key] = []
                            acc[key].push(s)
                            return acc
                          }, {})
                        ).map(([country, countrySites]: [string, any]) => (
                          <div key={country} style={{ marginBottom: '8px' }}>
                            <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 6px' }}>{country}</div>
                            {countrySites.map((s: any) => (
                              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', borderRadius: '5px', cursor: 'pointer', background: userForm.site_ids.includes(s.id) ? '#fef2f2' : 'transparent' }}>
                                <input type="checkbox"
                                  checked={userForm.site_ids.includes(s.id)}
                                  onChange={e => {
                                    const id = s.id
                                    setUserForm(p => ({
                                      ...p,
                                      site_ids: e.target.checked
                                        ? [...p.site_ids, id]
                                        : p.site_ids.filter((x: number) => x !== id)
                                    }))
                                  }}
                                />
                                <span style={{ fontSize: '13px', color: '#374151' }}>{s.site || s.name}</span>
                                {s.code && <span style={{ fontSize: '11px', color: '#9ca3af' }}>{s.code}</span>}
                              </label>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                      <button type="button" style={{ fontSize: '12px', color: '#C8102E', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => setUserForm(p => ({ ...p, site_ids: sites.map((s: any) => s.id) }))}>
                        Select all
                      </button>
                      <span style={{ color: '#d1d5db' }}>·</span>
                      <button type="button" style={{ fontSize: '12px', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => setUserForm(p => ({ ...p, site_ids: [] }))}>
                        Clear all
                      </button>
                    </div>
                  </div>
                )}
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
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Site access</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>{u.name}</td>
                    <td style={{ color: '#6b7280' }}>{u.email}</td>
                    <td>
                      <RoleBadge role={u.role} />
                    </td>
                    <td style={{ fontSize: '12px', color: '#6b7280', maxWidth: '200px' }}>
                      {u.role === 'site_admin' && u.sites && u.sites.length > 0
                        ? u.sites.map((s: any) => s.name || s.code).join(', ')
                        : u.role === 'site_admin' ? <span style={{ color: '#f59e0b' }}>No sites assigned</span>
                        : <span style={{ color: '#9ca3af' }}>All sites</span>}
                    </td>
                    <td style={{ color: '#9ca3af', fontSize: '12px' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {(isSuperAdmin || u.role !== 'super_admin') && <button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }} onClick={() => openEditUser(u)}>Edit</button>}
                        {isSuperAdmin && <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteUser(u.id, u.name)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECURITY TAB */}
      {activeTab === 'security' && (
        <div>
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Session security</div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px' }}>Session timeout</label>
              <select
                className="input select"
                style={{ maxWidth: '280px' }}
                value={idleTimeout}
                onChange={e => setIdleTimeout(e.target.value)}
              >
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">60 minutes (1 hour)</option>
                <option value="120">120 minutes (2 hours)</option>
                <option value="0">Never</option>
              </select>
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: '6px 0 0' }}>
                Users will be automatically logged out after this period of inactivity. Applies to all apps in the NocVault suite.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button className="btn-primary" onClick={saveSecuritySettings} disabled={savingSecuritySettings} style={{ padding: '10px 24px' }}>
                {savingSecuritySettings ? 'Saving...' : 'Save settings'}
              </button>
              {securitySettingsSaved && <span style={{ fontSize: '13px', color: '#166534', background: '#dcfce7', padding: '6px 12px', borderRadius: '6px' }}>Saved!</span>}
            </div>
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
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Site type</label>
                  <select className="input select" value={siteForm.site_type} onChange={e => setSiteForm(f => ({ ...f, site_type: e.target.value }))}>
                    <option value="">Select type</option>
                    <option>Head Office</option>
                    <option>Factory</option>
                    <option>Warehouse</option>
                    <option>Branch Office</option>
                    <option>Data Center</option>
                    <option>Cloud</option>
                    <option>Other</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>City</label>
                  <input className="input" placeholder="e.g. Bangkok" value={siteForm.city} onChange={e => setSiteForm(f => ({ ...f, city: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Postal code</label>
                  <input className="input" placeholder="e.g. 10110" value={siteForm.postal_code} onChange={e => setSiteForm(f => ({ ...f, postal_code: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>GPS coordinates</label>
                  <input className="input" placeholder="e.g. 13.7563, 100.5018" value={siteForm.coordinates} onChange={e => setSiteForm(f => ({ ...f, coordinates: e.target.value }))} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Address</label>
                  <textarea className="input" rows={2} placeholder="Full street address" value={siteForm.address} onChange={e => setSiteForm(f => ({ ...f, address: e.target.value }))} style={{ resize: 'vertical' }} />
                </div>
                <div style={{ borderTop: '1px solid #f3f4f6', gridColumn: '1 / -1', paddingTop: '12px', marginTop: '4px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '12px' }}>Site contact</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Contact name</label>
                  <input className="input" placeholder="e.g. John Smith" value={siteForm.contact_name} onChange={e => setSiteForm(f => ({ ...f, contact_name: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Contact email</label>
                  <input className="input" type="email" placeholder="e.g. john@company.com" value={siteForm.contact_email} onChange={e => setSiteForm(f => ({ ...f, contact_email: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Phone</label>
                  <input className="input" placeholder="e.g. +66 2 123 4567" value={siteForm.phone} onChange={e => setSiteForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
              </div>
              {siteError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>{siteError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={addSite} disabled={savingSite}>{savingSite ? 'Saving...' : 'Add site'}</button>
                <button className="btn-secondary" onClick={() => setShowSiteForm(false)}>Cancel</button>
              </div>
            </div>
          )}

          {editSite && (
            <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '16px' }}>Edit site — {editSite.name || (editSite as any).site}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                {[
                  { label: 'Site name *', field: 'name', placeholder: 'e.g. Bangkok Office' },
                  { label: 'Site code', field: 'code', placeholder: 'e.g. BKK-01' },
                  { label: 'City', field: 'city', placeholder: 'e.g. Bangkok' },
                  { label: 'Postal code', field: 'postal_code', placeholder: 'e.g. 10110' },
                  { label: 'GPS coordinates', field: 'coordinates', placeholder: 'e.g. 13.7563, 100.5018' },
                  { label: 'Phone', field: 'phone', placeholder: 'e.g. +66 2 123 4567' },
                  { label: 'Contact name', field: 'contact_name', placeholder: 'e.g. John Smith' },
                  { label: 'Contact email', field: 'contact_email', placeholder: 'e.g. john@company.com' },
                ].map(f => (
                  <div key={f.field}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>{f.label}</label>
                    <input className="input" placeholder={f.placeholder}
                      value={editSiteForm[f.field as keyof typeof editSiteForm]}
                      onChange={e => setEditSiteForm(p => ({ ...p, [f.field]: e.target.value }))} />
                  </div>
                ))}
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Site type</label>
                  <select className="input select" value={editSiteForm.site_type} onChange={e => setEditSiteForm(p => ({ ...p, site_type: e.target.value }))}>
                    <option value="">Select type</option>
                    {['Head Office','Factory','Warehouse','Branch Office','Data Center','Cloud','Other'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '5px' }}>Address</label>
                  <textarea className="input" rows={2} placeholder="Full street address"
                    value={editSiteForm.address}
                    onChange={e => setEditSiteForm(p => ({ ...p, address: e.target.value }))}
                    style={{ resize: 'vertical' }} />
                </div>
              </div>
              {editSiteError && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: '6px', fontSize: '13px', marginBottom: '12px' }}>{editSiteError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={saveEditSite} disabled={savingEditSite}>{savingEditSite ? 'Saving...' : 'Save changes'}</button>
                <button className="btn-secondary" onClick={() => setEditSite(null)}>Cancel</button>
              </div>
            </div>
          )}

          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <table>
              <thead><tr><th>Site name</th><th>Code</th><th>Country</th><th>Region</th><th>Devices</th><th>Actions</th></tr></thead>
              <tbody>
                {filteredSites.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: '500', color: '#111827' }}>{s.site || s.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px', color: '#6b7280' }}>{s.code || '—'}</td>
                    <td>{s.country}</td>
                    <td><span style={{ fontSize: '11px', color: '#6b7280' }}>{s.region}</span></td>
                    <td><span style={{ fontSize: '12px', fontWeight: '500', color: parseInt(s.total) > 0 ? '#111827' : '#9ca3af' }}>{s.total}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '5px', background: 'white', cursor: 'pointer' }} onClick={() => openEditSite(s)}>Edit</button>
                        {isSuperAdmin && <button className="btn-danger" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => deleteSite(s.id, s.name || (s as any).site)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* LICENSE TAB */}
      {activeTab === 'license' && (
        <div>
          {/* Status card */}
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>License status</div>
            {!licenseInfo ? (
              <div style={{ color: '#9ca3af', fontSize: '13px' }}>Loading…</div>
            ) : (
              <div>
                {/* Status badge row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                  {licenseInfo.status === 'active' && (
                    <span className="badge badge-active" style={{ fontSize: '13px', padding: '5px 14px' }}>Active</span>
                  )}
                  {licenseInfo.status === 'trial' && licenseInfo.daysRemaining > 5 && (
                    <span className="badge badge-blue" style={{ fontSize: '13px', padding: '5px 14px' }}>Trial — {licenseInfo.daysRemaining} days remaining</span>
                  )}
                  {licenseInfo.status === 'trial' && licenseInfo.daysRemaining <= 5 && (
                    <span className="badge badge-yellow" style={{ fontSize: '13px', padding: '5px 14px' }}>Trial expiring — {licenseInfo.daysRemaining} day{licenseInfo.daysRemaining !== 1 ? 's' : ''} left</span>
                  )}
                  {licenseInfo.status === 'grace' && (
                    <span className="badge badge-orange" style={{ fontSize: '13px', padding: '5px 14px' }}>Grace period</span>
                  )}
                  {licenseInfo.status === 'expired' && (
                    <span className="badge badge-red" style={{ fontSize: '13px', padding: '5px 14px' }}>Expired</span>
                  )}
                </div>

                {/* Trial progress bar */}
                {licenseInfo.status === 'trial' && licenseInfo.installDate && (
                  <div style={{ marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280', marginBottom: '6px' }}>
                      <span>Trial usage</span>
                      <span>{licenseInfo.trialDaysTotal - licenseInfo.daysRemaining} / {licenseInfo.trialDaysTotal} days used</span>
                    </div>
                    <div style={{ height: '8px', background: '#f3f4f6', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: '4px',
                        width: `${Math.min(100, ((licenseInfo.trialDaysTotal - licenseInfo.daysRemaining) / licenseInfo.trialDaysTotal) * 100)}%`,
                        background: licenseInfo.daysRemaining <= 5 ? '#f59e0b' : '#C8102E',
                        transition: 'width 0.3s',
                      }} />
                    </div>
                  </div>
                )}

                {/* Active license details */}
                {licenseInfo.status === 'active' && licenseInfo.customer && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '13px' }}>
                    <div><span style={{ color: '#9ca3af' }}>Customer</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.customer}</div></div>
                    <div><span style={{ color: '#9ca3af' }}>Expires</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.expiry} ({licenseInfo.daysRemaining} days)</div></div>
                    <div><span style={{ color: '#9ca3af' }}>Licensed modules</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.modules.join(', ') || '—'}</div></div>
                    <div><span style={{ color: '#9ca3af' }}>Max devices</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.maxDevices === 0 ? 'Unlimited' : licenseInfo.maxDevices ?? '—'}</div></div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Server ID */}
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Your Server ID</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>Provide this when purchasing a license so the key can be locked to this server.</div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <code style={{ flex: 1, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '7px', padding: '10px 14px', fontFamily: 'monospace', fontSize: '13px', color: '#111827', letterSpacing: '0.02em', userSelect: 'all' }}>
                {licenseInfo?.serverId ?? '—'}
              </code>
              <button
                onClick={copyServerId}
                className="btn-secondary"
                style={{ padding: '10px 16px', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {copiedServerId ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Activate license */}
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Activate license</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>Paste the license key you received after purchase.</div>
            <textarea
              className="input"
              rows={4}
              placeholder="Paste license key here…"
              value={licenseKeyInput}
              onChange={e => setLicenseKeyInput(e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: '12px', resize: 'vertical', marginBottom: '12px' }}
            />
            {licenseActivateMsg && (
              <div style={{
                background: licenseActivateMsg.ok ? '#dcfce7' : '#fee2e2',
                color: licenseActivateMsg.ok ? '#166534' : '#991b1b',
                padding: '10px 14px', borderRadius: '7px', fontSize: '13px', marginBottom: '12px',
              }}>
                {licenseActivateMsg.text}
              </div>
            )}
            <button className="btn-primary" onClick={activateLicense} disabled={activatingLicense}>
              {activatingLicense ? 'Activating…' : 'Activate License'}
            </button>
          </div>

          {/* Support link */}
          <p style={{ fontSize: '13px', color: '#9ca3af' }}>
            Need a license?{' '}
            <a href="mailto:sales@nocvault.com" style={{ color: '#C8102E', textDecoration: 'none' }}>
              Contact sales@nocvault.com
            </a>
          </p>
        </div>
      )}

      {/* UPDATES TAB */}
      {activeTab === 'updates' && (
        <div>
          <div style={{ background: 'white', borderRadius: '10px', border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: '20px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>NetVault version</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '16px' }}>Check GitHub for the latest code and apply updates via Windows Task Scheduler.</div>

            {checkUpdateErr && (
              <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: '7px', fontSize: '13px', marginBottom: '14px' }}>
                {checkUpdateErr}
              </div>
            )}

            {updateStatus?.error && (
              <div style={{ background: '#fff7ed', color: '#92400e', border: '1px solid #fcd34d', padding: '10px 14px', borderRadius: '7px', fontSize: '13px', marginBottom: '14px' }}>
                {updateStatus.error}
              </div>
            )}

            {updateStatus && !updateStatus.error && (
              <div style={{ marginBottom: '16px' }}>
                {updateStatus.up_to_date ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#166534', background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.25)', borderRadius: '7px', padding: '10px 14px', fontSize: '13px', fontWeight: '500', marginBottom: 10 }}>
                      <span>✓</span><span>NetVault is up to date</span>
                    </div>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
                      Version: <code style={{ fontWeight: 600 }}>v{updateStatus.current_version}</code>
                      {updateStatus.current_commit && <> (<code>{updateStatus.current_commit}</code>)</>}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 8px' }}>
                      {updateStatus.current_version === updateStatus.latest_version
                        ? <>🔄 Patches available since v{updateStatus.current_version}</>
                        : <>🔄 Update available: v{updateStatus.current_version} → v{updateStatus.latest_version}</>}
                    </p>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 10px' }}>
                      Current: v{updateStatus.current_version}
                      {updateStatus.current_commit && <> (<code>{updateStatus.current_commit}</code>)</>}
                      {'  →  '}
                      Latest: v{updateStatus.latest_version}
                      {updateStatus.latest_commit && <> (<code>{updateStatus.latest_commit}</code>)</>}
                    </p>
                    {updateStatus.release_notes && updateStatus.release_notes.length > 0 && (
                      <div style={{ marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', background: '#f9fafb' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2744', marginBottom: 8 }}>
                          What's new in v{updateStatus.latest_version}
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: '#374151' }}>
                          {updateStatus.release_notes.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {updateStatus.release_date && (
                      <p style={{ fontSize: 13, color: '#9ca3af', margin: '8px 0 0' }}>
                        Released: {fmtReleaseDate(updateStatus.release_date)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button className="btn-secondary" onClick={() => void checkForUpdates()} disabled={checkingUpdate} style={{ padding: '8px 16px' }}>
                {checkingUpdate ? 'Checking…' : 'Check for updates'}
              </button>
              {updateStatus?.update_available && !updateStatus.error && (
                <button className="btn-primary" onClick={() => setConfirmingUpdate(true)} style={{ padding: '8px 16px' }}>
                  Apply update
                </button>
              )}
            </div>

            {applyUpdateErr && (
              <div style={{ color: '#991b1b', fontSize: '13px', fontWeight: '500', marginTop: '10px' }}>
                {applyUpdateErr}
              </div>
            )}
          </div>
        </div>
      )}

      {confirmingUpdate && <UpdateConfirmModal onCancel={() => setConfirmingUpdate(false)} onConfirm={startUpdate} />}
      {updatingApp && <UpdatingOverlay preVersion={updateStatus?.current_commit || ''} />}

    </div>
  )
}
