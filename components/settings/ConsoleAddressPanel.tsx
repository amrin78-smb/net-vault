'use client'
//
// components/settings/ConsoleAddressPanel.tsx — Settings → Console address.
// Reads and writes NEXTAUTH_URL through /api/system/console-url.
//
// ⛔ THE LOCKOUT PROMPT IS A QUESTION, NOT AN ERROR. A PUT answers 409 with
// `needsConfirmation` when the hostname resolves to a machine that is not this
// one. That is the one typo that makes the console unreachable BY THE PERSON
// WHO MADE IT — the fix afterwards is editing a file on the server — so it gets
// what it resolved to, a sentence saying what goes wrong, and a second
// deliberate action that re-sends with `confirmed: true`. Rendering it red and
// calling it an error teaches the operator to retry the same thing harder, and
// swallowing it is an outage.
//
// ⛔ NOT EVERY 409 IS THE PROMPT. A duplicated NEXTAUTH_URL in either file also
// answers 409, with `error` and no `needsConfirmation` — that one is a refusal
// and must show the server's own text. The branch is on the flag, never on the
// status code.
//
// ⛔ EVERY COMPONENT IS AT MODULE TOP LEVEL (see panelChrome.tsx).

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/app/providers'
import {
  Callout,
  FactRow,
  FactTable,
  FieldLabel,
  Mono,
  PanelCard,
  PanelLoading,
  SavedRunningRows,
  StatePill,
} from './panelChrome.tsx'
import {
  filePresentation,
  fileRoleLabel,
  savedVsRunning,
  shadowPresentation,
  takesEffectPresentation,
  transportPresentation,
  type ShadowVerdictLike,
} from './systemPanelHelpers.ts'

type FileReport = {
  path?: string
  role?: string
  exists?: boolean
  value?: string | null
  error?: string | null
}

type ConsoleUrlState = {
  saved?: string | null
  running?: string | null
  restartPending?: boolean
  restartRequiresService?: string
  files?: FileReport[]
  shadow?: ShadowVerdictLike
  shadowNote?: string | null
  takesEffectOnRestart?: boolean | null
  transport?: { status?: string | null; httpsPort?: number | null; httpPort?: number | null; error?: string | null }
  schemeMismatch?: string | null
  examplePort?: number
  error?: string
}

/** The 409 the lockout guard answers with. */
type Confirmation = {
  reason?: string
  url?: string
  warnings?: string[]
  resolvedTo?: string[]
}

/** A successful PUT, kept on screen so the restart sentence does not vanish. */
type SaveResult = {
  url?: string
  previous?: string | null
  warnings?: string[]
  resolvedTo?: string[]
  pointsHere?: boolean
  takesEffectOnRestart?: boolean | null
  message?: string
}

export default function ConsoleAddressPanel() {
  const { showToast } = useToast()
  const [state, setState] = useState<ConsoleUrlState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [result, setResult] = useState<SaveResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/system/console-url', { cache: 'no-store' })
      const data = (await res.json()) as ConsoleUrlState
      if (!res.ok) {
        setLoadError(data?.error || `The console address could not be read (HTTP ${res.status}).`)
        setState(null)
      } else {
        setLoadError(null)
        setState(data)
        setUrl((data.saved || data.running || '').trim())
      }
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * ⛔ `confirmed` IS PASSED EXPLICITLY AND ONLY BY THE SECOND ACTION. There is
   * no state that makes the first Save send it, so a confirmation can never be
   * carried forward into a later, different address.
   */
  async function save(confirmed: boolean) {
    setSaving(true)
    setError(null)
    if (!confirmed) setConfirmation(null)
    setResult(null)
    try {
      const res = await fetch('/api/system/console-url', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed ? { url, confirmed: true } : { url }),
      })
      const data = await res.json().catch(() => ({}))

      // ⛔ THE FLAG, NOT THE STATUS CODE. The duplicate-key refusal is also 409.
      if (res.status === 409 && data?.needsConfirmation === true) {
        setConfirmation({
          reason: data.reason,
          url: data.url,
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
          resolvedTo: Array.isArray(data.resolvedTo) ? data.resolvedTo : [],
        })
        return
      }
      if (!res.ok || data?.ok !== true) {
        setConfirmation(null)
        setError(data?.error || `The console address could not be saved (HTTP ${res.status}).`)
        return
      }
      setConfirmation(null)
      setResult({
        url: data.url,
        previous: data.previous ?? null,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        resolvedTo: Array.isArray(data.resolvedTo) ? data.resolvedTo : [],
        pointsHere: data.pointsHere,
        takesEffectOnRestart: data.takesEffectOnRestart ?? null,
        message: data.message,
      })
      // ⛔ THE TOAST IS THE ANNOUNCEMENT, NOT THE RESTART NOTICE. A toast
      // disappears; the callout above keeps the restart sentence on screen,
      // because that sentence is the difference between "saved" and "in force".
      showToast(
        data.takesEffectOnRestart === true
          ? 'Console address saved — restart NetVault to apply it'
          : 'Console address saved — see the note about whether a restart will apply it',
        data.takesEffectOnRestart === true ? 'success' : 'info',
      )
      await load()
    } catch (e: unknown) {
      setConfirmation(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <PanelCard title="Console address"><PanelLoading /></PanelCard>

  if (loadError || !state) {
    return (
      <PanelCard title="Console address">
        <Callout tone="danger" title="The console address could not be read">{loadError}</Callout>
      </PanelCard>
    )
  }

  const service = state.restartRequiresService || 'NetVault'
  const transport = transportPresentation(state.transport?.status, {
    httpsPort: state.transport?.httpsPort,
    httpPort: state.transport?.httpPort,
    error: state.transport?.error,
  })
  const shadow = shadowPresentation(state.shadow, 'NEXTAUTH_URL', service)
  const pair = savedVsRunning(state.saved, state.running)
  const examplePort = state.examplePort || 3000
  const exampleScheme = state.transport?.status === 'active' ? 'https' : 'http'

  return (
    <div>
      <PanelCard
        title="Console address"
        description={
          <>This is the address users reach this console on, and the address sign-in cookies and
          every suite redirect are issued for. It is stored as <Mono>NEXTAUTH_URL</Mono> in both
          environment files.</>
        }
      >
        <FactTable>
          <SavedRunningRows saved={pair.saved} running={pair.running} differs={pair.differs} serviceName={service} />
          <FactRow label="Transport">
            <StatePill tone={transport.tone}>{transport.label}</StatePill>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
              {transport.headline}
            </div>
          </FactRow>
        </FactTable>

        {pair.differs && (
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn" title="Saved, but not yet in force">
              The saved address and the running address differ. NextAuth builds its options once at
              startup, so sign-in keeps using the running address until the {service} service is
              restarted.
            </Callout>
          </div>
        )}

        {/* ⛔ A scheme that disagrees with the real transport breaks every
            sign-in with no error anywhere, so it is loud. */}
        {state.schemeMismatch && (
          <div style={{ marginTop: pair.differs ? 0 : 14 }}>
            <Callout tone="danger" title="The address and the transport disagree">{state.schemeMismatch}</Callout>
          </div>
        )}

        {/* ⛔ THREE SHADOW STATES. `clear` is silent; `shadowed` and `unknown`
            are both shown, and `unknown` is never dressed up as fine. */}
        {shadow.show && (
          <div style={{ marginTop: 14 }}>
            <Callout tone={shadow.tone} title={shadow.label}>{state.shadowNote || shadow.detail}</Callout>
          </div>
        )}
      </PanelCard>

      <PanelCard title="Per-file state" description="NEXTAUTH_URL is written to both of these. If they disagree, the running file is what this process read at startup.">
        <FactTable>
          {(state.files || []).map((f, i) => {
            const p = filePresentation(f)
            return (
              <FactRow key={f.path || i} label={fileRoleLabel(f.role)}>
                <div style={{ marginBottom: 4 }}><Mono>{f.path}</Mono></div>
                <StatePill tone={p.tone}>{p.label}</StatePill>
                {p.detail && (
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tint-danger-fg)', marginTop: 4 }}>{p.detail}</div>
                )}
              </FactRow>
            )
          })}
        </FactTable>
      </PanelCard>

      <PanelCard title="Change the console address">
        <FieldLabel hint={<>Include the scheme and the port, for example <Mono>{`${exampleScheme}://netvault.example.com:${examplePort}`}</Mono>. Every value saved here needs a {service} restart before it does anything.</>}>
          Console address
        </FieldLabel>
        <input
          className="input"
          style={{ maxWidth: 520 }}
          value={url}
          placeholder={`${exampleScheme}://netvault.example.com:${examplePort}`}
          disabled={saving}
          onChange={(e) => {
            setUrl(e.target.value)
            // ⛔ A pending confirmation belongs to ONE address. Editing the box
            // withdraws the question rather than letting the next click confirm
            // something the operator was never shown.
            setConfirmation(null)
            setError(null)
          }}
        />

        {error && (
          <div style={{ marginTop: 14 }}>
            <Callout tone="danger" title="Refused — nothing was changed">{error}</Callout>
          </div>
        )}

        {/* ⛔ THE LOCKOUT PROMPT. Warn, not danger: this is a question about a
            consequence, and it is answered by a second deliberate action. */}
        {confirmation && (
          <div style={{ marginTop: 14 }}>
            <Callout
              tone="warn"
              title="This address does not point at this server. Confirm before saving."
              actions={
                <>
                  <button className="btn-primary" disabled={saving} onClick={() => { void save(true) }}>
                    {saving ? 'Saving…' : 'I understand — save this address anyway'}
                  </button>
                  <button className="btn-secondary" disabled={saving} onClick={() => setConfirmation(null)}>
                    Cancel and edit it
                  </button>
                </>
              }
            >
              <div style={{ marginBottom: 8 }}>{confirmation.reason}</div>
              <div style={{ marginBottom: 8 }}>
                <Mono>{confirmation.url}</Mono> resolves to{' '}
                {confirmation.resolvedTo && confirmation.resolvedTo.length > 0
                  ? <Mono>{confirmation.resolvedTo.join(', ')}</Mono>
                  : 'an address that is not one of this server’s own'}
                , which is not an address of this server.
              </div>
              <div style={{ fontWeight: 600 }}>
                If that is a typo, then after the next restart nobody can sign in — including you.
                Recovering from it means editing an environment file on the server itself, not this
                page.
              </div>
              {confirmation.warnings && confirmation.warnings.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {confirmation.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </Callout>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 14 }}>
            {/* ⛔ THE RESTART SENTENCE IS SHOWN AFTER THE SAVE, not only in the
                help text above. The API says `restartRequired` on every write;
                an administrator who does not read it concludes the save failed. */}
            <Callout
              tone={result.takesEffectOnRestart === true ? 'info' : 'warn'}
              title="Saved"
            >
              <div>{result.message || takesEffectPresentation(result.takesEffectOnRestart, service).text}</div>
              {result.previous && (
                <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
                  Previous value: <Mono>{result.previous}</Mono> — put this back by hand on the
                  server if the new one turns out to be wrong.
                </div>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </Callout>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 16 }}>
          <button
            className="btn-primary"
            style={{ padding: '10px 24px' }}
            disabled={saving || url.trim() === ''}
            onClick={() => { void save(false) }}
          >
            {saving && !confirmation ? 'Saving…' : 'Save console address'}
          </button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Needs a {service} service restart to take effect.
          </span>
        </div>

        {/* ⛔ THE DERIVED ENTRA REDIRECT URI IS DELIBERATELY NOT SHOWN HERE,
            even though it is derived from this value and changing this value
            changes it. `/api/system/entra` derives it from the provider's own
            id, and that id is load-bearing: a copy built by string-concatenation
            in this panel would be a SECOND implementation of the one string
            that has to match byte for byte, with nothing to keep the two in
            step. The Single sign-on section shows the real one — both of them
            when a change is pending — and says there that a save here moves it. */}
        <div style={{ marginTop: 16, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Changing this also changes the Entra Redirect URI that single sign-on needs registered.
          The Single sign-on section shows the exact string, and shows both the current and the
          post-restart value while a change here is pending.
        </div>
      </PanelCard>
    </div>
  )
}
