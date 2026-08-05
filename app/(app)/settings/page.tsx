'use client'
import { useToast, useConfirm } from '@/app/providers'
import { RoleBadge } from '@/components/Badges'
import { useState, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { STAGE_LABELS } from '@/app/components/UpdateFailureBanner'

// Shape of GET /api/system/last-update-status - written by Update-NetVault.ps1's
// Write-StatusJson on every run (success or failure). The "Update Now" overlay
// below uses this to tell a clean success apart from a silent auto-rollback
// (item 7) instead of just watching /api/health flip up/down/up.
type LastUpdateStatus = {
  exists?: boolean
  success?: boolean
  stage?: string | null
  errorCode?: number
  errorMessage?: string | null
  rolledBack?: boolean
  healthCheckPassed?: boolean
  schemaAppliedButRolledBack?: boolean
}

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
      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: '28px 32px', maxWidth: '400px', width: '90%' }}>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '12px' }}>Start Update?</div>
        <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', marginBottom: '24px' }}>
          Services will restart and you'll lose connection for 30–60 seconds. The page reloads automatically when the update completes.
        </div>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>Cancel</button>
          <button onClick={onConfirm} style={{ padding: '8px 16px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-base)', fontWeight: '600' }}>Start Update</button>
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

// How long to keep retrying GET /api/system/last-update-status once the API
// answers healthy again, before giving up and treating it as a clean success
// (item 7) - covers the gap between Update-NetVault.ps1's own post-health-check
// work (scheduled-task registration, .lastgood cleanup) finishing and it
// actually writing the status file, plus the same gap on a standalone install
// with no updater at all (no status file will EVER appear there).
const CONFIRM_MAX_ATTEMPTS = 6

type Phase = 'starting' | 'down' | 'confirming' | 'back_up' | 'rolled_back' | 'rollback_failed' | 'verify_failed' | 'timeout'

function UpdatingOverlay({ preVersion }: { preVersion: string }) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [countdown, setCountdown] = useState(RELOAD_COUNTDOWN_SECONDS)
  const [lastStatusInfo, setLastStatusInfo] = useState<LastUpdateStatus | null>(null)
  const wentDown = useRef(false)
  const consecutiveUp = useRef(0)
  // Capture the version that was running before the update so we can confirm
  // the code actually changed once services come back up.
  const preVersionRef = useRef(preVersion)
  useEffect(() => { preVersionRef.current = preVersion }, [preVersion])

  // Once the API answers healthy again, find out BEFORE showing any success UI
  // whether this was a clean update or a silent auto-rollback (item 7) - the
  // old code declared "✓ Services are back online" purely from the up/down/up
  // health-poll transition, with no idea whether the service that came back up
  // is running the NEW code or the OLD code that Update-NetVault.ps1's own
  // Invoke-Rollback restored after a failure.
  const confirmOutcome = async (attempt = 0) => {
    let data: LastUpdateStatus | null = null
    try {
      const ctrl = new AbortController()
      const abortId = setTimeout(() => ctrl.abort(), 4000)
      const res = await fetch('/api/system/last-update-status', { cache: 'no-store', signal: ctrl.signal })
      clearTimeout(abortId)
      data = await res.json()
    } catch {
      data = null
    }

    if (data && data.exists) {
      if (data.success === false) {
        // A failed run recorded a result - branch on whether the automatic
        // rollback itself succeeded or ALSO failed, rather than assuming
        // success just because the API is answering again (it may be
        // answering on the REVERTED old version, or - in the "rollback also
        // failed" case - on some unknown/unstable state).
        setLastStatusInfo(data)
        setPhase(data.rolledBack ? 'rolled_back' : 'rollback_failed')
        return
      }
      // success === true (or an older status shape without the field) - a
      // clean update was recorded. Proceed to the normal success flow below,
      // which still independently verifies the commit actually changed.
      setPhase('back_up')
      return
    }

    // No status recorded yet (or the fetch itself failed) - retry briefly to
    // cover the gap between the app answering healthy and the script finishing
    // its post-health-check work, then degrade to the normal success flow
    // rather than blocking forever (a standalone install with no updater has
    // no status file at all, and must not get stuck here permanently).
    if (attempt < CONFIRM_MAX_ATTEMPTS) {
      setTimeout(() => { void confirmOutcome(attempt + 1) }, 2000)
    } else {
      setPhase('back_up')
    }
  }

  // After services recover, confirm the running version actually changed.
  // If it matches the pre-update version, the pull/build silently failed —
  // show an error instead of redirecting with a false success banner. Driven by
  // the countdown effect (and the "Reload Now" button) once the API is back up.
  const verifyAndRedirect = async (attempt = 0) => {
    let fetchOk = false
    let newVersion = ''
    try {
      const ctrl = new AbortController()
      const abortId = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch('/api/system/update-status', { cache: 'no-store', signal: ctrl.signal })
      clearTimeout(abortId)
      const data = await res.json()
      // Compare commit hashes, not the semver version: a patch pushed without
      // a version bump still changes the commit, so the version string alone
      // would falsely report "verify_failed".
      newVersion = data?.current_commit || ''
      fetchOk = true
    } catch {
      // The verify fetch itself failed - most likely the service dropped again
      // right after the 3-consecutive-healthy gate passed. That gate can be
      // satisfied by NSSM briefly auto-restarting the OLD build (a known race -
      // see Update-NetVault.ps1's "already running" note) before the real
      // update has actually replaced it, so "back_up" isn't a hard guarantee
      // the new code is actually serving yet. Previously this assumed "must be
      // up" and reloaded straight into a dead server ("page cannot be
      // reached"). Retry a few times instead of trusting an unverified guess.
    }

    if (fetchOk) {
      if (newVersion) {
        if (preVersionRef.current && newVersion === preVersionRef.current) {
          setPhase('verify_failed')
          return
        }
        window.location.href = '/dashboard?updated=true'
        return
      }
      // fetchOk but newVersion is empty: the request itself succeeded (HTTP 200)
      // but the server-side git rev-parse behind it failed transiently, so
      // current_commit came back null. This is NOT the same as "verified
      // unchanged" - it's inconclusive, and must retry exactly like the
      // network-failure path below rather than falling through to an
      // unconditional redirect (a 200 response with no commit used to be
      // treated as success, reintroducing the same "guessed and reloaded into
      // an unverified state" bug class via a different trigger than the
      // original fetch-exception case).
    }

    if (attempt < 4) {
      setTimeout(() => { void verifyAndRedirect(attempt + 1) }, 2000)
    } else {
      // Still can't confirm after retrying - safer to say so than to guess and
      // risk reloading into a dead page. The user can retry manually once the
      // service has genuinely settled.
      setPhase('timeout')
    }
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
          // Don't jump straight to the green "back_up" success UI (item 7) -
          // confirm via the durable status file first, in case this is a
          // silent auto-rollback rather than a real success. confirmOutcome
          // itself sets 'back_up' once it's satisfied this was clean.
          setPhase('confirming')
          if (pollId !== null) clearInterval(pollId)
          void confirmOutcome()
          // The reload (once phase becomes 'back_up') is driven by the
          // countdown effect below — the API is up, but Next.js needs a
          // little longer before it can serve pages.
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

  const stageLabel = lastStatusInfo?.stage ? (STAGE_LABELS[lastStatusInfo.stage] || lastStatusInfo.stage) : 'an earlier stage'
  const schemaNote = lastStatusInfo?.schemaAppliedButRolledBack
    ? " Note: the database schema was updated as part of this attempt and was NOT reverted — verify it's compatible with the restored code version."
    : ''

  let statusLine = 'Starting update…'
  if (phase === 'down') statusLine = 'Services restarting…'
  else if (phase === 'confirming') statusLine = 'Services are responding — confirming the update actually applied…'
  else if (phase === 'back_up') statusLine = `✓ Services are back online. Reloading in ${countdown} second${countdown === 1 ? '' : 's'}…`
  else if (phase === 'rolled_back') statusLine = `The update failed at ${stageLabel} and was automatically rolled back — NetVault is running normally on the previous version.${schemaNote}`
  else if (phase === 'rollback_failed') statusLine = `CRITICAL: The update failed at ${stageLabel} and the automatic rollback ALSO failed — NetVault may be DOWN or unstable.${schemaNote} Do not rely on an automatic reload; manual intervention may be required.`
  else if (phase === 'verify_failed') statusLine = 'Services restarted, but the version did not change. The update may not have applied — try again or check the server logs.'
  else if (phase === 'timeout') statusLine = 'Update is taking longer than expected. Try refreshing the page manually.'

  const isError = phase === 'timeout' || phase === 'verify_failed'
  const isRolledBack = phase === 'rolled_back'
  const isRollbackFailed = phase === 'rollback_failed'
  // Neither of the rollback outcomes reloads automatically or on its own
  // countdown (item 7) - 'rollback_failed' in particular must never guess that
  // reloading is safe, since the server may genuinely be down; both offer only
  // the manual "Reload Now" button below.
  const showSpinner = phase !== 'back_up' && !isError && !isRolledBack && !isRollbackFailed

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15,23,42,0.78)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', boxShadow: '0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.04)', padding: 28, maxWidth: 440, width: '100%', textAlign: 'center', border: isRollbackFailed ? '2px solid #7f1d1d' : undefined }}>
        {showSpinner && (
          <div style={{ fontSize: 44, lineHeight: 1, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</div>
        )}
        {phase === 'back_up' && <div style={{ fontSize: 44, lineHeight: 1 }}>✓</div>}
        {isRolledBack && <div style={{ fontSize: 44, lineHeight: 1, color: '#b45309' }}>⚠</div>}
        {isRollbackFailed && <div style={{ fontSize: 52, lineHeight: 1, color: '#7f1d1d' }}>⛔</div>}
        {isError && <div style={{ fontSize: 44, lineHeight: 1 }}>⚠</div>}
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginTop: 14 }}>Updating NetVault…</div>
        <p style={{ color: 'var(--text-muted)', marginTop: 6 }}>Pulling latest code and restarting services. Do not close this window.</p>
        <p style={{
          fontWeight: isRollbackFailed ? 800 : 600,
          fontSize: isRollbackFailed ? 'var(--text-lg)' : undefined,
          color: isRollbackFailed ? '#7f1d1d' : isRolledBack ? '#b45309' : undefined,
          margin: '14px 0',
        }}>{statusLine}</p>
        {phase === 'back_up' && (
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, margin: '4px 0 10px', color: 'var(--primary, #C8102E)' }}>
            {countdown}
          </div>
        )}
        {phase !== 'back_up' && !isRolledBack && !isRollbackFailed && (
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>(This usually takes 1-3 minutes)</p>
        )}
        <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={phase === 'back_up' ? () => { void verifyAndRedirect() } : () => window.location.reload()}>Reload Now</button>
      </div>
    </div>
  )
}

type User = { id: number; name: string; email: string; role: string; created_at: string; sites?: { id: number; name: string; code: string }[]; apps?: string[] }
// Per-user app access (netvault 1.23.0). NetVault is always accessible; an empty/absent
// `apps` list means "all apps" (default). The form always sends 'netvault' + checked apps.
const APP_OPTIONS: { slug: string; label: string }[] = [
  { slug: 'netvault', label: 'NetVault' },
  { slug: 'logvault', label: 'LogVault' },
  { slug: 'ddivault', label: 'DDIVault' },
  { slug: 'spanvault', label: 'SpanVault' },
]
const ALL_SLUGS = APP_OPTIONS.map(a => a.slug)
const APP_LABEL: Record<string, string> = Object.fromEntries(APP_OPTIONS.map(a => [a.slug, a.label]))
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

  const [activeTab, setActiveTab] = useState<'general'|'users'|'sites'|'license'|'updates'|'about'>('general')

  // Deep-link support: the suite apps' "Manage License" link points at
  // /settings/license (which redirects here as ?tab=license). Honour ?tab=<name>
  // on load so the correct tab opens instead of the default.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t && ['general', 'users', 'sites', 'license', 'updates', 'about'].includes(t)) {
      setActiveTab(t as 'general' | 'users' | 'sites' | 'license' | 'updates' | 'about')
    }
  }, [])
  const [loadingSettings, setLoadingSettings] = useState(true)

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
  const [userForm, setUserForm] = useState({ name: '', email: '', password: '', role: 'viewer', site_ids: [] as number[], app_slugs: [...ALL_SLUGS] as string[] })
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
    setLoadingSettings(false)
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
      if (res.status === 409) {
        // Item 6: another update is already running (a manual console run, or
        // a double-click before this button disabled) - do NOT show the
        // updating overlay for a run that never actually started.
        const data = await res.json().catch(() => ({}))
        setApplyUpdateErr(data.error || 'An update is already in progress. Please wait for it to finish.')
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

  function openAddUser() { setUserForm({ name: '', email: '', password: '', role: 'viewer', site_ids: [], app_slugs: [...ALL_SLUGS] }); setEditUser(null); setShowUserForm(true); setUserError('') }
  function openEditUser(u: User) {
    // Empty/absent apps = all apps (default); otherwise the stored set (netvault always in).
    const appInit = (u.apps && u.apps.length > 0)
      ? Array.from(new Set(['netvault', ...u.apps.filter(s => ALL_SLUGS.includes(s))]))
      : [...ALL_SLUGS]
    setUserForm({ name: u.name, email: u.email, password: '', role: u.role, site_ids: (u as any).sites?.map((s: any) => s.id) || [], app_slugs: appInit })
    setEditUser(u); setShowUserForm(true); setUserError('')
  }

  async function saveUser() {
    if (!userForm.name || !userForm.email) { setUserError('Name and email required'); return }
    if (!editUser && !userForm.password) { setUserError('Password required for new users'); return }
    setSavingUser(true); setUserError('')
    // super_admin always gets all apps; everyone else = netvault + their checked apps.
    const app_slugs = userForm.role === 'super_admin'
      ? [...ALL_SLUGS]
      : Array.from(new Set(['netvault', ...userForm.app_slugs.filter(s => ALL_SLUGS.includes(s))]))
    const res = await fetch(editUser ? `/api/users/${editUser.id}` : '/api/users', {
      method: editUser ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...userForm, app_slugs })
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

  async function copyServerId() {
    const id = licenseInfo?.serverId
    if (!id) return
    // navigator.clipboard is undefined in an insecure context (HTTP over an IP,
    // which is how this is served) — guard on it and fall back to execCommand,
    // otherwise the copy silently throws and nothing happens.
    let ok = false
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(id)
        ok = true
      } else {
        const ta = document.createElement('textarea')
        ta.value = id
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      }
    } catch {
      ok = false
    }
    if (ok) {
      setCopiedServerId(true)
      setTimeout(() => setCopiedServerId(false), 2000)
      showToast('Server ID copied')
    } else {
      showToast('Could not copy — select the Server ID and copy manually', 'error')
    }
  }

  if (loadingSettings) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>

  const filteredSites = sites.filter(s =>
    !siteSearch || s.name?.toLowerCase().includes(siteSearch.toLowerCase()) || s.country?.toLowerCase().includes(siteSearch.toLowerCase())
  )

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>Settings</h1>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '2px 0 0' }}>Manage users, sites and licensing</p>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '24px', flexWrap: 'wrap' }}>
        {(['general', 'users', 'sites', 'license', 'eol', 'updates', 'about'] as const)
          .filter(tab => tab !== 'general' || isAdmin)
          .filter(tab => tab !== 'license' || isSuperAdmin)
          // EOL Intelligence is an admin curation surface — super_admin only.
          .filter(tab => tab !== 'eol' || isSuperAdmin)
          .filter(tab => tab !== 'updates' || isAdmin)
          .map(tab => (
          <button key={tab} onClick={() => { if (tab === 'eol') { router.push('/settings/eol-intelligence') } else { setActiveTab(tab as typeof activeTab) } }} style={{ padding: '10px 18px', fontSize: 'var(--text-md)', fontWeight: activeTab === tab ? '600' : '400', color: activeTab === tab ? 'var(--primary)' : 'var(--text-muted)', background: 'none', border: 'none', borderBottom: activeTab === tab ? '2px solid var(--primary)' : '2px solid transparent', cursor: 'pointer', marginBottom: '-1px', textTransform: 'capitalize' }}>
            {tab === 'general' ? 'General' : tab === 'users' ? `Users (${users.length})` : tab === 'sites' ? `Sites (${sites.length})` : tab === 'eol' ? 'EOL Intelligence' : tab === 'updates' ? 'Updates' : tab === 'about' ? 'About' : 'License'}
            {tab === 'updates' && updateStatus?.update_available && (
              <span title="Update available" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%' /* intentional: update-available status dot — squaring it would look broken */, background: '#dc2626', marginLeft: 6, verticalAlign: 'middle' }} />
            )}
          </button>
        ))}
      </div>

      {/* USERS TAB */}
      {activeTab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', margin: 0 }}>Manage who can access this system</p>
            <button className="btn-primary" onClick={openAddUser}>+ Add user</button>
          </div>
          {showUserForm && (
            <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '16px' }}>
              <h3 style={{ fontSize: 'var(--text-md)', fontWeight: '600', marginBottom: '16px' }}>{editUser ? 'Edit user' : 'Add new user'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                {[
                  { label: 'Full name', field: 'name', type: 'text', placeholder: 'e.g. John Smith' },
                  { label: 'Email address', field: 'email', type: 'email', placeholder: 'john@company.com' },
                  { label: editUser ? 'New password (leave blank to keep)' : 'Password', field: 'password', type: 'password', placeholder: '••••••••' },
                ].map(f => (
                  <div key={f.field}>
                    <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>{f.label}</label>
                    <input className="input" type={f.type} placeholder={f.placeholder} value={String(userForm[f.field as keyof typeof userForm] ?? '')} onChange={e => setUserForm(p => ({ ...p, [f.field]: e.target.value }))} />
                  </div>
                ))}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Role</label>
                  <select className="input select" value={userForm.role} onChange={e => setUserForm(p => ({ ...p, role: e.target.value, site_ids: [] }))}>
                    <option value="viewer">Viewer — read only, all sites</option>
                    <option value="site_admin">Site Admin — full edit, assigned sites only</option>
                    {isSuperAdmin && <option value="super_admin">Super Admin — full access including user management and deletes</option>}
                    <option value="admin">Admin — full access, all sites</option>
                  </select>
                </div>
                {userForm.role === 'site_admin' && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                      Assigned sites <span style={{ color: 'var(--primary)' }}>*</span>
                      <span style={{ fontWeight: '400', color: 'var(--text-muted)', marginLeft: '6px' }}>({userForm.site_ids.length} selected)</span>
                    </label>
                    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', maxHeight: '200px', overflowY: 'auto', padding: '8px' }}>
                      {sites.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', padding: '8px' }}>Loading sites...</div>
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
                            <div style={{ fontSize: 'var(--text-xs)', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 6px' }}>{country}</div>
                            {countrySites.map((s: any) => (
                              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: userForm.site_ids.includes(s.id) ? 'var(--tint-danger)' : 'transparent' }}>
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
                                <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{s.site || s.name}</span>
                                {s.code && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{s.code}</span>}
                              </label>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                      <button type="button" style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => setUserForm(p => ({ ...p, site_ids: sites.map((s: any) => s.id) }))}>
                        Select all
                      </button>
                      <span style={{ color: 'var(--text-muted)' }}>·</span>
                      <button type="button" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => setUserForm(p => ({ ...p, site_ids: [] }))}>
                        Clear all
                      </button>
                    </div>
                  </div>
                )}
                {/* App access — which suite apps this user can open (NetVault always on). */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                    App access
                    {userForm.role === 'super_admin' && <span style={{ fontWeight: '400', color: 'var(--text-muted)', marginLeft: '6px' }}>— super admins can access all apps</span>}
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {APP_OPTIONS.map(app => {
                      const locked = app.slug === 'netvault' || userForm.role === 'super_admin'
                      const checked = userForm.role === 'super_admin' || userForm.app_slugs.includes(app.slug)
                      return (
                        <label key={app.slug} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: checked ? 'var(--tint-danger)' : 'var(--bg-card)', cursor: locked ? 'default' : 'pointer', opacity: locked && !checked ? 0.6 : 1 }}>
                          <input type="checkbox" checked={checked} disabled={locked}
                            onChange={e => {
                              const slug = app.slug
                              setUserForm(p => ({
                                ...p,
                                app_slugs: e.target.checked
                                  ? Array.from(new Set([...p.app_slugs, slug]))
                                  : p.app_slugs.filter(s => s !== slug)
                              }))
                            }}
                          />
                          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{app.label}</span>
                        </label>
                      )
                    })}
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '6px' }}>NetVault is always accessible. Unchecked apps are hidden from the launcher and blocked at login.</div>
                </div>
              </div>
              {userError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{userError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={saveUser} disabled={savingUser}>{savingUser ? 'Saving...' : editUser ? 'Save changes' : 'Create user'}</button>
                <button className="btn-secondary" onClick={() => setShowUserForm(false)}>Cancel</button>
              </div>
            </div>
          )}
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Site access</th><th>App access</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{u.name}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                    <td>
                      <RoleBadge role={u.role} />
                    </td>
                    <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', maxWidth: '200px' }}>
                      {u.role === 'site_admin' && u.sites && u.sites.length > 0
                        ? u.sites.map((s: any) => s.name || s.code).join(', ')
                        : u.role === 'site_admin' ? <span style={{ color: 'var(--yellow)' }}>No sites assigned</span>
                        : <span style={{ color: 'var(--text-muted)' }}>All sites</span>}
                    </td>
                    <td style={{ fontSize: 'var(--text-sm)', maxWidth: '220px' }}>
                      {(u.role === 'super_admin' || !u.apps || u.apps.length === 0 || u.apps.length >= ALL_SLUGS.length)
                        ? <span style={{ color: 'var(--text-muted)' }}>All apps</span>
                        : <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '4px' }}>
                            {Array.from(new Set(['netvault', ...u.apps.filter(s => ALL_SLUGS.includes(s))])).map(s => (
                              <span key={s} style={{ fontSize: 'var(--text-xs)', padding: '1px 7px', borderRadius: 'var(--radius-pill)', background: 'var(--surface-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{APP_LABEL[s] || s}</span>
                            ))}
                          </span>}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {(isSuperAdmin || u.role !== 'super_admin') && <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => openEditUser(u)}>Edit</button>}
                        {isSuperAdmin && <button className="btn-danger" style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }} onClick={() => deleteUser(u.id, u.name)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* GENERAL TAB */}
      {activeTab === 'general' && (
        <div>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px', maxWidth: '860px' }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Session security</div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '6px' }}>Session timeout</label>
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
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Users will be automatically logged out after this period of inactivity. Applies to all apps in the NocVault suite.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button className="btn-primary" onClick={saveSecuritySettings} disabled={savingSecuritySettings} style={{ padding: '10px 24px' }}>
                {savingSecuritySettings ? 'Saving...' : 'Save settings'}
              </button>
              {securitySettingsSaved && <span style={{ fontSize: 'var(--text-base)', color: 'var(--tint-success-fg)', background: 'var(--tint-success)', padding: '6px 12px', borderRadius: 'var(--radius-sm)' }}>Saved!</span>}
            </div>
          </div>
        </div>
      )}

      {/* SITES TAB */}
      {activeTab === 'sites' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <input className="input input-md" placeholder="Search sites or countries..." value={siteSearch} onChange={e => setSiteSearch(e.target.value)} />
            <button className="btn-primary" onClick={() => { setShowSiteForm(true); setSiteError('') }}>+ Add site</button>
          </div>

          {showSiteForm && (
            <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '16px' }}>
              <h3 style={{ fontSize: 'var(--text-md)', fontWeight: '600', marginBottom: '16px' }}>Add new site</h3>
              <div className="form-grid-compact" style={{ marginBottom: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Site name <span style={{ color: 'var(--primary)' }}>*</span></label>
                  <input className="input" placeholder="e.g. Bangkok Office" value={siteForm.name} onChange={e => setSiteForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Site code</label>
                  <input className="input input-sm" placeholder="e.g. BKK-01" value={siteForm.code} onChange={e => setSiteForm(f => ({ ...f, code: e.target.value }))} />
                </div>
                <div style={{ flexBasis: '100%' }}>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Country <span style={{ color: 'var(--primary)' }}>*</span></label>
                  <select className="input select" value={siteForm.country_id} onChange={e => setSiteForm(f => ({ ...f, country_id: e.target.value }))}>
                    <option value="">Select country</option>
                    {countries.map(c => <option key={c.id} value={c.id}>{c.name} — {c.region}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Site type</label>
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
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>City</label>
                  <input className="input" placeholder="e.g. Bangkok" value={siteForm.city} onChange={e => setSiteForm(f => ({ ...f, city: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Postal code</label>
                  <input className="input input-sm" placeholder="e.g. 10110" value={siteForm.postal_code} onChange={e => setSiteForm(f => ({ ...f, postal_code: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>GPS coordinates</label>
                  <input className="input input-sm" placeholder="e.g. 13.7563, 100.5018" value={siteForm.coordinates} onChange={e => setSiteForm(f => ({ ...f, coordinates: e.target.value }))} />
                </div>
                <div style={{ flexBasis: '100%' }}>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Address</label>
                  <textarea className="input" rows={2} placeholder="Full street address" value={siteForm.address} onChange={e => setSiteForm(f => ({ ...f, address: e.target.value }))} style={{ resize: 'vertical' }} />
                </div>
                <div style={{ borderTop: '1px solid var(--border-light)', flexBasis: '100%', paddingTop: '12px', marginTop: '4px' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '12px' }}>Site contact</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Contact name</label>
                  <input className="input" placeholder="e.g. John Smith" value={siteForm.contact_name} onChange={e => setSiteForm(f => ({ ...f, contact_name: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Contact email</label>
                  <input className="input" type="email" placeholder="e.g. john@company.com" value={siteForm.contact_email} onChange={e => setSiteForm(f => ({ ...f, contact_email: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Phone</label>
                  <input className="input input-sm" placeholder="e.g. +66 2 123 4567" value={siteForm.phone} onChange={e => setSiteForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
              </div>
              {siteError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{siteError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={addSite} disabled={savingSite}>{savingSite ? 'Saving...' : 'Add site'}</button>
                <button className="btn-secondary" onClick={() => setShowSiteForm(false)}>Cancel</button>
              </div>
            </div>
          )}

          {editSite && (
            <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '16px' }}>
              <h3 style={{ fontSize: 'var(--text-md)', fontWeight: '600', marginBottom: '16px' }}>Edit site — {editSite.name || (editSite as any).site}</h3>
              <div className="form-grid-compact" style={{ marginBottom: '16px' }}>
                {[
                  { label: 'Site name *', field: 'name', placeholder: 'e.g. Bangkok Office' },
                  { label: 'Site code', field: 'code', placeholder: 'e.g. BKK-01', short: true },
                  { label: 'City', field: 'city', placeholder: 'e.g. Bangkok' },
                  { label: 'Postal code', field: 'postal_code', placeholder: 'e.g. 10110', short: true },
                  { label: 'GPS coordinates', field: 'coordinates', placeholder: 'e.g. 13.7563, 100.5018', short: true },
                  { label: 'Phone', field: 'phone', placeholder: 'e.g. +66 2 123 4567', short: true },
                  { label: 'Contact name', field: 'contact_name', placeholder: 'e.g. John Smith' },
                  { label: 'Contact email', field: 'contact_email', placeholder: 'e.g. john@company.com' },
                ].map(f => (
                  <div key={f.field}>
                    <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>{f.label}</label>
                    <input className={(f as { short?: boolean }).short ? 'input input-sm' : 'input'} placeholder={f.placeholder}
                      value={editSiteForm[f.field as keyof typeof editSiteForm]}
                      onChange={e => setEditSiteForm(p => ({ ...p, [f.field]: e.target.value }))} />
                  </div>
                ))}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Site type</label>
                  <select className="input select" value={editSiteForm.site_type} onChange={e => setEditSiteForm(p => ({ ...p, site_type: e.target.value }))}>
                    <option value="">Select type</option>
                    {['Head Office','Factory','Warehouse','Branch Office','Data Center','Cloud','Other'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div style={{ flexBasis: '100%' }}>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Address</label>
                  <textarea className="input" rows={2} placeholder="Full street address"
                    value={editSiteForm.address}
                    onChange={e => setEditSiteForm(p => ({ ...p, address: e.target.value }))}
                    style={{ resize: 'vertical' }} />
                </div>
              </div>
              {editSiteError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{editSiteError}</div>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={saveEditSite} disabled={savingEditSite}>{savingEditSite ? 'Saving...' : 'Save changes'}</button>
                <button className="btn-secondary" onClick={() => setEditSite(null)}>Cancel</button>
              </div>
            </div>
          )}

          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
            <table>
              <thead><tr><th>Site name</th><th>Code</th><th>Country</th><th>Region</th><th>Devices</th><th>Actions</th></tr></thead>
              <tbody>
                {filteredSites.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{s.site || s.name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{s.code || '—'}</td>
                    <td>{s.country}</td>
                    <td><span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{s.region}</span></td>
                    <td><span style={{ fontSize: 'var(--text-sm)', fontWeight: '500', color: parseInt(s.total) > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{s.total}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button style={{ padding: '4px 10px', fontSize: 'var(--text-sm)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => openEditSite(s)}>Edit</button>
                        {isSuperAdmin && <button className="btn-danger" style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }} onClick={() => deleteSite(s.id, s.name || (s as any).site)}>Delete</button>}
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
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px' }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>License status</div>
            {!licenseInfo ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>Loading…</div>
            ) : (
              <div>
                {/* Status badge row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                  {licenseInfo.status === 'active' && (
                    <span className="badge badge-active" style={{ fontSize: 'var(--text-base)', padding: '5px 14px' }}>Active</span>
                  )}
                  {licenseInfo.status === 'trial' && licenseInfo.daysRemaining > 5 && (
                    <span className="badge badge-blue" style={{ fontSize: 'var(--text-base)', padding: '5px 14px' }}>Trial — {licenseInfo.daysRemaining} days remaining</span>
                  )}
                  {licenseInfo.status === 'trial' && licenseInfo.daysRemaining <= 5 && (
                    <span className="badge badge-yellow" style={{ fontSize: 'var(--text-base)', padding: '5px 14px' }}>Trial expiring — {licenseInfo.daysRemaining} day{licenseInfo.daysRemaining !== 1 ? 's' : ''} left</span>
                  )}
                  {licenseInfo.status === 'grace' && (
                    <span className="badge badge-orange" style={{ fontSize: 'var(--text-base)', padding: '5px 14px' }}>Grace period</span>
                  )}
                  {licenseInfo.status === 'expired' && (
                    <span className="badge badge-red" style={{ fontSize: 'var(--text-base)', padding: '5px 14px' }}>Expired</span>
                  )}
                </div>

                {/* Trial progress bar */}
                {licenseInfo.status === 'trial' && licenseInfo.installDate && (
                  <div style={{ marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      <span>Trial usage</span>
                      <span>{licenseInfo.trialDaysTotal - licenseInfo.daysRemaining} / {licenseInfo.trialDaysTotal} days used</span>
                    </div>
                    <div style={{ height: '8px', background: 'var(--surface-subtle)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 'var(--radius-pill)',
                        width: `${Math.min(100, ((licenseInfo.trialDaysTotal - licenseInfo.daysRemaining) / licenseInfo.trialDaysTotal) * 100)}%`,
                        background: licenseInfo.daysRemaining <= 5 ? 'var(--yellow)' : 'var(--primary)',
                        transition: 'width 0.3s',
                      }} />
                    </div>
                  </div>
                )}

                {/* Active license details */}
                {licenseInfo.status === 'active' && licenseInfo.customer && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: 'var(--text-base)' }}>
                    <div><span style={{ color: 'var(--text-muted)' }}>Customer</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.customer}</div></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Expires</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.expiry} ({licenseInfo.daysRemaining} days)</div></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Licensed modules</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.modules.join(', ') || '—'}</div></div>
                    <div><span style={{ color: 'var(--text-muted)' }}>Max devices</span><div style={{ fontWeight: '600', marginTop: '2px' }}>{licenseInfo.maxDevices === 0 ? 'Unlimited' : licenseInfo.maxDevices ?? '—'}</div></div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Server ID */}
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px' }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Your Server ID</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '12px' }}>Provide this when purchasing a license so the key can be locked to this server.</div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <code style={{ flex: 1, background: 'var(--surface-subtle)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)', color: 'var(--text-primary)', letterSpacing: '0.02em', userSelect: 'all' }}>
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
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px' }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Activate license</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '12px' }}>Paste the license key you received after purchase.</div>
            <textarea
              className="input"
              rows={4}
              placeholder="Paste license key here…"
              value={licenseKeyInput}
              onChange={e => setLicenseKeyInput(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', resize: 'vertical', marginBottom: '12px' }}
            />
            {licenseActivateMsg && (
              <div style={{
                background: licenseActivateMsg.ok ? 'var(--tint-success)' : 'var(--tint-danger)',
                color: licenseActivateMsg.ok ? 'var(--tint-success-fg)' : 'var(--tint-danger-fg)',
                padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px',
              }}>
                {licenseActivateMsg.text}
              </div>
            )}
            <button className="btn-primary" onClick={activateLicense} disabled={activatingLicense}>
              {activatingLicense ? 'Activating…' : 'Activate License'}
            </button>
          </div>

          {/* Support link */}
          <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
            Need a license?{' '}
            <a href="mailto:sales@nocvault.com" style={{ color: 'var(--primary)', textDecoration: 'none' }}>
              Contact sales@nocvault.com
            </a>
          </p>
        </div>
      )}

      {/* UPDATES TAB */}
      {activeTab === 'updates' && (
        <div>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px' }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Software Updates</div>

            {checkUpdateErr && (
              <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '14px' }}>
                {checkUpdateErr}
              </div>
            )}

            {updateStatus?.error && (
              <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', border: '1px solid var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '14px' }}>
                {updateStatus.error}
              </div>
            )}

            {updateStatus && !updateStatus.error && (
              <div style={{ marginBottom: '16px' }}>
                {updateStatus.up_to_date ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--tint-success-fg)', background: 'var(--tint-success)', border: '1px solid var(--tint-success-fg)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', fontSize: 'var(--text-base)', fontWeight: '500', marginBottom: 10 }}>
                      <span>✓</span><span>NetVault is up to date</span>
                    </div>
                    <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', margin: 0 }}>
                      Current version: <code style={{ fontWeight: 600 }}>v{updateStatus.current_version}</code>
                      {updateStatus.current_commit && <> (<code>{updateStatus.current_commit}</code>)</>}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontWeight: 700, fontSize: 'var(--text-lg)', margin: '0 0 8px' }}>
                      {updateStatus.current_version === updateStatus.latest_version
                        ? <>🔄 Patches available since v{updateStatus.current_version}</>
                        : <>🔄 Update available: v{updateStatus.current_version} → v{updateStatus.latest_version}</>}
                    </p>
                    <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                      Current: v{updateStatus.current_version}
                      {updateStatus.current_commit && <> (<code>{updateStatus.current_commit}</code>)</>}
                      {'  →  '}
                      Latest: v{updateStatus.latest_version}
                      {updateStatus.latest_commit && <> (<code>{updateStatus.latest_commit}</code>)</>}
                    </p>
                    {updateStatus.release_notes && updateStatus.release_notes.length > 0 && (
                      <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px', background: 'var(--surface-subtle)' }}>
                        <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
                          What's new in v{updateStatus.latest_version}
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                          {updateStatus.release_notes.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {updateStatus.release_date && (
                      <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '8px 0 0' }}>
                        Released: {fmtReleaseDate(updateStatus.release_date)}
                      </p>
                    )}
                    <p style={{ fontSize: 'var(--text-base)', color: 'var(--tint-warn-fg)', margin: '10px 0 0' }}>
                      ⚠ Services will restart during the update — you may lose connection for 30–60 seconds.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button className="btn-secondary" onClick={() => void checkForUpdates()} disabled={checkingUpdate} style={{ padding: '8px 16px' }}>
                {checkingUpdate ? 'Checking…' : 'Check for Updates'}
              </button>
              {updateStatus?.update_available && !updateStatus.error && (
                <button className="btn-primary" onClick={() => setConfirmingUpdate(true)} style={{ padding: '8px 16px' }}>
                  Update Now
                </button>
              )}
            </div>

            {applyUpdateErr && (
              /license|expire/i.test(applyUpdateErr) ? (
                <div style={{ background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)', border: '1px solid var(--tint-warn-fg)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginTop: '10px' }}>
                  ⚠ License expired — updates disabled. Renew your license to receive updates.{' '}
                  <a href={`${process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || ''}/settings/license`} style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>Manage License →</a>
                </div>
              ) : (
                <div style={{ color: 'var(--tint-danger-fg)', fontSize: 'var(--text-base)', fontWeight: '500', marginTop: '10px' }}>
                  {applyUpdateErr}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* ABOUT TAB */}
      {activeTab === 'about' && (
        <div>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px' }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>About</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <tbody>
                {[
                  { label: 'Product', value: 'NetVault — IT Asset Management' },
                  { label: 'Family', value: 'NocVault Network Intelligence Suite' },
                  { label: 'Version', value: `v${updateStatus?.current_version || '1.0.0'}` },
                  { label: 'App Port', value: '3000' },
                  { label: 'Database', value: 'PostgreSQL 16' },
                  { label: 'Runtime', value: 'Node.js 20 · Next.js 16' },
                ].map(row => (
                  <tr key={row.label} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ padding: '8px 0', color: 'var(--text-muted)', width: '180px', verticalAlign: 'top' }}>{row.label}</td>
                    <td style={{ padding: '8px 0', color: 'var(--text-primary)', fontWeight: 500 }}>{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', padding: '20px', marginBottom: '20px' }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: '700', color: 'var(--text-primary)' }}>NetVault v{updateStatus?.current_version || '1.0.0'}</div>
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', marginTop: '4px' }}>Part of the NocVault Network Intelligence Suite</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '8px' }}>© 2026 NocVault</div>
          </div>
        </div>
      )}

      {confirmingUpdate && <UpdateConfirmModal onCancel={() => setConfirmingUpdate(false)} onConfirm={startUpdate} />}
      {updatingApp && <UpdatingOverlay preVersion={updateStatus?.current_commit || ''} />}

    </div>
  )
}
