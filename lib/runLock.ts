//
// lib/runLock.ts — the one lock two SYSTEM-task features share.
//
// `app/api/system/tls-transport` and `app/api/system/service-restart` have the
// same shape: a route writes a PowerShell wrapper, hands it to a scheduled task
// running as SYSTEM, and a panel reads a log. Both need exactly one run at a
// time, and both got the lock subtly wrong in a DIFFERENT way — which is why
// the rules now live in one place with the reasoning attached.
//
// ⛔ FOUR DEFECTS THIS FILE EXISTS TO CLOSE, ALL CONFIRMED IN 1.62.2:
//
// 1. `service-restart` NEVER CLAIMED THE LOCK. Its 409 guard read a lock only
//    the WRAPPER writes, so between `schtasks /run` and the wrapper's
//    `$PID | Out-File` nothing was held. Two super_admin tabs ~2 s apart both
//    passed the guard; POST 2 truncated the log — destroying run A's `runId=`
//    header and any lines wrapper A had already written — then deleted the
//    pending task and created its own. Either wrapper A never ran while its
//    panel had been told `started: true`, or both ran and the panel read a
//    verdict assembled from two runs' lines (wrapper A's `pid after: …
//    changed=True` for `NetVault` credited to wrapper B's `NocVault-Tls` run).
//    `tls-transport` got `flag: 'wx'` for precisely this; its sibling did not.
//
// 2. CLAIMING WITH THE HUB'S OWN PID WEDGED THE FEATURE. `tls-transport`
//    claimed the lock with `String(process.pid)` — a process that is
//    permanently alive. If the wrapper then never started (task launch refused,
//    Scheduler stopped), `isPidAlive` stayed true forever, GET reported
//    `runInProgress: true` indefinitely, and the panel showed "A change is
//    already running" with no buttons — so the only code that could clear it
//    was the POST the panel refused to let anyone send. A claim is therefore
//    marked PENDING and expires on its own (`ARM_WINDOW_MS`), whatever the PID
//    says.
//
// 3. `old` REAPED A LIVE LOCK. `reapStaleLock` was `dead || old` with a 30
//    minute age, and the mtime was written once at wrapper start and never
//    touched again — so age alone said "debris" about a run that was still
//    going. Both wrappers now REWRITE the lock as they work (see
//    `psLockHeartbeat`), which is what makes `old` mean "nothing has touched
//    this in 30 minutes" instead of "this run started a while ago".
//
// 4. CLEANUP COULD DELETE A LIVE RUN'S LOCK. The catch around
//    `/delete`+`/create`+`/run` released the lock unconditionally — but
//    `schtasks /run` can SUCCEED on the box and still exceed its 20 s timeout,
//    in which case the wrapper is mid-cutover and the route was deleting the
//    task and unlinking the lock the wrapper owned. GET then said
//    `runInProgress: false`, the panel re-enabled every button, and a second
//    POST started a SECOND engine instance against the same four services.
//    `releaseRunLock(..., { onlyIfPending: true })` can only ever drop a claim
//    the wrapper has not taken over.
//
// ⛔ NO `fs` HERE EITHER — IT IS PASSED IN. These are the four judgements that
// each have a one-line wrong version, so they have to be testable without a
// Windows host or a real scheduled task. The routes supply `node:fs` and the
// liveness probe.

/**
 * How long a route's claim may sit un-taken-over before it is debris.
 *
 * ⛔ BOUNDED BY TASK-SCHEDULER LATENCY, NOT BY RUN LENGTH. The only thing
 * happening in this window is Windows launching a PowerShell process. Two
 * minutes is generous for that and short enough that a failed launch does not
 * lock an operator out of the panel for long.
 */
export const ARM_WINDOW_MS = 2 * 60 * 1000

/**
 * How long a wrapper-owned lock may go untouched before it is debris.
 *
 * ⛔ THIS IS AN IDLE TIMEOUT NOW, NOT AN AGE LIMIT. It only means anything
 * because the wrappers heartbeat the file; see defect 3 above.
 */
export const LOCK_IDLE_MS = 30 * 60 * 1000

/** How a lock file reads. */
export type LockClaim = {
  pid: number | null
  /**
   * `true` while the ROUTE owns the claim and the wrapper has not started.
   * The wrapper's takeover overwrites the file with a bare PID, so this
   * flipping to `false` is the handover signal.
   */
  pending: boolean
  /** The run this claim belongs to; `null` for a wrapper-owned (bare PID) lock. */
  runId: string | null
}

/** The body the ROUTE writes to claim a run before the task exists. */
export function pendingLockBody(pid: number, runId: string): string {
  return `${pid} pending ${runId}`
}

/**
 * Read a lock body.
 *
 * ⛔ A BARE NUMBER STAYS VALID. That is what both wrappers write, and a parser
 * that only understood the new pending form would read every live run's lock as
 * garbage — including a run already in flight across a deploy.
 */
export function parseLockBody(raw: string | null | undefined): LockClaim | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).replace(/^﻿/, '').trim()
  if (text === '') return null
  const m = /^(\d+)(?:\s+pending\s+(\S+))?\s*$/.exec(text)
  if (!m) return null
  const pid = Number.parseInt(m[1], 10)
  if (!Number.isFinite(pid) || pid <= 0) return null
  return { pid, pending: m[2] !== undefined, runId: m[2] ?? null }
}

export type LockFs = {
  readFileSync(path: string, enc: 'utf8'): string
  writeFileSync(path: string, data: string, opts: { encoding: 'utf8'; flag?: string }): void
  statSync(path: string): { mtimeMs: number }
  unlinkSync(path: string): void
  existsSync(path: string): boolean
}

export type LockEnv = {
  fs: LockFs
  /** `process.kill(pid, 0)`-style liveness. */
  isPidAlive(pid: number): boolean
  now?: () => number
}

export type LockReading =
  | { held: false; reaped: boolean; claim: null }
  | { held: true; reaped: false; claim: LockClaim; ageMs: number }

/**
 * Is a run in progress, and remove the file if it cannot be one.
 *
 * ⛔ THIS IS A READ THAT WRITES, AND THAT IS THE WHOLE POINT. Reaping used to
 * live on the POST path while the GATE that blocks a POST lived on the read path
 * (`runInProgress` → `blockedReason` → the panel hides the entire action card,
 * Preview included). A lock that could only be cleared by the request the panel
 * refused to send is the wedge the reaper's own header claimed it had removed.
 * Call this from GET.
 */
export function readRunLock(lockPath: string, env: LockEnv): LockReading {
  const now = (env.now || Date.now)()
  let claim: LockClaim | null
  let ageMs: number
  try {
    if (!env.fs.existsSync(lockPath)) return { held: false, reaped: false, claim: null }
    claim = parseLockBody(env.fs.readFileSync(lockPath, 'utf8'))
    ageMs = now - env.fs.statSync(lockPath).mtimeMs
  } catch {
    // Unreadable is not held: a lock we cannot read cannot be honoured, and
    // refusing forever on it is the wedge above in another costume.
    return { held: false, reaped: false, claim: null }
  }
  // ⛔ AN UNPARSEABLE BODY IS DEBRIS, NOT A RUN. A truncated or half-written
  // lock would otherwise hold the feature closed with nothing able to clear it.
  if (claim === null) return { held: false, reaped: reap(lockPath, env), claim: null }

  if (claim.pending) {
    // ⛔ THE PID IS NOT CONSULTED FOR A PENDING CLAIM. It is the HUB's pid and
    // is always alive; only the clock can tell us the wrapper never started.
    if (ageMs > ARM_WINDOW_MS) return { held: false, reaped: reap(lockPath, env), claim: null }
    return { held: true, reaped: false, claim, ageMs }
  }

  // Wrapper-owned. Dead is immediate; otherwise it has to have gone quiet, and
  // `LOCK_IDLE_MS` only means that because the wrapper heartbeats the file.
  if (claim.pid === null || !env.isPidAlive(claim.pid)) {
    return { held: false, reaped: reap(lockPath, env), claim: null }
  }
  if (ageMs > LOCK_IDLE_MS) return { held: false, reaped: reap(lockPath, env), claim: null }
  return { held: true, reaped: false, claim, ageMs }
}

function reap(lockPath: string, env: LockEnv): boolean {
  try { env.fs.unlinkSync(lockPath); return true } catch { return false }
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'busy'; claim: LockClaim }
  | { ok: false; reason: 'error'; message: string }

/**
 * Claim a run before the scheduled task exists.
 *
 * ⛔ `flag: 'wx'`, SO THE CLAIM IS ATOMIC. A check-then-write leaves the exact
 * window two tabs clicking two seconds apart both walked through. The stale
 * reap runs FIRST, so debris cannot make this permanently busy.
 */
export function claimRunLock(
  lockPath: string,
  runId: string,
  pid: number,
  env: LockEnv,
): ClaimResult {
  const existing = readRunLock(lockPath, env)
  if (existing.held) return { ok: false, reason: 'busy', claim: existing.claim }
  try {
    env.fs.writeFileSync(lockPath, pendingLockBody(pid, runId), { encoding: 'utf8', flag: 'wx' })
    return { ok: true }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code === 'EEXIST') {
      const again = readRunLock(lockPath, env)
      return again.held
        ? { ok: false, reason: 'busy', claim: again.claim }
        : { ok: false, reason: 'busy', claim: { pid: null, pending: true, runId: null } }
    }
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Give a claim back.
 *
 * ⛔ `onlyIfPending` IS THE WHOLE FIX FOR DEFECT 4. A cleanup path that runs
 * because `schtasks /run` THREW cannot know whether the run started: the call
 * can exceed its timeout on a loaded host while the task launched perfectly. So
 * it may only ever withdraw a claim the wrapper has not taken over, and it must
 * leave a wrapper-owned lock exactly where it is.
 *
 * Returns whether the lock was removed, so a caller can tell the difference
 * between "withdrawn" and "the wrapper owns it, leave the task alone".
 */
export function releaseRunLock(
  lockPath: string,
  env: LockEnv,
  opts: { onlyIfPending?: boolean; runId?: string } = {},
): boolean {
  try {
    if (!env.fs.existsSync(lockPath)) return false
    if (opts.onlyIfPending) {
      const claim = parseLockBody(env.fs.readFileSync(lockPath, 'utf8'))
      if (claim === null) { reap(lockPath, env); return true }
      if (!claim.pending) return false
      // ⛔ AND IT MUST BE OUR OWN CLAIM. Another request's pending claim is
      // somebody else's run about to start.
      if (opts.runId !== undefined && claim.runId !== null && claim.runId !== opts.runId) return false
    }
    env.fs.unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

// ─── the PowerShell halves ──────────────────────────────────────────────────

/**
 * The lines a wrapper runs FIRST: prove it was armed, or do nothing at all.
 *
 * ⛔ THIS IS THE ONLY RELIABLE ANSWER TO THE ORPHANED TASK. Both routes delete
 * the task when `schtasks /run` FAILS, and nothing deleted it when the wrapper
 * STARTED AND THEN DIED — a host reboot mid-run, the task being terminated, a
 * PowerShell crash — which both files treat elsewhere as a first-class case (it
 * is the entire premise of stale-lock reaping). The task survives with its
 * `/sc once /st 00:00` trigger, and by those same files' stated reasoning a
 * `once` trigger whose start time has passed fires THE FOLLOWING DAY. So a
 * reboot during a cutover at 14:00 re-ran the wrapper at MIDNIGHT, still
 * holding `action: 'disable'`, dropping the whole suite to plain HTTP
 * unattended — the outcome the route's own comment claims it prevents. Only the
 * NEXT POST reaped the task, and midnight comes first.
 *
 * The guard: the route's PENDING claim names this run. A wrapper that finds no
 * lock, a lock for a different run, or a lock already taken over (a bare PID —
 * i.e. itself, earlier) refuses and exits. An orphan firing hours later can
 * never match, because the claim was either reaped or overwritten.
 *
 * ⛔ IT MUST RUN BEFORE ANY `sc.exe` CALL, not inside the try/finally that
 * reports an outcome — refusing is not a run, and it must not write a sentinel
 * that a panel would read as this run's verdict.
 */
export function psArmGuard(opts: {
  runId: string
  /** Deleted by the refusing wrapper, so an orphan removes itself on its one fire. */
  taskName: string
  quote: (s: string) => string
}): string[] {
  const q = opts.quote
  return [
    `$runId = ${q(opts.runId)}`,
    // Read whatever is there; absent/unreadable both mean "not armed".
    '$armed = $false',
    'try {',
    '    if (Test-Path -LiteralPath $lock) {',
    '        $claim = (Get-Content -LiteralPath $lock -Raw -ErrorAction Stop).Trim()',
    '        if ($claim -match ("^\\d+\\s+pending\\s+" + [regex]::Escape($runId) + "$")) { $armed = $true }',
    '    }',
    '} catch { $armed = $false }',
    'if (-not $armed) {',
    '    "[NV-LOCK] refusing: this task was not armed for run $runId - nothing was changed." |',
    '        Out-File -FilePath $log -Append -Encoding UTF8',
    // ⛔ AND IT TAKES THE TASK WITH IT. This is the only moment anything is
    // guaranteed to be running that can remove the orphan; the route only gets
    // the chance on a later POST, and midnight comes first.
    `    & schtasks.exe /delete /tn ${q(opts.taskName)} /f 2>&1 | Out-Null`,
    '    exit 0',
    '}',
  ]
}

/**
 * Take the claim over, and keep proving the run is alive.
 *
 * ⛔ THE REWRITE IS THE HEARTBEAT. `LOCK_IDLE_MS` is only a death signal
 * because this runs repeatedly; with a single write at start, age alone reaped
 * a live run (defect 3).
 */
export function psLockTakeover(): string {
  return '$PID | Out-File -FilePath $lock -Encoding ascii -Force'
}

/** Same statement, used inside a wrapper's loops. Named so intent is obvious. */
export function psLockHeartbeat(): string {
  return '$PID | Out-File -FilePath $lock -Encoding ascii -Force'
}
