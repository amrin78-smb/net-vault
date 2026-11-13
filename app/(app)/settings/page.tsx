'use client'
import { useToast, useConfirm } from '@/app/providers'
import { Dialog, Icon, PageHead } from '@/components/system'
import { RoleBadge } from '@/components/Badges'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { STAGE_LABELS } from '@/app/components/UpdateFailureBanner'
import { useEscape } from '@/components/ui'
import MfaCard from './MfaCard'
// The Entra-SSO-and-HTTPS panels (1.55.0) live in components/settings/ rather
// than in this file. This file is already ~1,600 lines and the three panels
// carry their own fetches, their own two confirmation flows and a shared set of
// module-top-level sub-components; inlining them would have doubled it and put
// the one rule those panels must not break — never declare a component inside
// another — right next to a file with several of them nested at the top.
// They render here, so they appear in the Settings navigation like every other
// section, and nothing else in this file had to move.
import ConsoleAddressPanel from '@/components/settings/ConsoleAddressPanel'
import CertificatePanel from '@/components/settings/CertificatePanel'
import TransportPanel from '@/components/settings/TransportPanel'
import SingleSignOnPanel from '@/components/settings/SingleSignOnPanel'
// The Notifications panel below is declared in THIS file, so it borrows the
// same card/callout chrome those panels use rather than inventing a second
// look for the same kind of surface.
import { Callout, PanelCard, PanelLoading, StatePill } from '@/components/settings/panelChrome'

/**
 * Shell for the Add/Edit site dialogs.
 *
 * These used to be inline panels rendered ABOVE the sites table. With 52 sites
 * that meant clicking Edit on a row near the bottom opened a form off-screen —
 * you had to scroll up to find it, and again to get back to where you were.
 *
 * A centred modal rather than a slide-in drawer, deliberately: `.modal-overlay`,
 * the backdrop-click/stopPropagation shape and `useEscape` are already this
 * app's convention (see the agents page, which uses it twice). A drawer would
 * be a one-off pattern here for no gain — this is a focused edit on a single
 * record, then straight back to the list, which is what a modal is for.
 *
 * Defined at module top level, NOT inside SettingsPage: a component declared
 * inside another remounts on every render, which would drop focus out of these
 * inputs on every keystroke.
 */
function SiteDialog({ title, subtitle, onClose, children, footer }: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}) {
  useEscape(onClose)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          background: 'var(--bg-card)', borderRadius: 'var(--radius)', width: '100%',
          maxWidth: 760, boxShadow: 'var(--shadow-lg)', maxHeight: '90vh',
          display: 'flex', flexDirection: 'column', margin: '0 16px',
        }}
      >
        <div style={{
          padding: '20px 24px 16px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{title}</h2>
            {subtitle && (
              <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: '4px 0 0' }}>{subtitle}</p>
            )}
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close" title="Close (Esc)"
            style={{ fontSize: 'var(--text-lg)', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            ×
          </button>
        </div>
        {/* Only the BODY scrolls — the header and the action buttons stay put, so
            "Save" is reachable without scrolling however long the form gets. */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {children}
        </div>
        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border-light)',
          display: 'flex', gap: '8px', flexShrink: 0,
        }}>
          {footer}
        </div>
      </div>
    </div>
  )
}

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
  else if (phase === 'back_up') statusLine = `Services are back online. Reloading in ${countdown} second${countdown === 1 ? '' : 's'}…`
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
          <div style={{ display: 'inline-flex', color: 'var(--primary)', animation: 'spin 1s linear infinite' }} aria-hidden><Icon.refresh size={44} /></div>
        )}
        {phase === 'back_up' && <div style={{ display: 'inline-flex', color: 'var(--status-success)' }} aria-hidden><Icon.check size={44} /></div>}
        {isRolledBack && <div style={{ display: 'inline-flex', color: 'var(--status-warn)' }} aria-hidden><Icon.alert size={44} /></div>}
        {isRollbackFailed && <div style={{ display: 'inline-flex', color: 'var(--status-danger)' }} aria-hidden><Icon.alert size={52} /></div>}
        {isError && <div style={{ display: 'inline-flex', color: 'var(--status-danger)' }} aria-hidden><Icon.alert size={44} /></div>}
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

type User = { id: number; name: string; email: string; role: string; created_at: string; sites?: { id: number; name: string; code: string }[]; apps?: string[]; auth_provider?: string }

// A row whose identity comes from the directory, not from this product.
// ⛔ Absent means 'local' (every account that existed before Entra), and an
// UNRECOGNISED value counts as a directory account — the same fail-closed call
// lib/directoryUser.ts's isDirectoryAccount makes. Do not infer this from the
// shape of any other field.
function isDirectoryUser(u: { auth_provider?: string } | null | undefined): boolean {
  return (u?.auth_provider || 'local') !== 'local'
}
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

/**
 * Every section this page can show.
 *
 * ⛔ ONE DECLARATION, because the list is repeated three times below (the state
 * type, the ?tab= allow-list and the cast that follows it) and a section added
 * to two of the three is reachable by URL but has no button, or has a button
 * that the deep-link guard then refuses. `console` and `certificate` are
 * admin+; `sso` is super_admin ONLY — see the filters on the nav below, which
 * are the same shape as the existing license/updates ones. `notifications` is
 * super_admin ONLY for the same reason `sso` is: it holds a credential the
 * whole suite sends mail with.
 */
type SettingsTab =
  'general' | 'console' | 'certificate' | 'https' | 'notifications' | 'sso' | 'users' | 'sites' | 'security' | 'license' | 'updates' | 'about'
const ADMIN_TABS: SettingsTab[] =
  ['general', 'console', 'certificate', 'https', 'notifications', 'sso', 'users', 'sites', 'security', 'license', 'updates', 'about']

// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — the one SMTP transport the whole suite sends through
// ══════════════════════════════════════════════════════════════════════════
//
// NetVault is the hub, so it owns the TRANSPORT (host, port, TLS, credential)
// and each satellite keeps its own From identity, recipients and alert
// filters. That split is the whole design, and the copy below has to say it
// plainly or an administrator will reasonably expect filling this one form to
// move LogVault's recipient list here too. See
// docs/nocvault-smtp-centralization-plan.md §3.
//
// ⛔ EVERY COMPONENT HERE IS AT MODULE TOP LEVEL. A component declared inside
// another is a new component type on every render, so React remounts the tree
// and the box being typed into loses focus on every keystroke. This panel is
// almost entirely text inputs — there is nowhere for that bug to hide.
//
// ⛔ NO HARDCODED HEX AND NO LITERAL FONT SIZES. Tokens only, or none of this
// flips in dark mode (CLAUDE.md, "Typography & design tokens").

/** The shape `GET /api/suite/smtp` returns under `data`. The password is never among it. */
type SuiteSmtp = {
  host: string
  port: number
  secure: boolean
  username: string
  from_email: string
  from_name: string
  enabled: boolean
  allow_self_signed: boolean
  updated_at: string | null
  /** Whether a password is STORED. The value itself never leaves the server. */
  password_set: boolean
  /** False when the server has no NEXTAUTH_SECRET, so it cannot encrypt one. */
  secret_configured: boolean
}

/**
 * ⛔ THE PLACEHOLDER THE SUITE ALREADY AGREED ON. DDIVault's form has written
 * this exact string back for an unchanged password since its SMTP card
 * shipped; the route treats it, an empty string and an absent field alike as
 * "keep what is stored". It exists so correcting a typo in the username can
 * never destroy a working credential.
 */
const SMTP_MASK = '********'

const SMTP_EMPTY = {
  host: '',
  port: '587',
  secure: false,
  username: '',
  from_email: '',
  from_name: '',
  enabled: false,
  // ⛔ OFF. Never pre-checked, on any path — see the checkbox's own note.
  allow_self_signed: false,
}

/** A labelled field. `htmlFor`/`id` are real here, so the label is clickable and announced. */
function SmtpField({ id, label, hint, children }: {
  id: string
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={id}
        style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '5px' }}
      >
        {label}
      </label>
      {hint && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '6px', lineHeight: 1.6 }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  )
}

/** A checkbox with the sentence that explains what ticking it actually does. */
function SmtpCheckbox({ id, checked, disabled, onChange, label, note }: {
  id: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
  label: React.ReactNode
  note?: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={id}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-base)',
          fontWeight: 500, color: 'var(--text-primary)', cursor: disabled ? 'default' : 'pointer',
        }}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(e.target.checked)}
          style={{ accentColor: 'var(--primary)', width: 15, height: 15, flexShrink: 0, cursor: disabled ? 'default' : 'pointer' }}
        />
        {label}
      </label>
      {note && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '6px 0 0 23px', lineHeight: 1.6 }}>
          {note}
        </div>
      )}
    </div>
  )
}

function NotificationsPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [form, setForm] = useState({ ...SMTP_EMPTY })
  const [password, setPassword] = useState('')
  const [passwordSet, setPasswordSet] = useState(false)
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // ⛔ TRUE UNTIL THE SERVER SAYS OTHERWISE. Only an explicit `false` means the
  // secret is missing; treating "did not say" as "missing" would bolt the form
  // shut on an installation that is perfectly healthy.
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string } | null>(null)

  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  function set<K extends keyof typeof SMTP_EMPTY>(key: K, value: (typeof SMTP_EMPTY)[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
    // The previous verdict described the values that were saved, not the ones
    // now on screen — leaving it up would claim a save that no longer matches.
    setSaveResult(null)
  }

  /** `quiet` re-reads without blanking the panel, so a save verdict stays readable. */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/suite/smtp')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `The SMTP settings could not be read (HTTP ${res.status}).`)
      const d: Partial<SuiteSmtp> | null = body?.data ?? null
      setSecretConfigured((d?.secret_configured ?? body?.secret_configured) !== false)
      if (d) {
        setForm({
          host: d.host || '',
          port: d.port != null ? String(d.port) : '587',
          secure: d.secure === true,
          username: d.username || '',
          from_email: d.from_email || '',
          from_name: d.from_name || '',
          enabled: d.enabled === true,
          allow_self_signed: d.allow_self_signed === true,
        })
        setPasswordSet(d.password_set === true)
        setPassword(d.password_set === true ? SMTP_MASK : '')
        setUpdatedAt(d.updated_at || null)
      } else {
        setForm({ ...SMTP_EMPTY })
        setPasswordSet(false)
        setPassword('')
        setUpdatedAt(null)
      }
      setPasswordTouched(false)
      setShowPassword(false)
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    if (!form.host.trim()) {
      setSaveResult({ ok: false, text: 'Enter the SMTP host before saving. Nothing was sent.' })
      return
    }
    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSaveResult({ ok: false, text: 'Enter a port between 1 and 65535. Nothing was sent.' })
      return
    }
    setSaving(true)
    setSaveResult(null)
    try {
      const body: Record<string, unknown> = {
        host: form.host.trim(),
        port,
        secure: form.secure,
        username: form.username.trim(),
        from_email: form.from_email.trim(),
        from_name: form.from_name.trim(),
        enabled: form.enabled,
        allow_self_signed: form.allow_self_signed,
      }
      // ⛔ `password` IS OMITTED unless a new one was really typed. Focusing the
      // box marks it touched and empties it, so an admin who clicks into it and
      // straight back out still sends nothing — absent means keep the stored one.
      if (passwordTouched && password !== '' && password !== SMTP_MASK) body.password = password

      const res = await fetch('/api/suite/smtp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success !== true) {
        setSaveResult({
          ok: false,
          text: data?.error || `The SMTP settings were not saved (HTTP ${res.status}). What is stored on the server is unchanged.`,
        })
        return
      }
      setSaveResult({
        ok: true,
        text: form.enabled
          ? 'Saved. Every app in the suite will pick these settings up within a few minutes and send through this server from then on.'
          : 'Saved, and suite-wide SMTP is still switched off. Each app keeps using its own mail settings until you enable it here.',
      })
      // Re-read so the stored-password state and the saved timestamp come from
      // the server rather than from what this page assumed it just wrote.
      await load(true)
    } catch (e: unknown) {
      setSaveResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    const to = testTo.trim()
    if (!to) {
      setTestResult({ ok: false, text: 'Enter an address to send the test to.' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/suite/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      })
      // ⛔ READ 429 BEFORE THE BODY. The rate limiter may answer with no JSON at
      // all, and "Unexpected end of JSON input" would read as a mail failure.
      if (res.status === 429) {
        const retry = res.headers.get('Retry-After')
        setTestResult({
          ok: false,
          text: retry
            ? `Too many test attempts, try again shortly — about ${retry} seconds. Nothing is wrong with the settings; the limit is on this button.`
            : 'Too many test attempts, try again shortly. Nothing is wrong with the settings; the limit is on this button.',
        })
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTestResult({ ok: false, text: data?.error || `The test could not be run (HTTP ${res.status}).` })
        return
      }
      if (data?.ok === true) {
        setTestResult({
          ok: true,
          text: `The mail server accepted a message for ${to}. Delivery is now up to that server — if nothing arrives, look in the recipient's junk folder and in the mail server's own logs.`,
        })
      } else {
        setTestResult({ ok: false, text: data?.error || 'The mail server refused the message and gave no reason.' })
      }
    } catch (e: unknown) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <PanelCard title="Notifications"><PanelLoading /></PanelCard>

  if (loadError) {
    return (
      <PanelCard title="Notifications">
        <Callout tone="danger" title="The SMTP settings could not be read">
          <div>{loadError}</div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn-secondary" onClick={() => void load()} style={{ padding: '8px 16px' }}>Try again</button>
          </div>
        </Callout>
      </PanelCard>
    )
  }

  const busy = saving || testing
  // ⛔ WITHOUT THE SECRET THE PASSWORD CANNOT BE ENCRYPTED, so saving is
  // refused here rather than storing a credential the server cannot protect.
  const canSave = secretConfigured && !busy
  const savedAt = updatedAt ? new Date(updatedAt) : null
  const savedAtText = savedAt && !Number.isNaN(savedAt.getTime()) ? savedAt.toLocaleString() : null

  return (
    <div>
      <PanelCard
        title="Suite-wide SMTP"
        description={
          <>
            This is the mail server every app in the NocVault suite sends through. Set it up once
            here and LogVault, DDIVault and SpanVault all use it, so there is one host, one
            credential and one place to change them when the mail server moves. Each app still
            decides its own recipients, its own alert filters and its own sender name, so a
            message from LogVault still arrives looking like it came from LogVault. An app that
            already has SMTP settings of its own keeps using them until this one is enabled.
          </>
        }
      >
        {!secretConfigured && (
          <div
            role="alert"
            style={{
              background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)',
              border: '1px solid var(--tint-warn-fg)', borderRadius: 'var(--radius-sm)',
              padding: '12px 14px', marginBottom: '14px', fontSize: 'var(--text-base)', lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>This server cannot store an SMTP password</div>
            <div>
              This installation has no <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>NEXTAUTH_SECRET</code>,
              and that value is what the SMTP password is encrypted with. Saving is switched off
              until it is set, rather than writing a mail credential the server cannot protect.
              Set it in the environment of the NetVault service, restart NetVault, then come back
              to this page.
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {form.enabled
            ? <StatePill tone="ok">On — the suite sends through this server</StatePill>
            : <StatePill tone="neutral">Off — each app uses its own mail settings</StatePill>}
          {savedAtText && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Last saved {savedAtText}</span>
          )}
        </div>

        <SmtpCheckbox
          id="smtp-enabled"
          checked={form.enabled}
          disabled={saving}
          onChange={v => set('enabled', v)}
          label="Enable suite-wide SMTP"
          note="While this is off nothing changes anywhere — the settings below are stored and simply not used, and every app carries on with whatever mail server it was configured with."
        />
      </PanelCard>

      <PanelCard
        title="Mail server"
        description="Where mail is handed over, and the account it is handed over as."
      >
        <div style={{ display: 'grid', gap: 18, maxWidth: 560 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <SmtpField id="smtp-host" label="SMTP host">
                <input
                  id="smtp-host"
                  className="input"
                  spellCheck={false}
                  autoComplete="off"
                  value={form.host}
                  placeholder="smtp.office365.com"
                  disabled={saving}
                  onChange={e => set('host', e.target.value)}
                />
              </SmtpField>
            </div>
            <div style={{ flex: '0 0 auto' }}>
              <SmtpField id="smtp-port" label="Port">
                <input
                  id="smtp-port"
                  className="input input-sm"
                  type="number"
                  min={1}
                  max={65535}
                  inputMode="numeric"
                  value={form.port}
                  placeholder="587"
                  disabled={saving}
                  onChange={e => set('port', e.target.value)}
                />
              </SmtpField>
            </div>
          </div>

          {/* ⛔ THE HONEST VERSION OF THIS CHECKBOX. "Use TLS" reads as "be
              secure", so it gets ticked on port 587 — where it makes the
              connection fail outright, because 587 is not an implicit-TLS port.
              Naming the two cases is what stops that. */}
          <SmtpCheckbox
            id="smtp-secure"
            checked={form.secure}
            disabled={saving}
            onChange={v => set('secure', v)}
            label="Use implicit TLS (SMTPS)"
            note="Tick this only for port 465, where the connection is encrypted from the first byte. Ports 587 and 25 start in the clear and upgrade with STARTTLS, which happens automatically — leave this off for them or the connection will fail. Turning it off does not mean the session is unencrypted."
          />

          <SmtpField
            id="smtp-username"
            label="Username"
            hint="Leave both this and the password blank for a relay that accepts mail from this server without authenticating."
          >
            <input
              id="smtp-username"
              className="input"
              spellCheck={false}
              autoComplete="off"
              value={form.username}
              placeholder="alerts@company.com"
              disabled={saving}
              onChange={e => set('username', e.target.value)}
            />
          </SmtpField>

          <SmtpField
            id="smtp-password"
            label={
              <>
                Password
                {passwordSet && !passwordTouched && <> <StatePill tone="ok" title="Stored on the server. It is never sent back to this page.">Stored</StatePill></>}
              </>
            }
            hint={
              passwordSet
                ? <><strong style={{ color: 'var(--text-secondary)' }}>Leave this unchanged to keep the current password.</strong> It is never sent back to this page, so what you see is a placeholder, not the real value. Type here only to replace it.</>
                : 'Stored encrypted. It is never shown again once saved.'
            }
          >
            <div style={{ position: 'relative' }}>
              <input
                id="smtp-password"
                className="input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                spellCheck={false}
                value={password}
                placeholder={passwordSet ? SMTP_MASK : 'Enter the mailbox password'}
                disabled={saving}
                style={{ paddingRight: 58 }}
                onFocus={() => {
                  // Clear the mask on first focus so a new password is typed
                  // into an empty box rather than appended to eight asterisks.
                  if (passwordSet && !passwordTouched) { setPasswordTouched(true); setPassword('') }
                }}
                onChange={e => { setPasswordTouched(true); setPassword(e.target.value); setSaveResult(null) }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(p => !p)}
                aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--primary)',
                }}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {passwordTouched && password !== '' && passwordSet && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tint-warn-fg)', marginTop: 6 }}>
                Saving now replaces the stored password.
              </div>
            )}
          </SmtpField>

          {/* ⛔ OFF BY DEFAULT, AND NEVER PRE-CHECKED. DDIVault did this
              invisibly and always; making it a deliberate, labelled choice is
              the point of moving it here. */}
          <SmtpCheckbox
            id="smtp-allow-self-signed"
            checked={form.allow_self_signed}
            disabled={saving}
            onChange={v => set('allow_self_signed', v)}
            label="Allow self-signed certificate"
            note="This switches off certificate verification for the connection to the mail server, so a wrong or impersonated server is accepted without complaint. Leave it off unless your mail server presents a certificate from an internal CA this machine does not trust."
          />
        </div>
      </PanelCard>

      <PanelCard
        title="Default sender identity"
        description="Who mail from the hub appears to come from. Each app in the suite keeps its own From name and address, so its alerts still read as coming from that app — these two are the fallback for an app that has not set one, and what NetVault itself sends as."
      >
        <div style={{ display: 'grid', gap: 18, maxWidth: 560 }}>
          <SmtpField id="smtp-from-email" label="From address">
            <input
              id="smtp-from-email"
              className="input"
              type="email"
              spellCheck={false}
              autoComplete="off"
              value={form.from_email}
              placeholder="nocvault@company.com"
              disabled={saving}
              onChange={e => set('from_email', e.target.value)}
            />
          </SmtpField>
          <SmtpField
            id="smtp-from-name"
            label="From name"
            hint="The display name beside the address in a recipient's inbox."
          >
            <input
              id="smtp-from-name"
              className="input"
              spellCheck={false}
              autoComplete="off"
              value={form.from_name}
              placeholder="NocVault"
              disabled={saving}
              onChange={e => set('from_name', e.target.value)}
            />
          </SmtpField>
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void save()}
            disabled={!canSave}
            style={{ padding: '10px 24px' }}
          >
            {saving ? 'Saving…' : 'Save SMTP settings'}
          </button>
          {!secretConfigured && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Saving is unavailable until the server can encrypt the password.
            </span>
          )}
        </div>

        {saveResult && (
          <div style={{ marginTop: 14 }}>
            <Callout tone={saveResult.ok ? 'ok' : 'danger'} title={saveResult.ok ? 'Saved' : 'Not saved'}>
              {saveResult.text}
            </Callout>
          </div>
        )}
      </PanelCard>

      <PanelCard
        title="Send a test email"
        description="The test uses the settings as they are SAVED on the server, not as they are typed above. Save first, then send, or you will be testing the previous configuration and reading the result as though it described the new one."
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', maxWidth: 560 }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <SmtpField id="smtp-test-to" label="Send to">
              <input
                id="smtp-test-to"
                className="input"
                type="email"
                spellCheck={false}
                autoComplete="off"
                value={testTo}
                placeholder="you@company.com"
                disabled={busy}
                onChange={e => { setTestTo(e.target.value); setTestResult(null) }}
              />
            </SmtpField>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void sendTest()}
            disabled={busy}
            style={{ padding: '10px 20px' }}
          >
            {testing ? 'Sending…' : 'Send test email'}
          </button>
        </div>

        {testResult && (
          <div style={{ marginTop: 14 }}>
            <Callout tone={testResult.ok ? 'ok' : 'danger'} title={testResult.ok ? 'The mail server accepted it' : 'The test did not send'}>
              {testResult.text}
            </Callout>
          </div>
        )}
      </PanelCard>
    </div>
  )
}

function SettingsInner() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { data: session } = useSession()
  const router = useRouter()
  const user = session?.user as { role?: string } | undefined
  const isSuperAdmin = user?.role === 'super_admin'
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  // Non-admins are no longer bounced out of Settings entirely — they are
  // admitted to the Security / 2FA tab and nothing else (see the tab filter
  // below, which reduces to just that one for them).
  //
  // They have to be able to get here. Two-factor is not an administrative
  // privilege, and once mfa_required_roles names a role, a member of it who
  // cannot self-enrol is locked out permanently: authorize() refuses the login
  // for having no factor, and the only page that could give them one would be
  // shut. Every other tab remains admin-gated exactly as before.
  const canSeeAdminTabs = user?.role === 'admin' || user?.role === 'super_admin'

  const searchParams = useSearchParams()
  const urlTab = searchParams.get('tab')

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  // A non-admin has exactly one tab, so land them on it rather than on the
  // 'general' default they are not allowed to see.
  useEffect(() => {
    if (user && !canSeeAdminTabs) setActiveTab('security')
  }, [user, canSeeAdminTabs])

  // Deep-link support: the suite apps' "Manage License" link points at
  // /settings/license (which redirects here as ?tab=license). Honour ?tab=<name>
  // on load so the correct tab opens instead of the default.
  //
  // The role check is NOT cosmetic. Filtering the tab STRIP hides the button,
  // but each tab's content is rendered by its own `activeTab === '<name>'`
  // block — so a non-admin arriving at /settings?tab=users would have had the
  // user-management panel rendered for them with no button ever shown. Depends
  // on `user` (not []) because the session resolves after first paint, so a
  // mount-only effect would decide this before the role is known.
  useEffect(() => {
    if (!user) return
    const t = urlTab
    if (!t) return
    // ⛔ 'sso' IS FILTERED OUT FOR A NON-super_admin HERE TOO, not only in the
    // nav. Hiding the button is cosmetic — each section is rendered by its own
    // `activeTab === '<name>'` block, so /settings?tab=sso would otherwise draw
    // the directory-trust panel for an `admin`, which is the exact role split
    // /api/system/entra refuses at the API.
    const allowed: string[] = canSeeAdminTabs
      // ⛔ `license` IS GATED HERE TOO, AND IT WAS NOT BEFORE. Its nav BUTTON is
      // filtered by isSuperAdmin further down, but this allow-list admitted it
      // for any admin — so /settings?tab=license rendered the licence panel for
      // someone who could never see the button. Exactly the split this effect's
      // own comment warns about, left behind on one tab.
      //
      // Found while adding `sso`, which is the point: CLAUDE.md's rule is that a
      // fixed access-control bug is a fixed INSTANCE, not a fixed CLASS — when
      // you gate one surface, check its siblings in the same pass. Both tabs
      // are now gated in BOTH places; if a third super_admin-only tab is added,
      // it belongs in both too. `https` was the third, and this line is where
      // it was nearly missed: the nav filter alone would have left
      // /settings?tab=https open to an `admin` who can never see the button.
      // `notifications` is the fourth and is gated in both places from the
      // start — it edits the SMTP credential the whole suite sends through.
      ? ADMIN_TABS.filter(x => (x !== 'sso' && x !== 'license' && x !== 'https' && x !== 'notifications') || isSuperAdmin)
      : ['security']
    if (allowed.includes(t)) {
      setActiveTab(t as SettingsTab)
    }
    // Depends on urlTab, NOT just [user]: the three Administration rows in
    // the sidebar are query-string variants of THIS SAME route, so moving
    // between them changes the URL without remounting the page. Reading the
    // tab only on mount made every Administration link look dead - the
    // address bar updated and the panel stayed exactly where it was.
  }, [user, canSeeAdminTabs, isSuperAdmin, urlTab])
  /**
   * Switch section AND reflect it in the URL.
   *
   * ?tab= was already honoured on load (the sibling apps deep-link
   * /settings/license here) but switching sections never updated the
   * address, so the open section could not be linked or bookmarked and the
   * sidebar's Administration rows could not tell which one was showing.
   * replaceState, not push: flipping sections should not stack history
   * entries for the back button to walk through.
   */
  function selectTab(tab: typeof activeTab) {
    setActiveTab(tab)
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('tab', tab)
      window.history.replaceState(null, '', url.toString())
    } catch { /* non-fatal: the section still switches */ }
  }

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

  // ⛔ THE FORM MIRRORS THE SERVER GUARD, IT DOES NOT REPLACE IT.
  // PUT /api/users/[id] refuses a password, a role change or an email change on
  // a directory row with a 409 (lib/localAccountPolicy.ts). Disabling the inputs
  // here stops an administrator filling in a field whose save is going to be
  // rejected — but a UI gate must never be the boundary, and must never be
  // STRICTER than the API it fronts, or the product reads as broken rather than
  // as restricted. `name`, sites and app access stay editable, because
  // user_apps/user_sites are hub-owned data the directory cannot supply and this
  // form is the only way to set them.
  const editingDirectory = isDirectoryUser(editUser)

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
    else {
      // ⛔ SHOW THE SERVER'S REASON. This used to be a flat
      // showToast('Failed to delete user'), which discarded a body that says
      // exactly what is wrong — the account is the last super admin, or other
      // records still refer to it. The operator was left with a button that
      // did nothing and no way to find out why, while `addSite` twenty lines
      // below already read `d.error`. A generic failure is worse than no
      // button: it reads as a product fault rather than a stated rule.
      const reason = await res.json().then((d) => d?.error).catch(() => null)
      showToast(reason || 'Failed to delete user', 'error')
    }
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
    // Close the Add dialog first. As inline panels these two could sit stacked
    // on the page harmlessly; as modals they would overlay each other, and both
    // would bind Escape.
    setShowSiteForm(false)
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
        <PageHead
          title="Settings"
          description="System configuration, who can access it, your subscription, and your own account security."
        />
      </div>

      {/* Grouped settings sub-navigation.

          Replaces a single horizontal strip of seven tabs. The grouping is
          conceptual, not cosmetic: System, Access, Billing and Personal are
          different kinds of setting with different audiences, and a viewer
          only ever sees the Personal group.

          The role filters below are carried over UNCHANGED - in particular,
          Security / 2FA is the one entry a non-admin may see, which is what
          lets someone reach their own two-factor setup without also being
          handed Users, Sites or Updates. Each content block keeps its own
          `activeTab === '<name>'` guard, so this is only the chrome. */}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {([
            // Console address and Certificate are System: they are facts about
            // this installation's address and transport. Single sign-on sits
            // under Access beside Users, because it decides WHO may sign in —
            // and it is the one entry here gated on super_admin alone.
            // Notifications is System, not Access: it is the suite's outbound
            // mail transport — a fact about this installation, like the console
            // address and the certificate are. It decides nothing about who may
            // sign in.
            ['System',   ['general', 'console', 'certificate', 'https', 'notifications', 'sites', 'updates', 'about']],
            ['Access',   ['users', 'sso']],
            ['Billing',  ['license']],
            ['Personal', ['security']],
          ] as const).map(([group, tabs]) => {
            const visible = (tabs as readonly string[])
              .filter(tab => tab === 'security' || canSeeAdminTabs)
              .filter(tab => tab !== 'general' || isAdmin)
              .filter(tab => tab !== 'license' || isSuperAdmin)
              .filter(tab => tab !== 'updates' || isAdmin)
              .filter(tab => tab !== 'console' || isAdmin)
              .filter(tab => tab !== 'certificate' || isAdmin)
              // ⛔ super_admin, not admin. Whoever sets the tenant decides which
              // directory is trusted to issue identities for the whole suite.
              .filter(tab => tab !== 'sso' || isSuperAdmin)
              // ⛔ super_admin TOO, and for a blunter reason: this is the one
              // Settings tab that can move all four consoles and take the suite
              // briefly offline. Reading the transport is admin+ (the GET), but
              // switching it is not.
              .filter(tab => tab !== 'https' || isSuperAdmin)
              // ⛔ super_admin TOO. This form holds one password that every app
              // in the suite sends mail with; an `admin` who could edit it
              // could repoint the suite's mail at a server they control.
              .filter(tab => tab !== 'notifications' || isSuperAdmin)
            if (visible.length === 0) return null
            return (
              <div key={group} className="settings-nav-group">
                <div className="settings-nav-label">{group}</div>
                {visible.map(tab => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => selectTab(tab as typeof activeTab)}
                    aria-current={activeTab === tab ? 'page' : undefined}
                    className="settings-nav-item"
                  >
                    <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      {tab === 'general' ? 'General'
                        : tab === 'console' ? 'Console address'
                        : tab === 'certificate' ? 'Certificate'
                        : tab === 'https' ? 'HTTPS'
                        : tab === 'notifications' ? 'Notifications'
                        : tab === 'sso' ? 'Single sign-on'
                        : tab === 'users' ? 'Users & access'
                        : tab === 'sites' ? 'Organisation & sites'
                        : tab === 'security' ? 'Security / 2FA'
                        : tab === 'updates' ? 'Updates'
                        : tab === 'about' ? 'About'
                        : 'Subscription & licensing'}
                    </span>
                    {tab === 'users' && users.length > 0 && <span className="tnum settings-nav-count">{users.length}</span>}
                    {tab === 'sites' && sites.length > 0 && <span className="tnum settings-nav-count">{sites.length}</span>}
                    {tab === 'updates' && updateStatus?.update_available && (
                      <span title="Update available" aria-label="Update available" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%' /* intentional: update-available status dot */, background: '#dc2626', flexShrink: 0 }} />
                    )}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>

        <div className="settings-panel">

      {/* USERS TAB */}
      {activeTab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', margin: 0 }}>Manage who can access this system</p>
            <button className="btn-primary" onClick={openAddUser}>+ Add user</button>
          </div>
          {/* The add/edit form is a focused drawer rather than a panel that
              pushes the user table down the page. It is the shared Dialog,
              so it gets role=dialog, aria-modal, a focus trap, Escape and
              focus restored to the button that opened it. The form markup
              itself is unchanged. */}
          <Dialog
            open={showUserForm}
            onClose={() => setShowUserForm(false)}
            variant="drawer"
            dismissible={!savingUser}
            title={editUser ? `Edit ${editUser.name}` : 'Add user'}
            description={editUser ? 'Change this account\u2019s role, site scope and application access.' : 'Create an account and set what it can reach.'}
            footer={
              <>
                <button className="btn btn-secondary" onClick={() => setShowUserForm(false)} disabled={savingUser}>Cancel</button>
                <button className="btn btn-primary" onClick={saveUser} disabled={savingUser}>
                  {savingUser ? 'Saving\u2026' : editUser ? 'Save changes' : 'Create user'}
                </button>
              </>
            }
          >
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                {[
                  { label: 'Full name', field: 'name', type: 'text', placeholder: 'e.g. John Smith' },
                  { label: 'Email address', field: 'email', type: 'email', placeholder: 'john@company.com' },
                  { label: editUser ? 'New password (leave blank to keep)' : 'Password', field: 'password', type: 'password', placeholder: '••••••••' },
                ].map(f => {
                  const locked = editingDirectory && (f.field === 'email' || f.field === 'password')
                  return (
                  <div key={f.field}>
                    <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>{f.label}</label>
                    <input className="input" type={f.type} placeholder={locked ? '\u2014' : f.placeholder} value={locked && f.field === 'password' ? '' : String(userForm[f.field as keyof typeof userForm] ?? '')} disabled={locked} onChange={e => setUserForm(p => ({ ...p, [f.field]: e.target.value }))} />
                    {locked && (
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {f.field === 'email'
                          ? 'Comes from your directory \u2014 change it there.'
                          : 'This account signs in through your directory, so it has no password here.'}
                      </div>
                    )}
                  </div>
                  )
                })}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '5px' }}>Role</label>
                  <select className="input select" value={userForm.role} disabled={editingDirectory} onChange={e => setUserForm(p => ({ ...p, role: e.target.value, site_ids: [] }))}>
                    <option value="viewer">Viewer — read only, all sites</option>
                    <option value="site_admin">Site Admin — full edit, assigned sites only</option>
                    {isSuperAdmin && <option value="super_admin">Super Admin — full access including user management and deletes</option>}
                    <option value="admin">Admin — full access, all sites</option>
                  </select>
                  {editingDirectory && (
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '4px' }}>
                      Set by this account&apos;s directory group. A role chosen here would be
                      overwritten the next time they sign in &mdash; change the group mapping in
                      Single sign-on instead.
                    </div>
                  )}
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
              {/* Effective access summary.

                  Role, site scope and per-app entitlement are three separate
                  controls whose combined result is not obvious - a site_admin
                  with no sites assigned can sign in and see nothing, and that
                  was only discoverable by saving and then looking at the
                  table. This states the outcome in plain language before the
                  save, and is derived from the form values so it always
                  describes what is about to be written. */}
              <div style={{ border: '1px solid var(--border)', background: 'var(--surface-subtle)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', marginBottom: 7 }}>
                  Effective access
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-base)', color: 'var(--text-secondary)', lineHeight: 1.75 }}>
                  <li>
                    {userForm.role === 'viewer' && 'Can read everything across all sites, but cannot change anything.'}
                    {userForm.role === 'site_admin' && 'Can view and edit records, limited to their assigned sites.'}
                    {userForm.role === 'admin' && 'Can view and edit everything across all sites, including settings.'}
                    {userForm.role === 'super_admin' && 'Full access including user management, licensing, agents and deletes.'}
                  </li>
                  <li>
                    {userForm.role === 'site_admin'
                      ? (userForm.site_ids.length === 0
                          ? <strong style={{ color: 'var(--yellow)' }}>No sites assigned — this account will be able to sign in but will see no devices, sites or circuits.</strong>
                          : <>Scoped to {userForm.site_ids.length} site{userForm.site_ids.length === 1 ? '' : 's'}.</>)
                      : 'All sites.'}
                  </li>
                  <li>
                    {userForm.role === 'super_admin'
                      ? 'All suite applications (super admins are never restricted).'
                      : userForm.app_slugs.length >= ALL_SLUGS.length
                        ? 'All suite applications: NetVault, LogVault, DDIVault and SpanVault.'
                        : <>Can open {userForm.app_slugs.join(', ')}. NetVault is always available.</>}
                  </li>
                  {/* No two-factor line here deliberately: which roles
                      require MFA is held in mfa_required_roles, which this
                      form does not load. Stating it from a guess would be
                      exactly the kind of invented status this page must not
                      show - it is on the Security section, which does read
                      the real value. */}
                </ul>
              </div>

              {userError && <div role="alert" style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', marginBottom: '12px' }}>{userError}</div>}
            </div>
          </Dialog>
          {/* overflow: hidden clipped the Actions column once the settings
              panel became a grid track rather than the full page width -
              the Delete button was cut off at the right edge. The card keeps
              its rounded corners via the wrapper; the inner div scrolls. */}
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
           <div className="table-scroll">
            <table className="data-table compact" style={{ minWidth: 720 }}>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Site access</th><th>App access</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{u.name}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>
                      {u.email}
                      {/* Says where this identity lives. Without it the list shows
                          two kinds of account that behave differently \u2014 one with a
                          password and a locally-set role, one with neither \u2014 and
                          looks identical. Tinted as information, not a warning:
                          a directory account is the normal, preferred kind. */}
                      {isDirectoryUser(u) && (
                        <span
                          title="Signs in through your directory. Its role comes from a directory group and it has no password here."
                          style={{ marginLeft: '8px', fontSize: 'var(--text-xs)', fontWeight: 600, padding: '1px 6px', borderRadius: 'var(--radius-pill)', background: 'var(--tint-info)', color: 'var(--tint-info-fg)', whiteSpace: 'nowrap' }}
                        >Directory</span>
                      )}
                    </td>
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
        </div>
      )}

      {/* SECURITY TAB — self-service MFA for the signed-in user. Every role
          sees this: two-factor is not an admin-only privilege, and the hub is
          the single sign-in for all four apps. */}
      {activeTab === 'security' && (
        <div><MfaCard /></div>
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

      {/* CONSOLE ADDRESS TAB (admin+) — NEXTAUTH_URL, saved vs running, the
          per-file state, and the lockout confirmation. */}
      {/* ⛔ `canRestart` — the panel is admin+, the restart POST is super_admin. */}
      {activeTab === 'console' && isAdmin && <ConsoleAddressPanel canRestart={isSuperAdmin} />}

      {/* CERTIFICATE TAB (admin+) — the three transport states and the
          certificate install, including the replace confirmation. */}
      {activeTab === 'certificate' && isAdmin && <CertificatePanel canInstall={isSuperAdmin} />}

      {/* HTTPS TAB — ⛔ super_admin ONLY, and the check is on the CONTENT as
          well as the nav: the nav filter hides the button, and this is what
          makes /settings?tab=https mean nothing for an `admin`. Turning the
          transport on or off restarts all four consoles. */}
      {activeTab === 'https' && isSuperAdmin && <TransportPanel />}

      {/* NOTIFICATIONS TAB — ⛔ super_admin ONLY, checked on the CONTENT as
          well as on the nav button and in the ?tab= allow-list above. The
          nav filter alone is cosmetic; this is what makes
          /settings?tab=notifications mean nothing for an `admin`. */}
      {activeTab === 'notifications' && isSuperAdmin && <NotificationsPanel />}

      {/* SINGLE SIGN-ON TAB — ⛔ super_admin ONLY, and the role check is on the
          CONTENT, not only on the nav button: the nav filter hides the button
          and this is what makes /settings?tab=sso mean nothing for an `admin`. */}
      {activeTab === 'sso' && isSuperAdmin && <SingleSignOnPanel />}

      {/* SITES TAB */}
      {activeTab === 'sites' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <input className="input input-md" placeholder="Search sites or countries..." aria-label="Search sites" value={siteSearch} onChange={e => setSiteSearch(e.target.value)} />
            <button className="btn-primary" onClick={() => { setEditSite(null); setShowSiteForm(true); setSiteError('') }}>+ Add site</button>
          </div>

          {showSiteForm && (
            <SiteDialog
              title="Add new site"
              subtitle="Site name and country are required."
              onClose={() => setShowSiteForm(false)}
              footer={<>
                <button className="btn-primary" onClick={addSite} disabled={savingSite}>{savingSite ? 'Saving...' : 'Add site'}</button>
                <button className="btn-secondary" onClick={() => setShowSiteForm(false)}>Cancel</button>
              </>}
            >
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
              {siteError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>{siteError}</div>}
            </SiteDialog>
          )}

          {editSite && (
            <SiteDialog
              title={`Edit site — ${editSite.name || (editSite as any).site}`}
              onClose={() => setEditSite(null)}
              footer={<>
                <button className="btn-primary" onClick={saveEditSite} disabled={savingEditSite}>{savingEditSite ? 'Saving...' : 'Save changes'}</button>
                <button className="btn-secondary" onClick={() => setEditSite(null)}>Cancel</button>
              </>}
            >
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
              {editSiteError && <div style={{ background: 'var(--tint-danger)', color: 'var(--tint-danger-fg)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}>{editSiteError}</div>}
            </SiteDialog>
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
      {/* ⛔ `&& isSuperAdmin` matches the sso block above and the allow-list.
          The content block is the real gate — the allow-list only decides which
          tab opens, and `setActiveTab` is reachable from other code paths. Both
          layers, or neither is a boundary. */}
      {activeTab === 'license' && isSuperAdmin && (
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

                {/* Module entitlements + capacity.

                    Previously the only place modules appeared was inside the
                    block below, which renders ONLY for status === 'active'
                    WITH a customer - so on a trial, in grace, or on an
                    expired licence there was no way to see what the install
                    is actually entitled to, which is exactly when someone
                    goes looking. This renders for every state.

                    An empty `modules` array is shown as "all modules", which
                    is what the licence check itself treats it as - not as
                    "nothing is licensed". */}
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', marginBottom: 10 }}>
                    Module entitlements
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))', gap: 8 }}>
                    {[
                      ['netvault',  'NetVault',  'Network asset management'],
                      ['logvault',  'LogVault',  'Syslog and log analysis'],
                      ['ddivault',  'DDIVault',  'DNS, DHCP and IPAM'],
                      ['spanvault', 'SpanVault', 'Network monitoring'],
                      ['eol',       'EOL Intelligence', 'Lifecycle enrichment add-on'],
                    ].map(([slug, name, desc]) => {
                      const all = (licenseInfo.modules?.length ?? 0) === 0
                      const on = all || licenseInfo.modules.includes(slug)
                      return (
                        <div key={slug} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8,
                          padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border)',
                          background: on ? 'var(--tint-success)' : 'var(--surface-subtle)',
                        }}>
                          <span aria-hidden style={{ display: 'flex', flexShrink: 0, marginTop: 1, color: on ? 'var(--tint-success-fg)' : 'var(--text-muted)' }}>
                            {on
                              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>}
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 600, color: on ? 'var(--tint-success-fg)' : 'var(--text-muted)' }}>
                              {name}
                            </span>
                            <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                              {on ? desc : 'Not licensed'}
                            </span>
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Capacity. Rendered only when the licence actually states
                      a device limit - no invented denominator. */}
                  {licenseInfo.maxDevices !== null && licenseInfo.maxDevices !== undefined && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontSize: 'var(--text-base)' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Device capacity</span>
                        <span className="tnum" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                          {licenseInfo.maxDevices === 0
                            ? 'Unlimited'
                            : `${licenseInfo.maxDevices.toLocaleString()} devices permitted`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

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
                {copiedServerId ? 'Copied' : 'Copy'}
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
            {/* license-action exempts this button from read-only mode's global
                pointer-events:none (see globals.css). Without it, an expired
                licence makes the button that renews the licence unclickable. */}
            <button className="btn-primary license-action" onClick={activateLicense} disabled={activatingLicense}>
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
                      <span>NetVault is up to date</span>
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
                        ? <>Patches available since v{updateStatus.current_version}</>
                        : <>Update available: v{updateStatus.current_version} → v{updateStatus.latest_version}</>}
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
                      Services will restart during the update — you may lose connection for 30–60 seconds.
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
                  License expired — updates disabled. Renew your license to receive updates.{' '}
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

        </div>
      </div>

      {confirmingUpdate && <UpdateConfirmModal onCancel={() => setConfirmingUpdate(false)} onConfirm={startUpdate} />}
      {updatingApp && <UpdatingOverlay preVersion={updateStatus?.current_commit || ''} />}

    </div>
  )
}

// useSearchParams (for ?tab=) needs a Suspense boundary to be prerender-safe,
// the same way the launcher wraps its ?denied read.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsInner />
    </Suspense>
  )
}
