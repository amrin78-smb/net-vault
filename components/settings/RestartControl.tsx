'use client'
//
// components/settings/RestartControl.tsx — "apply it now", for the settings
// that are inert until a service restarts.
//
// Console address, Certificate and Single sign-on all end the same way: the
// value is saved, durable, and doing nothing. The panels said "restart the
// NetVault service", which is only actionable by someone with a console on the
// server — so the product could save a change it could not apply.
//
// ⛔ ONE COMPONENT FOR ALL THREE PANELS, because the three are the same
// problem and fixing one would leave the other two telling a customer to go
// and use PowerShell. (CLAUDE.md: a fixed instance is not a fixed class.)
//
// ⛔ THE SERVICE IS NOT THE SAME FOR ALL THREE, AND THAT IS THE POINT. A
// certificate is served by NocVault-Tls, never by NetVault; the Certificate
// panel told an operator to restart NetVault after installing a real wildcard
// certificate and following it would have left the old certificate serving.
// The server decides, from `purpose` — this component never names a service.
//
// ⛔ EVERY COMPONENT AT MODULE TOP LEVEL (CLAUDE.md's first critical rule).
// No Tailwind, no hardcoded hex.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Callout, Mono } from './panelChrome.tsx'

export type RestartPurpose = 'console-address' | 'certificate' | 'sso'

type RestartState = {
  available: boolean
  terminatorPresent: boolean | null
  targets: Record<string, { service: string | null; why: string }>
  inProgress: boolean
  uptimeSeconds: number
  lastRun: { outcome: 'none' | 'running' | 'succeeded' | 'failed'; finished: boolean; lines: string[] }
}

type Phase = 'idle' | 'starting' | 'waiting' | 'done' | 'failed'

export default function RestartControl({ purpose, pending, title }: {
  purpose: RestartPurpose
  /** Whether anything is actually waiting on a restart. */
  pending: boolean
  title?: string
}) {
  const [state, setState] = useState<RestartState | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [lostContact, setLostContact] = useState(false)
  /** The uptime we saw before asking; a LOWER one proves a new process. */
  const baselineUptime = useRef<number | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (quiet = false) => {
    try {
      const res = await fetch('/api/system/service-restart', { cache: 'no-store' })
      if (!res.ok) throw new Error(`The server answered ${res.status}.`)
      const data = (await res.json()) as RestartState
      setState(data)
      setLostContact(false)
      // ⛔ PROOF, NOT OPTIMISM. "The page loaded again" is not evidence that
      // anything restarted — a refused stop leaves the ORIGINAL process
      // answering, and it would answer this poll just as happily. A LOWER
      // uptime than the one we recorded is the only thing that cannot be
      // produced by the old process.
      if (phase === 'waiting' && baselineUptime.current !== null && data.uptimeSeconds < baselineUptime.current) {
        setPhase('done')
      }
      return data
    } catch {
      if (phase === 'waiting' || phase === 'starting') setLostContact(true)
      else if (!quiet) setError('Could not read the restart state.')
      return null
    }
  }, [phase])

  useEffect(() => { void load(true) }, [load])

  useEffect(() => {
    if (phase !== 'waiting') {
      if (poll.current) { clearInterval(poll.current); poll.current = null }
      return
    }
    if (poll.current) return
    poll.current = setInterval(() => { void load(true) }, 2500)
    return () => { if (poll.current) { clearInterval(poll.current); poll.current = null } }
  }, [phase, load])

  const target = state?.targets?.[purpose]
  const service = target?.service ?? null

  const start = useCallback(async () => {
    setConfirming(false)
    setError(null)
    setPhase('starting')
    baselineUptime.current = state?.uptimeSeconds ?? null
    try {
      const res = await fetch('/api/system/service-restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `The server answered ${res.status}.`)
      if (body?.started === false) {
        // Nothing to restart — a real answer, not a failure.
        setPhase('idle')
        setError(null)
        setState((s) => s)
        return
      }
      setPhase('waiting')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('failed')
    }
  }, [purpose, state?.uptimeSeconds])

  if (!pending) return null

  if (state && !state.available) {
    return (
      <Callout tone="warn" title={title || 'A restart is needed to apply this'}>
        This change is saved and will take effect the next time the service restarts. Restarting from
        here is only available on the Windows host that runs the suite.
      </Callout>
    )
  }

  // A certificate with no terminator: there is genuinely nothing to restart.
  if (state && target && service === null) {
    return <Callout tone="info" title="Nothing to restart">{target.why}</Callout>
  }

  if (phase === 'waiting' || phase === 'starting') {
    return (
      <Callout tone="info" title={phase === 'starting' ? 'Starting the restart…' : `Restarting ${service || 'the service'}…`}>
        <div>
          {service === 'NocVault-Tls'
            ? 'The four consoles stay up; the public ports stop answering for a few seconds while the front door reloads.'
            : 'This console is going down for about twenty seconds. This page will lose contact — that is expected.'}
        </div>
        {lostContact && (
          <div style={{ marginTop: 8 }}>
            Contact lost, as expected. This page keeps checking and will confirm as soon as the console
            is back.
          </div>
        )}
      </Callout>
    )
  }

  if (phase === 'done') {
    return (
      <Callout tone="ok" title="Restarted — the change is now in force">
        <div>
          {service} restarted and this page is talking to a new process. The saved value is the one
          being used.
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn-secondary" onClick={() => { setPhase('idle'); void load() }} style={{ padding: '8px 16px' }}>
            Refresh this page&rsquo;s view
          </button>
        </div>
      </Callout>
    )
  }

  return (
    <>
      {error && <Callout tone="danger" title="The restart did not start">{error}</Callout>}
      {state?.lastRun.outcome === 'failed' && phase === 'idle' && (
        <Callout tone="warn" title="The last restart did not take effect">
          The service was asked to restart and the process did not change, so the old value is still in
          use. The server log has the detail.
        </Callout>
      )}
      {confirming ? (
        <Callout
          tone="warn"
          title={service === 'NocVault-Tls' ? 'Reload the TLS front door?' : 'Restart the console now?'}
          actions={
            <>
              <button type="button" className="btn-primary" onClick={() => void start()} style={{ padding: '8px 18px' }}>
                Yes, restart {service}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} style={{ padding: '8px 18px' }}>
                Not now
              </button>
            </>
          }
        >
          <div>{target?.why}</div>
          <div style={{ marginTop: 8 }}>
            {service === 'NocVault-Tls'
              ? 'The consoles themselves are not restarted. The public ports stop answering for a few seconds.'
              : 'Everyone using this console is signed out of their current page for about twenty seconds. The other three consoles are unaffected.'}
          </div>
        </Callout>
      ) : (
        <Callout tone="warn" title={title || 'Saved, but not yet in force'}>
          <div>{target?.why || 'This change takes effect when the service restarts.'}</div>
          {service && (
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn-primary" onClick={() => setConfirming(true)} disabled={Boolean(state?.inProgress)} style={{ padding: '8px 18px' }}>
                {state?.inProgress ? 'A restart is already running…' : <>Restart <Mono>{service}</Mono> now</>}
              </button>
            </div>
          )}
        </Callout>
      )}
    </>
  )
}
