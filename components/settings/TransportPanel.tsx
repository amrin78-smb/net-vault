'use client'
//
// components/settings/TransportPanel.tsx — Settings → HTTPS.
//
// The Certificate panel manages the certificate; this one manages whether the
// suite USES it. Until now that was `installer\Enable-NocVaultTls.ps1` on the
// server's console, which made HTTPS the one transport decision an
// administrator could not make from the product they bought.
//
// ⛔ EVERY COMPONENT AT MODULE TOP LEVEL (CLAUDE.md's first critical rule) and
// no Tailwind, no hardcoded hex — tokens only, so it flips in dark mode.
//
// ⛔ THIS PANEL DELIBERATELY DOES NOT AUTO-REDIRECT AFTER ENABLING. Turning
// HTTPS on moves this console from http to https on the SAME port, which is a
// different origin; the browser will not have accepted the self-signed
// certificate yet, so a scripted redirect or a cross-origin poll fails in a way
// indistinguishable from "the cutover broke". Only a human can click through a
// certificate warning, so the panel hands them a link and says plainly what to
// expect. An auto-redirect here would be a worse lie than no redirect.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Callout, FactRow, FactTable, FieldLabel, Mono, PanelCard, PanelLoading, StatePill,
} from './panelChrome.tsx'
import { transportPresentation, type Tone } from './systemPanelHelpers.ts'
import { destinationUrl, type RunOutcome, type TransportAction } from '@/lib/tlsTransport.ts'

type TransportState = {
  status: string | null
  summary: string | null
  error: string | null
  httpsPort: number | null
  httpPort: number | null
  certPath: string | null
  keyPath: string | null
  publicHost: string | null
  terminator: 'running' | 'stopped' | 'absent' | 'unknown'
  terminatorDetail: string | null
  boundPort: string | null
  boundHostname: string | null
  ports: Array<{ app: string; port: number }>
  scriptPresent: boolean
  runInProgress: boolean
  logPath: string | null
  logError: string | null
  lastRun: {
    outcome: RunOutcome
    action: TransportAction | null
    exitCode: number | null
    finished: boolean
    highlights: string[]
    lines: string[]
  }
  canEnable: boolean
  canDisable: boolean
  canPreview: boolean
  blockedReason: string | null
}

/** How the terminator's service state reads. */
function terminatorPresentation(state: TransportState['terminator'], detail: string | null): { tone: Tone; label: string; text: string } {
  if (state === 'running') {
    return { tone: 'ok', label: 'Running', text: 'The shared TLS front door is running and owns the four public ports.' }
  }
  if (state === 'absent') {
    return { tone: 'neutral', label: 'Not installed', text: 'HTTPS has never been turned on for this installation. The consoles serve directly.' }
  }
  if (state === 'stopped') {
    return {
      tone: 'warn',
      label: 'Installed but stopped',
      text:
        'The front door is registered and not running, so nothing is listening on the public ports. '
        + 'Turn HTTPS off to put the consoles back on them, or start the NocVault-Tls service.',
    }
  }
  return {
    tone: 'warn',
    label: 'Not checked',
    text:
      `Whether the NocVault-Tls service is running could not be read${detail ? ` (${detail})` : ''}. `
      + 'This is an unchecked condition, not a clean bill of health.',
  }
}

/**
 * How the last run reads.
 *
 * ⛔ `reverted` IS NOT A FAILURE MESSAGE WITH A SHRUG. The engine moved four
 * consoles, could not prove HTTPS, and put everything back — the suite is
 * fine, the ATTEMPT failed, and those are different sentences. And `reverted`
 * must never read like `enabled`: the engine exits 0 for both.
 */
function runPresentation(run: TransportState['lastRun']): { tone: Tone; title: string; text: string } | null {
  switch (run.outcome) {
    case 'none':
      return null
    case 'running':
      return { tone: 'info', title: 'A change is running', text: 'The engine is working. This panel is following its output below.' }
    case 'previewed':
      return { tone: 'info', title: 'Preview finished', text: 'Nothing was changed. The lines below are what a real run would do.' }
    case 'enabled':
      return { tone: 'ok', title: 'HTTPS was turned on', text: 'Every installed console answered over HTTPS through the front door.' }
    case 'disabled':
      return { tone: 'ok', title: 'HTTPS was turned off', text: 'The consoles are serving directly over plain HTTP again.' }
    case 'reverted':
      return {
        tone: 'warn',
        title: 'The change was abandoned and undone',
        text:
          'A gate did not pass, so the engine put every console back the way it found it — the suite '
          + 'is serving exactly as it was before. The lines below say which gate and why.',
      }
    default:
      return {
        tone: 'warn',
        title: 'The last run ended without a verdict',
        text:
          'The engine finished but printed no outcome this build recognises, so what it did is '
          + 'unknown. Read the log on the server before acting on this.',
      }
  }
}

/** The engine's own output, verbatim. */
function LogBlock({ lines, label }: { lines: string[]; label: string }) {
  if (lines.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <pre style={{
        margin: 0, padding: '12px 14px', background: 'var(--surface-subtle)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
        color: 'var(--text-primary)', lineHeight: 1.6, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>{lines.join('\n')}</pre>
    </div>
  )
}

const ACTION_LABEL: Record<TransportAction, string> = {
  preview: 'Preview',
  enable: 'Turn HTTPS on',
  disable: 'Turn HTTPS off',
}

export default function TransportPanel() {
  const [state, setState] = useState<TransportState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<TransportAction | null>(null)
  const [publicHost, setPublicHost] = useState('')
  const [hostTouched, setHostTouched] = useState(false)
  /** The action we started in THIS browser session, for the "what now" message. */
  const [started, setStarted] = useState<TransportAction | null>(null)
  const [contactLost, setContactLost] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const res = await fetch('/api/system/tls-transport', { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `The server answered ${res.status}.`)
      }
      const data = (await res.json()) as TransportState
      setState(data)
      setLoadError(null)
      setContactLost(false)
      // Seed the field from what is configured, but never fight the operator's
      // typing once they have started.
      if (!hostTouched) setPublicHost(data.publicHost || '')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // ⛔ DURING A CUTOVER THIS IS EXPECTED, NOT AN ERROR. The console is
      // moving ports; a failed poll here means the change is happening, and
      // showing it as a fault would send an operator chasing a problem that is
      // the feature working.
      if (started) setContactLost(true)
      else setLoadError(message)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [hostTouched, started])

  useEffect(() => { void load() }, [load])

  // Follow a run while one is in flight.
  useEffect(() => {
    const inFlight = Boolean(state?.runInProgress) || state?.lastRun.outcome === 'running' || (started !== null && !contactLost)
    if (!inFlight) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(() => { void load(true) }, 3000)
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [state?.runInProgress, state?.lastRun.outcome, started, contactLost, load])

  const run = useCallback(async (action: TransportAction) => {
    setBusy(true)
    setError(null)
    setConfirming(null)
    try {
      const res = await fetch('/api/system/tls-transport', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, publicHost: publicHost.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `The server answered ${res.status}.`)
      if (action !== 'preview') setStarted(action)
      await load(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [publicHost, load])

  if (loading) {
    return <PanelCard title="HTTPS"><PanelLoading /></PanelCard>
  }

  if (loadError || !state) {
    return (
      <PanelCard title="HTTPS">
        <Callout tone="danger" title="The transport could not be read">
          {loadError || 'No answer from the server.'}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn-secondary" onClick={() => void load()} style={{ padding: '8px 16px' }}>Try again</button>
          </div>
        </Callout>
      </PanelCard>
    )
  }

  const transport = transportPresentation(state.status, {
    httpsPort: state.httpsPort, httpPort: state.httpPort, error: state.error,
  })
  const term = terminatorPresentation(state.terminator, state.terminatorDetail)
  const runReport = runPresentation(state.lastRun)
  const browserHost = typeof window !== 'undefined' ? window.location.hostname : ''
  const movingTo = started
    ? destinationUrl({ action: started, browserHost, publicHost: publicHost.trim(), port: state.httpsPort || 3000 })
    : null
  const onLoopback = /^1300\d$/.test(state.boundPort || '')

  return (
    <>
      <PanelCard
        title="HTTPS"
        description={
          <>
            Whether this suite is served over HTTPS. Turning it on puts a shared TLS front door in front
            of all four consoles on the ports they already use, so existing links keep working — old{' '}
            <Mono>http://</Mono> addresses are answered with a redirect. The certificate itself is managed
            on the Certificate tab.
          </>
        }
      >
        {transport.loud && <Callout tone="danger" title={transport.label}>{transport.headline}</Callout>}

        <FactTable>
          <FactRow label="This console">
            <StatePill tone={transport.tone}>{transport.label}</StatePill>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>{transport.headline}</span>
          </FactRow>
          <FactRow label="TLS front door">
            <StatePill tone={term.tone}>{term.label}</StatePill>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>{term.text}</span>
          </FactRow>
          <FactRow label="Console bound to">
            {state.boundPort
              ? <><Mono>{`${state.boundHostname || '0.0.0.0'}:${state.boundPort}`}</Mono>{onLoopback && <> <StatePill tone="ok" title="Only reachable through the TLS front door">Loopback only</StatePill></>}</>
              : <span style={{ color: 'var(--text-muted)' }}>Not reported by this process</span>}
          </FactRow>
          <FactRow label="Certificate">
            {state.certPath
              ? <Mono>{state.certPath}</Mono>
              : <span style={{ color: 'var(--text-muted)' }}>None configured — one will be generated when you turn HTTPS on</span>}
          </FactRow>
          <FactRow label="Public hostname">
            {state.publicHost
              ? <Mono>{state.publicHost}</Mono>
              : <span style={{ color: 'var(--text-muted)' }}>Not set — the address each browser asks for is used</span>}
          </FactRow>
          <FactRow label="Ports affected">
            <span style={{ color: 'var(--text-secondary)' }}>
              {state.ports.map(p => `${p.app} ${p.port}`).join(' · ')}
            </span>
          </FactRow>
        </FactTable>
      </PanelCard>

      <PanelCard title="Change the transport">
        {state.blockedReason && <Callout tone="warn" title="Not available right now">{state.blockedReason}</Callout>}
        {error && <Callout tone="danger" title="That did not start">{error}</Callout>}

        {!state.blockedReason && (
          <>
            <div style={{ marginBottom: 16, maxWidth: 520 }}>
              <FieldLabel hint={
                <>
                  Optional. Leave blank and each browser keeps using the address it already asks for —
                  which is what most installations want. Set it only when the name people type differs
                  from what reaches this server. <strong>Microsoft Entra refuses an IP address in a
                  Redirect URI</strong>, so single sign-on needs a hostname with a domain here or on the
                  Console address tab.
                </>
              }>Public hostname</FieldLabel>
              <input
                className="input input-md"
                style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                placeholder="e.g. console.example.com"
                value={publicHost}
                onChange={(e) => { setHostTouched(true); setPublicHost(e.target.value) }}
                disabled={busy || state.runInProgress}
                aria-label="Public hostname"
              />
            </div>

            {confirming && (
              <Callout
                tone="warn"
                title={confirming === 'enable' ? 'Turn HTTPS on for all four consoles?' : 'Turn HTTPS off for all four consoles?'}
                actions={
                  <>
                    <button type="button" className="btn-primary" onClick={() => void run(confirming)} disabled={busy} style={{ padding: '8px 18px' }}>
                      {busy ? 'Starting…' : `Yes, ${ACTION_LABEL[confirming].toLowerCase()}`}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setConfirming(null)} disabled={busy} style={{ padding: '8px 18px' }}>
                      Cancel
                    </button>
                  </>
                }
              >
                {confirming === 'enable' ? (
                  <>
                    <div>Every console is moved behind the TLS front door, one at a time:</div>
                    <ul style={{ margin: '8px 0 8px 18px', padding: 0 }}>
                      {state.ports.map(p => (
                        <li key={p.port} style={{ marginBottom: 2 }}>
                          <Mono>{`${p.app} — port ${p.port} becomes HTTPS`}</Mono>
                        </li>
                      ))}
                    </ul>
                    <div>
                      Each console restarts, so the suite is briefly unavailable. If any console cannot be
                      proved to serve HTTPS, <strong>the whole change is undone automatically</strong> and
                      you end up exactly where you are now.
                    </div>
                    {state.certPath && (
                      <div style={{ marginTop: 8 }}>
                        A self-signed certificate will make browsers warn on the first visit. Install a
                        certificate your clients already trust on the Certificate tab to remove that.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      The four consoles go back to serving plain HTTP directly on ports{' '}
                      <Mono>{state.ports.map(p => p.port).join(', ')}</Mono>, the front door is removed, and
                      the certificate configuration is cleared so nothing reports this suite as encrypted.
                    </div>
                    <div style={{ marginTop: 8 }}>
                      The certificate files are left alone, so turning HTTPS back on needs no new certificate.
                      <strong> Sign-in credentials will cross the network unencrypted.</strong>
                    </div>
                  </>
                )}
              </Callout>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void run('preview')}
                disabled={busy || !state.canPreview || state.runInProgress}
                style={{ padding: '10px 20px' }}
                title="Run every check and report what would change, without changing anything"
              >
                {busy ? 'Working…' : 'Preview — change nothing'}
              </button>
              {state.canEnable && (
                <button type="button" className="btn-primary" onClick={() => setConfirming('enable')} disabled={busy || state.runInProgress} style={{ padding: '10px 20px' }}>
                  Turn HTTPS on
                </button>
              )}
              {state.canDisable && (
                <button type="button" className="btn-secondary" onClick={() => setConfirming('disable')} disabled={busy || state.runInProgress} style={{ padding: '10px 20px' }}>
                  Turn HTTPS off
                </button>
              )}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
              Preview is safe at any time: it runs the same checks and reports what a real change would do.
            </div>
          </>
        )}
      </PanelCard>

      {(runReport || started) && (
        <PanelCard title="Last change">
          {contactLost && started && (
            <Callout tone="info" title="This page has lost contact with the console — that is expected">
              <div>
                The console is moving {started === 'enable' ? 'from http to https' : 'from https to http'} on the
                same port, which the browser treats as a different site. This page cannot follow it.
              </div>
              {movingTo && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ marginBottom: 6 }}>Continue here once the change finishes:</div>
                  <a href={movingTo} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--primary)', wordBreak: 'break-all' }}>{movingTo}</a>
                  {started === 'enable' && (
                    <div style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
                      On a self-signed certificate the browser will warn the first time. That warning is
                      yours to accept once — nothing here can do it for you.
                    </div>
                  )}
                </div>
              )}
            </Callout>
          )}

          {runReport && <Callout tone={runReport.tone} title={runReport.title}>{runReport.text}</Callout>}

          {state.lastRun.finished && state.lastRun.action && (
            <FactTable>
              <FactRow label="Action">{ACTION_LABEL[state.lastRun.action]}</FactRow>
              {/* ⛔ SHOWN AS A FACT, NOT AS THE VERDICT. The engine exits 0 on a
                  run that reverted everything, so this number says nothing about
                  whether HTTPS is on — the outcome above is read from the
                  engine's own closing banner. */}
              <FactRow label="Engine exit code">
                <Mono>{String(state.lastRun.exitCode ?? 'unknown')}</Mono>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}> — not the verdict; the engine exits 0 whether it succeeded or undid itself</span>
              </FactRow>
              {state.logPath && <FactRow label="Full log"><Mono>{state.logPath}</Mono></FactRow>}
            </FactTable>
          )}

          {state.logError && <Callout tone="warn" title="The log could not be read">{state.logError}</Callout>}
          <LogBlock lines={state.lastRun.highlights} label="Gate results and refusals" />
          <LogBlock lines={state.lastRun.lines} label="The engine's output (tail)" />

          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn-secondary" onClick={() => void load()} style={{ padding: '8px 16px' }}>Refresh</button>
          </div>
        </PanelCard>
      )}
    </>
  )
}
