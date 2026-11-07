//
// app/api/system/tls-transport/route.ts — Settings → HTTPS.
//
// GET  reports which way the switch is facing and what the last run did.
// POST runs installer\Enable-NocVaultTls.ps1 (preview / enable / disable).
//
// ⛔ WHY THIS CANNOT JUST BE AN `await` IN THE REQUEST. The cutover
// reconfigures and restarts the very service handling this request: the hub
// moves off :3000 onto 127.0.0.1:13000 part-way through, so the socket this
// response would travel back on is gone before there is anything to say. The
// work is handed to a scheduled task running as SYSTEM and the panel reads the
// log — the same shape `app/api/system/update` already uses for the in-app
// updater, for the same reason.
//
// ⛔ SYSTEM, BECAUSE NSSM AND `sc.exe` NEED IT. The hub runs as LocalSystem but
// a request handler must not be the thing that stops four services; the task
// boundary is also what survives the hub going away mid-cutover.
//
// ⛔ NO `execSync` ON THIS PATH. [[sync-exec-blocks-event-loop]]: a synchronous
// child process in a route handler blocks the event loop and surfaces as
// database pool timeouts somewhere else entirely. Every child process here is
// awaited through execFile.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { findGitRoot } from '@/lib/gitRoot'
import { resolveTlsConfig, describeTlsStatus } from '@/lib/tlsConfig.ts'
import { recordSystemChanges } from '@/lib/systemAudit.ts'
import {
  TRANSPORT_TASK_NAME,
  SUITE_PUBLIC_PORTS,
  buildWrapperScript,
  isTransportAction,
  parseRunLog,
  transportCapability,
  transportPaths,
  validatePublicHost,
  type TerminatorState,
  type TransportAction,
} from '@/lib/tlsTransport.ts'
// ⛔ ONE IMPLEMENTATION. This file carried a byte-level duplicate of the 1060
// probe that lib/terminatorState.ts exists to be the single copy of — and the
// duplicate returned only {state, detail}, with no `running`, which is why the
// terminator frame could not be reported from this route at all.
import { HUB_PUBLIC_PORT, TERMINATOR_SERVICE, readTerminatorState } from '@/lib/terminatorState.ts'
import { claimRunLock, readRunLock, releaseRunLock, type LockEnv } from '@/lib/runLock.ts'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

type SessionUser = { id?: string | number; role?: string }
function userOf(session: unknown): SessionUser {
  return ((session as { user?: SessionUser } | null)?.user || {}) as SessionUser
}

/** Same liveness check the updater's concurrency guard uses. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    return (e as { code?: string })?.code === 'EPERM'
  }
}

/**
 * The lock rules, shared with `service-restart`.
 *
 * ⛔ THREE DEFECTS LIVED IN THE PRIVATE COPY THIS REPLACES, and each one is
 * written out in lib/runLock.ts's header:
 *
 *   - the claim was `String(process.pid)` — the HUB's own, permanently-alive
 *     pid — so a wrapper that never started left `runInProgress: true` forever
 *     while the panel hid the only button that could have cleared it;
 *   - `reapStaleLock` was `dead || old` against an mtime written once at
 *     wrapper start, so `old` alone removed a LIVE run's lock at 30 minutes,
 *     contradicting its own "age is the second condition" comment;
 *   - the reap was on the WRITE path while the gate it unblocks is on the READ
 *     path (`runInProgress` → `blockedReason` → the action card, Preview
 *     included, disappears). GET never reaped.
 *
 * The wrappers now heartbeat the lock as they work, so age is an IDLE timeout,
 * and GET reaps.
 */
const lockEnv: LockEnv = { fs, isPidAlive }

/**
 * Remove the scheduled task, best effort.
 *
 * ⛔ ALSO CALLED WHEN A LOCK IS REAPED. Nothing used to delete the task when
 * the wrapper STARTED AND THEN DIED — a host reboot mid-cutover, the task being
 * terminated, a PowerShell crash — and a `/sc once /st 00:00` trigger whose
 * start time has passed fires the FOLLOWING day, re-running the wrapper still on
 * disk holding the last requested action. A reboot during a cutover at 14:00
 * therefore dropped the whole suite to plain HTTP, unattended, at midnight. The
 * wrapper's own arm guard (lib/runLock.ts) refuses that fire; this stops the
 * orphan having to wait for midnight to be noticed.
 */
async function deleteTransportTask(): Promise<void> {
  try {
    await execFileAsync('schtasks.exe', ['/delete', '/tn', TRANSPORT_TASK_NAME, '/f'], { timeout: 15_000 })
  } catch { /* no such task is the normal case */ }
}

/**
 * The log, or `null` when there has never been a run.
 *
 * ⛔ A READ ERROR IS NOT AN ABSENT FILE. `parseRunLog(null)` means "no run has
 * happened"; a file that exists and cannot be read is reported separately so
 * the panel never shows "no changes yet" for a log it simply failed to open.
 */
function readLog(logPath: string): { text: string | null; error: string | null } {
  if (!fs.existsSync(logPath)) return { text: null, error: null }
  try {
    return { text: fs.readFileSync(logPath, 'utf8'), error: null }
  } catch (err: unknown) {
    return { text: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = userOf(session).role
  if (role !== 'admin' && role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const repoRoot = findGitRoot(process.cwd())
  const paths = transportPaths(repoRoot)
  const config = resolveTlsConfig(process.env)
  const terminator = await readTerminatorState()
  // ⛔ THE REAP IS HERE, ON THE READ PATH. It used to be in POST only, and the
  // gate it unblocks is drawn from this very payload — `runInProgress` becomes
  // `blockedReason`, which hides the entire action card including Preview, so
  // the only code that could clear a stuck lock was the POST the panel refused
  // to let anybody send. Reaping also removes the orphaned task.
  const lock = readRunLock(paths.lock, lockEnv)
  if (lock.reaped) await deleteTransportTask()
  const runInProgress = lock.held
  const { text, error: logError } = readLog(paths.log)
  const run = parseRunLog(text)

  const scriptPresent = fs.existsSync(paths.script)
  const capability = transportCapability({
    platform: process.platform,
    scriptPresent,
    terminator: terminator.state,
    // A sentinel-less log with a dead PID is a crashed run, not a live one; the
    // lock is what decides "in progress", never the log alone.
    runInProgress,
  })

  return NextResponse.json({
    // What lib/tlsConfig.ts says THIS PROCESS is serving. The authority on
    // whether the console is encrypted.
    status: config.status,
    summary: describeTlsStatus(config),
    error: config.error,
    httpsPort: config.httpsPort,
    httpPort: config.httpPort,
    certPath: config.certPath,
    // ⛔ `keyPath` IS DELIBERATELY NOT RETURNED. It is the PRIVATE key's
    // absolute path, GET is admin-or-super_admin, and TransportPanel never
    // rendered it — so it was pure disclosure to a role that cannot press a
    // button on this tab. `keyPresent` answers the only question the panel asks.
    keyPresent: Boolean(config.keyPath),
    publicHost: (process.env.TLS_PUBLIC_HOST || '').trim() || null,
    // ⛔ REPORTED SEPARATELY FROM `status`. The hub reads its environment at
    // startup, so `status` can be stale with respect to a terminator that was
    // started or removed since; the service state is the live fact and the
    // panel shows both rather than reconciling them into one.
    terminator: terminator.state,
    terminatorDetail: terminator.detail,
    // Where this console is bound right now — 1300x means the cutover is
    // applied and the public port belongs to the terminator.
    // ⛔ THE TERMINATOR FRAME, ON THIS ROUTE TOO. 1.62.0 wired `fronted`/
    // `publicPort` into the Certificate and Console-address panels and missed
    // THIS one — the HTTPS tab, the page an operator actually uses to judge a
    // cutover, which went on saying "Serving HTTPS on port 13000". There were
    // three call sites of `transportPresentation`, not two.
    fronted: terminator.running,
    publicPort:
      terminator.running === true ? HUB_PUBLIC_PORT
      : terminator.running === false ? config.httpsPort
      : null,
    boundPort: (process.env.PORT || '').trim() || null,
    boundHostname: (process.env.HOSTNAME || '').trim() || null,
    ports: SUITE_PUBLIC_PORTS,
    scriptPresent,
    runInProgress,
    // ⛔ "STARTED AND DIED" IS A THIRD STATE, AND IT WAS UNREPRESENTABLE.
    // `parseRunLog` returns 'running' for ANY log with no sentinel, forever —
    // the log is only truncated by the NEXT run. A cutover killed mid-flight
    // (reboot, task terminated, PowerShell crash) therefore left GET reporting
    // the contradictory pair `runInProgress: false` + `outcome: 'running'`, and
    // the panel polled every 3 s indefinitely showing "A change is running".
    runDied: run.outcome === 'running' && !runInProgress,
    logPath: paths.log,
    logError,
    lastRun: {
      outcome: run.outcome,
      action: run.action,
      exitCode: run.exitCode,
      finished: run.finished,
      highlights: run.highlights.slice(-12),
      // Tail only. The whole log is on the server for anyone who wants it, and
      // a settings panel is not a log viewer.
      lines: run.lines.slice(-60),
    },
    ...capability,
  })
}

/**
 * Run the engine.
 *
 * ⛔ super_admin ONLY, AND THE CHECK IS HERE, NOT ONLY ON THE NAV. This is the
 * first Settings action that can take all four consoles offline; the tab being
 * hidden for an `admin` is cosmetic, and this is what makes a hand-made POST
 * mean nothing. (`GET` is admin+ because reading the transport is diagnostic.)
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = userOf(session)
  if (user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { action?: unknown; publicHost?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  if (!isTransportAction(body.action)) {
    return NextResponse.json({ error: "action must be 'preview', 'enable' or 'disable'." }, { status: 400 })
  }
  const action: TransportAction = body.action

  const hostVerdict = validatePublicHost(body.publicHost)
  if (!hostVerdict.ok) return NextResponse.json({ error: hostVerdict.reason }, { status: 400 })
  const publicHost = hostVerdict.host

  const repoRoot = findGitRoot(process.cwd())
  const paths = transportPaths(repoRoot)

  if (!fs.existsSync(paths.script)) {
    return NextResponse.json(
      { error: `installer\\Enable-NocVaultTls.ps1 was not found at ${paths.script}.` },
      { status: 400 },
    )
  }

  const terminator = await readTerminatorState()
  const capability = transportCapability({
    platform: process.platform,
    scriptPresent: true,
    terminator: terminator.state,
    runInProgress: false,
  })
  // ⛔ THE SAME CAPABILITY THE PANEL RENDERS, RE-CHECKED HERE. A disabled button
  // is not a guard, and the facts can have changed between the GET that drew it
  // and this POST.
  const allowed = action === 'preview' ? capability.canPreview
    : action === 'enable' ? capability.canEnable
      : capability.canDisable
  if (!allowed) {
    return NextResponse.json(
      { error: capability.blockedReason || `'${action}' is not available in the current state.` },
      { status: 409 },
    )
  }

  // ⛔ THE ROUTE CLAIMS THE LOCK, NOT THE WRAPPER — and the claim is PENDING
  // until the wrapper takes it over. The wrapper only writes its own pid once
  // Task Scheduler has launched it, seconds after this request returns; in that
  // window a second click (two tabs, two admins, or a Preview launched "safely
  // at any time" on top of a live cutover) used to pass the guard, truncate the
  // running log with `-Force`, and start a second engine instance stopping and
  // starting the same four services. `claimRunLock` writes with `flag: 'wx'`,
  // so the claim is atomic, and it reaps debris first so it cannot be
  // permanently busy.
  const runId = randomUUID()
  try {
    fs.mkdirSync(paths.log.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  } catch { /* the wrapper write below reports a real failure */ }
  const claim = claimRunLock(paths.lock, runId, process.pid, lockEnv)
  if (!claim.ok) {
    if (claim.reason === 'busy') {
      return NextResponse.json(
        {
          error: claim.claim.pending
            ? 'A transport change was just started. Wait for it to finish.'
            : `A transport change is already running (process ${claim.claim.pid}). Wait for it to finish.`,
        },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: `Could not claim the run lock: ${claim.message}` }, { status: 500 })
  }

  // ⛔ ONLY EVER WITHDRAWS A **PENDING** CLAIM. The old `releaseLock` unlinked
  // the file unconditionally, and it was called from the catch around
  // `/delete`+`/create`+`/run` — where `schtasks /run` can have SUCCEEDED on the
  // box and merely exceeded its 20 s timeout on a loaded host. The wrapper was
  // then mid-cutover and this route deleted the task and unlinked the lock the
  // wrapper owned: GET reported `runInProgress: false`, the panel re-enabled
  // every button, and a second POST started a SECOND engine instance against
  // the same four services — the exact disaster the `wx` claim exists to
  // prevent, reached through its own cleanup. Returns whether the claim was
  // still ours, which is also the answer to "may I delete the task".
  const withdraw = () => releaseRunLock(paths.lock, lockEnv, { onlyIfPending: true, runId })

  try {
    fs.writeFileSync(
      paths.wrapper,
      buildWrapperScript({
        script: paths.script,
        action,
        log: paths.log,
        lock: paths.lock,
        taskName: TRANSPORT_TASK_NAME,
        publicHost,
        // ⛔ THE ARM TOKEN. The wrapper refuses to run the engine unless the
        // lock still carries THIS run's pending claim — which is what stops an
        // orphaned task re-running `-Disable` unattended at midnight.
        runId,
      }),
      'utf8',
    )
  } catch (err: unknown) {
    withdraw()
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Could not write the run script: ${message}` }, { status: 500 })
  }

  try {
    // A stale task from a previous run that could not clean itself up would
    // make /create fail; /f on create covers it, and the delete keeps the
    // failure modes down to one.
    try {
      await execFileAsync('schtasks.exe', ['/delete', '/tn', TRANSPORT_TASK_NAME, '/f'], { timeout: 15_000 })
    } catch { /* no such task is the normal case */ }
    await execFileAsync('schtasks.exe', [
      '/create', '/tn', TRANSPORT_TASK_NAME,
      // ⛔ execFile, so this is ONE argv entry and Node quotes it. The path can
      // contain spaces (C:\Program Files\…) and there is no shell here to
      // re-split it — which is the whole reason the engine call lives in a
      // wrapper file rather than being spelled out on this command line.
      '/tr', `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${paths.wrapper}"`,
      '/sc', 'once', '/st', '00:00', '/f', '/ru', 'SYSTEM',
    ], { timeout: 20_000 })
    await execFileAsync('schtasks.exe', ['/run', '/tn', TRANSPORT_TASK_NAME], { timeout: 20_000 })
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string }
    const message = (e?.stderr || e?.message || 'unknown error').toString().slice(0, 400)
    // ⛔ THE TASK IS REMOVED ONLY IF THE RUN NEVER STARTED. Returning here used
    // to leave `NocVault-TlsTransport` registered with a `/sc once /st 00:00`
    // trigger and the wrapper still on disk holding the last requested action —
    // and a `once` trigger whose start time has already passed is scheduled for
    // the FOLLOWING day, so a failed click could drop the whole suite to plain
    // HTTP, unattended, at midnight.
    //
    // ⛔ BUT `schtasks /run` CAN SUCCEED AND STILL TIME OUT. If the wrapper has
    // taken the lock over, the cutover IS running — deleting its task and
    // dropping its lock is how this cleanup became the second-engine disaster
    // described at `withdraw` above. So the withdrawal decides: ours, tidy up
    // and report the failure; not ours, report it as started.
    const stillOurs = withdraw()
    if (!stillOurs) {
      return NextResponse.json({
        started: true,
        action,
        publicHost: publicHost || null,
        logPath: paths.log,
        note: 'The scheduler took longer than expected to answer, but the change did start.',
      })
    }
    await deleteTransportTask()
    return NextResponse.json({ error: `Could not schedule the change: ${message}` }, { status: 500 })
  }

  // ⛔ AUDITED AS AN INTENT, NOT AS AN OUTCOME. The run has only just been
  // scheduled; the outcome lands in the log minutes later and is read by GET.
  // Recording "enabled HTTPS" here would be a claim this route cannot support
  // — the engine reverts itself on a failed gate and still exits 0.
  try {
    // Its own `field_name` namespace, the same way the group mappings take
    // `directory_mapping`: an auditor reading this later must be able to tell
    // "somebody switched the whole suite's transport" from "somebody edited a
    // setting", and a shared namespace makes those one event class.
    await recordSystemChanges(
      user.id,
      [{ key: 'action', from: null, to: publicHost ? `${action} (public host ${publicHost})` : action }],
      'tls_transport',
    )
  } catch { /* the audit row is not worth failing the action over */ }

  return NextResponse.json({ started: true, action, publicHost: publicHost || null, logPath: paths.log })
}
