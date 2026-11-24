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
import RestartControl from './RestartControl.tsx'
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
  consoleDrift,
  consoleStatePresentation,
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

/**
 * One of the four consoles, as GET reports it.
 *
 * ⛔ `locatable` IS `true` OR `null` AND NEVER `false` — the route cannot tell
 * "that console is not installed" from "the registry could not be read", so it
 * does not claim either. This panel renders `null` as "could not check".
 */
type AppRow = {
  slug?: string
  label?: string
  service?: string
  publicPort?: number
  locatable?: boolean | null
  appDirectory?: string | null
  note?: string | null
  /** The deploy-source value: what the next deploy propagates. */
  saved?: string | null
  /** ⛔ For a satellite this is a FILE, not that process's environment. */
  running?: string | null
  runningSource?: 'process' | 'file' | null
  /** What this console's address should be, derived from the hub's. */
  expected?: string | null
  matchesExpected?: boolean | null
  files?: FileReport[]
  shadow?: ShadowVerdictLike
  shadowNote?: string | null
  takesEffectOnRestart?: boolean | null
  restartServices?: string[]
  /** Only on a PUT response: what the write did. */
  state?: string
  /** Only on a PUT response: the address written, `null` when nothing was. */
  url?: string | null
  error?: string | null
}

type ConsoleUrlState = {
  saved?: string | null
  running?: string | null
  restartPending?: boolean
  restartRequiresService?: string
  files?: FileReport[]
  apps?: AppRow[]
  shadow?: ShadowVerdictLike
  shadowNote?: string | null
  takesEffectOnRestart?: boolean | null
  transport?: {
    status?: string | null
    httpsPort?: number | null
    httpPort?: number | null
    error?: string | null
    /** ⛔ Tri-state: `null` means the NocVault-Tls probe could not read it. */
    fronted?: boolean | null
    /** The port a browser connects to when fronted; `null` when unknown. */
    publicPort?: number | null
  }
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
  /** Per console, in the order written — the hub first. */
  apps?: AppRow[]
  /** The services the consoles that actually changed need restarted. */
  restartServices?: string[]
}

/**
 * ⛔ `canRestart` IS A PROP, NOT A SESSION READ IN HERE. The settings page
 * already holds `isSuperAdmin` and passes the same distinction to
 * `CertificatePanel` as `canInstall`; a second, independent way of answering
 * "who is this" inside a panel is how two parts of one tab end up disagreeing.
 */
export default function ConsoleAddressPanel({ canRestart = true }: { canRestart?: boolean }) {
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
        // ⛔ KEPT ON SCREEN PER CONSOLE. Three of these four products have no
        // settings page of their own, so this is the only place an operator
        // ever sees whether their address was written, shadowed by a service
        // environment pin, or not even located.
        apps: Array.isArray(data.apps) ? (data.apps as AppRow[]) : [],
        restartServices: Array.isArray(data.restartServices) ? data.restartServices : [],
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
  // ⛔ PASS THE TERMINATOR FRAME. Without `fronted`/`publicPort` the helper's
  // whole fronted branch is unreachable, and this panel states the loopback
  // port as the address people connect to. The route has computed these since
  // 1.60.1; nothing was reading them.
  const transport = transportPresentation(state.transport?.status, {
    httpsPort: state.transport?.httpsPort,
    httpPort: state.transport?.httpPort,
    error: state.transport?.error,
    fronted: state.transport?.fronted ?? null,
    publicPort: state.transport?.publicPort ?? null,
  })
  const shadow = shadowPresentation(state.shadow, 'NEXTAUTH_URL', service)
  const pair = savedVsRunning(state.saved, state.running)
  const examplePort = state.examplePort || 3000
  const exampleScheme = state.transport?.status === 'active' ? 'https' : 'http'
  // The four rows, with the just-saved outcome merged onto the GET reading so
  // the table does not go back to "Not compared" the moment a save returns.
  const rows: AppRow[] = (state.apps || []).map((row) => {
    const written = (result?.apps || []).find((w) => w.slug === row.slug)
    return written ? { ...row, ...written } : row
  })
  // ⛔ WHICH CONSOLES ARE ACTUALLY OUT OF STEP, not "all four". Offering to
  // restart a console whose address already matches interrupts it for nothing.
  const driftedSlugs = rows
    .filter((r) => consoleDrift(r.expected, r.saved).drifted === true)
    .map((r) => String(r.slug))
  // ⛔ "SOMETHING LANDED", NOT "THE STATE SAYS saved". A console whose pin
  // status could not be read is `unknown` and its files were still written — so
  // it still needs the restart, and withholding one would guarantee the value
  // never takes effect. `url` is set for exactly the consoles that were written.
  const savedSlugs = (result?.apps || [])
    .filter((r) => typeof r.url === 'string' && r.url !== '')
    .map((r) => String(r.slug))
  // The hub's own pending change is still decided by saved-vs-running, which is
  // the only one of the four where the RUNNING value is this process's own
  // environment rather than a file another product's process read.
  const restartApps = [...new Set([...(pair.differs ? ['netvault'] : []), ...savedSlugs, ...driftedSlugs])]

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

        {(pair.differs || restartApps.length > 0) && (
          <div style={{ marginTop: 14 }}>
            {/* ⛔ THE RESTART IS OFFERED, NOT DESCRIBED. This used to be a
                sentence ending "until the NetVault service is restarted",
                which is only actionable by somebody with a console on the
                server - so the product could save a change it could not
                apply. The control asks the SERVER which service applies this
                change; it never names one itself. */}
            {/* ⛔ `canRestart` — `POST /api/system/service-restart` IS super_admin
                WHILE THIS PANEL IS admin+. An `admin` may legitimately save a
                console address (an outage is not a privilege escalation, which
                is why the save route is admin+), but bouncing the service for
                the whole site is a step beyond editing a value. Rendered with no
                role prop, this showed them an enabled button that answered 403. */}
            <RestartControl purpose="console-address" pending={pair.differs || restartApps.length > 0} canRestart={canRestart} apps={restartApps} />
          </div>
        )}

        {/* ⛔ A scheme that disagrees with the real transport breaks every
            sign-in with no error anywhere, so it is loud. */}
        {state.schemeMismatch && (
          <div style={{ marginTop: pair.differs || restartApps.length > 0 ? 0 : 14 }}>
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

      {/* ⛔ ALL FOUR CONSOLES, BECAUSE THREE OF THEM HAVE NO SETTINGS PAGE.
          A satellite's NEXTAUTH_URL is exactly `<hub scheme>://<hub host>:<its
          port>` — it carries no independent information — and because nothing
          in the product could set the other three, production drifted: the hub
          on the public name, all three satellites still on the raw install-time
          server IP, leaking it into every NextAuth callback and sending users
          to an address the certificate does not cover. This table is the only
          place that is visible, and the Save below writes all four. */}
      <PanelCard
        title="The four consoles"
        description={
          <>Each console signs its own cookies for its own address. They are all the same host
          and transport as this one — only the port differs — so saving the address above writes
          all four. <Mono>Expected</Mono> is derived from the address above; a console that does
          not match it is still issuing sign-in callbacks for an older address.</>
        }
      >
        <FactTable>
          {rows.map((row, i) => {
            const pill = consoleStatePresentation(row.state)
            const drift = consoleDrift(row.expected, row.saved)
            const unknown = row.locatable !== true
            return (
              <FactRow key={row.slug || i} label={`${row.label || row.slug} · port ${row.publicPort ?? '—'}`}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* ⛔ THE SAVE OUTCOME ONLY ONCE THERE HAS BEEN ONE. Before a
                      save there is nothing to report, and `consoleStatePresentation`
                      fails closed to "could not check" — which would be a
                      warning about a save nobody asked for yet. */}
                  {row.state && <StatePill tone={pill.tone}>{pill.label}</StatePill>}
                  <StatePill tone={unknown ? 'warn' : drift.tone}>
                    {unknown ? 'Could not check' : drift.label}
                  </StatePill>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                    {row.service}
                  </span>
                </div>
                <div style={{ marginTop: 6, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <div>Expected: {row.expected ? <Mono>{row.expected}</Mono> : 'not derived — set the address above first'}</div>
                  <div>
                    Saved: {row.saved ? <Mono>{row.saved}</Mono> : unknown ? 'not read' : 'not set'}
                  </div>
                  {/* ⛔ SAY WHAT "RUNNING" IS EVIDENCE OF. For this console it is
                      its own process environment; for the other three it is the
                      file that console's process loaded at ITS startup, which is
                      not proof of what it currently holds — the hub cannot read
                      another process's environment. */}
                  {row.running && (
                    <div>
                      {row.runningSource === 'process' ? 'In force now' : 'In its running file'}:{' '}
                      <Mono>{row.running}</Mono>
                    </div>
                  )}
                </div>
                {/* ⛔ A FAILED READ IS SAID OUT LOUD, PER CONSOLE, AND THE OTHER
                    THREE STILL PROCEED. "Could not locate LogVault's environment
                    files" is an unknown, not a clean state. */}
                {(row.note || row.error) && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 'var(--text-sm)',
                      color: row.error ? 'var(--tint-danger-fg)' : 'var(--tint-warn-fg)',
                      lineHeight: 1.6,
                    }}
                  >
                    {row.error || row.note}
                  </div>
                )}
                {(row.files || []).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {(row.files || []).map((f, fi) => {
                      const fp = filePresentation(f)
                      return (
                        <div key={f.path || fi} style={{ fontSize: 'var(--text-sm)', marginTop: 4 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{fileRoleLabel(f.role)}: </span>
                          <Mono>{f.path}</Mono>{' '}
                          <StatePill tone={fp.tone}>{fp.label}</StatePill>
                          {fp.detail && (
                            <span style={{ color: 'var(--tint-danger-fg)' }}> {fp.detail}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {row.shadowNote && (
                  <div style={{ marginTop: 6, fontSize: 'var(--text-sm)', color: 'var(--tint-warn-fg)', lineHeight: 1.6 }}>
                    {row.shadowNote}
                  </div>
                )}
              </FactRow>
            )
          })}
        </FactTable>
      </PanelCard>

      <PanelCard title="Per-file state" description="This console's own NEXTAUTH_URL is written to both of these. If they disagree, the running file is what this process read at startup.">
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
                  <button className="btn-primary readonly-allowed" disabled={saving} onClick={() => { void save(true) }}>
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
            className="btn-primary readonly-allowed"
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
