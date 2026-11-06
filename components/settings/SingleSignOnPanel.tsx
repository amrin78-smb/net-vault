'use client'
//
// components/settings/SingleSignOnPanel.tsx — Settings → Single sign-on.
// Reads and writes the three ENTRA_* values through /api/system/entra.
//
// ⛔ super_admin ONLY. The page does not render this for an `admin`, and the
// route refuses one as well — whoever sets the tenant decides WHICH DIRECTORY
// IS TRUSTED to issue identities for the whole suite, which is a privilege
// escalation rather than an outage.
//
// ⛔ THE CLIENT SECRET IS WRITE-ONLY. The API never returns it in any shape, so
// the box cannot be pre-filled, and A BLANK BOX MEANS "KEEP THE STORED SECRET",
// NOT "CLEAR IT". That is not a detail to leave implicit: an administrator who
// edits the tenant id, sees an empty secret box and saves would otherwise
// believe they had just wiped the credential — or, worse, believe they had
// replaced it when nothing was sent. The body omits `clientSecret` ENTIRELY
// unless something was typed, because `normaliseEntraInput` distinguishes
// absent (keep) from '' (clear) by the body's SHAPE, which is the only signal
// a write-only field can carry.
//
// ⛔ CLEARING ALL THREE IS HOW SSO IS TURNED OFF, and it has its own control.
// `planEntraWrite` refuses two blank ids with a message that names "Turn off
// single sign-on" by that exact wording, because emptying the boxes cannot
// express it — a blank secret box means keep.
//
// ⛔ THE REDIRECT URI IS DERIVED AND MUST MATCH BYTE FOR BYTE. A mismatch fails
// on Microsoft's side: the user gets an AADSTS page and nothing reaches this
// server's logs, so there is no trace here of the commonest setup mistake in
// the feature. It is shown with a copy button, never asked for.
//
// ⛔ EVERY COMPONENT IS AT MODULE TOP LEVEL (see panelChrome.tsx).

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/app/providers'
import {
  Callout,
  CopyValue,
  FactRow,
  FactTable,
  FieldLabel,
  Mono,
  PanelCard,
  PanelLoading,
  StatePill,
} from './panelChrome.tsx'
import { DirectoryMappingsCard } from './DirectoryMappingsCard.tsx'
// Pure, zero-import module: see the header in lib/redirectUri.ts for why it is
// not in lib/entraSettings.ts.
import { classifyRedirectUri } from '../../lib/redirectUri.ts'
import {
  pendingFieldSummary,
  redirectUriPresentation,
  shadowPresentation,
  takesEffectPresentation,
  worstShadow,
  type ShadowVerdictLike,
} from './systemPanelHelpers.ts'
import RestartControl from './RestartControl.tsx'

/** Obviously-fake, and the same example the route's own refusal quotes. */
const EXAMPLE_GUID = '11111111-2222-3333-4444-555555555555'

const ENTRA_KEYS = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET'] as const

type EntraState = {
  tenantIdSet?: boolean
  clientIdSet?: boolean
  clientSecretSet?: boolean
  tenantId?: string
  clientId?: string
  configured?: boolean
  runningConfigured?: boolean
  restartPending?: boolean
  restartPendingFields?: string[]
  restartRequiresService?: string
  redirectUri?: string | null
  redirectUriAfterRestart?: string | null
  consoleUrl?: string | null
  consoleUrlConfigured?: boolean
  shadow?: Record<string, ShadowVerdictLike>
  shadowNotes?: string[]
  takesEffectOnRestart?: boolean | null
  error?: string
}

type SaveResult = {
  disabled?: boolean
  configured?: boolean
  writtenFields?: string[]
  changedFields?: string[]
  takesEffectOnRestart?: boolean | null
  redirectUri?: string | null
  message?: string
}

type SaveFailure = {
  error: string
  /** The LABEL of the offending field, as the route named it. */
  field?: string | null
  nothingChanged?: boolean
  ssoDisabled?: boolean
  writtenFields?: string[]
}

export default function SingleSignOnPanel() {
  const { showToast } = useToast()
  const [state, setState] = useState<EntraState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  /** ⛔ ALWAYS STARTS EMPTY AND IS NEVER SEEDED FROM THE API — there is nothing
   *  to seed it from, and a placeholder that looked like a value would be a
   *  lie about what is stored. */
  const [clientSecret, setClientSecret] = useState('')

  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [confirmingOff, setConfirmingOff] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/system/entra', { cache: 'no-store' })
      const data = (await res.json()) as EntraState
      if (!res.ok) {
        setLoadError(data?.error || `Single sign-on settings could not be read (HTTP ${res.status}).`)
        setState(null)
      } else {
        setLoadError(null)
        setState(data)
        setTenantId((data.tenantId || '').trim())
        setClientId((data.clientId || '').trim())
        setClientSecret('')
      }
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function send(body: Record<string, unknown>) {
    setSaving(true)
    setFailure(null)
    setResult(null)
    try {
      const res = await fetch('/api/system/entra', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok !== true) {
        setFailure({
          error: data?.error || `Single sign-on could not be saved (HTTP ${res.status}).`,
          field: data?.field ?? null,
          nothingChanged: data?.nothingChanged,
          ssoDisabled: data?.ssoDisabled,
          writtenFields: Array.isArray(data?.writtenFields) ? data.writtenFields : [],
        })
        return
      }
      setResult({
        disabled: data.disabled,
        configured: data.configured,
        writtenFields: Array.isArray(data.writtenFields) ? data.writtenFields : [],
        changedFields: Array.isArray(data.changedFields) ? data.changedFields : [],
        takesEffectOnRestart: data.takesEffectOnRestart ?? null,
        redirectUri: data.redirectUri ?? null,
        message: data.message,
      })
      setClientSecret('')
      setConfirmingOff(false)
      // ⛔ The toast announces; the callout above holds the restart sentence
      // and the Redirect-URI instruction, which outlive it.
      showToast(
        data.disabled === true
          ? 'Single sign-on cleared — restart NetVault to apply it'
          : 'Single sign-on saved — restart NetVault to apply it',
        'success',
      )
      await load()
    } catch (e: unknown) {
      setFailure({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  /**
   * ⛔ `clientSecret` IS OMITTED WHEN THE BOX IS EMPTY. Absent means "keep the
   * stored secret"; `''` means "clear it", and only the dedicated off control
   * sends that. Sending `''` here would silently destroy a working credential
   * every time somebody corrected a typo in the application id.
   */
  function save() {
    const body: Record<string, unknown> = { tenantId: tenantId.trim(), clientId: clientId.trim() }
    if (clientSecret !== '') body.clientSecret = clientSecret
    void send(body)
  }

  /** ⛔ The one body that `planEntraWrite` treats as `disabling`. */
  function turnOff() {
    void send({ tenantId: '', clientId: '', clientSecret: '' })
  }

  // ⛔ THE MAPPINGS CARD RENDERS ON EVERY BRANCH, INCLUDING THE FAILURE ONE.
  // It was originally only in the success return, and a live check caught what
  // that means: /api/system/entra reads ENV FILES and 500s when it cannot (a
  // missing .env, a permissions problem, a half-finished deploy), and the
  // mappings are in the DATABASE and entirely unaffected. Hiding them behind an
  // unrelated failure takes the group -> role table away from an administrator
  // at the moment they are most likely to be trying to fix a sign-in problem.
  //
  // `null` is passed where this component does not KNOW whether single sign-on
  // is configured — the card then states the consequence of an empty list
  // without asserting anything about the tenant it could not read.
  const mappings = (ssoConfigured: boolean | null) => (
    <div style={{ marginTop: 20 }}>
      <DirectoryMappingsCard ssoConfigured={ssoConfigured} />
    </div>
  )

  if (loading) {
    return (
      <div>
        <PanelCard title="Single sign-on"><PanelLoading /></PanelCard>
        {mappings(null)}
      </div>
    )
  }

  if (loadError || !state) {
    return (
      <div>
        <PanelCard title="Single sign-on">
          <Callout tone="danger" title="Single sign-on settings could not be read">{loadError}</Callout>
        </PanelCard>
        {mappings(null)}
      </div>
    )
  }

  const service = state.restartRequiresService || 'NetVault'
  const redirect = redirectUriPresentation(state.redirectUri, state.redirectUriAfterRestart)
  // Classified against what Entra will actually take. `afterRestart` is checked
  // in preference when there is one: that is the value the install is heading
  // for, and warning about a URI that is about to be replaced would send an
  // administrator to fix something they have already fixed.
  const redirectVerdict = classifyRedirectUri(redirect.afterRestart || redirect.current)
  const pending = pendingFieldSummary(state.restartPendingFields, service)
  const worst = worstShadow(ENTRA_KEYS.map((k) => state.shadow?.[k]))
  const shadowSummary = shadowPresentation(
    worst === 'clear' ? { state: 'clear' } : { state: worst, reason: '' },
    'the ENTRA_* keys',
    service,
  )

  return (
    <div>
      <PanelCard
        title="Single sign-on"
        description={
          <>Lets people sign in with their Microsoft Entra ID account instead of a password held
          here. All three values below are required together — with any one of them blank the
          provider is not registered at all and no sign-in button appears, which is the normal
          state of an install that does not use it.</>
        }
      >
        <FactTable>
          <FactRow label="Saved configuration">
            {state.configured
              ? <StatePill tone="ok">Complete — all three values are set</StatePill>
              : <StatePill tone="neutral">Off — not all three values are set</StatePill>}
          </FactRow>
          <FactRow label="Currently running">
            {state.runningConfigured
              ? <StatePill tone="ok">Single sign-on is live</StatePill>
              : <StatePill tone="neutral">Single sign-on is not running</StatePill>}
          </FactRow>
          <FactRow label="Directory (tenant) ID">
            {state.tenantIdSet ? <Mono>{state.tenantId}</Mono> : <span style={{ color: 'var(--text-muted)' }}>Not set</span>}
          </FactRow>
          <FactRow label="Application (client) ID">
            {state.clientIdSet ? <Mono>{state.clientId}</Mono> : <span style={{ color: 'var(--text-muted)' }}>Not set</span>}
          </FactRow>
          <FactRow label="Client secret">
            {/* ⛔ WHETHER ONE EXISTS, NEVER THE VALUE — the API does not return
                it and there is nothing here to render even if it did. */}
            {state.clientSecretSet
              ? <StatePill tone="ok" title="Stored on the server. It is never sent back to this page.">Stored</StatePill>
              : <StatePill tone="neutral">Not stored</StatePill>}
          </FactRow>
        </FactTable>

        {/* ⛔ SAVED vs RUNNING, WITH THE API'S OWN FIELD LABELS. The secret is
            compared on the server precisely so its label — and nothing else —
            can travel; a label invented here would be a guess about the one
            field we are not allowed to see. */}
        {pending && (
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn" title="Saved, but not yet in force">
              {pending}
              <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
                Until then the running process keeps presenting the previous values to Microsoft.
                For a rotated secret that means every sign-in fails with nothing on screen saying why.
              </div>
            </Callout>
            {/* And the restart that applies it, rather than a sentence telling
                an administrator to go and find a console on the server. */}
            <RestartControl purpose="sso" pending title="Restart to apply the directory settings" />
          </div>
        )}

        {shadowSummary.show && (
          <div style={{ marginTop: 14 }}>
            <Callout tone={shadowSummary.tone} title={shadowSummary.label}>
              {state.shadowNotes && state.shadowNotes.length > 0
                ? <ul style={{ margin: 0, paddingLeft: 18 }}>{state.shadowNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                : shadowSummary.detail}
            </Callout>
          </div>
        )}
      </PanelCard>

      {/* ⛔ PROMINENT, AND ABOVE THE FORM. This is the value that has to be
          registered in Entra, it is derived rather than typed, and getting it
          wrong fails on Microsoft's side with an error that never reaches us. */}
      <PanelCard
        title="Redirect URI to register"
        description={<>Add this to the app registration in Entra under <Mono>Authentication → Web → Redirect URIs</Mono>. It is derived from the console address — it is not something you choose, and it has to match byte for byte.</>}
      >
        {!redirect.current ? (
          <Callout tone="warn" title="No console address is set">
            The Redirect URI is derived from the console address, so it cannot be worked out yet.
            Set the console address first.
          </Callout>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              {redirect.bothRequired && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600 }}>
                  In force now
                </div>
              )}
              <CopyValue value={redirect.current} label="redirect URI" />
            </div>
            {redirect.bothRequired && redirect.afterRestart && (
              <div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600 }}>
                  After the pending {service} restart
                </div>
                <CopyValue value={redirect.afterRestart} label="redirect URI after restart" />
              </div>
            )}
            {redirect.note && <Callout tone="warn" title="Register both of these">{redirect.note}</Callout>}

            {/* ⛔ ENTRA WILL NOT ACCEPT AN IP ADDRESS, AND EVERY INSTALL STARTS
                ON ONE. NEXTAUTH_URL is baked to the server's address at install
                time, so the derived URI above is an IP URI until somebody sets
                a hostname — and this card presented it as the string to
                register, confidently, when the portal will refuse the paste.
                That refusal happens on MICROSOFT'S side: nothing about it
                reaches this server, so there is no log line and no audit row,
                and the administrator is left believing they copied it wrong.
                Same for the scheme: https is required for anything but
                loopback, so an install whose TLS cutover has not run cannot use
                single sign-on either. Verified in the field on SecVault. */}
            {redirectVerdict.problems.length > 0 && (
              <Callout
                tone="warn"
                title={
                  redirectVerdict.kind === 'ip'
                    ? 'Entra will not accept this Redirect URI'
                    : 'This Redirect URI cannot be registered as it stands'
                }
              >
                {redirectVerdict.problems.map((p, i) => (
                  <div key={i} style={{ marginBottom: i === redirectVerdict.problems.length - 1 ? 0 : 6 }}>{p}</div>
                ))}
                <div style={{ marginTop: 8, fontSize: 'var(--text-sm)' }}>
                  Registering it will be refused by the Entra portal, and that refusal happens at
                  Microsoft — nothing about it reaches this server, so there will be nothing here
                  to explain it. Change the console address under
                  {' '}<strong>Settings → Console address</strong>, then come back: this value
                  follows it automatically.
                </div>
              </Callout>
            )}
          </div>
        )}
      </PanelCard>

      <PanelCard title="Change single sign-on">
        <div style={{ display: 'grid', gap: 18, maxWidth: 560 }}>
          <div>
            <FieldLabel hint={<>The directory this product trusts to issue identities. Copy it from the app registration Overview page. A GUID, e.g. <Mono>{EXAMPLE_GUID}</Mono>.</>}>
              Directory (tenant) ID
            </FieldLabel>
            <input
              className="input"
              spellCheck={false}
              value={tenantId}
              placeholder={EXAMPLE_GUID}
              disabled={saving}
              onChange={(e) => { setTenantId(e.target.value); setFailure(null) }}
            />
          </div>
          <div>
            <FieldLabel hint="From the same Overview page — not the Object ID and not the secret ID.">
              Application (client) ID
            </FieldLabel>
            <input
              className="input"
              spellCheck={false}
              value={clientId}
              placeholder={EXAMPLE_GUID}
              disabled={saving}
              onChange={(e) => { setClientId(e.target.value); setFailure(null) }}
            />
          </div>
          <div>
            <FieldLabel
              hint={
                <>
                  <strong style={{ color: 'var(--text-secondary)' }}>
                    Leave this blank to keep the secret that is already stored.
                  </strong>{' '}
                  Blank does not clear it. The secret is never sent back to this page, so this box
                  cannot be pre-filled and an empty box tells you nothing about whether one exists
                  — the row above does. Paste the secret <em>value</em> (not the secret ID) only
                  when you are replacing it.
                </>
              }
            >
              Client secret
              {state.clientSecretSet && <> <StatePill tone="ok">A secret is stored</StatePill></>}
            </FieldLabel>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={clientSecret}
              placeholder={state.clientSecretSet ? 'Leave blank to keep the stored secret' : 'Paste the secret value'}
              disabled={saving}
              onChange={(e) => { setClientSecret(e.target.value); setFailure(null) }}
            />
            {clientSecret !== '' && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tint-warn-fg)', marginTop: 6 }}>
                Saving now replaces the stored secret. The old one stops working at the next restart.
              </div>
            )}
          </div>
        </div>

        {failure && (
          <div style={{ marginTop: 16 }}>
            <Callout
              tone="danger"
              title={failure.nothingChanged === false || failure.ssoDisabled ? 'Failed part-way — single sign-on is now OFF' : 'Refused — nothing was changed'}
            >
              <div>{failure.error}</div>
              {failure.field && (
                <div style={{ marginTop: 6, fontWeight: 600 }}>Field: {failure.field}</div>
              )}
              {failure.writtenFields && failure.writtenFields.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
                  Already written: {failure.writtenFields.join(', ')}.
                </div>
              )}
            </Callout>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            {/* ⛔ THE RESTART SENTENCE AFTER THE SAVE, not only in help text.
                NextAuth builds its provider array once at startup, so the
                sign-in button does not appear until the service restarts — and
                an administrator who does not know that concludes it is broken. */}
            <Callout tone={result.takesEffectOnRestart === true ? 'info' : 'warn'} title={result.disabled ? 'Single sign-on cleared' : 'Saved'}>
              <div>{result.message || takesEffectPresentation(result.takesEffectOnRestart, service).text}</div>
              {result.changedFields && result.changedFields.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
                  Changed: {result.changedFields.join(', ')}.
                </div>
              )}
            </Callout>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
          <button className="btn-primary" style={{ padding: '10px 24px' }} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save single sign-on'}
          </button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Needs a {service} service restart to take effect.
          </span>
        </div>
      </PanelCard>

      <PanelCard
        title="Turn off single sign-on"
        description={<>Switching it off means clearing all three values together — the tenant, the application id and the stored secret. Emptying the boxes above cannot do it, because a blank secret box means &ldquo;keep the stored secret&rdquo;.</>}
      >
        {!confirmingOff ? (
          <button
            className="btn-secondary"
            style={{ padding: '10px 20px' }}
            disabled={saving || !(state.tenantIdSet || state.clientIdSet || state.clientSecretSet)}
            onClick={() => { setConfirmingOff(true); setFailure(null); setResult(null) }}
          >
            Turn off single sign-on
          </button>
        ) : (
          <Callout
            tone="warn"
            title="Clear the tenant, the application id and the stored secret?"
            actions={
              <>
                <button className="btn-danger" style={{ padding: '8px 16px' }} disabled={saving} onClick={turnOff}>
                  {saving ? 'Clearing…' : 'Yes, clear all three'}
                </button>
                <button className="btn-secondary" style={{ padding: '8px 16px' }} disabled={saving} onClick={() => setConfirmingOff(false)}>
                  Cancel
                </button>
              </>
            }
          >
            The stored client secret is deleted from the environment files and cannot be recovered
            from here — you would have to generate a new one in Entra to switch single sign-on back
            on. Local accounts keep working, and nobody who signs in through the directory can sign
            in after the next {service} restart.
          </Callout>
        )}
      </PanelCard>

      {/* The second half of directory sign-in: the tenant above decides which
          directory is trusted, this decides what an identity from it becomes.
          Rendered here rather than wired into the Settings page separately so
          the two always appear together — a tenant with no mappings is a
          configuration that looks finished and refuses everyone, and the
          warning that says so is in that card. */}
      {mappings(Boolean(state.configured))}
    </div>
  )
}
