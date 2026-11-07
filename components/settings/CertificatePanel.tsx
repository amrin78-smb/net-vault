'use client'
//
// components/settings/CertificatePanel.tsx — Settings → Certificate (HTTPS).
// Reads /api/system/tls and installs a certificate pair through its POST.
//
// ⛔ THREE TRANSPORT STATES AND THEY READ DIFFERENTLY. `active` is fine,
// `disabled` is NORMAL — not configured is how the whole suite has shipped for
// its entire life and is not a fault — and `failed` is loud, because the
// operator asked for TLS and the console is serving plaintext anyway. A panel
// that renders `failed` like `disabled` lets an administrator read "no HTTPS
// here" and move on while the settings still name a certificate.
//
// ⛔ THE REPLACE PROMPT IS A QUESTION, NOT AN ERROR. A 409 with
// `needsConfirmation` means a pair is already installed at the target path and
// would be overwritten — possibly the only copy of a CA-issued certificate on
// the box. Both certificates are put side by side so the operator compares two
// real things, and the second action re-sends with `replace: true`.
//
// ⛔ BINARY UPLOADS ARE BASE64, WITH THE DATA-URL PREFIX STRIPPED. See
// `base64Payload` — the route's `Buffer.from(v,'base64')` does not throw on the
// prefix, it decodes garbage, and the resulting failure blames the password.
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
  StatePill,
} from './panelChrome.tsx'
import {
  base64Payload,
  chainPresentation,
  formatDaysRemaining,
  shadowPresentation,
  transportPresentation,
  worstShadow,
  type ShadowVerdictLike,
} from './systemPanelHelpers.ts'
import RestartControl from './RestartControl.tsx'

type CertDescription = {
  subject?: string
  issuer?: string
  sans?: string[]
  validFrom?: string
  validTo?: string
  daysRemaining?: number
  expired?: boolean
  selfSigned?: boolean
  chainLength?: number
  chain?: Array<{ subject: string; issuer: string }>
  parseError?: string | null
}

type TlsState = {
  status?: string | null
  summary?: string
  error?: string | null
  httpsPort?: number | null
  httpPort?: number | null
  /** ⛔ Tri-state: `null` means the NocVault-Tls probe could not read it. */
  fronted?: boolean | null
  /** The port a browser connects to when fronted; `null` when unknown. */
  publicPort?: number | null
  terminator?: string | null
  certPath?: string | null
  certPresent?: boolean
  /** A key path is configured. The path itself is deliberately never sent. */
  keyConfigured?: boolean
  keyPresent?: boolean
  certReadError?: string | null
  certificate?: CertDescription | null
  consoleUrl?: string | null
  nextAuthUrlMismatch?: string | null
  installTargets?: { certPath?: string; keyPath?: string }
  shadow?: Record<string, ShadowVerdictLike>
  shadowNotes?: string[]
  takesEffectOnRestart?: boolean | null
}

type ReplacePrompt = {
  reason?: string
  existingFiles?: string[]
  currentCertificate?: CertDescription | null
  incomingCertificate?: CertDescription | null
}

type InstallResult = {
  certPath?: string
  keyPath?: string
  backups?: string[]
  chainLength?: number
  chainOnly?: boolean
  certificate?: CertDescription
  envWritten?: boolean
  envError?: string | null
  previousStatus?: string
  takesEffectOnRestart?: boolean | null
  consoleUrlActionRequired?: string | null
  message?: string
}

/** Read one picked file as base64, with the data-URL prefix removed. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error(`${file.name} could not be read.`))
    reader.onload = () => resolve(base64Payload(String(reader.result || '')))
    reader.readAsDataURL(file)
  })
}

/** One certificate's facts — used for what is installed AND for both halves of
 *  the replace prompt, so the two are never described differently. */
function CertificateFacts({ cert, title }: { cert: CertDescription | null | undefined; title?: string }) {
  if (!cert) {
    return <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>No certificate.</div>
  }
  if (cert.parseError) {
    return (
      <Callout tone="danger" title={title ? `${title}: could not be parsed` : 'Could not be parsed'}>
        {cert.parseError}
      </Callout>
    )
  }
  const expiry = formatDaysRemaining(cert.daysRemaining)
  const chain = chainPresentation(cert.chainLength)
  return (
    <div>
      {title && (
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', marginBottom: 8 }}>
          {title}
        </div>
      )}
      <FactTable>
        <FactRow label="Subject"><Mono>{cert.subject || '—'}</Mono></FactRow>
        <FactRow label="Issuer">
          <Mono>{cert.issuer || '—'}</Mono>
          {cert.selfSigned && <> <StatePill tone="warn" title="Issued by itself — browsers will warn unless this certificate is trusted on every client.">Self-signed</StatePill></>}
        </FactRow>
        <FactRow label="Subject alt names">
          {cert.sans && cert.sans.length > 0
            ? <Mono>{cert.sans.join(', ')}</Mono>
            : <span style={{ color: 'var(--text-muted)' }}>None — modern browsers match the hostname against these, not the subject.</span>}
        </FactRow>
        <FactRow label="Valid">
          <Mono>{cert.validFrom || '—'}</Mono> <span style={{ color: 'var(--text-muted)' }}>to</span> <Mono>{cert.validTo || '—'}</Mono>
        </FactRow>
        <FactRow label="Expiry"><StatePill tone={expiry.tone}>{expiry.text}</StatePill></FactRow>
        <FactRow label="Chain">
          <StatePill tone={chain.tone}>{cert.chainLength ?? '—'} in file</StatePill>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>{chain.text}</div>
        </FactRow>
      </FactTable>
    </div>
  )
}

type Mode = 'paste' | 'upload'

export default function CertificatePanel({ canInstall = true }: { canInstall?: boolean }) {
  const { showToast } = useToast()
  const [state, setState] = useState<TlsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [mode, setMode] = useState<Mode>('paste')
  const [certText, setCertText] = useState('')
  const [keyText, setKeyText] = useState('')
  const [certFile, setCertFile] = useState<File | null>(null)
  const [keyFile, setKeyFile] = useState<File | null>(null)
  const [chainFile, setChainFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<ReplacePrompt | null>(null)
  const [result, setResult] = useState<InstallResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/system/tls', { cache: 'no-store' })
      const data = (await res.json()) as TlsState & { error?: string }
      if (!res.ok) {
        setLoadError(data?.error || `The certificate state could not be read (HTTP ${res.status}).`)
        setState(null)
      } else {
        setLoadError(null)
        setState(data)
      }
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Any edit withdraws a pending replace prompt — it belongs to one upload. */
  function touched() {
    setPrompt(null)
    setError(null)
  }

  async function buildBody(replace: boolean): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {}
    if (mode === 'paste') {
      if (certText.trim()) body.certificate = certText
      if (keyText.trim()) body.privateKey = keyText
    } else {
      if (certFile) body.certificateB64 = await readAsBase64(certFile)
      if (keyFile) body.privateKeyB64 = await readAsBase64(keyFile)
      if (chainFile) body.chainB64 = await readAsBase64(chainFile)
    }
    if (passphrase) body.passphrase = passphrase
    if (replace) body.replace = true
    return body
  }

  async function install(replace: boolean) {
    setBusy(true)
    setError(null)
    if (!replace) setPrompt(null)
    setResult(null)
    try {
      const res = await fetch('/api/system/tls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await buildBody(replace)),
      })
      const data = await res.json().catch(() => ({}))

      if (res.status === 409 && data?.needsConfirmation === true) {
        setPrompt({
          reason: data.reason,
          existingFiles: Array.isArray(data.existingFiles) ? data.existingFiles : [],
          currentCertificate: data.currentCertificate || null,
          incomingCertificate: data.incomingCertificate || null,
        })
        return
      }
      if (!res.ok || data?.ok !== true) {
        setPrompt(null)
        setError(data?.error || `The certificate could not be installed (HTTP ${res.status}).`)
        return
      }
      setPrompt(null)
      setResult({
        certPath: data.certPath,
        backups: Array.isArray(data.backups) ? data.backups : [],
        chainLength: data.chainLength,
        chainOnly: data.chainOnly,
        certificate: data.certificate,
        envWritten: data.envWritten,
        envError: data.envError ?? null,
        previousStatus: data.previousStatus,
        takesEffectOnRestart: data.takesEffectOnRestart ?? null,
        consoleUrlActionRequired: data.consoleUrlActionRequired ?? null,
        message: data.message,
      })
      setCertText('')
      setKeyText('')
      setCertFile(null)
      setKeyFile(null)
      setChainFile(null)
      setPassphrase('')
      // ⛔ The toast announces; the callout above holds the restart sentence
      // and the console-address follow-up, which must not scroll away with it.
      showToast(
        data.envWritten === false
          ? 'Certificate installed, but the TLS paths could not be saved'
          : 'Certificate installed — restart below to begin serving it',
        data.envWritten === false ? 'info' : 'success',
      )
      await load()
    } catch (e: unknown) {
      setPrompt(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <PanelCard title="Certificate"><PanelLoading /></PanelCard>

  if (loadError || !state) {
    return (
      <PanelCard title="Certificate">
        <Callout tone="danger" title="The certificate state could not be read">{loadError}</Callout>
      </PanelCard>
    )
  }

  // ⛔ Same as ConsoleAddressPanel: the route returns `fronted`/`publicPort`
  // and this file never mentioned either, so the Certificate tab reported the
  // loopback port as the HTTPS port on every fronted install.
  const transport = transportPresentation(state.status, {
    fronted: state.fronted ?? null,
    publicPort: state.publicPort ?? null,
    httpsPort: state.httpsPort,
    httpPort: state.httpPort,
    error: state.error,
  })
  const shadowKeys = ['TLS_CERT_PATH', 'TLS_KEY_PATH']
  const worst = worstShadow(shadowKeys.map((k) => state.shadow?.[k]))
  const shadowSummary = shadowPresentation(
    worst === 'clear' ? { state: 'clear' } : { state: worst, reason: '' },
    'the TLS paths',
  )
  const hasInput = mode === 'paste' ? certText.trim() !== '' : certFile !== null

  return (
    <div>
      <PanelCard
        title="Certificate"
        description={<>Whether this console is served over HTTPS, and which certificate it presents. The private key never leaves the server — only its file path is shown here.</>}
      >
        {/* ⛔ THE THREE STATES, EACH IN ITS OWN VOICE. */}
        <Callout
          tone={transport.tone}
          title={
            <>
              <StatePill tone={transport.tone}>{transport.label}</StatePill>
              {transport.loud && <span style={{ marginLeft: 8 }}>HTTPS is not working</span>}
              {transport.normal && <span style={{ marginLeft: 8 }}>This is not an error</span>}
            </>
          }
        >
          <div>{transport.headline}</div>
          {transport.loud && (
            <div style={{ marginTop: 6, fontWeight: 600 }}>
              Everything reaching this console — including sign-in credentials — is being sent in
              clear text. Fix the certificate below, or clear <Mono>TLS_CERT_PATH</Mono> and{' '}
              <Mono>TLS_KEY_PATH</Mono> on the server if HTTPS is no longer wanted.
            </div>
          )}
        </Callout>

        {state.nextAuthUrlMismatch && (
          <Callout tone="danger" title="The console address and the transport disagree">
            {state.nextAuthUrlMismatch} Change it on the Console address section.
          </Callout>
        )}

        <FactTable>
          <FactRow label="Certificate file">
            {state.certPath
              ? <>
                  <Mono>{state.certPath}</Mono>{' '}
                  <StatePill tone={state.certPresent ? 'ok' : 'danger'}>{state.certPresent ? 'Present' : 'Missing'}</StatePill>
                </>
              : <span style={{ color: 'var(--text-muted)' }}>Not configured</span>}
          </FactRow>
          <FactRow label="Private key file">
            {/* No path, by design — see app/api/system/tls/route.ts. The two
                booleans separate "none configured" from "configured but the
                file is gone", which is the only distinction this row needs. */}
            {state.keyConfigured
              ? <StatePill tone={state.keyPresent ? 'ok' : 'danger'}>{state.keyPresent ? 'Present' : 'Missing'}</StatePill>
              : <span style={{ color: 'var(--text-muted)' }}>Not configured</span>}
          </FactRow>
        </FactTable>

        {state.certReadError && (
          <div style={{ marginTop: 14 }}>
            <Callout tone="danger" title="The configured certificate could not be read">{state.certReadError}</Callout>
          </div>
        )}

        {state.certificate && (
          <div style={{ marginTop: 18 }}>
            <CertificateFacts cert={state.certificate} title="Installed certificate" />
          </div>
        )}

        {/* ⛔ THREE SHADOW STATES, SUMMARISED WORST-FIRST ACROSS BOTH KEYS; the
            route's own per-key notes are shown verbatim when it sent them. */}
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

      <PanelCard
        title="Install a certificate"
        description={
          <>Accepts a pasted PEM pair, a <Mono>.cer</Mono>/<Mono>.der</Mono> with its key file, or a{' '}
          <Mono>.pfx</Mono> with its password. The pair is checked against each other before a single
          byte is written, and whatever is there now is backed up beside itself.</>
        }
      >
        <div style={{ display: 'flex', gap: '8px', marginBottom: 16, flexWrap: 'wrap' }}>
          {([['paste', 'Paste PEM'], ['upload', 'Upload files (.cer / .der / .pfx)']] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); touched() }}
              className={mode === m ? 'btn-primary' : 'btn-secondary'}
              style={{ padding: '8px 16px' }}
            >{label}</button>
          ))}
        </div>

        {mode === 'paste' ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <div>
              <FieldLabel hint="Begins with -----BEGIN CERTIFICATE-----. Paste the full chain if you have it — leaf first.">Certificate (PEM)</FieldLabel>
              <textarea
                className="input"
                rows={7}
                spellCheck={false}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
                placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
                value={certText}
                onChange={(e) => { setCertText(e.target.value); touched() }}
                disabled={busy}
              />
            </div>
            <div>
              <FieldLabel hint="Begins with -----BEGIN PRIVATE KEY-----. An encrypted key is refused: a Windows service has nowhere to prompt for a passphrase at boot.">Private key (PEM)</FieldLabel>
              <textarea
                className="input"
                rows={5}
                spellCheck={false}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
                placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
                value={keyText}
                onChange={(e) => { setKeyText(e.target.value); touched() }}
                disabled={busy}
              />
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 16, maxWidth: 560 }}>
            <div>
              <FieldLabel hint="A .cer/.der/.crt/.pem certificate, or a .pfx/.p12 bundle that already contains the key.">Certificate file</FieldLabel>
              <input
                className="input"
                type="file"
                accept=".cer,.der,.crt,.pem,.pfx,.p12"
                disabled={busy}
                onChange={(e) => { setCertFile(e.target.files?.[0] || null); touched() }}
              />
            </div>
            <div>
              <FieldLabel hint="Not needed for a .pfx — the key is inside it.">Private key file (optional)</FieldLabel>
              <input
                className="input"
                type="file"
                accept=".key,.pem"
                disabled={busy}
                onChange={(e) => { setKeyFile(e.target.files?.[0] || null); touched() }}
              />
            </div>
            <div>
              <FieldLabel hint="Intermediates, if your CA sent them separately. Without them strict clients reject the certificate.">Chain file (optional)</FieldLabel>
              <input
                className="input"
                type="file"
                accept=".cer,.crt,.pem,.p7b"
                disabled={busy}
                onChange={(e) => { setChainFile(e.target.files?.[0] || null); touched() }}
              />
            </div>
          </div>
        )}

        <div style={{ marginTop: 16, maxWidth: 360 }}>
          <FieldLabel hint="Only for a .pfx / .p12 bundle. It is used to open the file and is never stored.">Password (.pfx only)</FieldLabel>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••"
            value={passphrase}
            disabled={busy}
            onChange={(e) => { setPassphrase(e.target.value); touched() }}
          />
        </div>

        {error && (
          <div style={{ marginTop: 16 }}>
            <Callout tone="danger" title="Refused — nothing was changed">{error}</Callout>
          </div>
        )}

        {/* ⛔ THE REPLACE PROMPT: two real certificates side by side, then one
            deliberate action. */}
        {prompt && (
          <div style={{ marginTop: 16 }}>
            <Callout
              tone="warn"
              title="A certificate is already installed here. Replace it?"
              actions={
                <>
                  {/* ⛔ `!canInstall` TOO. This prompt is only reachable after an
                      install attempt, which the main button already gates — but
                      the confirmation of a super_admin-only write must not be the
                      one control in the panel that forgets, and a disabled-only-
                      on-busy button here contradicts the read-only notice below. */}
                  <button className="btn-primary" disabled={busy || !canInstall} onClick={() => { void install(true) }}>
                    {busy ? 'Installing…' : 'Replace the installed certificate'}
                  </button>
                  <button className="btn-secondary" disabled={busy} onClick={() => setPrompt(null)}>
                    Keep the current one
                  </button>
                </>
              }
            >
              <div style={{ marginBottom: 10 }}>{prompt.reason}</div>
              {prompt.existingFiles && prompt.existingFiles.length > 0 && (
                <div style={{ marginBottom: 12, fontSize: 'var(--text-sm)' }}>
                  Files that would be replaced: {prompt.existingFiles.map((f, i) => (
                    <span key={f}>{i > 0 && ', '}<Mono>{f}</Mono></span>
                  ))}
                </div>
              )}
              <div style={{ display: 'grid', gap: 16 }}>
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '12px 14px' }}>
                  <CertificateFacts cert={prompt.currentCertificate} title="Installed now" />
                </div>
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '12px 14px' }}>
                  <CertificateFacts cert={prompt.incomingCertificate} title="Would be installed" />
                </div>
              </div>
            </Callout>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            {/* ⛔ THE RESTART SENTENCE, AFTER THE SAVE. node reads certificate
                material once at startup, so the files have changed and the
                running process is still holding the old certificate. */}
            <Callout tone={result.envWritten === false ? 'danger' : result.takesEffectOnRestart === true ? 'info' : 'warn'} title="Installed">
              <div>{result.message}</div>
              {result.chainOnly && (
                <div style={{ marginTop: 6 }}>
                  Only the leaf certificate was installed — no intermediate. It will validate in
                  browsers that have the intermediate cached and fail in strict clients.
                </div>
              )}
              {result.consoleUrlActionRequired && (
                <div style={{ marginTop: 6, fontWeight: 600 }}>
                  {result.consoleUrlActionRequired} Change it on the Console address section before
                  restarting, or sign-in will fail silently afterwards.
                </div>
              )}
              {result.backups && result.backups.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
                  Backed up: {result.backups.map((b, i) => <span key={b}>{i > 0 && ', '}<Mono>{b}</Mono></span>)}
                </div>
              )}
            </Callout>
            {result.certificate && <CertificateFacts cert={result.certificate} title="Installed certificate" />}
            {/* ⛔ AND THE RESTART THAT MAKES IT REAL — against the RIGHT
                service. A certificate is served by NocVault-Tls, never by
                NetVault; this panel used to say "restart NetVault", and
                following that leaves the OLD certificate being served while
                everything reports success. The control asks the server which
                service applies a certificate, and on a suite with no front
                door it correctly answers "nothing to restart". */}
            <div style={{ marginTop: 14 }}>
              {/* ⛔ `canRestart={canInstall}` — BOTH ARE super_admin. This used to
                  render with no role prop while `POST /api/system/service-restart`
                  is super_admin, so an `admin` got an enabled "Restart
                  NocVault-Tls now" that answered a bare 403 — in the same commit
                  that added the `canInstall` gate to the install button below. */}
              <RestartControl purpose="certificate" pending canRestart={canInstall} title="Installed — restart to begin serving it" />
            </div>
          </div>
        )}

        {/* ⛔ A BUTTON THE SERVER WILL REFUSE IS WORSE THAN NO BUTTON. The
            write is super_admin because the certificate installed here is the
            one all four consoles present through NocVault-Tls; an `admin` can
            still READ this tab for diagnostics. */}
        {!canInstall && (
          <Callout tone="info" title="Read-only for your role">
            Installing a certificate replaces the one all four consoles present, so it is restricted
            to a super admin. Everything above is current and accurate.
          </Callout>
        )}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 18 }}>
          <button
            className="btn-primary"
            style={{ padding: '10px 24px' }}
            disabled={busy || !hasInput || !canInstall}
            onClick={() => { void install(false) }}
          >
            {busy && !prompt ? 'Installing…' : 'Install certificate'}
          </button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {/* ⛔ NOT "a NetVault restart". NetVault never terminates TLS on
                this product — NocVault-Tls holds the certificate and reads it
                at ITS startup. Naming the wrong service here sent an operator
                to bounce a process that changes nothing. */}
            A restart is needed before it is served; this page offers it once the certificate is installed.
          </span>
        </div>
      </PanelCard>
    </div>
  )
}
