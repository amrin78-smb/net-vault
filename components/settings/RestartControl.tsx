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
// ⛔ AND IT IS NOT ALWAYS ONE SERVICE EITHER, SINCE THE HUB OWNS ALL FOUR
// CONSOLE ADDRESSES. A console-address change can need `LogVault-App`,
// `DDIVault-App`, `SpanVault-App` and `SpanVault-API` bounced as well. This
// component passes APP SLUGS (a closed enum) and renders the service names the
// ROUTE served back; it still never maps a slug to a service itself, because
// the mapping that matters is the one the POST handler uses.
//
// ⛔ EVERY COMPONENT AT MODULE TOP LEVEL (CLAUDE.md's first critical rule).
// No Tailwind, no hardcoded hex.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Callout, Mono } from './panelChrome.tsx'
import { restartWaitLimitMs } from '@/lib/serviceRestart.ts'

export type RestartPurpose = 'console-address' | 'certificate' | 'sso'

/**
 * ⛔ `POST /api/system/service-restart` IS super_admin, SO THE BUTTON HAS TO
 * BE TOO. Both panels rendered this with no role prop at all, so an `admin` —
 * who legitimately reaches both tabs, and for whom the Certificate panel's
 * install button 20 lines below is correctly gated by `canInstall` — met an
 * enabled "Restart NetVault now" that answered a bare 403. A button the server
 * will refuse is worse than no button; it reads as the product being broken.
 */
export type RestartControlProps = {
  purpose: RestartPurpose
  /** Whether anything is actually waiting on a restart. */
  pending: boolean
  title?: string
  /** Defaults to `true` so an un-updated call site keeps today's behaviour. */
  canRestart?: boolean
  /**
   * Which consoles changed, for `console-address`.
   *
   * ⛔ SLUGS, NEVER SERVICE NAMES, AND THE SERVER TURNS THEM INTO SERVICES.
   * `lib/serviceRestart.ts`'s rule — a service name is never a request field —
   * is what keeps this route from being a denial-of-service primitive, and a
   * closed four-value enum is not a service name. The names this component
   * DISPLAYS come from the route's own `consoleServices` map for the same
   * reason: building them here would be a second mapping.
   */
  apps?: string[]
}

type RestartState = {
  available: boolean
  terminatorPresent: boolean | null
  targets: Record<string, { services: string[]; why: string }>
  /** slug → the services that console's address needs restarted. */
  consoleServices?: Record<string, string[]>
  inProgress: boolean
  uptimeSeconds: number
  logUnreadable?: boolean
  lastRun: {
    outcome: 'none' | 'running' | 'succeeded' | 'failed'
    finished: boolean
    runId: string | null
    failedServices?: string[]
    lines: string[]
  }
}

/** What POST hands back, for the facts only it knows. */
type StartedRun = {
  started?: boolean
  runId?: string
  reason?: string
  previousUptimeSeconds?: number
  /** ⛔ Tri-state: `null` only when `terminatorDependsOn` could not tell. */
  dependencyDetail?: string | null
  /** Whether the wrapper will stop and restart the shared TLS front door. */
  stopsDependents?: boolean
  /** What the run is actually restarting, after absent services were dropped. */
  services?: string[]
  absentServices?: string[]
  error?: string
}

type Phase = 'idle' | 'starting' | 'waiting' | 'done' | 'failed' | 'unconfirmed'

/**
 * The sentence that turns a bare failure into something actionable.
 *
 * ⛔ `terminatorDependsOn` RETURNS `null` WITH A REASON AND NOBODY READ IT.
 * `null` is the branch where the restart is GUARANTEED to fail with 1051: the
 * hub's dependents are not stopped, so Windows refuses `sc stop NetVault`, the
 * following start returns 1056, the service is Running the whole time, and the
 * verdict is `failed` with no clue why.
 */
const DEPENDENCY_HINT =
  'Whether NocVault-Tls depends on this service could not be read, so the shared front door was '
  + 'left running — Windows refuses to stop a service while a dependent is running (error 1051), '
  + 'which is the most likely reason this did not take effect. The probe said:'

/**
 * How long to keep waiting before admitting we cannot confirm.
 *
 * ⛔ IT HAS TO COVER THE WRAPPER'S OWN WORST CASE, and a FIXED limit cannot —
 * which is why this is now `restartWaitLimitMs(serviceCount, dependentCount)`
 * from `lib/serviceRestart.ts`, the module that owns the wrapper's timeouts. The
 * bounds add up per service (60 s polling for Stopped + 150 s of start
 * attempts) plus once per run (45 s stopping each dependent, 90 s waiting for
 * it to come back). A console-address change can cover six services, so the
 * old flat seven minutes would have reported "could not confirm the restart"
 * for a restart that was working normally — and the verdict, not the hub's
 * uptime, is what declares success now.
 *
 * This default is the single-service case, used until POST says how many.
 */
const WAIT_LIMIT_MS = restartWaitLimitMs(1, 1)

export default function RestartControl({ purpose, pending, title, canRestart = true, apps }: RestartControlProps) {
  const [state, setState] = useState<RestartState | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [lostContact, setLostContact] = useState(false)
  /** The uptime we saw before asking; a LOWER one proves a new process. */
  const baselineUptime = useRef<number | null>(null)
  /** The id of the run WE started, so a stale verdict can never be read. */
  const myRunId = useRef<string | null>(null)
  const waitingSince = useRef<number | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)
  const [failReason, setFailReason] = useState<string | null>(null)
  /** Why the dependency probe could not tell — the 1051 branch. */
  const [dependencyDetail, setDependencyDetail] = useState<string | null>(null)
  /** Whether THIS run stops and restarts the shared TLS front door. */
  const stopsDependents = useRef(false)
  /** What THIS run is restarting, as the server resolved it. */
  const [runServices, setRunServices] = useState<string[] | null>(null)
  /** Services this host does not have, named by the server so they are not a mystery. */
  const [absentServices, setAbsentServices] = useState<string[]>([])
  /** ⛔ SIZED TO THIS RUN, not to a constant. See WAIT_LIMIT_MS. */
  const waitLimit = useRef(WAIT_LIMIT_MS)
  /** The console answered again. Progress, NEVER a verdict — see `load`. */
  const [backOnline, setBackOnline] = useState(false)

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
      if (phase === 'waiting') {
        // ⛔ TWO INDEPENDENT PROOFS, AND NEITHER ALONE IS ENOUGH FOR EVERY CASE.
        //
        // 1. A LOWER uptime than the baseline. Only the hub's own restart can
        //    produce this, and nothing the old process could do fakes it — so
        //    it stays the primary signal when WE are the service going down.
        //    The baseline now comes from the POST response, not from whatever
        //    this component happened to fetch at mount: a hub that restarted
        //    for any unrelated reason in between (a deploy, an NSSM app-exit
        //    restart) left a stale, far larger baseline, and the very first
        //    poll then "proved" a restart that had not started yet.
        //
        // 2. The run's OWN verdict, matched on runId. Restarting NocVault-Tls
        //    never changes the hub's uptime, so proof 1 can never fire for it
        //    — the panel span on "Restarting…" forever while the log had said
        //    `succeeded` for minutes. The id match is what makes reading the
        //    log safe: without it, the previous run's green verdict is sitting
        //    in that file during the seconds before the wrapper starts.
        const mine = myRunId.current !== null && data.lastRun.runId === myRunId.current
        const uptimeProof = baselineUptime.current !== null && data.uptimeSeconds < baselineUptime.current
        // ⛔ THE UPTIME PROOF IS PROGRESS, NOT A VERDICT, AND TREATING IT AS ONE
        // WAS A FALSE ALL-CLEAR. It used to be enough on its own to reach
        // `done`. On an install where NocVault-Tls really does declare
        // `DependOnService NetVault`, the wrapper's order is: stop the
        // terminator → stop and start the hub → START THE TERMINATOR AGAIN (up
        // to 90 s) → write `dependent … back:` → write the sentinel. The hub
        // answers HTTP before `Get-Service` even reports it Running, so the
        // FIRST poll after that gives a lower uptime, `finished: false` — and
        // the panel went green with "Restarted — the change is now in force"
        // while the front door was still stopped and ALL FOUR consoles' public
        // ports were dead. Polling stops at `done`, so if the terminator never
        // came back the panel stayed green forever. That also made
        // `parseRestartLog`'s `depsFailed` term unreachable on the only path
        // where dependents exist — the term added specifically to refuse this.
        //
        // So the RUN'S OWN VERDICT is the only thing that reaches `done`, for
        // every target. The uptime proof still has a job: it is what tells the
        // operator the console is back while the wrapper finishes bringing the
        // front door up, which is the honest thing to say in that window.
        if (uptimeProof) setBackOnline(true)
        if (mine && data.lastRun.finished && data.lastRun.outcome === 'failed') {
          // ⛔ NAME THE CONSOLE THAT DID NOT COME BACK. With up to five
          // services in one run, "the restart did not take effect" without a
          // name sends an operator to check all four consoles by hand.
          const failed = data.lastRun.failedServices || []
          setFailReason(
            [failed.length ? `Did not restart: ${failed.join(', ')}.` : '', data.lastRun.lines.slice(-4).join(' · ')]
              .filter(Boolean)
              .join(' ') || null,
          )
          setPhase('failed')
        } else if (mine && data.lastRun.finished && data.lastRun.outcome === 'succeeded') {
          setPhase('done')
        } else if (waitingSince.current !== null && Date.now() - waitingSince.current > waitLimit.current) {
          // ⛔ NEVER SPIN FOREVER. A wrapper killed before it wrote its
          // sentinel leaves `outcome: 'running'` in the log permanently.
          setPhase('unconfirmed')
        }
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
  /**
   * The services this restart will bounce.
   *
   * ⛔ FROM THE SERVER, FOR BOTH SHAPES. For a certificate or an SSO change the
   * route's own `targets[purpose]` is the answer. For a console address the
   * route cannot know WHICH consoles changed, so it serves the slug→service map
   * and this unions the rows for the apps the panel was given — still the
   * server's mapping, never one rebuilt in the browser.
   */
  // ⛔ MEMOISED BECAUSE `start` DEPENDS ON IT. A fresh array every render would
  // give the callback a new identity every render, which is the churn the
  // exhaustive-deps rule is warning about.
  const services = useMemo(
    () =>
      purpose === 'console-address' && apps && apps.length > 0 && state?.consoleServices
        ? [...new Set(apps.flatMap((slug) => state.consoleServices?.[slug] || []))]
        : (target?.services ?? []),
    [purpose, apps, state?.consoleServices, target?.services],
  )
  const serviceLabel = (runServices ?? services).join(', ')
  const onlyTerminator = services.length === 1 && services[0] === 'NocVault-Tls'

  const start = useCallback(async () => {
    setConfirming(false)
    setError(null)
    setPhase('starting')
    setFailReason(null)
    setDependencyDetail(null)
    setBackOnline(false)
    stopsDependents.current = false
    myRunId.current = null
    setRunServices(null)
    setAbsentServices([])
    try {
      const res = await fetch('/api/system/service-restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⛔ SLUGS ONLY, AND ONLY FOR THE PURPOSE THAT HAS THEM. The route
        // defaults to the hub when `apps` is absent, which is what a certificate
        // or SSO restart wants.
        body: JSON.stringify(
          purpose === 'console-address' && apps && apps.length > 0 ? { purpose, apps } : { purpose },
        ),
      })
      const body = (await res.json().catch(() => ({}))) as StartedRun
      if (!res.ok) throw new Error(body?.error || `The server answered ${res.status}.`)
      if (body?.started === false) {
        // Nothing to restart — a real answer, not a failure. ⛔ SHOW THE
        // SERVER'S REASON AND REFETCH. This used to call `setState((s) => s)`,
        // which returns the same reference, so React bailed out: nothing
        // re-rendered, the reason was discarded, and the button looked dead.
        // The operator clicked it again, and again.
        setPhase('idle')
        setError(null)
        setFailReason(body?.reason || null)
        void load(true)
        return
      }
      // ⛔ FROM THE RESPONSE, not from state fetched at mount. See the verdict
      // comment in `load`.
      baselineUptime.current = typeof body?.previousUptimeSeconds === 'number'
        ? body.previousUptimeSeconds
        : (state?.uptimeSeconds ?? null)
      myRunId.current = typeof body?.runId === 'string' ? body.runId : null
      // ⛔ CARRIED FROM THE RESPONSE, BECAUSE ONLY POST KNOWS IT.
      // `terminatorDependsOn` computes a `detail` saying WHY it could not read
      // the dependency field, and the route used to read only the boolean and
      // throw the explanation away — while `null` is exactly the branch where
      // the restart is guaranteed to fail with 1051, because the front door is
      // left running and Windows refuses the stop. The operator got "The
      // restart did not take effect" and nothing else.
      setDependencyDetail(typeof body?.dependencyDetail === 'string' ? body.dependencyDetail : null)
      stopsDependents.current = body?.stopsDependents === true
      // ⛔ WHAT THE SERVER ACTUALLY RESOLVED, which is not always what this
      // component asked for: a service this host does not have is dropped and
      // NAMED, and the wait limit has to be sized to the run that is really
      // happening rather than to the list that was requested.
      const started = Array.isArray(body?.services) ? body.services.filter((x) => typeof x === 'string') : []
      setRunServices(started.length > 0 ? started : null)
      setAbsentServices(Array.isArray(body?.absentServices) ? body.absentServices : [])
      waitLimit.current = restartWaitLimitMs(
        started.length || services.length || 1,
        body?.stopsDependents === true ? 1 : 0,
      )
      waitingSince.current = Date.now()
      setPhase('waiting')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('failed')
    }
  }, [purpose, apps, services, state?.uptimeSeconds, load])

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
  // ⛔ AN EMPTY LIST IS THE "NOTHING TO RESTART" ANSWER, not an error: a
  // certificate on a suite with no terminator genuinely needs no restart, and
  // naming a service there sends an operator to bounce one for no effect.
  if (state && target && services.length === 0) {
    return <Callout tone="info" title="Nothing to restart">{target.why}</Callout>
  }

  if (phase === 'waiting' || phase === 'starting') {
    return (
      <Callout tone="info" title={phase === 'starting' ? 'Starting the restart…' : `Restarting ${serviceLabel || 'the service'}…`}>
        <div>
          {onlyTerminator
            ? 'The four consoles stay up; the public ports stop answering for a few seconds while the front door reloads.'
            : (runServices ?? services).includes('NetVault')
              ? 'This console is going down for about twenty seconds. This page will lose contact — that is expected.'
              : 'The consoles being restarted stop answering for about twenty seconds each. This page stays up.'}
        </div>
        {absentServices.length > 0 && (
          <div style={{ marginTop: 8 }}>
            Not installed on this host, so skipped: <Mono>{absentServices.join(', ')}</Mono>
          </div>
        )}
        {lostContact && (
          <div style={{ marginTop: 8 }}>
            Contact lost, as expected. This page keeps checking and will confirm as soon as the console
            is back.
          </div>
        )}
        {/* ⛔ THE CONSOLE BEING BACK IS NOT THE RESTART BEING DONE, and saying
            so is the whole point of this line. When the shared front door has
            to be stopped first it is brought back LAST, after this console
            already answers — so there is a real window in which the page works
            and the four public ports do not. This panel used to call that
            window success. */}
        {backOnline && (
          <div style={{ marginTop: 8 }}>
            {stopsDependents.current
              ? 'This console is answering again. Still waiting for NocVault-Tls, the shared front '
                + 'door, to come back — until it does, the four public ports do not answer.'
              : 'This console is answering again. Waiting for the run to report its own verdict.'}
          </div>
        )}
      </Callout>
    )
  }

  if (phase === 'done') {
    return (
      <Callout tone="ok" title="Restarted — the change is now in force">
        <div>
          {serviceLabel} restarted and the run reported its own verdict. The saved value is the one
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

  if (phase === 'unconfirmed') {
    return (
      <Callout tone="warn" title="Could not confirm the restart">
        <div>
          The restart was started, but this page has not seen proof that {serviceLabel} came back with a new
          process. It may still have worked. Check the service on the server before assuming the saved
          value is in force.
        </div>
        {dependencyDetail && <div style={{ marginTop: 8 }}>{DEPENDENCY_HINT} <Mono>{dependencyDetail}</Mono></div>}
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn-secondary" onClick={() => { setPhase('idle'); void load() }} style={{ padding: '8px 16px' }}>
            Check again
          </button>
        </div>
      </Callout>
    )
  }

  if (phase === 'failed' && failReason) {
    return (
      <Callout tone="danger" title="The restart did not take effect">
        <div>
          {serviceLabel} was asked to restart and at least one process did not change, so the old
          value is still in use on that console.
        </div>
        {/* ⛔ THE LIKELIEST CAUSE, NAMED. An unreadable dependency field means
            the front door was left running, and Windows then REFUSES the stop
            with 1051 — so this failure is not mysterious, it is predicted. The
            route computed the explanation and discarded it. */}
        {dependencyDetail && <div style={{ marginTop: 8 }}>{DEPENDENCY_HINT} <Mono>{dependencyDetail}</Mono></div>}
        <div style={{ marginTop: 8 }}><Mono>{failReason}</Mono></div>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn-secondary" onClick={() => { setPhase('idle'); setFailReason(null); void load() }} style={{ padding: '8px 16px' }}>
            Try again
          </button>
        </div>
      </Callout>
    )
  }

  return (
    <>
      {error && <Callout tone="danger" title="The restart did not start">{error}</Callout>}
      {failReason && phase === 'idle' && (
        <Callout tone="info" title="Nothing was restarted">{failReason}</Callout>
      )}
      {state?.logUnreadable && (
        <Callout tone="warn" title="The restart log could not be read">
          A restart may have run. This panel cannot report its outcome, so treat the state of {serviceLabel || 'the service'} as
          unknown rather than as unchanged.
        </Callout>
      )}
      {state?.lastRun.outcome === 'failed' && phase === 'idle' && (
        <Callout tone="warn" title="The last restart did not take effect">
          The service was asked to restart and the process did not change, so the old value is still in
          use. The server log has the detail.
        </Callout>
      )}
      {/* ⛔ A BUTTON THE SERVER WILL REFUSE IS WORSE THAN NO BUTTON. The POST is
          super_admin; both call sites used to render this with no role prop, so
          an `admin` got an enabled "Restart NetVault now" that answered a bare
          403 — in the same commit that correctly gated the Certificate panel's
          install button 20 lines below it. */}
      {!canRestart ? (
        <Callout tone="info" title={title || 'Saved, but not yet in force'}>
          <div>{target?.why || 'This change takes effect when the service restarts.'}</div>
          <div style={{ marginTop: 8 }}>
            Restarting a service interrupts it for everyone, so it is restricted to a super admin. Ask
            one to apply this, or it takes effect at the next restart.
          </div>
        </Callout>
      ) : confirming ? (
        <Callout
          tone="warn"
          title={onlyTerminator ? 'Reload the TLS front door?' : services.length > 1 ? 'Restart these services now?' : 'Restart the console now?'}
          actions={
            <>
              <button type="button" className="btn-primary readonly-allowed" onClick={() => void start()} style={{ padding: '8px 18px' }}>
                Yes, restart {serviceLabel}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} style={{ padding: '8px 18px' }}>
                Not now
              </button>
            </>
          }
        >
          <div>{target?.why}</div>
          <div style={{ marginTop: 8 }}>
            {onlyTerminator
              ? 'The consoles themselves are not restarted. The public ports stop answering for a few seconds.'
              : services.length > 1
                ? `Everyone using ${serviceLabel} is interrupted for about twenty seconds each, in that order. `
                  + 'Any console not listed is unaffected.'
                : 'Everyone using this console is signed out of their current page for about twenty seconds. The other three consoles are unaffected.'}
          </div>
        </Callout>
      ) : (
        <Callout tone="warn" title={title || 'Saved, but not yet in force'}>
          <div>{target?.why || 'This change takes effect when the service restarts.'}</div>
          {services.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn-primary readonly-allowed" onClick={() => setConfirming(true)} disabled={Boolean(state?.inProgress)} style={{ padding: '8px 18px' }}>
                {state?.inProgress ? 'A restart is already running…' : <>Restart <Mono>{services.join(', ')}</Mono> now</>}
              </button>
            </div>
          )}
        </Callout>
      )}
    </>
  )
}
