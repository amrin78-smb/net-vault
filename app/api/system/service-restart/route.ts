//
// app/api/system/service-restart/route.ts — "apply it now" for the settings
// that are inert until a service restarts.
//
// NEXTAUTH_URL, the ENTRA_* values and a replaced certificate are all read once
// at startup. Saving one leaves the panel honest but stuck: "restart the
// NetVault service" is not something a customer can do from the product they
// bought, and it is the last step of three different settings flows.
//
// ⛔ AND IT IS NOT ALWAYS THE SAME SERVICE. A certificate is served by
// NocVault-Tls, never by NetVault — see `resolveRestartTarget`. The Certificate
// panel told an operator to restart NetVault after installing a real wildcard
// certificate on production (2026-11-06); following that restarts the wrong
// process and the old certificate keeps being served.
//
// ⛔ THE RESTART CANNOT BE AWAITED when the target is the hub: the service
// being restarted is the one serving the request. It goes to a SYSTEM
// scheduled task — the same shape as tls-transport and the in-app updater —
// and the panel watches for the console coming back.
//
// ⛔ NO `execSync` ON THIS PATH ([[sync-exec-blocks-event-loop]]).

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { findGitRoot } from '@/lib/gitRoot'
import { recordSystemChanges } from '@/lib/systemAudit.ts'
import {
  readTerminatorState,
  serviceExists,
  terminatorDependsOn,
} from '@/lib/terminatorState.ts'
import {
  HUB_SERVICE,
  buildRestartHeader,
  RESTART_PURPOSES,
  RESTART_SENTINEL,
  RESTART_TASK_NAME,
  TERMINATOR_SERVICE,
  buildRestartWrapper,
  isRestartPurpose,
  parseRestartLog,
  resolveRestartTarget,
  restartPaths,
} from '@/lib/serviceRestart.ts'
import { claimRunLock, readRunLock, releaseRunLock, type LockEnv } from '@/lib/runLock.ts'

const execFileAsync = promisify(execFile)

type SessionUser = { id?: string | number; role?: string }
function userOf(session: unknown): SessionUser {
  return ((session as { user?: SessionUser } | null)?.user || {}) as SessionUser
}

/**
 * Whether the terminator exists at all.
 *
 * ⛔ A FAILED READ IS `null`, NOT `false`. "We could not ask" and "it is not
 * installed" lead to different advice for a certificate change, and treating
 * the first as the second tells an operator their new certificate needs no
 * action when it may need a restart.
 */
async function terminatorPresent(): Promise<boolean | null> {
  // ⛔ ONE IMPLEMENTATION. This was a byte-level duplicate of
  // lib/terminatorState.ts's probe, which exists precisely so four routes get
  // the same answer; the copy also treated a SUCCESSFUL query whose output
  // lacked the English tokens SERVICE_NAME/STATE as "absent".
  const reading = await readTerminatorState()
  return reading.present
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    return (e as { code?: string })?.code === 'EPERM'
  }
}

/**
 * The lock rules, which are shared with `tls-transport`.
 *
 * ⛔ THIS ROUTE USED TO HAVE NO CLAIM AT ALL. Its 409 guard read a lock only
 * the WRAPPER writes (`lib/serviceRestart.ts`), so between `schtasks /run` and
 * the wrapper's `$PID | Out-File` nothing was held — two super_admin tabs ~2 s
 * apart both passed the guard, and POST 2 then TRUNCATED the log, destroying
 * run A's `runId=` header and whatever lines wrapper A had already written.
 * Either wrapper A never ran while its panel had been told `started: true`
 * (→ "Could not confirm the restart" for a restart that never happened), or
 * both ran and the panel read a verdict assembled from BOTH wrappers' lines.
 * The sibling route got `flag: 'wx'` for exactly this; this one did not.
 * See lib/runLock.ts for all four defects and the reasoning.
 */
const lockEnv: LockEnv = { fs, isPidAlive }

/**
 * Remove the scheduled task, best effort.
 *
 * ⛔ CALLED WHEN A LOCK IS REAPED, NOT ONLY WHEN `/run` FAILS. Nothing used to
 * delete the task when the wrapper STARTED AND THEN DIED — and a `/sc once
 * /st 00:00` trigger whose start time has passed fires the following day, so a
 * restart nobody asked for ran at midnight. The wrapper's own arm guard
 * (lib/runLock.ts `psArmGuard`) refuses that fire and deletes the task itself;
 * this is the second half, so the orphan does not have to wait for midnight to
 * be removed.
 */
async function deleteRestartTask(): Promise<void> {
  try {
    await execFileAsync('schtasks.exe', ['/delete', '/tn', RESTART_TASK_NAME, '/f'], { timeout: 15_000 })
  } catch { /* no such task is the normal case */ }
}

/**
 * What a restart would do, per purpose, and what the last one did.
 *
 * ⛔ THE PANEL POLLS THIS THROUGH THE RESTART, so for most of a hub restart
 * this route is simply unreachable — a failed fetch IS the expected signal and
 * the panel renders it as progress, not as a fault.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = userOf(session).role
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const paths = restartPaths(findGitRoot(process.cwd()))
  let text: string | null = null
  try {
    if (fs.existsSync(paths.log)) text = fs.readFileSync(paths.log, 'utf8')
  } catch { text = null }
  const report = parseRestartLog(text)
  const logUnreadable = text === null && fs.existsSync(paths.log)
  const present = await terminatorPresent()

  // ⛔ THE REAP IS ON THE READ PATH. It used to be on POST only, while the
  // thing a stale lock BLOCKS (`inProgress` → a disabled button) is drawn from
  // GET — so the only code that could clear the lock was the request the panel
  // refused to let anyone send. Reaping here also removes the orphaned task,
  // which nothing did when the wrapper started and then died.
  const lock = readRunLock(paths.lock, lockEnv)
  if (lock.reaped) await deleteRestartTask()

  const targets: Record<string, { service: string | null; why: string }> = {}
  for (const purpose of RESTART_PURPOSES) {
    // ⛔ `present !== false`, NOT `present === true`. `null` means we could not
    // read the service, and the two outcomes are not symmetric: offering a
    // restart that then fails with 1060 is recoverable noise, while telling an
    // operator their newly-installed certificate needs no action is the
    // 2026-11-06 production failure restated in calmer words.
    targets[purpose] = resolveRestartTarget(purpose, present !== false)
  }

  return NextResponse.json({
    available: process.platform === 'win32',
    terminatorPresent: present,
    targets,
    inProgress: lock.held,
    // ⛔ So the panel can prove the hub answering it is a NEW process rather
    // than the old one that never went down. "The page loaded again" is not
    // evidence that anything restarted.
    uptimeSeconds: Math.floor(process.uptime()),
    logUnreadable,
    lastRun: {
      outcome: report.outcome,
      finished: report.finished,
      // ⛔ The panel matches this against the id POST handed it, so a verdict
      // from an earlier run can never be read as this one's.
      runId: report.runId,
      lines: report.lines.slice(-20),
    },
  })
}

/**
 * Restart the service that applies `purpose`.
 *
 * ⛔ super_admin. This interrupts service for everyone. An `admin` may save a
 * console address (an outage is not a privilege escalation, which is why that
 * route is admin+), but deciding to bounce a service for the whole site is a
 * step beyond editing a value.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = userOf(session)
  if (user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (process.platform !== 'win32') {
    return NextResponse.json(
      { error: 'Restarting a service is only available on the Windows host that runs it.' },
      { status: 400 },
    )
  }

  let body: { purpose?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  if (!isRestartPurpose(body.purpose)) {
    return NextResponse.json(
      { error: `purpose must be one of: ${RESTART_PURPOSES.join(', ')}.` },
      { status: 400 },
    )
  }
  const purpose = body.purpose

  const present = await terminatorPresent()
  const target = resolveRestartTarget(purpose, present !== false)
  if (!target.service) {
    // Not an error — there is genuinely nothing to restart, and saying so is
    // more useful than bouncing a service for no effect.
    return NextResponse.json({ started: false, service: null, reason: target.why })
  }
  // ⛔ ONLY A DEFINITE `false` BLOCKS. `null` is "we could not ask" — refusing
  // there would turn an unreadable SCM into "nothing to restart", which is the
  // same collapse as above.
  if ((await serviceExists(target.service)) === false) {
    return NextResponse.json(
      { error: `The ${target.service} service is not installed on this host, so there is nothing to restart.` },
      { status: 409 },
    )
  }

  const paths = restartPaths(findGitRoot(process.cwd()))

  let hubDependents: string[] = []
  let dependencyDetail: string | null = null
  if (target.service === HUB_SERVICE) {
    const dep = await terminatorDependsOn(HUB_SERVICE)
    // ⛔ THE REASON `null` LEAVES IT OUT IS WORTH SURFACING, NOT DISCARDING.
    // `terminatorDependsOn` computes a `detail` explaining why it could not
    // tell, and this route read only `.dependsOn` — while `null` is precisely
    // the branch where the restart is GUARANTEED to fail with 1051, because the
    // terminator is left running and Windows refuses the stop. The operator got
    // "The restart did not take effect" with no hint that an unreadable
    // dependency field was the cause. Carried into the response below.
    if (dep.dependsOn === true) hubDependents = [TERMINATOR_SERVICE]
    dependencyDetail = dep.dependsOn === null ? dep.detail : null
  }

  // ⛔ THE ROUTE OWNS THE LOG HEADER. Without a run id written BEFORE the task
  // is scheduled, the panel polls a log that still holds the PREVIOUS run's
  // verdict for the seconds between `schtasks /run` and the wrapper starting —
  // and presents it as this run's result. A green "Restarted" from the last
  // successful run is the worst possible thing to show while a restart is
  // actually still pending.
  const runId = randomUUID()

  // ⛔ CLAIMED BEFORE THE LOG IS TRUNCATED, AND ATOMICALLY. This is the whole
  // of defect 1 in lib/runLock.ts: the 409 above used to read a lock only the
  // WRAPPER writes, so two clicks ~2 s apart both got here and the second one
  // destroyed the first one's log — including the `runId=` header the handshake
  // exists to make a cross-run verdict impossible. `flag: 'wx'` means the claim
  // cannot be lost to a check-then-write race.
  try {
    fs.mkdirSync(paths.log.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  } catch { /* the write below reports a real failure */ }
  const claim = claimRunLock(paths.lock, runId, process.pid, lockEnv)
  if (!claim.ok) {
    if (claim.reason === 'busy') {
      return NextResponse.json(
        {
          error: claim.claim.pending
            ? 'A restart was just started. Wait for it to finish.'
            : `A restart is already running (process ${claim.claim.pid}).`,
        },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: `Could not claim the restart lock: ${claim.message}` }, { status: 500 })
  }

  // From here on every failure path must give the claim back. ⛔ ONLY EVER A
  // PENDING CLAIM — see defect 4 in lib/runLock.ts: once the wrapper has taken
  // the lock over, a cleanup that drops it hands a second POST a live run's
  // services.
  const withdraw = () => releaseRunLock(paths.lock, lockEnv, { onlyIfPending: true, runId })

  try {
    fs.writeFileSync(paths.log, buildRestartHeader(runId, target.service), 'utf8')
    fs.writeFileSync(
      paths.wrapper,
      buildRestartWrapper({
        service: target.service,
        log: paths.log,
        lock: paths.lock,
        taskName: RESTART_TASK_NAME,
        // ⛔ THE ARM TOKEN. The wrapper refuses to touch a service unless the
        // lock still carries THIS run's pending claim, which is what stops an
        // orphaned task re-running it unattended at midnight.
        runId,
        // ⛔ ONLY WHEN THE TERMINATOR ACTUALLY DECLARES THE DEPENDENCY.
        // This used to key on the terminator merely EXISTING, and the comment
        // here asserted the dependency as a standing fact. It stopped being
        // one the same day: cutovers from 1.61.1 clear `DependOnService`
        // (NocVault-TlsCutover.ps1), because it turned every one-app restart
        // into a four-console outage. Keyed on existence, this panel
        // reintroduced exactly that outage — while its own confirm dialog
        // promised "the other three consoles are unaffected".
        //
        // ⛔ AND `null` FALLS THE OTHER WAY HERE THAN IN THE UPDATERS, ON
        // PURPOSE. An updater that guesses wrong gets 1051, carries on, and
        // rebuilds node_modules under a live process — corruption. This button
        // that guesses wrong just reports `failed`, which the operator retries.
        // So: stop the front door only on a POSITIVE reading.
        dependents: hubDependents,
      }),
      'utf8',
    )
  } catch (err: unknown) {
    withdraw()
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Could not write the restart script: ${message}` }, { status: 500 })
  }

  try {
    try {
      await execFileAsync('schtasks.exe', ['/delete', '/tn', RESTART_TASK_NAME, '/f'], { timeout: 15_000 })
    } catch { /* no such task is the normal case */ }
    await execFileAsync('schtasks.exe', [
      '/create', '/tn', RESTART_TASK_NAME,
      '/tr', `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${paths.wrapper}"`,
      '/sc', 'once', '/st', '00:00', '/f', '/ru', 'SYSTEM',
    ], { timeout: 20_000 })
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string }
    // ⛔ THE LOG HAS ALREADY BEEN TRUNCATED BY THIS POINT, so returning without
    // tidying up left it holding nothing but this run's `runId=` header — which
    // `parseRestartLog` reads as `outcome: 'running'`, FOREVER, with no sentinel
    // ever coming and nothing in the panel surfacing it. The header is replaced
    // with the sentinel so the state is `failed`, which is the truth, and the
    // task we may have half-created goes with it.
    await deleteRestartTask()
    try {
      fs.appendFileSync(
        paths.log,
        `[NV-RESTART] could not schedule the task: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 300)}\r\n`
          + `${RESTART_SENTINEL} exit=1\r\n`,
        'utf8',
      )
    } catch { /* the response below is the operator's answer either way */ }
    withdraw()
    return NextResponse.json(
      { error: `Could not schedule the restart: ${(e?.stderr || e?.message || '').toString().slice(0, 300)}` },
      { status: 500 },
    )
  }

  // ⛔ AUDITED BEFORE THE TASK RUNS, NOT AFTER. From the moment
  // `schtasks /run` succeeds this process can be killed at any instant, and an
  // audit write queued after it is one that may never happen — "who restarted
  // the console, and why" is exactly what an audit log is read for.
  try {
    await recordSystemChanges(user.id, [{ key: purpose, from: null, to: target.service }], 'service_restart')
  } catch { /* never block the restart on the audit row */ }

  try {
    await execFileAsync('schtasks.exe', ['/run', '/tn', RESTART_TASK_NAME], { timeout: 20_000 })
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string }
    // ⛔ REMOVE THE TASK WE JUST CREATED. Returning here used to leave
    // `NocVault-ServiceRestart` registered with a `/sc once /st 00:00`
    // trigger and the wrapper still on disk — which Windows schedules for the
    // FOLLOWING day when the start time has passed. A failed click could
    // therefore restart a service unattended at midnight. The wrapper's own
    // self-delete never runs, because the wrapper never ran.
    //
    // ⛔ AND IT MAY ONLY WITHDRAW A **PENDING** CLAIM. `schtasks /run` can
    // SUCCEED on the box and still exceed its timeout on a loaded host, in which
    // case the wrapper is already running and owns this lock — dropping it would
    // let a second POST start a second wrapper against the same service. If the
    // wrapper has taken over, the claim stays and so does the task.
    const stillOurs = releaseRunLock(paths.lock, lockEnv, { onlyIfPending: true, runId })
    if (stillOurs) {
      await deleteRestartTask()
      try {
        fs.appendFileSync(paths.log, `${RESTART_SENTINEL} exit=1\r\n`, 'utf8')
      } catch { /* best effort */ }
      return NextResponse.json(
        { error: `Could not start the restart: ${(e?.stderr || e?.message || '').toString().slice(0, 300)}` },
        { status: 500 },
      )
    }
    // The wrapper owns the lock: the task DID launch and the call merely timed
    // out. Report it as started, because it was.
    return NextResponse.json({
      started: true,
      service: target.service,
      why: target.why,
      runId,
      dependencyDetail,
      stopsDependents: hubDependents.length > 0,
      previousUptimeSeconds: Math.floor(process.uptime()),
      note: 'The scheduler took longer than expected to answer, but the restart did start.',
    })
  }

  return NextResponse.json({
    started: true,
    service: target.service,
    why: target.why,
    runId,
    // ⛔ `selfRestart` WAS REMOVED (1.63.0): it was computed, returned, and read
    // by nobody. The panel already decides the same thing from `service`
    // (`service === 'NocVault-Tls'`), and a second, derived spelling of one fact
    // is how the two drift apart. Whether the request's own process is the one
    // going down still decides the entire client experience — it is just not
    // this route's job to say it twice.
    //
    // ⛔ `dependencyDetail` IS NEW, AND IT IS THE BRANCH WHERE THE RESTART IS
    // GUARANTEED TO FAIL. `terminatorDependsOn` returns `null` with a reason
    // when it could not read the dependency field; this route consumed only the
    // boolean, so the operator got "The restart did not take effect" with no
    // hint that an unreadable `sc qc` was the cause — and a `null` reading means
    // the terminator is left running, so Windows refuses the stop with 1051.
    dependencyDetail,
    // ⛔ THE PANEL HAS TO KNOW. When the terminator really does declare
    // `DependOnService NetVault`, the wrapper's order is: stop the terminator →
    // stop/start the hub → START THE TERMINATOR AGAIN (up to 90 s) → write
    // `dependent … back:` and only then the sentinel. The hub answers HTTP
    // before `Get-Service` even reports it Running, so the panel's uptime proof
    // fires while NocVault-Tls is still STOPPED and all four consoles' public
    // ports are dead. The panel used that proof alone to declare success, which
    // made `parseRestartLog`'s `depsFailed` term — added specifically to refuse
    // that false all-clear — unreachable on the only path where dependents
    // exist. See components/settings/RestartControl.tsx.
    stopsDependents: hubDependents.length > 0,
    previousUptimeSeconds: Math.floor(process.uptime()),
  })
}
